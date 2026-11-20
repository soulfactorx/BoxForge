package nerdctl

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/soulfactorx/boxforge/internal/engine"
	"github.com/soulfactorx/boxforge/internal/engine/docker"
)

type containers struct{ r *runtime }

// inspected is the part of `nerdctl inspect` (which keeps to Docker's
// shape) that the list is made from.
type inspected struct {
	Id, Name, Image, Created, Path string
	Args                           []string
	State                          struct {
		Status     string
		ExitCode   int
		FinishedAt string
		StartedAt  string
	}
	Config struct {
		Labels map[string]string
		Env    []string
	}
	HostConfig struct {
		Privileged bool
	}
	Mounts          []struct{ Type, Name, Source, Destination, Mode string }
	NetworkSettings struct {
		Ports    map[string][]struct{ HostIp, HostPort string }
		Networks map[string]struct{ IPAddress string }
	}
}

// ago says how long since, as the docker command does in a status line.
func ago(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%d seconds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%d minutes", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%d hours", int(d.Hours()))
	}
	return fmt.Sprintf("%d days", int(d.Hours()/24))
}

func (s containers) List(ctx context.Context) ([]engine.Container, error) {
	b, err := s.r.out(ctx, "ps", "-aq", "--no-trunc")
	if err != nil {
		return nil, err
	}
	ids := strings.Fields(string(b))
	list := make([]engine.Container, 0, len(ids))
	if len(ids) == 0 {
		return list, nil
	}
	// One that went away between the two commands makes inspect fail as a
	// whole, while still printing the rest: what it printed is used.
	c := s.r.cmd(ctx, append([]string{"inspect"}, ids...)...)
	b, _ = c.Output()
	var in []inspected
	if err := json.Unmarshal(b, &in); err != nil {
		return nil, errors.New("nerdctl's description of the containers could not be read")
	}
	for _, c := range in {
		out := engine.Container{
			ID: c.Id, Name: c.Name, Image: c.Image, ImageID: c.Image, State: c.State.Status,
			ExitCode: c.State.ExitCode, Created: stamp(c.Created), Labels: c.Config.Labels,
			Project: c.Config.Labels[engine.LabelComposeProject], Service: c.Config.Labels[engine.LabelComposeService],
			Ports: []engine.Port{}, Volumes: []string{}, Networks: []engine.Attachment{},
		}
		if out.State == "stopped" {
			out.State = "exited"
		}
		switch out.State {
		case "running", "paused":
			out.Status = "Up"
			if t, err := time.Parse(time.RFC3339Nano, c.State.StartedAt); err == nil {
				out.Status = "Up " + ago(t)
			}
			if out.State == "paused" {
				out.Status += " (Paused)"
			}
		case "exited":
			out.Status = fmt.Sprintf("Exited (%d)", c.State.ExitCode)
			if t, err := time.Parse(time.RFC3339Nano, c.State.FinishedAt); err == nil {
				out.Status += " " + ago(t) + " ago"
			}
		default:
			out.Status = strings.ToUpper(out.State[:min(1, len(out.State))]) + out.State[min(1, len(out.State)):]
		}
		out.Failed = engine.FailedStatus(out.State, out.Status)
		for key, binds := range c.NetworkSettings.Ports {
			num, proto, _ := strings.Cut(key, "/")
			private, _ := strconv.Atoi(num)
			if len(binds) == 0 {
				out.Ports = append(out.Ports, engine.Port{Private: uint16(private), Proto: proto})
			}
			for _, b := range binds {
				public, _ := strconv.Atoi(b.HostPort)
				out.Ports = append(out.Ports, engine.Port{IP: b.HostIp, Private: uint16(private), Public: uint16(public), Proto: proto})
			}
		}
		sort.Slice(out.Ports, func(i, j int) bool { return out.Ports[i].Private < out.Ports[j].Private })
		for _, m := range c.Mounts {
			if m.Type == "volume" && m.Name != "" {
				out.Volumes = append(out.Volumes, m.Name)
			}
		}
		// The networks' names are in a label, in the order of the
		// container's interfaces (eth0, eth1, …), which is how inspect
		// names their addresses.
		var names []string
		_ = json.Unmarshal([]byte(c.Config.Labels["nerdctl/networks"]), &names)
		for i, name := range names {
			at := engine.Attachment{Network: name}
			for key, n := range c.NetworkSettings.Networks {
				if strings.HasSuffix(key, "eth"+strconv.Itoa(i)) {
					at.IP = n.IPAddress
				}
			}
			out.Networks = append(out.Networks, at)
		}
		list = append(list, out)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Created > list[j].Created })
	return list, nil
}

func (s containers) Start(ctx context.Context, id string) error {
	return s.r.do(ctx, "container", "start", id)
}
func (s containers) Stop(ctx context.Context, id string) error {
	return s.r.do(ctx, "container", "stop", id)
}
func (s containers) Restart(ctx context.Context, id string) error {
	return s.r.do(ctx, "container", "restart", id)
}
func (s containers) Pause(ctx context.Context, id string) error {
	return s.r.do(ctx, "container", "pause", id)
}
func (s containers) Unpause(ctx context.Context, id string) error {
	return s.r.do(ctx, "container", "unpause", id)
}
func (s containers) Kill(ctx context.Context, id string) error {
	return s.r.do(ctx, "container", "kill", id)
}
func (s containers) Rename(ctx context.Context, id, name string) error {
	return s.r.do(ctx, "container", "rename", id, name)
}

func (s containers) Remove(ctx context.Context, id string, force, vols bool) error {
	args := []string{"rm"}
	if force {
		args = append(args, "-f")
	}
	if vols {
		args = append(args, "-v")
	}
	return s.r.do(ctx, "container", append(args, id)...)
}

func (s containers) Inspect(ctx context.Context, id string) ([]byte, error) {
	b, err := s.r.out(ctx, "inspect", id)
	if err != nil {
		return nil, err
	}
	var list []map[string]json.RawMessage
	if err := json.Unmarshal(b, &list); err != nil || len(list) == 0 {
		return nil, errors.New("no such container")
	}
	// nerdctl names a container's networks "unknown-eth0", …; their real
	// names are in a label, in the same order.
	var c inspected
	var names []string
	var settings map[string]json.RawMessage
	_ = json.Unmarshal(list[0]["Config"], &c.Config)
	_ = json.Unmarshal([]byte(c.Config.Labels["nerdctl/networks"]), &names)
	if json.Unmarshal(list[0]["NetworkSettings"], &settings) == nil {
		var nets map[string]json.RawMessage
		if json.Unmarshal(settings["Networks"], &nets) == nil {
			named := map[string]json.RawMessage{}
			for key, v := range nets {
				for i, name := range names {
					if strings.HasSuffix(key, "eth"+strconv.Itoa(i)) {
						key = name
					}
				}
				named[key] = v
			}
			settings["Networks"], _ = json.Marshal(named)
			list[0]["NetworkSettings"], _ = json.Marshal(settings)
		}
	}
	return json.MarshalIndent(list[0], "", "    ")
}

func (s containers) Logs(ctx context.Context, id string, tail int, w io.Writer) error {
	c := s.r.cmd(ctx, "logs", "-f", "--tail", strconv.Itoa(tail), id)
	c.Stdout, c.Stderr = w, w
	if err := c.Run(); err != nil && ctx.Err() == nil {
		return err
	}
	return ctx.Err()
}

// runArgs is what `nerdctl run` and `nerdctl create` take for a spec.
func runArgs(spec engine.RunSpec) []string {
	var args []string
	if spec.Name != "" {
		args = append(args, "--name", spec.Name)
	}
	for _, p := range spec.Ports {
		m := fmt.Sprintf("%d:%d", p.Host, p.Container)
		if p.Proto != "" && p.Proto != "tcp" {
			m += "/" + p.Proto
		}
		args = append(args, "-p", m)
	}
	for _, m := range spec.Mounts {
		args = append(args, "-v", m.Source+":"+m.Target)
	}
	for _, e := range spec.Env {
		args = append(args, "-e", e)
	}
	if spec.Restart != "" {
		args = append(args, "--restart", spec.Restart)
	}
	if spec.Privileged {
		args = append(args, "--privileged")
	}
	for _, t := range spec.Tmpfs {
		args = append(args, "--tmpfs", t)
	}
	if spec.Network != "" {
		args = append(args, "--network", spec.Network)
	}
	return append(append(args, spec.Image), spec.Command...)
}

func (s containers) Run(ctx context.Context, spec engine.RunSpec) (string, error) {
	// Never fetched here: the caller has seen to the image, with progress.
	b, err := s.r.out(ctx, append([]string{"run", "-d", "--pull", "never"}, runArgs(spec)...)...)
	s.r.changed("container")
	s.r.changed("volume")
	if err != nil {
		return "", err
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return "", errors.New("nerdctl did not say which container it made")
	}
	return f[len(f)-1], nil
}

func (s containers) Sizes(ctx context.Context) (map[string]engine.Size, error) {
	b, err := s.r.out(ctx, "ps", "-a", "-s", "--no-trunc", "--format", "{{json .}}")
	if err != nil {
		return nil, err
	}
	sizes := map[string]engine.Size{}
	for _, c := range lines[struct{ ID, Size string }](b) {
		// "8.0 KiB (virtual 8.7 MiB)"
		rw, rest, _ := strings.Cut(c.Size, "(virtual")
		sizes[c.ID] = engine.Size{RW: size(rw), RootFS: size(strings.TrimSuffix(strings.TrimSpace(rest), ")"))}
	}
	return sizes, nil
}

// shq writes s as one word of a shell command.
func shq(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// session is a command on a terminal. nerdctl wants a real terminal for
// that, and BoxForge has pipes: `script` (util-linux, busybox) lends one
// on the machine nerdctl runs on.
type session struct {
	io.Reader
	in     io.WriteCloser
	cmd    *exec.Cmd
	cancel context.CancelFunc
}

func (s *session) Write(b []byte) (int, error) { return s.in.Write(b) }
func (s *session) Close() error {
	s.cancel()
	_ = s.in.Close()
	go func() { _ = s.cmd.Wait() }()
	return nil
}

// Resize does nothing: the terminal is `script`'s, on the far side of a
// pipe, and keeps the size it was opened with.
func (s *session) Resize(context.Context, uint, uint) error { return nil }

func (s containers) Exec(_ context.Context, id string, cmd []string, cols, rows uint) (engine.Session, error) {
	line := fmt.Sprintf("stty rows %d cols %d 2>/dev/null; exec nerdctl exec -it %s", rows, cols, shq(id))
	for _, w := range cmd {
		line += " " + shq(w)
	}
	// The session outlives the call that opens it.
	ctx, cancel := context.WithCancel(context.Background())
	name, full := s.r.command()
	// The launcher that leads to nerdctl leads to `script` as well: its
	// last word, "nerdctl", is swapped for the command.
	if len(full) == 0 {
		name, full = "script", nil
	} else {
		full = full[:len(full)-1]
		full = append(full, "script")
	}
	if name == "nerdctl" {
		name = "script"
	}
	c := exec.CommandContext(ctx, name, append(full, "-qfc", line, "/dev/null")...)
	hide(c)
	in, err := c.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	r, w := io.Pipe()
	c.Stdout, c.Stderr = w, w
	if err := c.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("a terminal needs the `script` command beside nerdctl: %w", err)
	}
	go func() { w.CloseWithError(c.Wait()) }()
	return &session{Reader: r, in: in, cmd: c, cancel: cancel}, nil
}

// percent and pair read "0.50%" and "828KiB / 8EiB".
func percent(s string) float64 {
	f, _ := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(s), "%"), 64)
	return f
}

func pair(s string) (int64, int64) {
	a, b, _ := strings.Cut(s, "/")
	return size(a), size(b)
}

func (s containers) StatsOnce(ctx context.Context, id string) (engine.Stats, error) {
	b, err := s.r.out(ctx, "stats", "--no-stream", "--format", "{{json .}}", id)
	if err != nil {
		return engine.Stats{}, err
	}
	for _, st := range lines[struct{ CPUPerc, MemUsage, NetIO string }](b) {
		out := engine.Stats{CPU: percent(st.CPUPerc)}
		out.MemUsed, out.MemLimit = pair(st.MemUsage)
		out.NetRx, out.NetTx = pair(st.NetIO)
		return out, nil
	}
	return engine.Stats{}, errors.New("the container is not running")
}

func (s containers) Stats(ctx context.Context, id string, each func(engine.Stats)) error {
	for {
		st, err := s.StatsOnce(ctx, id)
		if err != nil {
			return err
		}
		each(st)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

func (s containers) Output(ctx context.Context, id string, cmd []string, stdin []byte) (string, string, int, error) {
	args := []string{"exec"}
	if stdin != nil {
		args = append(args, "-i")
	}
	c := s.r.cmd(ctx, append(append(args, id), cmd...)...)
	var stdout, stderr strings.Builder
	c.Stdout, c.Stderr = &stdout, &stderr
	if stdin != nil {
		c.Stdin = strings.NewReader(string(stdin))
	}
	err := c.Run()
	var exit *exec.ExitError
	switch {
	case err == nil:
		return stdout.String(), stderr.String(), 0, nil
	case errors.As(err, &exit):
		// nerdctl itself ends with 1 and says the command's code in words.
		code, said := exit.ExitCode(), stderr.String()
		const words = "exec failed with exit code "
		if at := strings.LastIndex(said, words); at >= 0 {
			if n, err := strconv.Atoi(strings.TrimRight(strings.TrimSpace(said[at+len(words):]), `"`)); err == nil {
				code = n
				said = said[:strings.LastIndex(said[:at], "\n")+1]
			}
		}
		return stdout.String(), said, code, nil
	}
	return "", "", 0, err
}

// duplex is a command's input and output as one stream.
type duplex struct {
	io.Reader
	in     io.WriteCloser
	cancel context.CancelFunc
}

func (d duplex) Write(b []byte) (int, error) { return d.in.Write(b) }
func (d duplex) CloseWrite() error           { return d.in.Close() }
func (d duplex) Close() error {
	d.cancel()
	return d.in.Close()
}

func (s containers) Pipe(ctx context.Context, id string, cmd []string) (io.ReadWriteCloser, error) {
	ctx, cancel := context.WithCancel(ctx)
	c := s.r.cmd(ctx, append([]string{"exec", "-i", id}, cmd...)...)
	in, err := c.StdinPipe()
	var out io.Reader
	if err == nil {
		out, err = c.StdoutPipe()
	}
	if err == nil {
		err = c.Start()
	}
	if err != nil {
		cancel()
		return nil, err
	}
	go func() { _ = c.Wait() }()
	return duplex{out, in, cancel}, nil
}

var errStopped = errors.New("with containerd, files can be looked at only while the container is running (and has a shell)")

func (s containers) Files(ctx context.Context, id, p string) ([]engine.FileEntry, error) {
	stdout, _, code, err := s.Output(ctx, id, []string{"/bin/sh", "-c", docker.ListScript, "sh", path.Clean("/" + p)}, nil)
	if err == nil && code == 0 {
		if entries, ok := docker.ParseListing(stdout); ok {
			return entries, nil
		}
	}
	return nil, errStopped
}

// Archive asks the container's own tar: nerdctl's copy command writes to
// a folder on its machine, not to a stream.
func (s containers) Archive(ctx context.Context, id, p string) (io.ReadCloser, error) {
	p = path.Clean("/" + p)
	dir, base := path.Split(p)
	if p == "/" {
		dir, base = "/", "."
	}
	return s.r.reading(ctx, "exec", id, "tar", "-cf", "-", "-C", dir, base)
}

func (s containers) Prune(ctx context.Context) (int64, error) {
	return 0, s.r.do(ctx, "container", "container", "prune", "-f")
}

func (s containers) Commit(ctx context.Context, id, ref string) error {
	return s.r.do(ctx, "image", "commit", id, ref)
}

// CreateFrom reads a description in Docker's shape (which nerdctl's own
// inspect keeps to) and carries over what `nerdctl create` can take.
func (s containers) CreateFrom(ctx context.Context, raw []byte, img string) (string, []string, error) {
	var in struct {
		Name   string
		Config *struct {
			Env        []string
			Cmd        []string
			Entrypoint []string
		}
		HostConfig *struct {
			Binds         []string
			Privileged    bool
			RestartPolicy struct{ Name string }
			PortBindings  map[string][]struct{ HostPort string }
		}
		Mounts []struct{ Type, Name, Source, Destination string }
	}
	if err := json.Unmarshal(raw, &in); err != nil {
		return "", nil, err
	}
	if in.Config == nil || in.HostConfig == nil {
		return "", nil, errors.New("the container's description is incomplete")
	}
	spec := engine.RunSpec{
		Image: img, Name: strings.TrimPrefix(in.Name, "/"), Env: in.Config.Env, Command: in.Config.Cmd,
		Privileged: in.HostConfig.Privileged, Restart: in.HostConfig.RestartPolicy.Name,
	}
	if spec.Restart == "no" {
		spec.Restart = ""
	}
	for key, binds := range in.HostConfig.PortBindings {
		num, proto, _ := strings.Cut(key, "/")
		private, _ := strconv.Atoi(num)
		for _, b := range binds {
			if public, err := strconv.Atoi(b.HostPort); err == nil && public > 0 {
				spec.Ports = append(spec.Ports, engine.PortSpec{Host: uint16(public), Container: uint16(private), Proto: proto})
			}
		}
	}
	for _, m := range in.Mounts {
		source := m.Source
		if m.Type == "volume" {
			source = m.Name
		}
		if source != "" && m.Destination != "" {
			spec.Mounts = append(spec.Mounts, engine.MountSpec{Source: source, Target: m.Destination})
		}
	}
	notes := []string{"네트워크 연결, 리소스 제한 같은 세부 설정은 옮기지 않았습니다."}
	if len(in.Config.Entrypoint) > 0 {
		notes = append(notes, "이미지의 시작 명령(entrypoint)을 바꾼 설정은 옮기지 않았습니다.")
	}
	b, err := s.r.out(ctx, append([]string{"create", "--pull", "never"}, runArgs(spec)...)...)
	s.r.changed("container")
	if err != nil {
		return "", nil, err
	}
	f := strings.Fields(string(b))
	if len(f) == 0 {
		return "", nil, errors.New("nerdctl did not say which container it made")
	}
	return f[len(f)-1], notes, nil
}
