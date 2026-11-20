// Package app is what the UI can call. Every exported method of App is a
// binding: Wails exposes it to the page as window.go.app.App.<Method>, and
// the dev server as POST /api/call/<Method>. Keep it thin; the work belongs
// in the packages it calls.
package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
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
	emit   hub.Emit
	cancel context.CancelFunc

	mu   sync.Mutex
	logs map[string]context.CancelFunc // open log streams, by container ID
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
	a.emit = emit
	a.logs = map[string]context.CancelFunc{}
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

// InspectContainer returns the engine's own description of the container,
// as indented JSON.
func (a *App) InspectContainer(id string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	raw, err := a.rt.Containers().Inspect(ctx, id)
	if err != nil {
		return "", err
	}
	var out bytes.Buffer
	if err := json.Indent(&out, raw, "", "  "); err != nil {
		return string(raw), nil
	}
	return out.String(), nil
}

// LogChunk is the payload of a "logs" event: more of one container's output.
// End is set on the last one, with Error when the stream broke.
type LogChunk struct {
	ID    string `json:"id"`
	Text  string `json:"text"`
	End   bool   `json:"end"`
	Error string `json:"error"`
}

// How many earlier lines a log view starts with, and how often output
// collected in between goes to the page.
const (
	logTail  = 1000
	logFlush = 100 * time.Millisecond
)

// StartLogs begins sending the container's output as "logs" events: its
// last lines first, then new ones as they are written, until StopLogs.
func (a *App) StartLogs(id string) {
	ctx, cancel := context.WithCancel(context.Background())
	a.mu.Lock()
	if old := a.logs[id]; old != nil {
		old()
	}
	a.logs[id] = cancel
	a.mu.Unlock()

	w := &batcher{}
	done := make(chan error, 1)
	go func() { done <- a.rt.Containers().Logs(ctx, id, logTail, w) }()
	go func() {
		tick := time.NewTicker(logFlush)
		defer tick.Stop()
		for {
			select {
			case <-tick.C:
				if text := w.take(); text != "" {
					a.emit("logs", LogChunk{ID: id, Text: text})
				}
			case err := <-done:
				if ctx.Err() != nil {
					return // stopped by the page: it is no longer listening
				}
				last := LogChunk{ID: id, Text: w.take(), End: true}
				if err != nil {
					last.Error = err.Error()
				}
				a.emit("logs", last)
				return
			}
		}
	}()
}

// StopLogs ends the stream StartLogs began.
func (a *App) StopLogs(id string) {
	a.mu.Lock()
	if cancel := a.logs[id]; cancel != nil {
		cancel()
		delete(a.logs, id)
	}
	a.mu.Unlock()
}

// batcher collects writes between flushes.
type batcher struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *batcher) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *batcher) take() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := strings.ToValidUTF8(b.buf.String(), "\uFFFD")
	b.buf.Reset()
	return s
}

// Images returns the current image list. Later changes arrive as "images" events.
func (a *App) Images() []engine.Image { return a.hub.Images() }

// PullState is the payload of a "pull" event.
type PullState struct {
	Ref     string `json:"ref"`
	Status  string `json:"status"`
	Percent int    `json:"percent"` // -1 while the size is unknown
	Done    bool   `json:"done"`
	Error   string `json:"error"`
}

// Downloading a large image on a slow line takes a while.
const pullTimeout = 30 * time.Minute

// pull downloads ref, reporting as "pull" events, at most a few a second.
func (a *App) pull(ctx context.Context, ref string) error {
	var last time.Time
	err := a.rt.Images().Pull(ctx, ref, func(p engine.PullProgress) {
		if time.Since(last) < 150*time.Millisecond {
			return
		}
		last = time.Now()
		percent := -1
		if p.Total > 0 {
			percent = int(p.Current * 100 / p.Total)
		}
		a.emit("pull", PullState{Ref: ref, Status: p.Status, Percent: percent})
	})
	end := PullState{Ref: ref, Percent: 100, Done: true}
	if err != nil {
		end.Error = err.Error()
	}
	a.emit("pull", end)
	return err
}

// PullImage downloads an image. Progress arrives as "pull" events; the call
// returns when the download has ended.
func (a *App) PullImage(ref string) error {
	ref = strings.TrimSpace(ref)
	if ref == "" {
		return fmt.Errorf("the image name is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	return a.pull(ctx, ref)
}

// RemoveImage deletes an image; force also when containers were made from it.
func (a *App) RemoveImage(id string, force bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.rt.Images().Remove(ctx, id, force)
}

// TagImage gives an image one more name.
func (a *App) TagImage(source, target string) error {
	target = strings.TrimSpace(target)
	if target == "" {
		return fmt.Errorf("the new tag is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.rt.Images().Tag(ctx, source, target)
}

// PruneImages deletes untagged images nothing uses and returns the bytes freed.
func (a *App) PruneImages() (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.rt.Images().Prune(ctx)
}

// RunContainer creates and starts a container, downloading its image first
// when it is not here yet. It returns the new container's ID.
func (a *App) RunContainer(spec engine.RunSpec) (string, error) {
	spec.Image = strings.TrimSpace(spec.Image)
	spec.Name = strings.TrimSpace(spec.Name)
	if spec.Image == "" {
		return "", fmt.Errorf("choose an image to run")
	}
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	if !a.rt.Images().Exists(ctx, spec.Image) {
		if err := a.pull(ctx, spec.Image); err != nil {
			return "", err
		}
	}
	return a.rt.Containers().Run(ctx, spec)
}
