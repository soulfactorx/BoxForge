// Package app is what the UI can call. Every exported method of App is a
// binding: Wails exposes it to the page as window.go.app.App.<Method>, and
// the dev server as POST /api/call/<Method>. Keep it thin; the work belongs
// in the packages it calls.
package app

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/soulfactorx/boxforge/internal/engine"
	"github.com/soulfactorx/boxforge/internal/engine/docker"
	"github.com/soulfactorx/boxforge/internal/engine/fake"
	"github.com/soulfactorx/boxforge/internal/hub"
)

// How long one action (stop waits for the container's own shutdown) may take.
const actionTimeout = 60 * time.Second

// App is the bound object.
type App struct {
	rt     engine.Runtime
	hub    *hub.Hub
	cancel context.CancelFunc
}

// New picks the engine: BOXFORGE_ENGINE=fake for the in-memory one, else
// Docker at DOCKER_HOST or the platform's default socket.
func New() (*App, error) {
	if os.Getenv("BOXFORGE_ENGINE") == "fake" {
		return &App{rt: fake.New()}, nil
	}
	rt, err := docker.Connect("")
	if err != nil {
		return nil, err
	}
	return &App{rt: rt}, nil
}

// Start begins mirroring the engine, sending changes through emit. It is a
// function, not a method, so that it is not bound.
func Start(a *App, emit hub.Emit) {
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	a.hub = hub.New(a.rt, emit)
	go a.hub.Run(ctx)
}

// Stop ends the mirroring and closes the engine connection.
func Stop(a *App) {
	if a.cancel != nil {
		a.cancel()
	}
	_ = a.rt.Close()
}

// Engine returns the engine's connection status.
func (a *App) Engine() hub.Status { return a.hub.Status() }

// Containers returns the current container list. Later changes arrive as
// "containers" events.
func (a *App) Containers() []engine.Container { return a.hub.Containers() }

// ContainerAction runs start, stop, restart, pause, unpause or kill.
func (a *App) ContainerAction(id, action string) error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	c := a.rt.Containers()
	switch action {
	case "start":
		return c.Start(ctx, id)
	case "stop":
		return c.Stop(ctx, id)
	case "restart":
		return c.Restart(ctx, id)
	case "pause":
		return c.Pause(ctx, id)
	case "unpause":
		return c.Unpause(ctx, id)
	case "kill":
		return c.Kill(ctx, id)
	}
	return fmt.Errorf("unknown container action %q", action)
}

// RenameContainer gives the container a new name.
func (a *App) RenameContainer(id, name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("the new name is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.rt.Containers().Rename(ctx, id, name)
}

// RemoveContainer deletes the container; force removes a running one, and
// volumes also deletes its anonymous volumes.
func (a *App) RemoveContainer(id string, force, volumes bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.rt.Containers().Remove(ctx, id, force, volumes)
}
