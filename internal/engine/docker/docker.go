// Package docker adapts the Docker Engine API to engine.Runtime.
package docker

import (
	"context"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/events"
	"github.com/docker/docker/client"

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
		out = append(out, engine.Container{
			ID:      s.ID,
			Name:    name,
			Image:   s.Image,
			State:   state,
			Status:  s.Status,
			Failed:  engine.FailedStatus(state, s.Status),
			Created: s.Created,
			Ports:   ports,
			Project: s.Labels[engine.LabelComposeProject],
			Service: s.Labels[engine.LabelComposeService],
			Labels:  s.Labels,
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
