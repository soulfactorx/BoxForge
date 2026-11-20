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

func (s images) List(ctx context.Context) ([]engine.Image, error) {
	b, err := s.r.out(ctx, "images", "--no-trunc", "--format", "{{json .}}")
	if err != nil {
		return nil, err
	}
	byID := map[string]*engine.Image{}
	var order []string
	for _, im := range lines[struct{ ID, Repository, Tag, Size, CreatedAt string }](b) {
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

func (s images) Remove(ctx context.Context, id string, force bool) error {
	args := []string{"rmi"}
	if force {
		args = append(args, "-f")
	}
	return s.r.do(ctx, "image", append(args, id)...)
}

func (s images) Tag(ctx context.Context, source, target string) error {
	return s.r.do(ctx, "image", "tag", source, target)
}

func (s images) Prune(ctx context.Context) (int64, error) {
	return 0, s.r.do(ctx, "image", "image", "prune", "-f")
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
	return d, nil
}

// stream is a command's output as a reader; closing it ends the command.
type stream struct {
	io.ReadCloser
	cmd    *exec.Cmd
	stderr *bytes.Buffer
	cancel context.CancelFunc
}

func (s stream) Close() error {
	s.cancel()
	_ = s.ReadCloser.Close()
	_ = s.cmd.Wait()
	return nil
}

// reading starts nerdctl and returns what it prints.
func (r *runtime) reading(ctx context.Context, args ...string) (io.ReadCloser, error) {
	ctx, cancel := context.WithCancel(ctx)
	c := r.cmd(ctx, args...)
	stderr := &bytes.Buffer{}
	c.Stderr = stderr
	stdout, err := c.StdoutPipe()
	if err == nil {
		err = c.Start()
	}
	if err != nil {
		cancel()
		return nil, err
	}
	return stream{stdout, c, stderr, cancel}, nil
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

func (s images) Save(ctx context.Context, ref string) (io.ReadCloser, error) {
	return s.r.reading(ctx, "save", ref)
}

func (s images) Load(ctx context.Context, in io.Reader) error {
	err := s.r.writing(ctx, in, "load")
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
