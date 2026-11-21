// Package nerdctl is the adapter for containerd on its own, with no Docker
// Engine in front of it.
//
// containerd has no API of Docker's kind; what gives it containers with
// names, ports, volumes and networks is nerdctl, its command-line tool,
// which keeps to the docker command's words and output. So this adapter
// runs nerdctl for everything, wherever containerd is: on this machine or
// inside a WSL distribution.
package nerdctl

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os/exec"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/soulfactorx/boxforge/internal/clirunner"
	"github.com/soulfactorx/boxforge/internal/engine"
)

// Command turns nerdctl's arguments into the program to run: nerdctl
// itself, or the launcher that runs it somewhere else.
type Command func(args ...string) (name string, full []string)

// Local runs the nerdctl on this machine.
func Local(args ...string) (string, []string) { return "nerdctl", args }

type runtime struct {
	command Command
	mu      sync.Mutex
	subs    map[chan engine.Event]struct{}
}

// Connect checks that nerdctl answers and returns the engine.
func Connect(command Command) (engine.Runtime, error) {
	r := &runtime{command: command, subs: map[chan engine.Event]struct{}{}}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	if _, err := r.Info(ctx); err != nil {
		return nil, err
	}
	return r, nil
}

// Is reports whether the engine is containerd reached through nerdctl.
func Is(rt engine.Runtime) bool {
	_, ok := rt.(*runtime)
	return ok
}

func (r *runtime) cmd(ctx context.Context, args ...string) *exec.Cmd {
	name, full := r.command(args...)
	c := exec.CommandContext(ctx, name, full...)
	clirunner.HideWindow(c)
	return c
}

// fault makes an error of what nerdctl wrote: its last line that says
// something, without the logger's dressing.
func fault(stderr []byte, err error) error {
	lines := strings.Split(strings.TrimSpace(string(stderr)), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		line := strings.TrimSpace(lines[i])
		if line == "" {
			continue
		}
		if at := strings.Index(line, `msg="`); at >= 0 {
			line = strings.TrimSuffix(line[at+5:], `"`)
			line = strings.ReplaceAll(line, `\"`, `"`)
		}
		return errors.New(line)
	}
	return err
}

// out runs nerdctl and returns what it printed.
func (r *runtime) out(ctx context.Context, args ...string) ([]byte, error) {
	c := r.cmd(ctx, args...)
	var stderr bytes.Buffer
	c.Stderr = &stderr
	b, err := c.Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fault(stderr.Bytes(), err)
	}
	return b, nil
}

// do runs nerdctl for its effect and tells the listeners that things of
// this kind changed: containerd's own events don't cover nerdctl's
// volumes and networks, and come late for the rest.
func (r *runtime) do(ctx context.Context, kind string, args ...string) error {
	_, err := r.out(ctx, args...)
	r.changed(kind)
	return err
}

func (r *runtime) changed(kind string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for ch := range r.subs {
		select {
		case ch <- engine.Event{Type: kind, Action: "change"}:
		default:
		}
	}
}

// lines decodes one JSON object per line, skipping what is not one.
func lines[T any](b []byte) []T {
	var list []T
	for _, line := range bytes.Split(b, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 || line[0] != '{' {
			continue
		}
		var v T
		if json.Unmarshal(line, &v) == nil {
			list = append(list, v)
		}
	}
	return list
}

func (r *runtime) Info(ctx context.Context) (engine.Info, error) {
	b, err := r.out(ctx, "info", "--format", "{{json .}}")
	if err != nil {
		return engine.Info{}, err
	}
	var in struct {
		Name              string
		ServerVersion     string
		OperatingSystem   string
		Architecture      string
		NCPU              int
		MemTotal          int64
		Containers        int
		ContainersRunning int
		Images            int
	}
	for _, v := range lines[json.RawMessage](b) {
		_ = json.Unmarshal(v, &in)
	}
	if in.ServerVersion == "" {
		return engine.Info{}, errors.New("containerd did not answer nerdctl")
	}
	// nerdctl's info leaves the counts at zero: they are counted here.
	count := func(args ...string) int {
		b, _ := r.out(ctx, args...)
		return len(strings.Fields(string(b)))
	}
	in.Containers, in.ContainersRunning, in.Images = count("ps", "-aq"), count("ps", "-q"), count("images", "-q")
	return engine.Info{
		Runtime: "containerd", Name: in.Name, Version: strings.TrimPrefix(in.ServerVersion, "v"),
		OS: in.OperatingSystem, Arch: in.Architecture, CPUs: in.NCPU, MemTotal: in.MemTotal,
		Containers: in.Containers, Running: in.ContainersRunning, Images: in.Images,
	}, nil
}

func (r *runtime) Capabilities() []engine.Capability {
	return []engine.Capability{engine.CapPause, engine.CapRename}
}

// Events joins containerd's events (things done by other tools) with the
// adapter's own notices of what it did.
func (r *runtime) Events(ctx context.Context) (<-chan engine.Event, <-chan error) {
	events := make(chan engine.Event, 64)
	errs := make(chan error, 1)
	own := make(chan engine.Event, 64)
	r.mu.Lock()
	r.subs[own] = struct{}{}
	r.mu.Unlock()

	c := r.cmd(ctx, "events", "--format", "{{json .}}")
	stdout, err := c.StdoutPipe()
	if err == nil {
		err = c.Start()
	}
	if err != nil {
		errs <- err
		close(events)
		close(errs)
		return events, errs
	}
	ended := make(chan error, 1)
	seen := make(chan engine.Event, 64)
	go func() {
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 64<<10), 4<<20)
		for sc.Scan() {
			var e struct{ Topic string }
			if json.Unmarshal(sc.Bytes(), &e) != nil {
				continue
			}
			kind := ""
			switch {
			case strings.HasPrefix(e.Topic, "/tasks/"), strings.HasPrefix(e.Topic, "/containers/"):
				kind = "container"
			case strings.HasPrefix(e.Topic, "/images/"):
				kind = "image"
			}
			if kind != "" {
				select {
				case seen <- engine.Event{Type: kind, Action: strings.TrimPrefix(e.Topic, "/")}:
				default:
				}
			}
		}
		err := c.Wait()
		if err == nil {
			err = io.EOF
		}
		ended <- err
	}()
	go func() {
		defer func() {
			r.mu.Lock()
			delete(r.subs, own)
			r.mu.Unlock()
			close(events)
			close(errs)
		}()
		for {
			select {
			case e := <-seen:
				events <- e
			case e := <-own:
				events <- e
			case err := <-ended:
				if ctx.Err() != nil {
					err = ctx.Err()
				}
				errs <- err
				return
			}
		}
	}()
	return events, errs
}

func (r *runtime) Containers() engine.ContainerService { return containers{r} }
func (r *runtime) Images() engine.ImageService         { return images{r} }
func (r *runtime) Volumes() engine.VolumeService       { return volumes{r} }
func (r *runtime) Networks() engine.NetworkService     { return networks{r} }
func (r *runtime) Close() error                        { return nil }

// Usage: nerdctl has no `system df`. What it does tell is added up.
func (r *runtime) Usage(ctx context.Context) (engine.Usage, error) {
	var u engine.Usage
	ims, err := images{r}.List(ctx)
	if err != nil {
		return u, err
	}
	cs, err := containers{r}.List(ctx)
	if err != nil {
		return u, err
	}
	used := map[string]bool{}
	for _, c := range cs {
		used[c.Image] = true
		if c.State == "exited" || c.State == "created" {
			u.StoppedCount++
		}
	}
	for _, im := range ims {
		u.Images += im.Size
		inUse := false
		for _, t := range im.Tags {
			inUse = inUse || used[t]
		}
		if len(im.Tags) == 0 && !inUse {
			u.ImagesFree += im.Size
			u.UnusedImages++
		}
	}
	if sizes, err := (containers{r}).Sizes(ctx); err == nil {
		for _, c := range cs {
			u.Containers += sizes[c.ID].RW
			if c.State != "running" {
				u.ContainersFree += sizes[c.ID].RW
			}
		}
	}
	vols, _ := volumes{r}.List(ctx)
	mounted := map[string]bool{}
	for _, c := range cs {
		for _, v := range c.Volumes {
			mounted[v] = true
		}
	}
	sizes, _ := volumes{r}.Sizes(ctx)
	for _, v := range vols {
		u.Volumes += sizes[v.Name]
		if !mounted[v.Name] {
			u.VolumesFree += sizes[v.Name]
			u.UnusedVolumes++
		}
	}
	return u, nil
}

// size reads "9.089MB", "8.0 KiB", "828KiB" as bytes.
func size(s string) int64 {
	s = strings.TrimSpace(s)
	at := strings.IndexFunc(s, func(c rune) bool { return (c < '0' || c > '9') && c != '.' })
	if at <= 0 {
		n, _ := strconv.ParseFloat(s, 64)
		return int64(n)
	}
	n, _ := strconv.ParseFloat(s[:at], 64)
	unit := strings.ToLower(strings.TrimSpace(s[at:]))
	mult := map[string]float64{
		"b": 1, "kb": 1e3, "mb": 1e6, "gb": 1e9, "tb": 1e12,
		"kib": 1 << 10, "mib": 1 << 20, "gib": 1 << 30, "tib": 1 << 40, "eib": 1 << 60,
	}[unit]
	if mult == 0 {
		mult = 1
	}
	if v := n * mult; v < 1<<62 {
		return int64(v)
	}
	return 0 // "8EiB": the kernel's way of saying no limit
}

// stamp reads the time forms nerdctl prints.
func stamp(s string) int64 {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05 -0700 MST", "2006-01-02 15:04:05.999999999 -0700 MST"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.Unix()
		}
	}
	return 0
}

// ---- images

type images struct{ r *runtime }

// row is one line of `nerdctl images`: one name of an image.
type row struct{ ID, Repository, Tag, Name, Size, CreatedAt string }

// unnamed reports whether the name is one containerd made up for an
// image that came without: "import-…@sha256:…", "overlayfs@sha256:…".
// The list shows such a name cut short, and nerdctl does not know the
// image by what it shows.
func (r row) unnamed() bool { return strings.Contains(r.Name, "@sha256:") }

// shown is the name as the list gives it to the UI.
func (r row) shown() string {
	if r.Tag == "" || r.Tag == "<none>" {
		return r.Repository
	}
	return r.Repository + ":" + r.Tag
}

func (s images) rows(ctx context.Context) []row {
	b, _ := s.r.out(ctx, "images", "--no-trunc", "--format", "{{json .}}")
	return lines[row](b)
}

func (s images) List(ctx context.Context) ([]engine.Image, error) {
	b, err := s.r.out(ctx, "images", "--no-trunc", "--format", "{{json .}}")
	if err != nil {
		return nil, err
	}
	byID := map[string]*engine.Image{}
	var order []string
	for _, im := range lines[row](b) {
		if im.unnamed() {
			im.Repository = ""
		}
		have := byID[im.ID]
		if have == nil {
			have = &engine.Image{ID: im.ID, Size: size(im.Size), Created: stamp(im.CreatedAt), Tags: []string{}}
			byID[im.ID] = have
			order = append(order, im.ID)
		}
		if im.Repository != "" && im.Repository != "<none>" {
			tag := im.Repository
			if im.Tag != "" && im.Tag != "<none>" {
				tag += ":" + im.Tag
			}
			have.Tags = append(have.Tags, tag)
		}
	}
	list := make([]engine.Image, 0, len(order))
	for _, id := range order {
		list = append(list, *byID[id])
	}
	return list, nil
}

func (s images) Exists(ctx context.Context, ref string) bool {
	_, err := s.r.out(ctx, "image", "inspect", "--format", "{{.Id}}", ref)
	return err == nil
}

func (s images) Pull(ctx context.Context, ref string, progress func(engine.PullProgress)) error {
	c := s.r.cmd(ctx, "pull", ref)
	var stderr bytes.Buffer
	c.Stderr = &stderr
	stdout, err := c.StdoutPipe()
	if err != nil {
		return err
	}
	if err := c.Start(); err != nil {
		return err
	}
	// nerdctl reports in lines of text with no totals to add up.
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		if line := strings.TrimSpace(sc.Text()); line != "" && progress != nil {
			if len(line) > 80 {
				line = line[:80]
			}
			progress(engine.PullProgress{Status: line})
		}
	}
	err = c.Wait()
	s.r.changed("image")
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fault(stderr.Bytes(), err)
	}
	return nil
}

// Remove takes an image by ID or by one of its names. nerdctl wants the
// exact name: an ID that has several names is refused, and so is a
// made-up name as the list shows it. So the names are looked up here.
func (s images) Remove(ctx context.Context, id string, force bool) error {
	args := []string{"rmi"}
	if force {
		args = append(args, "-f")
	}
	var names []string
	for _, r := range s.rows(ctx) {
		switch {
		case r.ID == id || strings.TrimPrefix(r.ID, "sha256:") == id:
			names = append(names, r.Name) // by ID: every name it has
		case r.unnamed() && (r.shown() == id || r.Repository == id):
			names = append(names, r.Name)
		}
	}
	if len(names) == 0 {
		names = []string{id}
	}
	return s.r.do(ctx, "image", append(args, names...)...)
}

func (s images) Tag(ctx context.Context, source, target string) error {
	return s.r.do(ctx, "image", "tag", source, target)
}

// total adds up what the images take.
func (s images) total(ctx context.Context) int64 {
	var n int64
	list, _ := s.List(ctx)
	for _, im := range list {
		n += im.Size
	}
	return n
}

// Prune: nerdctl does not say how much it freed; the difference does.
func (s images) Prune(ctx context.Context) (int64, error) {
	before := s.total(ctx)
	err := s.r.do(ctx, "image", "image", "prune", "-f")
	return max(before-s.total(ctx), 0), err
}

func (s images) Defaults(ctx context.Context, ref string) (engine.ImageDefaults, error) {
	d := engine.ImageDefaults{Ports: []engine.PortSpec{}, Volumes: []string{}}
	b, err := s.r.out(ctx, "image", "inspect", ref)
	if err != nil {
		return d, err
	}
	var in []struct {
		Config struct {
			ExposedPorts map[string]struct{}
			Volumes      map[string]struct{}
			Entrypoint   []string
			Cmd          []string
		}
	}
	if err := json.Unmarshal(b, &in); err != nil || len(in) == 0 {
		return d, err
	}
	for p := range in[0].Config.ExposedPorts {
		num, proto, _ := strings.Cut(p, "/")
		if n, err := strconv.Atoi(num); err == nil && n > 0 && n < 65536 {
			d.Ports = append(d.Ports, engine.PortSpec{Host: uint16(n), Container: uint16(n), Proto: proto})
		}
	}
	sort.Slice(d.Ports, func(i, j int) bool { return d.Ports[i].Container < d.Ports[j].Container })
	for v := range in[0].Config.Volumes {
		d.Volumes = append(d.Volumes, v)
	}
	sort.Strings(d.Volumes)
	d.Shell = engine.BareShell(in[0].Config.Entrypoint, in[0].Config.Cmd)
	return d, nil
}

// stream is a command's output as a reader; closing it ends the command.
type stream struct {
	out    io.ReadCloser
	cmd    *exec.Cmd
	stderr *bytes.Buffer
	cancel context.CancelFunc
	ended  chan struct{} // closed when the command has exited
	whole  bool          // the output was read to its end
}

func (s *stream) Read(p []byte) (int, error) {
	n, err := s.out.Read(p)
	if err == io.EOF {
		s.whole = true
		// The output ended: the command is finishing. An error it ended
		// with is the read's error, not a quiet short stream.
		<-s.ended
		if s.cmd.ProcessState != nil && !s.cmd.ProcessState.Success() {
			return n, fault(s.stderr.Bytes(), errors.New("the command failed"))
		}
	}
	return n, err
}

// Close ends the command. One that was read to its end is left to finish
// by itself: killed a moment early, a `run --rm` would leave its
// container behind.
func (s *stream) Close() error {
	if s.whole {
		select {
		case <-s.ended:
		case <-time.After(20 * time.Second):
		}
	}
	s.cancel()
	_ = s.out.Close()
	<-s.ended
	return nil
}

// reading starts nerdctl and returns what it prints.
func (r *runtime) reading(ctx context.Context, args ...string) (io.ReadCloser, error) {
	ctx, cancel := context.WithCancel(ctx)
	c := r.cmd(ctx, args...)
	stderr := &bytes.Buffer{}
	c.Stderr = stderr
	// A pipe of our own: the command's exit can then be waited for while
	// the output is still being read.
	pr, pw := io.Pipe()
	c.Stdout = pw
	if err := c.Start(); err != nil {
		cancel()
		return nil, err
	}
	st := &stream{out: pr, cmd: c, stderr: stderr, cancel: cancel, ended: make(chan struct{})}
	go func() {
		_ = c.Wait()
		close(st.ended)
		pw.Close()
	}()
	return st, nil
}

// writing runs nerdctl with in as its input.
func (r *runtime) writing(ctx context.Context, in io.Reader, args ...string) error {
	c := r.cmd(ctx, args...)
	var stderr bytes.Buffer
	c.Stdin, c.Stderr = in, &stderr
	if err := c.Run(); err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fault(stderr.Bytes(), err)
	}
	return nil
}

func (s images) History(ctx context.Context, ref string) ([]engine.Layer, error) {
	b, err := s.r.out(ctx, "history", "--no-trunc", "--format", "{{json .}}", ref)
	if err != nil {
		return nil, err
	}
	list := []engine.Layer{}
	for _, h := range lines[struct{ CreatedBy, Size, CreatedAt string }](b) {
		cmd := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(h.CreatedBy), "# buildkit"))
		cmd = strings.TrimPrefix(cmd, "/bin/sh -c #(nop) ")
		list = append(list, engine.Layer{Command: cmd, Size: size(h.Size), Created: stamp(h.CreatedAt)})
	}
	return list, nil
}

func (s images) Save(ctx context.Context, ref string) (io.ReadCloser, error) {
	return s.r.reading(ctx, "save", ref)
}

// Load takes in an archive. One from Docker can hold the same image
// twice, once with its name and once without; the nameless one arrives
// under a made-up name. When the load brought a named image too, that
// extra is taken away again.
func (s images) Load(ctx context.Context, in io.Reader) error {
	had := map[string]bool{}
	for _, r := range s.rows(ctx) {
		had[r.Name] = true
	}
	err := s.r.writing(ctx, in, "load")
	if err == nil {
		named := false
		var extra []string
		for _, r := range s.rows(ctx) {
			switch {
			case had[r.Name]:
			case r.unnamed():
				extra = append(extra, r.Name)
			default:
				named = true
			}
		}
		if named {
			for _, name := range extra {
				_, _ = s.r.out(ctx, "rmi", name)
			}
		}
	}
	s.r.changed("image")
	return err
}

// ---- networks

type networks struct{ r *runtime }

func (s networks) List(ctx context.Context) ([]engine.Network, error) {
	b, err := s.r.out(ctx, "network", "ls", "--format", "{{json .}}")
	if err != nil {
		return nil, err
	}
	var names []string
	for _, n := range lines[struct{ Name string }](b) {
		names = append(names, n.Name)
	}
	list := make([]engine.Network, 0, len(names))
	if len(names) == 0 {
		return list, nil
	}
	b, err = s.r.out(ctx, append([]string{"network", "inspect"}, names...)...)
	if err != nil {
		return nil, err
	}
	var in []struct {
		Name, Id string
		IPAM     struct {
			Config []struct{ Subnet, Gateway string }
		}
		Labels map[string]string
	}
	if err := json.Unmarshal(b, &in); err != nil {
		return nil, err
	}
	for _, n := range in {
		net := engine.Network{
			ID: n.Id, Name: n.Name, Driver: "bridge", Project: n.Labels[engine.LabelComposeProject],
			Builtin: engine.BuiltinNetwork(n.Name),
		}
		if net.ID == "" {
			net.ID, net.Driver = n.Name, n.Name // host, none
		}
		if len(n.IPAM.Config) > 0 {
			net.Subnet, net.Gateway = n.IPAM.Config[0].Subnet, n.IPAM.Config[0].Gateway
		}
		list = append(list, net)
	}
	return list, nil
}

func (s networks) Create(ctx context.Context, name, subnet string) error {
	args := []string{"network", "create"}
	if subnet != "" {
		args = append(args, "--subnet", subnet)
	}
	return s.r.do(ctx, "network", append(args, name)...)
}

func (s networks) Remove(ctx context.Context, id string) error {
	return s.r.do(ctx, "network", "network", "rm", id)
}

var errNoConnect = errors.New("containerd (nerdctl) cannot change the networks of a container that exists: choose the network when the container is made")

func (s networks) Connect(context.Context, string, string) error    { return errNoConnect }
func (s networks) Disconnect(context.Context, string, string) error { return errNoConnect }

func (s networks) Prune(ctx context.Context) error {
	return s.r.do(ctx, "network", "network", "prune", "-f")
}
