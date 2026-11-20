// Package fake is an in-memory engine.Runtime for tests and for working on
// the UI on a machine with no container engine.
package fake

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/soulfactorx/boxforge/internal/engine"
)

// Runtime is a pretend engine holding a fixed set of containers.
type Runtime struct {
	mu   sync.Mutex
	list []engine.Container
	imgs []engine.Image
	vols []engine.Volume
	nets []engine.Network
	next int
	subs map[chan engine.Event]struct{}
}

// New returns an engine with a few sample containers.
func New() *Runtime {
	now := time.Now().Unix()
	c := func(id, name, image, state, status, project, service string, ports ...engine.Port) engine.Container {
		labels := map[string]string{}
		if project != "" {
			labels[engine.LabelComposeProject] = project
			labels[engine.LabelComposeService] = service
		}
		if ports == nil {
			ports = []engine.Port{}
		}
		return engine.Container{
			ID: id, Name: name, Image: image, ImageID: "sha256:" + image, State: state, Status: status,
			Failed: engine.FailedStatus(state, status), Created: now - 3600,
			Volumes: []string{}, Networks: []engine.Attachment{{Network: "bridge", IP: "172.17.0.2"}},
			Ports: ports, Project: project, Service: service, Labels: labels,
		}
	}
	tcp := func(pub, priv uint16) engine.Port {
		return engine.Port{IP: "0.0.0.0", Public: pub, Private: priv, Proto: "tcp"}
	}
	img := func(tag string, mib int64) engine.Image {
		return engine.Image{ID: "sha256:" + tag, Tags: []string{tag}, Size: mib << 20, Created: now - 86400}
	}
	return &Runtime{
		imgs: []engine.Image{
			img("nginx:1.27", 188), img("postgres:17", 438), img("node:22", 1120),
			img("redis:7", 117), img("alpine:3", 8),
			{ID: "sha256:dangling", Tags: []string{}, Size: 64 << 20, Created: now - 172800},
		},
		subs: map[chan engine.Event]struct{}{},
		vols: []engine.Volume{{Name: "pgdata", Driver: "local", Created: now - 86400}, {Name: "unused", Driver: "local", Created: now - 3600}},
		nets: []engine.Network{
			{ID: "nb", Name: "bridge", Driver: "bridge", Subnet: "172.17.0.0/16", Gateway: "172.17.0.1", Builtin: true},
			{ID: "nh", Name: "host", Driver: "host", Builtin: true},
			{ID: "nn", Name: "none", Driver: "null", Builtin: true},
		},
		list: []engine.Container{
			c("a1", "web", "nginx:1.27", "running", "Up 1 hour", "", "", tcp(8080, 80)),
			c("a2", "shop-db-1", "postgres:17", "running", "Up 1 hour", "shop", "db", tcp(5432, 5432)),
			c("a3", "shop-api-1", "node:22", "running", "Up 1 hour", "shop", "api", tcp(3000, 3000)),
			c("a4", "cache", "redis:7", "paused", "Up 1 hour (Paused)", "", ""),
			c("a5", "old-job", "alpine:3", "exited", "Exited (0) 2 hours ago", "", ""),
			c("a6", "broken", "alpine:3", "exited", "Exited (1) 5 minutes ago", "", ""),
		},
	}
}

func (r *Runtime) Close() error { return nil }

func (r *Runtime) Capabilities() []engine.Capability {
	return []engine.Capability{engine.CapPause, engine.CapRename}
}

func (r *Runtime) Info(context.Context) (engine.Info, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	running := 0
	for _, c := range r.list {
		if c.State == "running" {
			running++
		}
	}
	return engine.Info{
		Runtime: "fake", Name: "fake", Version: "0.0.0", OS: "Fake Linux", Arch: "x86_64",
		CPUs: 4, MemTotal: 8 << 30, Containers: len(r.list), Running: running, Images: 5,
	}, nil
}

func (r *Runtime) Events(ctx context.Context) (<-chan engine.Event, <-chan error) {
	ch := make(chan engine.Event, 16)
	errc := make(chan error, 1)
	r.mu.Lock()
	r.subs[ch] = struct{}{}
	r.mu.Unlock()
	go func() {
		<-ctx.Done()
		r.mu.Lock()
		delete(r.subs, ch)
		r.mu.Unlock()
		close(ch)
		errc <- ctx.Err()
		close(errc)
	}()
	return ch, errc
}

func (r *Runtime) Containers() engine.ContainerService { return containers{r} }
func (r *Runtime) Images() engine.ImageService         { return images{r} }
func (r *Runtime) Volumes() engine.VolumeService       { return volumes{r} }
func (r *Runtime) Networks() engine.NetworkService     { return networks{r} }

// announce tells every subscriber. Callers hold r.mu.
func (r *Runtime) announce(ev engine.Event) {
	for ch := range r.subs {
		select {
		case ch <- ev:
		default:
		}
	}
}

type containers struct{ r *Runtime }

func (c containers) List(context.Context) ([]engine.Container, error) {
	c.r.mu.Lock()
	defer c.r.mu.Unlock()
	return append([]engine.Container{}, c.r.list...), nil
}

// change applies f to the container id names (by ID or name) and announces
// action. Callers hold no lock.
func (c containers) change(id, action string, f func(*engine.Container) error) error {
	c.r.mu.Lock()
	defer c.r.mu.Unlock()
	for i := range c.r.list {
		it := &c.r.list[i]
		if it.ID != id && it.Name != id {
			continue
		}
		if err := f(it); err != nil {
			return err
		}
		it.Failed = engine.FailedStatus(it.State, it.Status)
		ev := engine.Event{Type: "container", Action: action, ID: it.ID}
		if action == "destroy" {
			c.r.list = append(c.r.list[:i], c.r.list[i+1:]...)
		}
		c.r.announce(ev)
		return nil
	}
	return fmt.Errorf("No such container: %s", id)
}

func set(state, status string) func(*engine.Container) error {
	return func(c *engine.Container) error {
		c.State, c.Status = state, status
		return nil
	}
}

func (c containers) Start(_ context.Context, id string) error {
	return c.change(id, "start", set("running", "Up 1 second"))
}
func (c containers) Stop(_ context.Context, id string) error {
	return c.change(id, "die", set("exited", "Exited (0) 1 second ago"))
}
func (c containers) Restart(_ context.Context, id string) error {
	return c.change(id, "restart", set("running", "Up 1 second"))
}
func (c containers) Pause(_ context.Context, id string) error {
	return c.change(id, "pause", func(it *engine.Container) error {
		if it.State != "running" {
			return fmt.Errorf("Container %s is not running", it.Name)
		}
		it.State, it.Status = "paused", "Up 1 second (Paused)"
		return nil
	})
}
func (c containers) Unpause(_ context.Context, id string) error {
	return c.change(id, "unpause", func(it *engine.Container) error {
		if it.State != "paused" {
			return fmt.Errorf("Container %s is not paused", it.Name)
		}
		it.State, it.Status = "running", "Up 1 second"
		return nil
	})
}
func (c containers) Kill(_ context.Context, id string) error {
	return c.change(id, "kill", set("exited", "Exited (137) 1 second ago"))
}
func (c containers) Rename(_ context.Context, id, name string) error {
	if name == "" {
		return errors.New("Neither old nor new names may be empty")
	}
	c.r.mu.Lock()
	for _, it := range c.r.list {
		if it.Name == name && it.ID != id {
			c.r.mu.Unlock()
			return fmt.Errorf("Conflict. The container name %q is already in use", name)
		}
	}
	c.r.mu.Unlock()
	return c.change(id, "rename", func(it *engine.Container) error {
		it.Name = name
		return nil
	})
}
func (c containers) Remove(_ context.Context, id string, force, _ bool) error {
	return c.change(id, "destroy", func(it *engine.Container) error {
		if !force && (it.State == "running" || it.State == "paused") {
			return fmt.Errorf("cannot remove container %q: container is running: stop the container before removing or force remove", it.Name)
		}
		return nil
	})
}

func (c containers) Inspect(_ context.Context, id string) ([]byte, error) {
	c.r.mu.Lock()
	defer c.r.mu.Unlock()
	for _, it := range c.r.list {
		if it.ID == id || it.Name == id {
			return json.Marshal(map[string]any{
				"Id": it.ID, "Name": "/" + it.Name, "Config": map[string]any{"Image": it.Image},
				"State": map[string]any{"Status": it.State},
			})
		}
	}
	return nil, fmt.Errorf("No such container: %s", id)
}

func (c containers) Logs(ctx context.Context, id string, _ int, w io.Writer) error {
	fmt.Fprintf(w, "fake log line 1 for %s\nfake log line 2\n", id)
	<-ctx.Done()
	return nil
}

func (c containers) Run(_ context.Context, spec engine.RunSpec) (string, error) {
	c.r.mu.Lock()
	defer c.r.mu.Unlock()
	name := spec.Name
	c.r.next++
	id := fmt.Sprintf("n%d", c.r.next)
	if name == "" {
		name = "fake_" + id
	}
	for _, it := range c.r.list {
		if it.Name == name {
			return "", fmt.Errorf("Conflict. The container name %q is already in use", name)
		}
	}
	ports := []engine.Port{}
	for _, p := range spec.Ports {
		ports = append(ports, engine.Port{IP: "0.0.0.0", Public: p.Host, Private: p.Container, Proto: "tcp"})
	}
	c.r.list = append(c.r.list, engine.Container{
		ID: id, Name: name, Image: spec.Image, ImageID: "sha256:" + spec.Image, State: "running",
		Status: "Up 1 second", Created: time.Now().Unix(), Ports: ports, Labels: map[string]string{},
		Volumes: []string{}, Networks: []engine.Attachment{{Network: "bridge", IP: "172.17.0.9"}},
	})
	c.r.announce(engine.Event{Type: "container", Action: "start", ID: id})
	return id, nil
}

func (c containers) Sizes(context.Context) (map[string]engine.Size, error) {
	c.r.mu.Lock()
	defer c.r.mu.Unlock()
	out := map[string]engine.Size{}
	for i, it := range c.r.list {
		out[it.ID] = engine.Size{RW: int64(i) << 20, RootFS: int64(100+i*40) << 20}
	}
	return out, nil
}

// echo is a terminal that answers every write with the same bytes.
type echo struct {
	r *io.PipeReader
	w *io.PipeWriter
}

func (e echo) Read(p []byte) (int, error)               { return e.r.Read(p) }
func (e echo) Write(p []byte) (int, error)              { return e.w.Write(p) }
func (e echo) Close() error                             { return e.w.Close() }
func (e echo) Resize(context.Context, uint, uint) error { return nil }

func (c containers) Exec(_ context.Context, id string, _ []string, _, _ uint) (engine.Session, error) {
	r, w := io.Pipe()
	go fmt.Fprintf(w, "fake shell in %s\r\n$ ", id)
	return echo{r, w}, nil
}

func (c containers) Stats(ctx context.Context, _ string, each func(engine.Stats)) error {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	for n := 0; ; n++ {
		each(engine.Stats{CPU: float64(5 + n%7*3), MemUsed: int64(120+n%5*4) << 20, MemLimit: 2 << 30, NetRx: int64(n) << 10, NetTx: int64(n) << 9})
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
		}
	}
}

func (c containers) Commit(context.Context, string, string) error { return nil }

func (c containers) CreateFrom(ctx context.Context, _ []byte, img string) (string, []string, error) {
	id, err := c.Run(ctx, engine.RunSpec{Image: img})
	return id, nil, err
}

func (c containers) StatsOnce(context.Context, string) (engine.Stats, error) {
	return engine.Stats{MemUsed: 128 << 20, MemLimit: 2 << 30}, nil
}

type images struct{ r *Runtime }

func (i images) List(context.Context) ([]engine.Image, error) {
	i.r.mu.Lock()
	defer i.r.mu.Unlock()
	return append([]engine.Image{}, i.r.imgs...), nil
}

func (i images) Exists(_ context.Context, ref string) bool {
	i.r.mu.Lock()
	defer i.r.mu.Unlock()
	for _, im := range i.r.imgs {
		for _, t := range im.Tags {
			if t == ref {
				return true
			}
		}
	}
	return false
}

func (i images) Pull(_ context.Context, ref string, progress func(engine.PullProgress)) error {
	if !strings.Contains(ref, ":") {
		ref += ":latest"
	}
	if strings.HasPrefix(ref, "missing") {
		return fmt.Errorf("pull access denied for %s, repository does not exist", ref)
	}
	if progress != nil {
		progress(engine.PullProgress{Status: "Downloading", Current: 50, Total: 100})
	}
	i.r.mu.Lock()
	defer i.r.mu.Unlock()
	i.r.imgs = append(i.r.imgs, engine.Image{ID: "sha256:" + ref, Tags: []string{ref}, Size: 10 << 20, Created: time.Now().Unix()})
	i.r.announce(engine.Event{Type: "image", Action: "pull", ID: ref})
	return nil
}

func (i images) Remove(_ context.Context, id string, force bool) error {
	i.r.mu.Lock()
	defer i.r.mu.Unlock()
	for n, im := range i.r.imgs {
		if im.ID != id && !contains(im.Tags, id) {
			continue
		}
		if !force {
			for _, c := range i.r.list {
				if c.ImageID == im.ID {
					return fmt.Errorf("conflict: unable to delete %s (must be forced) - container %s is using its referenced image", id, c.ID)
				}
			}
		}
		i.r.imgs = append(i.r.imgs[:n], i.r.imgs[n+1:]...)
		i.r.announce(engine.Event{Type: "image", Action: "delete", ID: im.ID})
		return nil
	}
	return fmt.Errorf("No such image: %s", id)
}

func (i images) Tag(_ context.Context, source, target string) error {
	i.r.mu.Lock()
	defer i.r.mu.Unlock()
	for n := range i.r.imgs {
		if i.r.imgs[n].ID == source || contains(i.r.imgs[n].Tags, source) {
			i.r.imgs[n].Tags = append(i.r.imgs[n].Tags, target)
			i.r.announce(engine.Event{Type: "image", Action: "tag", ID: i.r.imgs[n].ID})
			return nil
		}
	}
	return fmt.Errorf("No such image: %s", source)
}

func (i images) Prune(context.Context) (int64, error) {
	i.r.mu.Lock()
	defer i.r.mu.Unlock()
	var freed int64
	kept := i.r.imgs[:0]
	for _, im := range i.r.imgs {
		if len(im.Tags) == 0 {
			freed += im.Size
			continue
		}
		kept = append(kept, im)
	}
	i.r.imgs = kept
	i.r.announce(engine.Event{Type: "image", Action: "prune"})
	return freed, nil
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func (i images) Save(_ context.Context, ref string) (io.ReadCloser, error) {
	if !i.Exists(context.Background(), ref) {
		return nil, fmt.Errorf("No such image: %s", ref)
	}
	return io.NopCloser(strings.NewReader("fake image " + ref)), nil
}

func (i images) Load(_ context.Context, r io.Reader) error {
	b, err := io.ReadAll(r)
	if err != nil {
		return err
	}
	return i.Pull(context.Background(), strings.TrimPrefix(string(b), "fake image "), nil)
}

type volumes struct{ r *Runtime }

func (v volumes) List(context.Context) ([]engine.Volume, error) {
	v.r.mu.Lock()
	defer v.r.mu.Unlock()
	return append([]engine.Volume{}, v.r.vols...), nil
}

func (v volumes) Create(_ context.Context, name string) error {
	v.r.mu.Lock()
	defer v.r.mu.Unlock()
	for _, it := range v.r.vols {
		if it.Name == name {
			return nil // as Docker: creating a volume that exists succeeds
		}
	}
	v.r.vols = append(v.r.vols, engine.Volume{Name: name, Driver: "local", Created: time.Now().Unix()})
	v.r.announce(engine.Event{Type: "volume", Action: "create", ID: name})
	return nil
}

// used reports whether a container mounts the volume. Callers hold r.mu.
func (v volumes) used(name string) bool {
	for _, c := range v.r.list {
		if contains(c.Volumes, name) {
			return true
		}
	}
	return false
}

func (v volumes) Remove(_ context.Context, name string) error {
	v.r.mu.Lock()
	defer v.r.mu.Unlock()
	for i, it := range v.r.vols {
		if it.Name != name {
			continue
		}
		if v.used(name) {
			return fmt.Errorf("remove %s: volume is in use", name)
		}
		v.r.vols = append(v.r.vols[:i], v.r.vols[i+1:]...)
		v.r.announce(engine.Event{Type: "volume", Action: "destroy", ID: name})
		return nil
	}
	return fmt.Errorf("get %s: no such volume", name)
}

func (v volumes) Prune(context.Context) (int64, error) {
	v.r.mu.Lock()
	defer v.r.mu.Unlock()
	kept := v.r.vols[:0]
	var freed int64
	for _, it := range v.r.vols {
		if v.used(it.Name) {
			kept = append(kept, it)
		} else {
			freed += 1 << 20
		}
	}
	v.r.vols = kept
	v.r.announce(engine.Event{Type: "volume", Action: "prune"})
	return freed, nil
}

func (v volumes) Sizes(context.Context) (map[string]int64, error) {
	v.r.mu.Lock()
	defer v.r.mu.Unlock()
	out := map[string]int64{}
	for i, it := range v.r.vols {
		out[it.Name] = int64(i+1) << 20
	}
	return out, nil
}

type networks struct{ r *Runtime }

func (n networks) List(context.Context) ([]engine.Network, error) {
	n.r.mu.Lock()
	defer n.r.mu.Unlock()
	return append([]engine.Network{}, n.r.nets...), nil
}

func (n networks) Create(_ context.Context, name, subnet string) error {
	n.r.mu.Lock()
	defer n.r.mu.Unlock()
	for _, it := range n.r.nets {
		if it.Name == name {
			return fmt.Errorf("network with name %s already exists", name)
		}
	}
	n.r.next++
	n.r.nets = append(n.r.nets, engine.Network{ID: fmt.Sprintf("net%d", n.r.next), Name: name, Driver: "bridge", Subnet: subnet, Created: time.Now().Unix()})
	n.r.announce(engine.Event{Type: "network", Action: "create", ID: name})
	return nil
}

// find returns the network and container named by ID or name. Callers hold r.mu.
func (n networks) find(net, ctr string) (*engine.Network, *engine.Container) {
	var fn *engine.Network
	var fc *engine.Container
	for i := range n.r.nets {
		if n.r.nets[i].ID == net || n.r.nets[i].Name == net {
			fn = &n.r.nets[i]
		}
	}
	for i := range n.r.list {
		if n.r.list[i].ID == ctr || n.r.list[i].Name == ctr {
			fc = &n.r.list[i]
		}
	}
	return fn, fc
}

func (n networks) Remove(_ context.Context, id string) error {
	n.r.mu.Lock()
	defer n.r.mu.Unlock()
	for i, it := range n.r.nets {
		if it.ID != id && it.Name != id {
			continue
		}
		if it.Builtin {
			return fmt.Errorf("%s is a pre-defined network and cannot be removed", it.Name)
		}
		for _, c := range n.r.list {
			for _, a := range c.Networks {
				if a.Network == it.Name {
					return fmt.Errorf("network %s has active endpoints", it.Name)
				}
			}
		}
		n.r.nets = append(n.r.nets[:i], n.r.nets[i+1:]...)
		n.r.announce(engine.Event{Type: "network", Action: "destroy", ID: it.ID})
		return nil
	}
	return fmt.Errorf("network %s not found", id)
}

func (n networks) Connect(_ context.Context, net, ctr string) error {
	n.r.mu.Lock()
	defer n.r.mu.Unlock()
	fn, fc := n.find(net, ctr)
	if fn == nil || fc == nil {
		return fmt.Errorf("network or container not found")
	}
	fc.Networks = append(fc.Networks, engine.Attachment{Network: fn.Name, IP: "10.0.0.2"})
	n.r.announce(engine.Event{Type: "network", Action: "connect", ID: fn.ID})
	return nil
}

func (n networks) Disconnect(_ context.Context, net, ctr string) error {
	n.r.mu.Lock()
	defer n.r.mu.Unlock()
	fn, fc := n.find(net, ctr)
	if fn == nil || fc == nil {
		return fmt.Errorf("network or container not found")
	}
	kept := []engine.Attachment{}
	for _, a := range fc.Networks {
		if a.Network != fn.Name {
			kept = append(kept, a)
		}
	}
	fc.Networks = kept
	n.r.announce(engine.Event{Type: "network", Action: "disconnect", ID: fn.ID})
	return nil
}

func (n networks) Prune(context.Context) error { return nil }

func (v volumes) Files(_ context.Context, _, p string) ([]engine.FileEntry, error) {
	if p == "/" || p == "" {
		return []engine.FileEntry{
			{Name: "data", Kind: "dir", Modified: time.Now().Unix() - 60},
			{Name: "hello.txt", Kind: "file", Size: 12, Modified: time.Now().Unix() - 60},
		}, nil
	}
	return []engine.FileEntry{}, nil
}

func (v volumes) Archive(_ context.Context, _, p string) (io.ReadCloser, error) {
	var buf bytes.Buffer
	tw := tar.NewWriter(&buf)
	body := []byte("hello, fake\n")
	_ = tw.WriteHeader(&tar.Header{Name: "hello.txt", Mode: 0o644, Size: int64(len(body)), Typeflag: tar.TypeReg})
	_, _ = tw.Write(body)
	_ = tw.Close()
	return io.NopCloser(&buf), nil
}

func (v volumes) Restore(ctx context.Context, name string, r io.Reader) error {
	_, _ = io.Copy(io.Discard, r)
	return v.Create(ctx, name)
}
