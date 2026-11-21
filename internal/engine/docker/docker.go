// Package docker adapts the Docker Engine API to engine.Runtime.
package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"

	"github.com/soulfactorx/boxforge/internal/engine"
)

// Runtime is a connection to one Docker engine.
type Runtime struct {
	cli *client.Client
}

// Connect opens the engine named by host ("unix:///…", "npipe://…",
// "tcp://…"). An empty host means the platform default.
// It does not talk to the engine yet: the first call does.
func Connect(host string) (*Runtime, error) {
	opts := []client.Opt{client.FromEnv, client.WithAPIVersionNegotiation()}
	if host != "" {
		opts = append(opts, client.WithHost(host))
	}
	cli, err := client.NewClientWithOpts(opts...)
	if err != nil {
		return nil, err
	}
	return &Runtime{cli: cli}, nil
}

// ConnectDialer opens an engine reached by a connection of the caller's
// making, such as a helper process's stdin and stdout.
func ConnectDialer(dial func(ctx context.Context, network, addr string) (net.Conn, error)) (*Runtime, error) {
	cli, err := client.NewClientWithOpts(
		// The address is never dialled: every connection comes from dial.
		client.WithHost("http://engine.boxforge.invalid"),
		client.WithDialContext(dial),
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, err
	}
	return &Runtime{cli: cli}, nil
}

func (r *Runtime) Close() error { return r.cli.Close() }

func (r *Runtime) Capabilities() []engine.Capability {
	return []engine.Capability{engine.CapPause, engine.CapRename}
}

func (r *Runtime) Info(ctx context.Context) (engine.Info, error) {
	i, err := r.cli.Info(ctx)
	if err != nil {
		return engine.Info{}, err
	}
	// Podman answers this API too, and says so in its version.
	kind := "docker"
	if v, err := r.cli.ServerVersion(ctx); err == nil {
		for _, c := range v.Components {
			if strings.Contains(strings.ToLower(c.Name), "podman") {
				kind = "podman"
			}
		}
	}
	return engine.Info{
		Runtime:    kind,
		Name:       i.Name,
		Version:    i.ServerVersion,
		OS:         i.OperatingSystem,
		Arch:       i.Architecture,
		CPUs:       i.NCPU,
		MemTotal:   i.MemTotal,
		Containers: i.Containers,
		Running:    i.ContainersRunning,
		Images:     i.Images,
	}, nil
}

func (r *Runtime) Events(ctx context.Context) (<-chan engine.Event, <-chan error) {
	out := make(chan engine.Event)
	errc := make(chan error, 1)
	msgs, errs := r.cli.Events(ctx, events.ListOptions{})
	go func() {
		defer close(out)
		defer close(errc)
		for {
			select {
			case m := <-msgs:
				ev := engine.Event{Type: string(m.Type), Action: string(m.Action), ID: m.Actor.ID}
				select {
				case out <- ev:
				case <-ctx.Done():
					errc <- ctx.Err()
					return
				}
			case err := <-errs:
				errc <- err
				return
			}
		}
	}()
	return out, errc
}

func (r *Runtime) Usage(ctx context.Context) (engine.Usage, error) {
	du, err := r.cli.DiskUsage(ctx, types.DiskUsageOptions{})
	if err != nil {
		return engine.Usage{}, err
	}
	u := engine.Usage{Images: du.LayersSize}
	for _, im := range du.Images {
		if im != nil && im.Containers == 0 {
			u.ImagesFree += im.Size - max(im.SharedSize, 0)
			u.UnusedImages++
		}
	}
	for _, c := range du.Containers {
		if c == nil {
			continue
		}
		u.Containers += c.SizeRw
		if c.State != "running" && c.State != "paused" && c.State != "restarting" {
			u.ContainersFree += c.SizeRw
			u.StoppedCount++
		}
	}
	for _, v := range du.Volumes {
		if v == nil || v.UsageData == nil || v.UsageData.Size < 0 {
			continue
		}
		u.Volumes += v.UsageData.Size
		if v.UsageData.RefCount == 0 {
			u.VolumesFree += v.UsageData.Size
			u.UnusedVolumes++
		}
	}
	for _, b := range du.BuildCache {
		if b == nil {
			continue
		}
		u.BuildCache += b.Size
		if !b.InUse {
			u.BuildCacheFree += b.Size
		}
	}
	return u, nil
}

func (r *Runtime) Containers() engine.ContainerService { return containers{r.cli} }
func (r *Runtime) Images() engine.ImageService         { return images{r.cli} }
func (r *Runtime) Volumes() engine.VolumeService       { return volumes{r.cli} }
func (r *Runtime) Networks() engine.NetworkService     { return networks{r.cli} }

type containers struct{ cli *client.Client }

func (c containers) List(ctx context.Context) ([]engine.Container, error) {
	list, err := c.cli.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, err
	}
	out := make([]engine.Container, 0, len(list))
	for _, s := range list {
		name := ""
		if len(s.Names) > 0 {
			name = strings.TrimPrefix(s.Names[0], "/")
		}
		ports := make([]engine.Port, 0, len(s.Ports))
		for _, p := range s.Ports {
			ports = append(ports, engine.Port{IP: p.IP, Private: p.PrivatePort, Public: p.PublicPort, Proto: p.Type})
		}
		vols := []string{}
		for _, m := range s.Mounts {
			if m.Type == "volume" && m.Name != "" {
				vols = append(vols, m.Name)
			}
		}
		nets := []engine.Attachment{}
		if s.NetworkSettings != nil {
			for name, n := range s.NetworkSettings.Networks {
				if n != nil {
					nets = append(nets, engine.Attachment{Network: name, IP: n.IPAddress})
				}
			}
		}
		sort.Slice(nets, func(i, j int) bool { return nets[i].Network < nets[j].Network })
		state := string(s.State)
		code, _ := engine.ExitCode(s.Status)
		out = append(out, engine.Container{
			ID:       s.ID,
			Name:     name,
			Image:    s.Image,
			ImageID:  s.ImageID,
			State:    state,
			Status:   s.Status,
			Failed:   engine.FailedStatus(state, s.Status),
			ExitCode: code,
			System:   engine.SystemName(name),
			Created:  s.Created,
			Ports:    ports,
			Project:  s.Labels[engine.LabelComposeProject],
			Service:  s.Labels[engine.LabelComposeService],
			Volumes:  vols,
			Networks: nets,
			Labels:   s.Labels,
		})
	}
	return out, nil
}

func (c containers) Start(ctx context.Context, id string) error {
	return c.cli.ContainerStart(ctx, id, container.StartOptions{})
}
func (c containers) Stop(ctx context.Context, id string) error {
	return c.cli.ContainerStop(ctx, id, container.StopOptions{})
}
func (c containers) Restart(ctx context.Context, id string) error {
	return c.cli.ContainerRestart(ctx, id, container.StopOptions{})
}
func (c containers) Pause(ctx context.Context, id string) error {
	return c.cli.ContainerPause(ctx, id)
}
func (c containers) Unpause(ctx context.Context, id string) error {
	return c.cli.ContainerUnpause(ctx, id)
}
func (c containers) Kill(ctx context.Context, id string) error {
	return c.cli.ContainerKill(ctx, id, "KILL")
}
func (c containers) Rename(ctx context.Context, id, name string) error {
	return c.cli.ContainerRename(ctx, id, name)
}
func (c containers) Remove(ctx context.Context, id string, force, volumes bool) error {
	return c.cli.ContainerRemove(ctx, id, container.RemoveOptions{Force: force, RemoveVolumes: volumes})
}

func (c containers) Inspect(ctx context.Context, id string) ([]byte, error) {
	_, raw, err := c.cli.ContainerInspectWithRaw(ctx, id, false)
	return raw, err
}

func (c containers) Logs(ctx context.Context, id string, tail int, w io.Writer) error {
	info, err := c.cli.ContainerInspect(ctx, id)
	if err != nil {
		return err
	}
	rc, err := c.cli.ContainerLogs(ctx, id, container.LogsOptions{
		ShowStdout: true, ShowStderr: true, Follow: true, Tail: strconv.Itoa(tail),
	})
	if err != nil {
		return err
	}
	defer rc.Close()
	// A container with a terminal sends its output as it is; one without
	// interleaves stdout and stderr in framed chunks.
	if info.Config != nil && info.Config.Tty {
		_, err = io.Copy(w, rc)
	} else {
		_, err = stdcopy.StdCopy(w, w, rc)
	}
	if ctx.Err() != nil {
		return nil
	}
	return err
}

func (c containers) Run(ctx context.Context, spec engine.RunSpec) (string, error) {
	exposed := nat.PortSet{}
	bindings := nat.PortMap{}
	for _, p := range spec.Ports {
		proto := p.Proto
		if proto == "" {
			proto = "tcp"
		}
		port, err := nat.NewPort(proto, strconv.Itoa(int(p.Container)))
		if err != nil {
			return "", err
		}
		exposed[port] = struct{}{}
		bindings[port] = append(bindings[port], nat.PortBinding{HostPort: strconv.Itoa(int(p.Host))})
	}
	binds := make([]string, 0, len(spec.Mounts))
	for _, m := range spec.Mounts {
		binds = append(binds, m.Source+":"+m.Target)
	}
	var tmpfs map[string]string
	if len(spec.Tmpfs) > 0 {
		tmpfs = map[string]string{}
		for _, dir := range spec.Tmpfs {
			tmpfs[dir] = ""
		}
	}
	created, err := c.cli.ContainerCreate(ctx,
		&container.Config{
			Image: spec.Image, Env: spec.Env, Cmd: spec.Command, ExposedPorts: exposed,
			Tty: spec.Interactive, OpenStdin: spec.Interactive,
		},
		&container.HostConfig{
			PortBindings:  bindings,
			Binds:         binds,
			Privileged:    spec.Privileged,
			Tmpfs:         tmpfs,
			NetworkMode:   container.NetworkMode(spec.Network),
			RestartPolicy: container.RestartPolicy{Name: container.RestartPolicyMode(spec.Restart)},
		},
		nil, nil, spec.Name)
	if err != nil {
		return "", err
	}
	if err := c.cli.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		// Created but not started (a taken port, say): it stays, visible
		// in the list, for the user to fix or remove.
		return created.ID, err
	}
	return created.ID, nil
}

func (c containers) Output(ctx context.Context, id string, cmd []string, stdin []byte) (string, string, int, error) {
	created, err := c.cli.ContainerExecCreate(ctx, id, container.ExecOptions{
		Cmd: cmd, AttachStdin: stdin != nil, AttachStdout: true, AttachStderr: true,
	})
	if err != nil {
		return "", "", 0, err
	}
	att, err := c.cli.ContainerExecAttach(ctx, created.ID, container.ExecAttachOptions{})
	if err != nil {
		return "", "", 0, err
	}
	defer att.Close()
	if stdin != nil {
		go func() {
			_, _ = att.Conn.Write(stdin)
			_ = att.CloseWrite() // the command reads to the end of its input
		}()
	}
	var stdout, stderr bytes.Buffer
	copied := make(chan error, 1)
	go func() {
		_, err := stdcopy.StdCopy(&stdout, &stderr, att.Reader)
		copied <- err
	}()
	select {
	case err := <-copied:
		if err != nil {
			return "", "", 0, err
		}
	case <-ctx.Done():
		return "", "", 0, ctx.Err()
	}
	res, err := c.cli.ContainerExecInspect(ctx, created.ID)
	if err != nil {
		return "", "", 0, err
	}
	return stdout.String(), stderr.String(), res.ExitCode, nil
}

// pipe is a command's input and output. The engine sends output framed
// (which of stdout and stderr each piece is); out is that, unframed.
type pipe struct {
	att types.HijackedResponse
	out *io.PipeReader
}

func (p pipe) Read(b []byte) (int, error)  { return p.out.Read(b) }
func (p pipe) Write(b []byte) (int, error) { return p.att.Conn.Write(b) }
func (p pipe) CloseWrite() error           { return p.att.CloseWrite() }
func (p pipe) Close() error {
	p.att.Close()
	return p.out.Close()
}

func (c containers) Pipe(ctx context.Context, id string, cmd []string) (io.ReadWriteCloser, error) {
	created, err := c.cli.ContainerExecCreate(ctx, id, container.ExecOptions{Cmd: cmd, AttachStdin: true, AttachStdout: true, AttachStderr: true})
	if err != nil {
		return nil, err
	}
	att, err := c.cli.ContainerExecAttach(ctx, created.ID, container.ExecAttachOptions{})
	if err != nil {
		return nil, err
	}
	r, w := io.Pipe()
	go func() {
		_, err := stdcopy.StdCopy(w, io.Discard, att.Reader)
		w.CloseWithError(err)
	}()
	return pipe{att, r}, nil
}

func (c containers) Files(ctx context.Context, id, p string) ([]engine.FileEntry, error) {
	dir := path.Clean("/" + p)
	// A running container is asked directly; one that is stopped, or has
	// no shell, is read from the engine's archive of the folder.
	if stdout, _, code, err := c.Output(ctx, id, []string{"/bin/sh", "-c", listScript, "sh", dir}, nil); err == nil && code == 0 {
		if entries, ok := parseListing(stdout); ok {
			return entries, nil
		}
	}
	if dir == "/" {
		// The archive names its entries after the folder, and "/" has no name.
		dir = "/."
	}
	return listArchive(ctx, c.cli, id, dir)
}

func (c containers) Archive(ctx context.Context, id, p string) (io.ReadCloser, error) {
	rc, _, err := c.cli.CopyFromContainer(ctx, id, path.Clean("/"+p))
	return rc, err
}

func (c containers) Prune(ctx context.Context) (int64, error) {
	rep, err := c.cli.ContainersPrune(ctx, filters.Args{})
	if err != nil {
		return 0, err
	}
	return int64(rep.SpaceReclaimed), nil
}

func (c containers) Commit(ctx context.Context, id, ref string) error {
	_, err := c.cli.ContainerCommit(ctx, id, container.CommitOptions{Reference: ref, Pause: true})
	return err
}

func (c containers) CreateFrom(ctx context.Context, inspect []byte, img string) (string, []string, error) {
	var in container.InspectResponse
	if err := json.Unmarshal(inspect, &in); err != nil {
		return "", nil, err
	}
	if in.ContainerJSONBase == nil || in.Config == nil || in.HostConfig == nil {
		return "", nil, errors.New("the container's description is incomplete")
	}
	cfg, host := in.Config, in.HostConfig
	if _, ok := cfg.Labels["nerdctl/name"]; ok {
		cfg, host = fromNerdctl(inspect, in)
	}
	var notes []string
	cfg.Image = img
	// A bare shell with no terminal ends at once, as it did where it came
	// from: it is given one.
	if !cfg.Tty && len(in.Args) == 0 && engine.BareShell(nil, []string{in.Path}) {
		cfg.Tty, cfg.OpenStdin = true, true
	}
	// A hostname the engine made from the old ID would be a stale one.
	if cfg.Hostname != "" && strings.HasPrefix(in.ID, cfg.Hostname) {
		cfg.Hostname = ""
	}
	// Networks are the other engine's own: a container on one that the
	// user made starts on the default one there instead.
	switch mode := string(host.NetworkMode); {
	case mode == "" || mode == "default" || mode == "bridge" || mode == "host" || mode == "none":
	default:
		notes = append(notes, "network:"+mode)
		host.NetworkMode = ""
	}
	host.Links, host.VolumesFrom = nil, nil
	named := map[string]bool{}
	for _, b := range host.Binds {
		named[strings.SplitN(b, ":", 2)[0]] = true
	}
	for _, m := range host.Mounts {
		named[m.Source] = true
	}
	for _, m := range in.Mounts {
		switch {
		case engine.OwnMount(m.Source, m.Destination):
		case m.Type == "bind":
			notes = append(notes, "bind:"+m.Source)
		case m.Type == "volume" && m.Name != "" && !named[m.Name]:
			// A volume the image asked for, with a name the engine made
			// up: named here, so that the copy uses the copied data.
			host.Binds = append(host.Binds, m.Name+":"+m.Destination)
		}
	}
	created, err := c.cli.ContainerCreate(ctx, cfg, host, nil, nil, strings.TrimPrefix(in.Name, "/"))
	if err != nil {
		return "", notes, err
	}
	return created.ID, notes, nil
}

func (c containers) Sizes(ctx context.Context) (map[string]engine.Size, error) {
	list, err := c.cli.ContainerList(ctx, container.ListOptions{All: true, Size: true})
	if err != nil {
		return nil, err
	}
	out := make(map[string]engine.Size, len(list))
	for _, s := range list {
		out[s.ID] = engine.Size{RW: s.SizeRw, RootFS: s.SizeRootFs}
	}
	return out, nil
}

// session is an attached exec.
type session struct {
	cli  *client.Client
	id   string
	conn net.Conn
	r    io.Reader
}

func (s *session) Read(p []byte) (int, error)  { return s.r.Read(p) }
func (s *session) Write(p []byte) (int, error) { return s.conn.Write(p) }
func (s *session) Close() error                { return s.conn.Close() }
func (s *session) Resize(ctx context.Context, cols, rows uint) error {
	return s.cli.ContainerExecResize(ctx, s.id, container.ResizeOptions{Height: rows, Width: cols})
}

func (c containers) Exec(ctx context.Context, id string, cmd []string, cols, rows uint) (engine.Session, error) {
	size := [2]uint{rows, cols}
	created, err := c.cli.ContainerExecCreate(ctx, id, container.ExecOptions{
		Cmd: cmd, Tty: true, AttachStdin: true, AttachStdout: true, AttachStderr: true,
		ConsoleSize: &size, Env: []string{"TERM=xterm-256color"},
	})
	if err != nil {
		return nil, err
	}
	att, err := c.cli.ContainerExecAttach(ctx, created.ID, container.ExecAttachOptions{Tty: true, ConsoleSize: &size})
	if err != nil {
		return nil, err
	}
	return &session{cli: c.cli, id: created.ID, conn: att.Conn, r: att.Reader}, nil
}

// statsSample is the part of the engine's stats JSON that Stats reads.
type statsSample struct {
	CPUStats, PreCPUStats struct {
		CPUUsage struct {
			TotalUsage uint64 `json:"total_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs  uint64 `json:"online_cpus"`
	}
	MemoryStats struct {
		Usage uint64            `json:"usage"`
		Limit uint64            `json:"limit"`
		Stats map[string]uint64 `json:"stats"`
	} `json:"memory_stats"`
	Networks map[string]struct {
		RxBytes uint64 `json:"rx_bytes"`
		TxBytes uint64 `json:"tx_bytes"`
	} `json:"networks"`
}

func (s *statsSample) UnmarshalJSON(b []byte) error {
	// The two CPU blocks share a shape but not a JSON name.
	type plain statsSample
	aux := struct {
		*plain
		CPU    json.RawMessage `json:"cpu_stats"`
		PreCPU json.RawMessage `json:"precpu_stats"`
	}{plain: (*plain)(s)}
	if err := json.Unmarshal(b, &aux); err != nil {
		return err
	}
	if len(aux.CPU) > 0 {
		if err := json.Unmarshal(aux.CPU, &s.CPUStats); err != nil {
			return err
		}
	}
	if len(aux.PreCPU) > 0 {
		return json.Unmarshal(aux.PreCPU, &s.PreCPUStats)
	}
	return nil
}

// reading turns one of the engine's samples into ours.
func (s *statsSample) reading() engine.Stats {
	out := engine.Stats{MemLimit: int64(s.MemoryStats.Limit)}
	// As the docker CLI computes them: the container's share of the
	// CPU time that passed, times the CPUs; memory without the page
	// cache the kernel can take back.
	cpu := float64(s.CPUStats.CPUUsage.TotalUsage) - float64(s.PreCPUStats.CPUUsage.TotalUsage)
	sys := float64(s.CPUStats.SystemUsage) - float64(s.PreCPUStats.SystemUsage)
	if cpu > 0 && sys > 0 && s.PreCPUStats.SystemUsage > 0 {
		out.CPU = cpu / sys * float64(max(s.CPUStats.OnlineCPUs, 1)) * 100
	}
	cache := s.MemoryStats.Stats["inactive_file"]
	if cache == 0 {
		cache = s.MemoryStats.Stats["total_inactive_file"]
	}
	if cache < s.MemoryStats.Usage {
		out.MemUsed = int64(s.MemoryStats.Usage - cache)
	}
	for _, n := range s.Networks {
		out.NetRx += int64(n.RxBytes)
		out.NetTx += int64(n.TxBytes)
	}
	return out
}

func (c containers) StatsOnce(ctx context.Context, id string) (engine.Stats, error) {
	res, err := c.cli.ContainerStatsOneShot(ctx, id)
	if err != nil {
		return engine.Stats{}, err
	}
	defer res.Body.Close()
	var s statsSample
	if err := json.NewDecoder(res.Body).Decode(&s); err != nil {
		return engine.Stats{}, err
	}
	return s.reading(), nil
}

func (c containers) Stats(ctx context.Context, id string, each func(engine.Stats)) error {
	res, err := c.cli.ContainerStats(ctx, id, true)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	dec := json.NewDecoder(res.Body)
	for {
		var s statsSample
		if err := dec.Decode(&s); err != nil {
			if ctx.Err() != nil || errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		each(s.reading())
	}
}

type images struct{ cli *client.Client }

func (i images) List(ctx context.Context) ([]engine.Image, error) {
	list, err := i.cli.ImageList(ctx, image.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]engine.Image, 0, len(list))
	for _, s := range list {
		tags := make([]string, 0, len(s.RepoTags))
		for _, t := range s.RepoTags {
			if t != "<none>:<none>" {
				tags = append(tags, t)
			}
		}
		out = append(out, engine.Image{ID: s.ID, Tags: tags, Size: s.Size, Created: s.Created})
	}
	return out, nil
}

func (i images) Exists(ctx context.Context, ref string) bool {
	_, err := i.cli.ImageInspect(ctx, ref)
	return err == nil
}

func (i images) Pull(ctx context.Context, ref string, progress func(engine.PullProgress)) error {
	rc, err := i.cli.ImagePull(ctx, ref, image.PullOptions{})
	if err != nil {
		return err
	}
	defer rc.Close()
	// The engine reports each layer on its own; the sum over the layers
	// seen so far is the whole pull's progress.
	type layer struct{ current, total int64 }
	layers := map[string]layer{}
	dec := json.NewDecoder(rc)
	for {
		var m struct {
			ID             string `json:"id"`
			Status         string `json:"status"`
			Error          string `json:"error"`
			ProgressDetail struct {
				Current int64 `json:"current"`
				Total   int64 `json:"total"`
			} `json:"progressDetail"`
		}
		if err := dec.Decode(&m); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if m.Error != "" {
			return errors.New(m.Error)
		}
		switch {
		case m.ID != "" && m.Status == "Downloading" && m.ProgressDetail.Total > 0:
			layers[m.ID] = layer{m.ProgressDetail.Current, m.ProgressDetail.Total}
		case m.ID != "" && (m.Status == "Download complete" || m.Status == "Pull complete" || m.Status == "Already exists"):
			if l, ok := layers[m.ID]; ok {
				layers[m.ID] = layer{l.total, l.total}
			}
		}
		var p engine.PullProgress
		p.Status = m.Status
		for _, l := range layers {
			p.Current += l.current
			p.Total += l.total
		}
		if progress != nil {
			progress(p)
		}
	}
}

func (i images) Remove(ctx context.Context, id string, force bool) error {
	_, err := i.cli.ImageRemove(ctx, id, image.RemoveOptions{Force: force, PruneChildren: true})
	return err
}

func (i images) Tag(ctx context.Context, source, target string) error {
	return i.cli.ImageTag(ctx, source, target)
}

func (i images) Prune(ctx context.Context) (int64, error) {
	rep, err := i.cli.ImagesPrune(ctx, filters.NewArgs(filters.Arg("dangling", "true")))
	if err != nil {
		return 0, fmt.Errorf("prune images: %w", err)
	}
	return int64(rep.SpaceReclaimed), nil
}

func (i images) Defaults(ctx context.Context, ref string) (engine.ImageDefaults, error) {
	d := engine.ImageDefaults{Ports: []engine.PortSpec{}, Volumes: []string{}}
	in, err := i.cli.ImageInspect(ctx, ref)
	if err != nil {
		return d, err
	}
	if in.Config == nil {
		return d, nil
	}
	for port := range in.Config.ExposedPorts {
		// "5432/tcp"
		num, proto, _ := strings.Cut(string(port), "/")
		if n, err := strconv.Atoi(num); err == nil && n > 0 && n < 65536 {
			d.Ports = append(d.Ports, engine.PortSpec{Host: uint16(n), Container: uint16(n), Proto: proto})
		}
	}
	sort.Slice(d.Ports, func(a, b int) bool { return d.Ports[a].Container < d.Ports[b].Container })
	for dir := range in.Config.Volumes {
		d.Volumes = append(d.Volumes, dir)
	}
	sort.Strings(d.Volumes)
	d.Shell = engine.BareShell(in.Config.Entrypoint, in.Config.Cmd)
	return d, nil
}

func (i images) History(ctx context.Context, ref string) ([]engine.Layer, error) {
	steps, err := i.cli.ImageHistory(ctx, ref)
	if err != nil {
		return nil, err
	}
	list := make([]engine.Layer, 0, len(steps))
	for _, s := range steps {
		list = append(list, engine.Layer{Command: cleanStep(s.CreatedBy), Size: s.Size, Created: s.Created})
	}
	return list, nil
}

// cleanStep takes the shell dressing off a build step's command.
func cleanStep(cmd string) string {
	cmd = strings.TrimSpace(cmd)
	cmd = strings.TrimPrefix(cmd, "/bin/sh -c #(nop) ")
	if rest, ok := strings.CutPrefix(cmd, "/bin/sh -c "); ok {
		cmd = "RUN " + rest
	}
	return strings.TrimSpace(strings.TrimSuffix(cmd, "# buildkit"))
}

func (i images) Save(ctx context.Context, ref string) (io.ReadCloser, error) {
	return i.cli.ImageSave(ctx, []string{ref})
}

func (i images) Load(ctx context.Context, r io.Reader) error {
	res, err := i.cli.ImageLoad(ctx, r)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	// The engine answers with progress lines; a failure is one of them.
	dec := json.NewDecoder(res.Body)
	for {
		var m struct {
			Error string `json:"error"`
		}
		if err := dec.Decode(&m); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if m.Error != "" {
			return errors.New(m.Error)
		}
	}
}

type volumes struct{ cli *client.Client }

func (v volumes) List(ctx context.Context) ([]engine.Volume, error) {
	res, err := v.cli.VolumeList(ctx, volume.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]engine.Volume, 0, len(res.Volumes))
	for _, it := range res.Volumes {
		if it == nil {
			continue
		}
		var created int64
		if t, err := time.Parse(time.RFC3339, it.CreatedAt); err == nil {
			created = t.Unix()
		}
		out = append(out, engine.Volume{
			Name: it.Name, Driver: it.Driver, Created: created, Project: it.Labels[engine.LabelComposeProject],
		})
	}
	return out, nil
}

func (v volumes) Create(ctx context.Context, name string) error {
	_, err := v.cli.VolumeCreate(ctx, volume.CreateOptions{Name: name})
	return err
}

func (v volumes) Remove(ctx context.Context, name string) error {
	return v.cli.VolumeRemove(ctx, name, false)
}

func (v volumes) Prune(ctx context.Context) (int64, error) {
	// "all": named volumes too, not only the anonymous ones.
	rep, err := v.cli.VolumesPrune(ctx, filters.NewArgs(filters.Arg("all", "true")))
	if err != nil {
		return 0, err
	}
	return int64(rep.SpaceReclaimed), nil
}

func (v volumes) Sizes(ctx context.Context) (map[string]int64, error) {
	du, err := v.cli.DiskUsage(ctx, types.DiskUsageOptions{Types: []types.DiskUsageObject{types.VolumeObject}})
	if err != nil {
		return nil, err
	}
	out := map[string]int64{}
	for _, it := range du.Volumes {
		if it != nil && it.UsageData != nil && it.UsageData.Size >= 0 {
			out[it.Name] = it.UsageData.Size
		}
	}
	return out, nil
}

type networks struct{ cli *client.Client }

func (n networks) List(ctx context.Context) ([]engine.Network, error) {
	list, err := n.cli.NetworkList(ctx, network.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]engine.Network, 0, len(list))
	for _, it := range list {
		net := engine.Network{
			ID: it.ID, Name: it.Name, Driver: it.Driver, Internal: it.Internal,
			Builtin: engine.BuiltinNetwork(it.Name), Project: it.Labels[engine.LabelComposeProject],
		}
		if !it.Created.IsZero() {
			net.Created = it.Created.Unix()
		}
		if len(it.IPAM.Config) > 0 {
			net.Subnet, net.Gateway = it.IPAM.Config[0].Subnet, it.IPAM.Config[0].Gateway
		}
		out = append(out, net)
	}
	return out, nil
}

func (n networks) Create(ctx context.Context, name, subnet string) error {
	opts := network.CreateOptions{Driver: "bridge"}
	if subnet != "" {
		opts.IPAM = &network.IPAM{Config: []network.IPAMConfig{{Subnet: subnet}}}
	}
	_, err := n.cli.NetworkCreate(ctx, name, opts)
	return err
}

func (n networks) Remove(ctx context.Context, id string) error {
	return n.cli.NetworkRemove(ctx, id)
}

func (n networks) Connect(ctx context.Context, net, ctr string) error {
	return n.cli.NetworkConnect(ctx, net, ctr, nil)
}

func (n networks) Disconnect(ctx context.Context, net, ctr string) error {
	return n.cli.NetworkDisconnect(ctx, net, ctr, false)
}

func (n networks) Prune(ctx context.Context) error {
	_, err := n.cli.NetworksPrune(ctx, filters.Args{})
	return err
}

// Where a helper container sees the volume it was made to look into.
const helperMount = "/boxforge-volume"

// listScript prints, for each name in the directory $1, "kind/size/mtime",
// a newline, the name, and a NUL: names may hold anything but NUL. It runs
// in whatever image is at hand, so it keeps to what busybox and coreutils
// both have.
const listScript = `cd "$1" || exit 2
for f in * .[!.]* ..?*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  stat -c '%F/%s/%Y' -- "$f" || exit 3
  printf '%s\000' "$f"
done`

// inVolume turns a path the UI sent into the helper's path for it, never
// above the volume's top.
func inVolume(p string) string {
	return path.Join(helperMount, path.Clean("/"+p))
}

// helperImage picks the image a helper container is made from: a small
// one with a shell if there is one, else the smallest.
func (v volumes) helperImage(ctx context.Context) (string, error) {
	list, err := v.cli.ImageList(ctx, image.ListOptions{})
	if err != nil {
		return "", err
	}
	best, bestScore := "", int64(-1)
	for _, im := range list {
		for _, tag := range im.RepoTags {
			if tag == "<none>:<none>" {
				continue
			}
			score := im.Size
			if strings.Contains(tag, "busybox") || strings.Contains(tag, "alpine") {
				score = 0
			}
			if bestScore < 0 || score < bestScore {
				best, bestScore = tag, score
			}
		}
	}
	if best == "" {
		return "", errors.New("looking inside a volume needs one image on this engine, any image; pull one (busybox is the smallest) and try again")
	}
	return best, nil
}

// helper creates, without starting it, a container that mounts the volume
// read-only. The caller removes it with the returned function.
func (v volumes) helper(ctx context.Context, name string, entrypoint []string) (string, func(), error) {
	return v.helperMode(ctx, name, entrypoint, ":ro")
}

// helperMode is helper with the volume mounted as mode says: ":ro" to
// look, "" to write.
func (v volumes) helperMode(ctx context.Context, name string, entrypoint []string, mode string) (string, func(), error) {
	img, err := v.helperImage(ctx)
	if err != nil {
		return "", nil, err
	}
	suffix := make([]byte, 6)
	_, _ = rand.Read(suffix)
	created, err := v.cli.ContainerCreate(ctx,
		&container.Config{Image: img, Entrypoint: entrypoint, Cmd: []string{}, NetworkDisabled: true},
		&container.HostConfig{Binds: []string{name + ":" + helperMount + mode}, NetworkMode: "none"},
		nil, nil, engine.HelperPrefix+hex.EncodeToString(suffix))
	if err != nil {
		return "", nil, err
	}
	remove := func() {
		// Its own context: the caller's may be over by now.
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		_ = v.cli.ContainerRemove(ctx, created.ID, container.RemoveOptions{Force: true})
	}
	return created.ID, remove, nil
}

func (v volumes) Files(ctx context.Context, name, p string) ([]engine.FileEntry, error) {
	dir := inVolume(p)
	id, remove, err := v.helper(ctx, name, []string{"/bin/sh", "-c", listScript, "sh", dir})
	if err != nil {
		return nil, err
	}
	defer remove()

	// The quick way: run the listing script. An image with no shell or no
	// stat can't; the engine's own archive of the directory then tells.
	if entries, ok := v.listByScript(ctx, id); ok {
		return entries, nil
	}
	return v.listByArchive(ctx, id, dir)
}

func (v volumes) listByScript(ctx context.Context, id string) ([]engine.FileEntry, bool) {
	if err := v.cli.ContainerStart(ctx, id, container.StartOptions{}); err != nil {
		return nil, false
	}
	statusCh, errCh := v.cli.ContainerWait(ctx, id, container.WaitConditionNotRunning)
	select {
	case st := <-statusCh:
		if st.StatusCode != 0 {
			return nil, false
		}
	case <-errCh:
		return nil, false
	}
	rc, err := v.cli.ContainerLogs(ctx, id, container.LogsOptions{ShowStdout: true})
	if err != nil {
		return nil, false
	}
	defer rc.Close()
	var stdout bytes.Buffer
	if _, err := stdcopy.StdCopy(&stdout, io.Discard, rc); err != nil {
		return nil, false
	}
	return parseListing(stdout.String())
}

// parseListing reads what listScript printed.
func parseListing(text string) ([]engine.FileEntry, bool) {
	entries := []engine.FileEntry{}
	for _, rec := range strings.Split(text, "\x00") {
		rec = strings.TrimPrefix(rec, "\n")
		head, fname, ok := strings.Cut(rec, "\n")
		if !ok {
			continue
		}
		// "regular file/123/1700000000": the kind may hold spaces, never a slash.
		parts := strings.Split(head, "/")
		if len(parts) != 3 {
			return nil, false
		}
		size, _ := strconv.ParseInt(parts[1], 10, 64)
		mtime, _ := strconv.ParseInt(parts[2], 10, 64)
		kind := "other"
		switch {
		case parts[0] == "directory":
			kind = "dir"
		case strings.HasPrefix(parts[0], "regular"):
			kind = "file"
		case parts[0] == "symbolic link":
			kind = "link"
		}
		entries = append(entries, engine.FileEntry{Name: fname, Kind: kind, Size: size, Modified: mtime})
	}
	sortEntries(entries)
	return entries, true
}

func (v volumes) listByArchive(ctx context.Context, id, dir string) ([]engine.FileEntry, error) {
	return listArchive(ctx, v.cli, id, dir)
}

// listArchive lists a directory of a container from the engine's archive
// of it: slower than asking a shell, but needs none in the image and works
// on a container that is not running.
func listArchive(ctx context.Context, cli *client.Client, id, dir string) ([]engine.FileEntry, error) {
	rc, _, err := cli.CopyFromContainer(ctx, id, dir)
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	entries := []engine.FileEntry{}
	tr := tar.NewReader(rc)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		// Names come as "<dir's own name>/child/…": the children are the
		// ones with exactly one more part.
		// The top folder is asked for as "/.", and its children come as
		// "./child": given a name of its own, they read like any other's.
		name := path.Clean(h.Name)
		if strings.HasSuffix(dir, "/.") {
			name = path.Join("top", name)
		}
		parts := strings.Split(strings.Trim(name, "/"), "/")
		if len(parts) != 2 {
			continue
		}
		kind := "other"
		switch h.Typeflag {
		case tar.TypeDir:
			kind = "dir"
		case tar.TypeReg:
			kind = "file"
		case tar.TypeSymlink:
			kind = "link"
		}
		entries = append(entries, engine.FileEntry{Name: parts[1], Kind: kind, Size: h.Size, Modified: h.ModTime.Unix()})
	}
	sortEntries(entries)
	return entries, nil
}

// sortEntries puts directories first, then names in order.
func sortEntries(entries []engine.FileEntry) {
	sort.Slice(entries, func(i, j int) bool {
		if (entries[i].Kind == "dir") != (entries[j].Kind == "dir") {
			return entries[i].Kind == "dir"
		}
		return entries[i].Name < entries[j].Name
	})
}

// removeOnClose runs a cleanup when the stream it wraps is closed.
type removeOnClose struct {
	io.ReadCloser
	remove func()
}

func (r removeOnClose) Close() error {
	err := r.ReadCloser.Close()
	r.remove()
	return err
}

func (v volumes) Archive(ctx context.Context, name, p string) (io.ReadCloser, error) {
	// The helper is made to do nothing for a while, in case it has to run.
	id, remove, err := v.helper(ctx, name, []string{"/bin/sh", "-c", "sleep 900"})
	if err != nil {
		return nil, err
	}
	// Docker mounts a container's volumes to copy out of it even when it
	// has never run. Other engines (Kiri's) show a container's volumes
	// only while it runs: there the first try finds no such file, and the
	// helper is started for a second one.
	rc, _, err := v.cli.CopyFromContainer(ctx, id, inVolume(p))
	if err != nil {
		if v.cli.ContainerStart(ctx, id, container.StartOptions{}) == nil {
			rc, _, err = v.cli.CopyFromContainer(ctx, id, inVolume(p))
		}
	}
	if err != nil {
		remove()
		return nil, err
	}
	return removeOnClose{rc, remove}, nil
}

func (v volumes) Restore(ctx context.Context, name string, tar io.Reader) error {
	if _, err := v.cli.VolumeCreate(ctx, volume.CreateOptions{Name: name}); err != nil {
		return err
	}
	id, remove, err := v.helperMode(ctx, name, []string{"/bin/sh", "-c", "sleep 900"}, "")
	if err != nil {
		return err
	}
	defer remove()
	// Started first: some engines attach a container's volumes only while
	// it runs. Where the image has no shell to run, Docker still attaches
	// them for a copy into a container that never ran.
	_ = v.cli.ContainerStart(ctx, id, container.StartOptions{})
	// The archive's top entry is the helper's mount point itself, so it
	// unpacks from the root into the volume.
	return v.cli.CopyToContainer(ctx, id, "/", tar, container.CopyToContainerOptions{})
}

// fromNerdctl reads a description written by containerd's nerdctl, which
// keeps Docker's shape but fills it its own way: the command is in Path
// and Args, folders of the PC only among the mounts, and the rest holds
// settings of that engine that mean nothing to this one.
func fromNerdctl(inspect []byte, in container.InspectResponse) (*container.Config, *container.HostConfig) {
	var more struct {
		Path       string
		Args       []string
		HostConfig struct{ PortBindings nat.PortMap }
	}
	_ = json.Unmarshal(inspect, &more)
	cfg := &container.Config{Labels: map[string]string{}, ExposedPorts: nat.PortSet{}, Tty: in.Config.Tty, OpenStdin: in.Config.Tty}
	for _, e := range in.Config.Env {
		if !strings.HasPrefix(e, "HOSTNAME=") {
			cfg.Env = append(cfg.Env, e)
		}
	}
	for k, v := range in.Config.Labels {
		if !strings.HasPrefix(k, "nerdctl/") && !strings.HasPrefix(k, "io.containerd.") && !strings.HasPrefix(k, "containerd.io/") {
			cfg.Labels[k] = v
		}
	}
	if more.Path != "" {
		cfg.Entrypoint, cfg.Cmd = []string{more.Path}, more.Args
	}
	host := &container.HostConfig{PortBindings: more.HostConfig.PortBindings, Privileged: in.HostConfig.Privileged}
	for port := range host.PortBindings {
		cfg.ExposedPorts[port] = struct{}{}
	}
	for _, m := range in.Mounts {
		if m.Type == "bind" && !engine.OwnMount(m.Source, m.Destination) {
			bind := m.Source + ":" + m.Destination
			if !m.RW {
				bind += ":ro"
			}
			host.Binds = append(host.Binds, bind)
		}
	}
	return cfg, host
}

// ListScript and ParseListing are how a directory is listed with a shell
// in whatever image is at hand; other adapters list the same way.
const ListScript = listScript

// ParseListing reads what ListScript printed.
func ParseListing(text string) ([]engine.FileEntry, bool) { return parseListing(text) }
