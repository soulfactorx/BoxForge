package nerdctl

import (
	"archive/tar"
	"bufio"
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
	// A container may name its image by ID (one made from a loaded
	// image): the list says the image's name, and its ID apart.
	nameOf, idOf := map[string]string{}, map[string]string{}
	if ims, err := (images{s.r}).List(ctx); err == nil {
		for _, im := range ims {
			for _, tag := range im.Tags {
				idOf[tag] = im.ID
				idOf["docker.io/"+tag] = im.ID
				idOf["docker.io/library/"+tag] = im.ID
				if nameOf[im.ID] == "" || strings.HasPrefix(nameOf[im.ID], "import") {
					nameOf[im.ID] = tag
				}
			}
		}
	}
	for _, c := range in {
		if name := nameOf[c.Image]; name != "" {
			c.Image = name
		}
		imageID := idOf[c.Image]
		if imageID == "" {
			imageID = c.Image
		}
		c.Image = strings.TrimPrefix(c.Image, "docker.io/")
		if c.State.Status == "" {
			c.State.Status = "created" // made, never started: nerdctl leaves it blank
		}
		out := engine.Container{
			ID: c.Id, Name: c.Name, Image: c.Image, ImageID: imageID, State: c.State.Status,
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

func (s containers) Top(ctx context.Context, id string) (engine.Top, error) {
	b, err := s.r.out(ctx, "top", id, "-eo", "pid,user,pcpu,pmem,etime,args")
	if err != nil {
		if b, err = s.r.out(ctx, "top", id); err != nil {
			return engine.Top{}, err
		}
	}
	return parseTop(string(b)), nil
}

// parseTop reads ps's table: the header's columns, and each line split
// into as many, the last (the command) keeping its spaces.
func parseTop(out string) engine.Top {
	lines := strings.Split(strings.TrimSpace(out), "\n")
	t := engine.Top{Titles: []string{}, Processes: [][]string{}}
	if len(lines) == 0 || strings.TrimSpace(lines[0]) == "" {
		return t
	}
	t.Titles = strings.Fields(lines[0])
	for _, l := range lines[1:] {
		f := strings.Fields(l)
		if len(f) == 0 {
			continue
		}
		if n := len(t.Titles); len(f) > n && n > 0 {
			f = append(f[:n-1], strings.Join(f[n-1:], " "))
		}
		t.Processes = append(t.Processes, f)
	}
	return t
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
	// The files nerdctl itself mounts in every container are not the
	// user's mounts, and are left out.
	var mounts []map[string]json.RawMessage
	if json.Unmarshal(list[0]["Mounts"], &mounts) == nil {
		kept := []map[string]json.RawMessage{}
		for _, m := range mounts {
			var source, target string
			_ = json.Unmarshal(m["Source"], &source)
			_ = json.Unmarshal(m["Destination"], &target)
			if !engine.OwnMount(source, target) {
				kept = append(kept, m)
			}
		}
		list[0]["Mounts"], _ = json.Marshal(kept)
	}
	// Whether it runs on a terminal is only in containerd's own
	// description; it is put where Docker's shape has it.
	if nb, err := s.r.out(ctx, "inspect", "--mode", "native", id); err == nil {
		var native []struct {
			Spec struct {
				Process struct{ Terminal bool } `json:"process"`
			}
		}
		if json.Unmarshal(nb, &native) == nil && len(native) > 0 {
			var cfg map[string]json.RawMessage
			if json.Unmarshal(list[0]["Config"], &cfg) == nil {
				cfg["Tty"], _ = json.Marshal(native[0].Spec.Process.Terminal)
				cfg["OpenStdin"] = cfg["Tty"]
				list[0]["Config"], _ = json.Marshal(cfg)
			}
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
		if p.IP != "" {
			m = p.IP + ":" + m
		}
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
	for k, v := range spec.Labels {
		args = append(args, "--label", k+"="+v)
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
	if spec.Interactive {
		args = append(args, "-t") // nerdctl takes no -i with -d; the terminal is what keeps a shell
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
	r      *runtime
	tty    string // the terminal `script` lent, as its machine names it
}

func (s *session) Write(b []byte) (int, error) { return s.in.Write(b) }
func (s *session) Close() error {
	s.cancel()
	_ = s.in.Close()
	go func() { _ = s.cmd.Wait() }()
	return nil
}

// Resize sets the size of the terminal `script` lent, from outside it;
// the system then tells nerdctl, which tells the container.
func (s *session) Resize(ctx context.Context, cols, rows uint) error {
	if s.tty == "" {
		return nil
	}
	return s.r.beside(ctx, "stty", "-F", s.tty, "rows", strconv.Itoa(int(rows)), "cols", strconv.Itoa(int(cols))).Run()
}

// beside is a command other than nerdctl on the machine nerdctl runs on:
// the launcher that leads to nerdctl leads to it as well.
func (r *runtime) beside(ctx context.Context, tool string, args ...string) *exec.Cmd {
	name, full := r.command()
	if len(full) == 0 {
		name = tool
	} else {
		full = append(full[:len(full)-1:len(full)-1], tool)
	}
	c := exec.CommandContext(ctx, name, append(full, args...)...)
	hide(c)
	return c
}

// ttyMark begins the line in which a session says which terminal it has.
const ttyMark = "BOXFORGE-TTY:"

func (s containers) Exec(_ context.Context, id string, cmd []string, cols, rows uint) (engine.Session, error) {
	line := fmt.Sprintf(`printf '%s%%s\n' "$(tty)"; stty rows %d cols %d 2>/dev/null; exec nerdctl exec -it %s`, ttyMark, rows, cols, shq(id))
	for _, w := range cmd {
		line += " " + shq(w)
	}
	// The session outlives the call that opens it.
	ctx, cancel := context.WithCancel(context.Background())
	c := s.r.beside(ctx, "script", "-qfc", line, "/dev/null")
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
	// Its first line names the terminal; the rest is the session.
	out := bufio.NewReader(r)
	sess := &session{Reader: out, in: in, cmd: c, cancel: cancel, r: s.r}
	for i := 0; i < 5; i++ {
		text, err := out.ReadString('\n')
		if at := strings.Index(text, ttyMark); at >= 0 {
			sess.tty = strings.TrimSpace(text[at+len(ttyMark):])
			break
		}
		if err != nil {
			break
		}
	}
	return sess, nil
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

// exported reads the container's whole file system, which is what
// nerdctl gives of a container that is not running, and calls each with
// the entries under dir (all of them for "/"), names made relative to it.
func (s containers) exported(ctx context.Context, id, dir string, each func(h *tar.Header, rel string, body io.Reader) error) error {
	rc, err := s.r.reading(ctx, "export", id)
	if err != nil {
		return err
	}
	defer rc.Close()
	prefix := strings.Trim(dir, "/")
	tr := tar.NewReader(rc)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		name := strings.Trim(path.Clean("/"+h.Name), "/")
		rel := name
		if prefix != "" {
			if name != prefix && !strings.HasPrefix(name, prefix+"/") {
				continue
			}
			rel = strings.TrimPrefix(strings.TrimPrefix(name, prefix), "/")
		}
		if err := each(h, rel, tr); err != nil {
			return err
		}
	}
}

func (s containers) filesExported(ctx context.Context, id, dir string) ([]engine.FileEntry, error) {
	entries := []engine.FileEntry{}
	found := dir == "/"
	err := s.exported(ctx, id, dir, func(h *tar.Header, rel string, _ io.Reader) error {
		if rel == "" {
			found = true
			return nil
		}
		if strings.Contains(rel, "/") {
			return nil
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
		entries = append(entries, engine.FileEntry{Name: rel, Kind: kind, Size: h.Size, Modified: h.ModTime.Unix()})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if !found && len(entries) == 0 {
		return nil, fmt.Errorf("no such folder: %s", dir)
	}
	sort.Slice(entries, func(i, j int) bool {
		if (entries[i].Kind == "dir") != (entries[j].Kind == "dir") {
			return entries[i].Kind == "dir"
		}
		return entries[i].Name < entries[j].Name
	})
	return entries, nil
}

// running reports whether the container can be asked directly.
func (s containers) running(ctx context.Context, id string) bool {
	b, err := s.r.out(ctx, "inspect", "--format", "{{.State.Status}}", id)
	return err == nil && strings.TrimSpace(string(b)) == "running"
}

func (s containers) Files(ctx context.Context, id, p string) ([]engine.FileEntry, error) {
	stdout, _, code, err := s.Output(ctx, id, []string{"/bin/sh", "-c", docker.ListScript, "sh", path.Clean("/" + p)}, nil)
	if err == nil && code == 0 {
		if entries, ok := docker.ParseListing(stdout); ok {
			return entries, nil
		}
	}
	// Stopped, or with no shell: read from the export of its files.
	return s.filesExported(ctx, id, path.Clean("/"+p))
}

// Archive asks the container's own tar: nerdctl's copy command writes to
// a folder on its machine, not to a stream.
func (s containers) Archive(ctx context.Context, id, p string) (io.ReadCloser, error) {
	p = path.Clean("/" + p)
	dir, base := path.Split(p)
	if p == "/" {
		dir, base = "/", "."
	}
	if s.running(ctx, id) {
		if _, _, code, err := s.Output(ctx, id, []string{"tar", "--version"}, nil); err == nil && code == 0 {
			return s.r.reading(ctx, "exec", id, "tar", "-cf", "-", "-C", dir, base)
		}
	}
	// Not running, or no tar inside: the same archive, cut from the export.
	pr, pw := io.Pipe()
	go func() {
		tw := tar.NewWriter(pw)
		err := s.exported(ctx, id, p, func(h *tar.Header, rel string, body io.Reader) error {
			out := *h
			out.Name = path.Join(base, rel)
			if h.Typeflag == tar.TypeDir {
				out.Name += "/"
			}
			if err := tw.WriteHeader(&out); err != nil {
				return err
			}
			_, err := io.Copy(tw, body)
			return err
		})
		if err == nil {
			err = tw.Close()
		}
		pw.CloseWithError(err)
	}()
	return pr, nil
}

func (s containers) Put(ctx context.Context, id, dir string, tar io.Reader) error {
	err := s.r.writing(ctx, tar, "exec", "-i", id, "tar", "-xf", "-", "-C", path.Clean("/"+dir))
	s.r.changed("container")
	return err
}

func (s containers) Limit(ctx context.Context, id string, memory int64, cpus float64) error {
	args := []string{"update"}
	if memory > 0 {
		args = append(args, "--memory", strconv.FormatInt(memory, 10))
	}
	if cpus > 0 {
		args = append(args, "--cpus", strconv.FormatFloat(cpus, 'f', -1, 64))
	}
	if len(args) == 1 {
		return errors.New("containerd (nerdctl) can set limits but not take them away: remake the container without them")
	}
	return s.r.do(ctx, "container", append(args, id)...)
}

// Prune: nerdctl does not say how much it freed, so what the stopped
// containers held is measured first.
func (s containers) Prune(ctx context.Context) (int64, error) {
	var freed int64
	if list, err := s.List(ctx); err == nil {
		if sizes, err := s.Sizes(ctx); err == nil {
			for _, c := range list {
				if c.State != "running" && c.State != "paused" {
					freed += sizes[c.ID].RW
				}
			}
		}
	}
	return freed, s.r.do(ctx, "container", "container", "prune", "-f")
}

func (s containers) Commit(ctx context.Context, id, ref string) error {
	return s.r.do(ctx, "image", "commit", id, ref)
}

// CreateFrom reads a description in Docker's shape (which nerdctl's own
// inspect keeps to) and carries over what `nerdctl create` can take.
func (s containers) CreateFrom(ctx context.Context, raw []byte, img string) (string, []string, error) {
	var in struct {
		Name   string
		Path   string
		Args   []string
		Config *struct {
			Env        []string
			Cmd        []string
			Entrypoint []string
			Tty        bool
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
		if source != "" && m.Destination != "" && !engine.OwnMount(m.Source, m.Destination) {
			spec.Mounts = append(spec.Mounts, engine.MountSpec{Source: source, Target: m.Destination})
		}
	}
	notes := []string{"네트워크 연결, 리소스 제한 같은 세부 설정은 옮기지 않았습니다."}
	if len(in.Config.Entrypoint) > 0 {
		notes = append(notes, "이미지의 시작 명령(entrypoint)을 바꾼 설정은 옮기지 않았습니다.")
	}
	// On a terminal as it was; and a bare shell that had none (it would
	// end at once, as it did where it came from) is given one.
	spec.Interactive = in.Config.Tty || (len(in.Args) == 0 && engine.BareShell(nil, []string{in.Path}))
	args := []string{"create", "--pull", "never"}
	if len(in.Config.Cmd) == 0 && len(in.Config.Entrypoint) == 0 && in.Path != "" {
		// nerdctl's own description: the whole command is in Path and Args.
		args = append(args, "--entrypoint", in.Path)
		spec.Command = in.Args
	}
	b, err := s.r.out(ctx, append(args, runArgs(spec)...)...)
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
