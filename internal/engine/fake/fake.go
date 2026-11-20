// Package fake is an in-memory engine.Runtime for tests and for working on
// the UI on a machine with no container engine.
package fake

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/soulfactorx/boxforge/internal/engine"
)

// Runtime is a pretend engine holding a fixed set of containers.
type Runtime struct {
	mu   sync.Mutex
	list []engine.Container
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
			ID: id, Name: name, Image: image, State: state, Status: status,
			Failed: engine.FailedStatus(state, status), Created: now - 3600,
			Ports: ports, Project: project, Service: service, Labels: labels,
		}
	}
	tcp := func(pub, priv uint16) engine.Port {
		return engine.Port{IP: "0.0.0.0", Public: pub, Private: priv, Proto: "tcp"}
	}
	return &Runtime{
		subs: map[chan engine.Event]struct{}{},
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
		for ch := range c.r.subs {
			select {
			case ch <- ev:
			default:
			}
		}
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
