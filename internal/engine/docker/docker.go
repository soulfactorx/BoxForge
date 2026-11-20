// Package docker adapts the Docker Engine API to engine.Runtime.
package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
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
// "tcp://…"). An empty host means DOCKER_HOST, else the platform default.
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

func (r *Runtime) Close() error { return r.cli.Close() }

func (r *Runtime) Capabilities() []engine.Capability {
	return []engine.Capability{engine.CapPause, engine.CapRename}
}

func (r *Runtime) Info(ctx context.Context) (engine.Info, error) {
	i, err := r.cli.Info(ctx)
	if err != nil {
		return engine.Info{}, err
	}
	return engine.Info{
		Runtime:    "docker",
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

func (r *Runtime) Containers() engine.ContainerService { return containers{r.cli} }
func (r *Runtime) Images() engine.ImageService         { return images{r.cli} }

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
	created, err := c.cli.ContainerCreate(ctx,
		&container.Config{Image: spec.Image, Env: spec.Env, Cmd: spec.Command, ExposedPorts: exposed},
		&container.HostConfig{
			PortBindings:  bindings,
			Binds:         binds,
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
		each(out)
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
