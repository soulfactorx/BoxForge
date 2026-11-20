// Package app is what the UI can call. Every exported method of App is a
// binding: Wails exposes it to the page as window.go.app.App.<Method>, and
// the dev server as POST /api/call/<Method>. Keep it thin; the work belongs
// in the packages it calls.
package app

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/soulfactorx/boxforge/internal/engine"
	"github.com/soulfactorx/boxforge/internal/engine/docker"
	"github.com/soulfactorx/boxforge/internal/engine/fake"
	"github.com/soulfactorx/boxforge/internal/engine/nerdctl"
	"github.com/soulfactorx/boxforge/internal/engines"
	"github.com/soulfactorx/boxforge/internal/extterm"
	"github.com/soulfactorx/boxforge/internal/hub"
	"github.com/soulfactorx/boxforge/internal/provision"
	"github.com/soulfactorx/boxforge/internal/update"
)

// How long one action (stop waits for the container's own shutdown) may take.
const actionTimeout = 60 * time.Second

// App is the bound object.
type App struct {
	emit hub.Emit

	// The engine in use, and what follows from it. UseEngine replaces them.
	emu    sync.RWMutex
	target engines.Target
	rt     engine.Runtime
	hub    *hub.Hub
	cancel context.CancelFunc

	mu     sync.Mutex
	logs   map[string]context.CancelFunc // open log streams, by container ID
	stats  map[string]context.CancelFunc // open stats streams, by container ID
	terms  map[string]engine.Session     // open terminals, by session ID
	builds map[string]context.CancelFunc // running builds, by the page's key
	seq    int

	setup provision.Installer
}

// connect opens the engine a target names. Nothing is sent to it yet.
func connect(t engines.Target) (engine.Runtime, error) {
	if os.Getenv("BOXFORGE_ENGINE") == "fake" {
		return fake.New(), nil
	}
	switch t.Kind {
	case "containerd":
		return nerdctl.Connect(nerdctl.Local)
	case "wsl":
		rt, err := docker.ConnectDialer(t.Dialer())
		if err != nil {
			// No Docker in the distribution: containerd on its own, perhaps.
			inside := func(args ...string) (string, []string) {
				return engines.InWSL(t.Distro, append([]string{"nerdctl"}, args...)...)
			}
			if alt, aerr := nerdctl.Connect(inside); aerr == nil {
				return alt, nil
			}
		}
		return rt, err
	case "ssh":
		return docker.ConnectDialer(t.Dialer())
	case "context", "podman":
		return docker.Connect(t.Host)
	}
	return docker.Connect(engines.DefaultHost())
}

// New opens the engine chosen last time, else the one the docker command
// uses. BOXFORGE_ENGINE=fake gives the in-memory one.
func New() (*App, error) {
	update.Cleanup()
	t := engines.Find(engines.Saved())
	rt, err := connect(t)
	if err != nil {
		// What was saved no longer works (a distribution removed, say).
		t = engines.Default
		if rt, err = connect(t); err != nil {
			return nil, err
		}
	}
	return &App{rt: rt, target: t}, nil
}

// Start begins mirroring the engine, sending changes through emit. It is a
// function, not a method, so that it is not bound.
func Start(a *App, emit hub.Emit) {
	a.emit = emit
	a.logs = map[string]context.CancelFunc{}
	a.stats = map[string]context.CancelFunc{}
	a.terms = map[string]engine.Session{}
	a.builds = map[string]context.CancelFunc{}
	a.setup.Notify = func(st provision.Status) { emit("setup", st) }
	a.emu.Lock()
	a.follow()
	a.emu.Unlock()
	a.keepAlive()
	if p := engines.Setting("proxy.url"); p != "" {
		setProxyEnv(p, engines.Setting("proxy.no"))
	}
}

// follow starts a hub on a.rt. Callers hold emu for writing.
func (a *App) follow() {
	ctx, cancel := context.WithCancel(context.Background())
	a.cancel = cancel
	a.hub = hub.New(a.rt, a.emit)
	go a.hub.Run(ctx)
}

// hangUp ends everything that streams from the engine in use.
func (a *App) hangUp() {
	a.stopForwards(false)
	a.mu.Lock()
	for id, cancel := range a.logs {
		cancel()
		delete(a.logs, id)
	}
	for id, cancel := range a.stats {
		cancel()
		delete(a.stats, id)
	}
	for id, s := range a.terms {
		_ = s.Close()
		delete(a.terms, id)
	}
	a.mu.Unlock()
}

// Stop ends the mirroring and closes the engine connection.
func Stop(a *App) {
	a.hangUp()
	a.emu.Lock()
	defer a.emu.Unlock()
	if a.cancel != nil {
		a.cancel()
	}
	_ = a.rt.Close()
}

func (a *App) eng() engine.Runtime {
	a.emu.RLock()
	defer a.emu.RUnlock()
	return a.rt
}

func (a *App) mirror() *hub.Hub {
	a.emu.RLock()
	defer a.emu.RUnlock()
	return a.hub
}

// EngineChoice is the engines to choose from and the one in use.
type EngineChoice struct {
	Current string           `json:"current"`
	Targets []engines.Target `json:"targets"`
}

// Engines lists the engines this PC can reach.
func (a *App) Engines() EngineChoice {
	a.emu.RLock()
	defer a.emu.RUnlock()
	return EngineChoice{Current: a.target.ID, Targets: engines.Discover()}
}

// How long a newly chosen engine has to answer before the choice is refused.
const probeTimeout = 30 * time.Second

// UseEngine switches to another engine and remembers the choice. The engine
// must answer first; when it doesn't, nothing changes and the error says why.
func (a *App) UseEngine(id string) error {
	t := engines.Find(id)
	if t.ID != id {
		return fmt.Errorf("that engine is no longer in the list")
	}
	rt, err := connect(t)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	_, err = rt.Info(ctx)
	cancel()
	if err != nil {
		_ = rt.Close()
		return err
	}
	a.hangUp()
	a.emu.Lock()
	a.cancel()
	_ = a.rt.Close()
	a.rt, a.target = rt, t
	a.follow()
	a.emu.Unlock()
	a.keepAlive()
	return engines.Save(id)
}

// docker is the docker command aimed at the engine in use: its name, its
// arguments, and what to add to its environment.
func (a *App) docker(args ...string) (name string, full []string, env []string) {
	a.emu.RLock()
	t := a.target
	a.emu.RUnlock()
	// With containerd on its own the command is nerdctl, which takes the
	// docker command's words.
	tool := "docker"
	if nerdctl.Is(a.eng()) {
		tool = "nerdctl"
	}
	switch t.Kind {
	case "containerd":
		return tool, args, nil
	case "wsl":
		// The command inside the distribution, beside its engine.
		name, full = engines.InWSL(t.Distro, append([]string{tool}, args...)...)
		return name, full, nil
	case "context", "podman":
		return "docker", args, []string{"DOCKER_HOST=" + t.Host}
	case "ssh":
		// The docker command speaks SSH itself.
		return "docker", args, []string{"DOCKER_HOST=ssh://" + t.Host}
	}
	return "docker", args, nil
}

// hostPath is a path on this PC as the docker command in use sees it.
func (a *App) hostPath(p string) string {
	a.emu.RLock()
	defer a.emu.RUnlock()
	if a.target.Kind == "wsl" {
		return engines.WSLPath(p)
	}
	return p
}

// Engine returns the engine's connection status.
func (a *App) Engine() hub.Status { return a.mirror().Status() }

// Containers returns the current container list. Later changes arrive as
// "containers" events.
func (a *App) Containers() []engine.Container { return a.mirror().Containers() }

// ContainerAction runs start, stop, restart, pause, unpause or kill.
func (a *App) ContainerAction(id, action string) error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	c := a.eng().Containers()
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
	return a.eng().Containers().Rename(ctx, id, name)
}

// RemoveContainer deletes the container; force removes a running one, and
// volumes also deletes its anonymous volumes.
func (a *App) RemoveContainer(id string, force, volumes bool) error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.eng().Containers().Remove(ctx, id, force, volumes)
}

// InspectContainer returns the engine's own description of the container,
// as indented JSON.
func (a *App) InspectContainer(id string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	raw, err := a.eng().Containers().Inspect(ctx, id)
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
	go func() { done <- a.eng().Containers().Logs(ctx, id, logTail, w) }()
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
func (a *App) Images() []engine.Image { return a.mirror().Images() }

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
	err := a.eng().Images().Pull(ctx, ref, func(p engine.PullProgress) {
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
	if err != nil && needsLogin(err) {
		// The engine was asked without a sign-in. The docker command knows
		// the ones made with "docker login": let it try.
		if cliErr := a.pullWithCLI(ctx, ref); cliErr == nil {
			err = nil
		}
	}
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
	return a.eng().Images().Remove(ctx, id, force)
}

// TagImage gives an image one more name.
func (a *App) TagImage(source, target string) error {
	target = strings.TrimSpace(target)
	if target == "" {
		return fmt.Errorf("the new tag is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.eng().Images().Tag(ctx, source, target)
}

// PruneImages deletes untagged images nothing uses and returns the bytes freed.
func (a *App) PruneImages() (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.eng().Images().Prune(ctx)
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
	if !a.eng().Images().Exists(ctx, spec.Image) {
		if err := a.pull(ctx, spec.Image); err != nil {
			return "", err
		}
	}
	// A base image (alpine, ubuntu) runs a bare shell, which ends at once
	// when started in the background with no terminal: nobody means that.
	if len(spec.Command) == 0 && !spec.Interactive {
		if d, err := a.eng().Images().Defaults(ctx, spec.Image); err == nil && d.Shell {
			spec.Interactive = true
		}
	}
	return a.eng().Containers().Run(ctx, spec)
}

// RecreateContainer replaces a container with one made anew from spec:
// the way to change what can only be set when a container is made (its
// ports, folders, variables, network). The old one is set aside first and
// put back if the new one can't be made; its volumes stay.
func (a *App) RecreateContainer(id string, spec engine.RunSpec) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	cs := a.eng().Containers()
	var old *engine.Container
	for _, c := range a.mirror().Containers() {
		if c.ID == id {
			c := c
			old = &c
		}
	}
	if old == nil {
		// The mirror may be a moment behind the engine.
		for _, c := range a.listNow(ctx) {
			if c.ID == id {
				c := c
				old = &c
			}
		}
	}
	if old == nil {
		return "", fmt.Errorf("the container is no longer there")
	}
	wasUp := old.State == "running" || old.State == "paused"
	// Whatever can fail without touching the old one goes first.
	if img := strings.TrimSpace(spec.Image); img != "" && !a.eng().Images().Exists(ctx, img) {
		if err := a.pull(ctx, img); err != nil {
			return "", err
		}
	}
	if strings.TrimSpace(spec.Name) == "" {
		spec.Name = old.Name
	}
	if nerdctl.Is(a.eng()) {
		return a.recreateByRemoving(ctx, *old, wasUp, spec)
	}
	if wasUp {
		// Its ports are free only once it has stopped.
		if err := cs.Stop(ctx, id); err != nil {
			return "", err
		}
	}
	aside := old.Name + "-old-" + time.Now().Format("150405")
	if err := cs.Rename(ctx, id, aside); err != nil {
		return "", err
	}
	back := func() {
		ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
		defer cancel()
		_ = cs.Rename(ctx, id, old.Name)
		if wasUp {
			_ = cs.Start(ctx, id)
		}
	}
	fresh, err := a.RunContainer(spec)
	if err != nil {
		// Made but unable to start (a port taken, say): not left behind.
		for _, c := range a.listNow(ctx) {
			if c.Name == spec.Name && c.ID != id {
				_ = cs.Remove(ctx, c.ID, true, false)
			}
		}
		back()
		return "", err
	}
	if err := cs.Remove(ctx, id, true, false); err != nil {
		return fresh, fmt.Errorf("the new container is running, but the old one (%s) could not be removed: %w", aside, err)
	}
	return fresh, nil
}

// recreateByRemoving is RecreateContainer where a container can't be set
// aside under another name: nerdctl keeps a container's first name on
// its books, so a renamed one can no longer be removed once another has
// taken that name. Here the old one is kept as an image instead, removed,
// and made again from that image if the new one can't be.
func (a *App) recreateByRemoving(ctx context.Context, old engine.Container, wasUp bool, spec engine.RunSpec) (string, error) {
	cs := a.eng().Containers()
	raw, err := cs.Inspect(ctx, old.ID)
	if err != nil {
		return "", err
	}
	if wasUp {
		if err := cs.Stop(ctx, old.ID); err != nil {
			return "", err
		}
	}
	keep := "boxforge-undo/" + strings.ToLower(old.Name) + ":" + time.Now().Format("20060102-150405")
	if err := cs.Commit(ctx, old.ID, keep); err != nil {
		if wasUp {
			_ = cs.Start(ctx, old.ID)
		}
		return "", err
	}
	drop := func() {
		ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
		defer cancel()
		_ = a.eng().Images().Remove(ctx, keep, false)
	}
	if err := cs.Remove(ctx, old.ID, true, false); err != nil {
		drop()
		if wasUp {
			_ = cs.Start(ctx, old.ID)
		}
		return "", err
	}
	fresh, err := a.RunContainer(spec)
	if err == nil {
		drop()
		return fresh, nil
	}
	// Put back: what the new one left, away; the old one, from its image.
	undo, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	for _, c := range a.listNow(undo) {
		if c.Name == spec.Name {
			_ = cs.Remove(undo, c.ID, true, false)
		}
	}
	id, _, rerr := cs.CreateFrom(undo, raw, keep)
	if rerr != nil {
		return "", fmt.Errorf("%w\n\n원래 컨테이너를 되돌리지도 못했습니다(%v). 그 상태는 이미지 %s 로 남아 있습니다", err, rerr, keep)
	}
	if wasUp {
		_ = cs.Start(undo, id)
	}
	return "", err
}

// listNow asks the engine itself for the containers, not the mirror,
// which may be a moment behind.
func (a *App) listNow(ctx context.Context) []engine.Container {
	list, _ := a.eng().Containers().List(ctx)
	return list
}

// Measuring disk use walks every container's files.
const sizeTimeout = 2 * time.Minute

// ContainerSizes measures every container's disk use, by container ID.
func (a *App) ContainerSizes() (map[string]engine.Size, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	return a.eng().Containers().Sizes(ctx)
}

// StatsSample is the payload of a "stats" event.
type StatsSample struct {
	ID string `json:"id"`
	engine.Stats
}

// StartStats begins sending the container's resource use as "stats" events,
// about one a second, until StopStats or the container stops.
func (a *App) StartStats(id string) {
	ctx, cancel := context.WithCancel(context.Background())
	a.mu.Lock()
	if old := a.stats[id]; old != nil {
		old()
	}
	a.stats[id] = cancel
	a.mu.Unlock()
	go func() {
		_ = a.eng().Containers().Stats(ctx, id, func(s engine.Stats) {
			a.emit("stats", StatsSample{ID: id, Stats: s})
		})
	}()
}

// StopStats ends the stream StartStats began.
func (a *App) StopStats(id string) {
	a.mu.Lock()
	if cancel := a.stats[id]; cancel != nil {
		cancel()
		delete(a.stats, id)
	}
	a.mu.Unlock()
}

// TermData is the payload of a "term" event: terminal output, base64 since
// it is bytes, not text. End marks the shell's exit.
type TermData struct {
	Session string `json:"session"`
	Data    string `json:"data"`
	End     bool   `json:"end"`
}

// The shell a terminal starts: bash where the image has it, else sh.
var shell = []string{"/bin/sh", "-c", "command -v bash >/dev/null 2>&1 && exec bash || exec sh"}

// TermOpen starts a shell in the container on a terminal of the given size
// and returns the session's ID. Its output arrives as "term" events.
func (a *App) TermOpen(id string, cols, rows int) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	s, err := a.eng().Containers().Exec(ctx, id, shell, uint(max(cols, 1)), uint(max(rows, 1)))
	if err != nil {
		return "", err
	}
	return a.attach(s), nil
}

// attach gives a terminal session an ID and sends its output to the page.
func (a *App) attach(s engine.Session) string {
	a.mu.Lock()
	a.seq++
	session := fmt.Sprintf("t%d", a.seq)
	a.terms[session] = s
	a.mu.Unlock()
	go func() {
		buf := make([]byte, 32<<10)
		for {
			n, err := s.Read(buf)
			if n > 0 {
				a.emit("term", TermData{Session: session, Data: base64.StdEncoding.EncodeToString(buf[:n])})
			}
			if err != nil {
				break
			}
		}
		a.mu.Lock()
		_, open := a.terms[session]
		delete(a.terms, session)
		a.mu.Unlock()
		_ = s.Close()
		if open { // not closed by the page: tell it the shell is gone
			a.emit("term", TermData{Session: session, End: true})
		}
	}()
	return session
}

func (a *App) term(session string) (engine.Session, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	s := a.terms[session]
	if s == nil {
		return nil, fmt.Errorf("the terminal session has ended")
	}
	return s, nil
}

// TermWrite sends what was typed to the terminal.
func (a *App) TermWrite(session, data string) error {
	s, err := a.term(session)
	if err != nil {
		return err
	}
	_, err = s.Write([]byte(data))
	return err
}

// TermResize tells the shell its window changed size.
func (a *App) TermResize(session string, cols, rows int) error {
	s, err := a.term(session)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return s.Resize(ctx, uint(max(cols, 1)), uint(max(rows, 1)))
}

// TermClose ends the terminal session.
func (a *App) TermClose(session string) {
	a.mu.Lock()
	s := a.terms[session]
	delete(a.terms, session)
	a.mu.Unlock()
	if s != nil {
		_ = s.Close()
	}
}

// Volumes returns the current volume list. Later changes arrive as "volumes" events.
func (a *App) Volumes() []engine.Volume { return a.mirror().Volumes() }

// CreateVolume makes an empty volume.
func (a *App) CreateVolume(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("the volume name is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.eng().Volumes().Create(ctx, name)
}

// RemoveVolume deletes a volume and the data in it.
func (a *App) RemoveVolume(name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.eng().Volumes().Remove(ctx, name)
}

// PruneVolumes deletes every volume no container uses and returns the bytes freed.
func (a *App) PruneVolumes() (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	return a.eng().Volumes().Prune(ctx)
}

// VolumeSizes measures each volume's data, by volume name.
func (a *App) VolumeSizes() (map[string]int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	return a.eng().Volumes().Sizes(ctx)
}

// Networks returns the current network list. Later changes arrive as "networks" events.
func (a *App) Networks() []engine.Network { return a.mirror().Networks() }

// CreateNetwork makes a network; subnet may be empty.
func (a *App) CreateNetwork(name, subnet string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("the network name is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.eng().Networks().Create(ctx, name, strings.TrimSpace(subnet))
}

// RemoveNetwork deletes a network no container is on.
func (a *App) RemoveNetwork(id string) error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.eng().Networks().Remove(ctx, id)
}

// ConnectNetwork puts a container on a network.
func (a *App) ConnectNetwork(network, container string) error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.eng().Networks().Connect(ctx, network, container)
}

// DisconnectNetwork takes a container off a network.
func (a *App) DisconnectNetwork(network, container string) error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.eng().Networks().Disconnect(ctx, network, container)
}

// PruneNetworks deletes every network no container is on.
func (a *App) PruneNetworks() error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.eng().Networks().Prune(ctx)
}

// VolumeFiles lists one directory inside a volume; "/" is its top.
func (a *App) VolumeFiles(name, dir string) ([]engine.FileEntry, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	list, err := a.eng().Volumes().Files(ctx, name, dir)
	if list == nil {
		list = []engine.FileEntry{}
	}
	return list, err
}

// FilePreview is the start of a file, for reading on screen.
type FilePreview struct {
	Text      string `json:"text"`
	Binary    bool   `json:"binary"`    // not text: nothing to show
	Truncated bool   `json:"truncated"` // the file is longer than Text
	Size      int64  `json:"size"`
}

// The most of a file a preview shows.
const previewLimit = 256 << 10

// firstFile advances a tar stream to its first regular file.
func firstFile(r io.Reader) (*tar.Reader, *tar.Header, error) {
	tr := tar.NewReader(r)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil, nil, fmt.Errorf("that is not a file")
		}
		if err != nil {
			return nil, nil, err
		}
		if h.Typeflag == tar.TypeReg {
			return tr, h, nil
		}
	}
}

// archiver gets a file or folder as a tar stream.
type archiver func(ctx context.Context, item string) (io.ReadCloser, error)

// preview returns the start of a file.
func preview(get archiver, file string) (FilePreview, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	rc, err := get(ctx, file)
	if err != nil {
		return FilePreview{}, err
	}
	defer rc.Close()
	tr, h, err := firstFile(rc)
	if err != nil {
		return FilePreview{}, err
	}
	buf, err := io.ReadAll(io.LimitReader(tr, previewLimit))
	if err != nil {
		return FilePreview{}, err
	}
	p := FilePreview{Size: h.Size, Truncated: h.Size > int64(len(buf))}
	// A cut can land inside a character: drop the broken tail before judging.
	for len(buf) > 0 && p.Truncated && !utf8.Valid(buf) && len(buf) > previewLimit-4 {
		buf = buf[:len(buf)-1]
	}
	if bytes.IndexByte(buf, 0) >= 0 || !utf8.Valid(buf) {
		p.Binary = true
		return p, nil
	}
	p.Text = string(buf)
	return p, nil
}

// VolumePreview returns the start of a file inside a volume.
func (a *App) VolumePreview(name, file string) (FilePreview, error) {
	return preview(func(ctx context.Context, item string) (io.ReadCloser, error) {
		return a.eng().Volumes().Archive(ctx, name, item)
	}, file)
}

// ContainerFiles lists one directory inside a container.
func (a *App) ContainerFiles(id, dir string) ([]engine.FileEntry, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	list, err := a.eng().Containers().Files(ctx, id, dir)
	if list == nil {
		list = []engine.FileEntry{}
	}
	return list, err
}

// ContainerPreview returns the start of a file inside a container.
func (a *App) ContainerPreview(id, file string) (FilePreview, error) {
	return preview(func(ctx context.Context, item string) (io.ReadCloser, error) {
		return a.eng().Containers().Archive(ctx, id, item)
	}, file)
}

// ContainerSave copies a file out of a container into the user's Downloads
// folder (a directory as a .tar of itself) and returns where it went.
func (a *App) ContainerSave(id, item string) (string, error) {
	return saveOut(func(ctx context.Context, it string) (io.ReadCloser, error) {
		return a.eng().Containers().Archive(ctx, id, it)
	}, item, "container")
}

// freePath returns dir/name, or dir/"name (2)" and so on when taken.
func freePath(dir, name string) string {
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for n := 1; ; n++ {
		candidate := filepath.Join(dir, name)
		if n > 1 {
			candidate = filepath.Join(dir, fmt.Sprintf("%s (%d)%s", base, n, ext))
		}
		if _, err := os.Stat(candidate); os.IsNotExist(err) {
			return candidate
		}
	}
}

// VolumeSave copies a file out of a volume into the user's Downloads folder
// (a directory is saved as a .tar of itself) and returns where it went.
func (a *App) VolumeSave(name, item string) (string, error) {
	return saveOut(func(ctx context.Context, it string) (io.ReadCloser, error) {
		return a.eng().Volumes().Archive(ctx, name, it)
	}, item, name)
}

// outbox is set when the app is served to browsers on other machines:
// files "saved to this PC" are then written there, for the browser to
// fetch, instead of into the Downloads folder of the server.
var outbox string

// SetRemote tells the app it is served to browsers elsewhere, and where
// to write the files they are to fetch.
func SetRemote(dir string) { outbox = dir }

// downloads is the folder files are saved into.
func downloads() (string, error) {
	dir := outbox
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		dir = filepath.Join(home, "Downloads")
	}
	return dir, os.MkdirAll(dir, 0o755)
}

// saveOut copies what get returns for item into the Downloads folder; top
// names the result when item is the top folder itself.
func saveOut(get archiver, item, top string) (string, error) {
	dir, err := downloads()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	rc, err := get(ctx, item)
	if err != nil {
		return "", err
	}
	defer rc.Close()

	leaf := path.Base(path.Clean("/" + item))
	if leaf == "/" || leaf == "." {
		leaf = top
	}
	// What the engine sends is a tar either way. A lone file is taken out
	// of it; a directory is kept as the tar it is.
	tr := tar.NewReader(rc)
	h, err := tr.Next()
	if err != nil {
		return "", err
	}
	var src io.Reader
	target := freePath(dir, leaf)
	if h.Typeflag == tar.TypeReg {
		src = tr
	} else {
		rc.Close()
		again, err := get(ctx, item)
		if err != nil {
			return "", err
		}
		defer again.Close()
		src = again
		target = freePath(dir, leaf+".tar")
	}
	f, err := os.Create(target)
	if err != nil {
		return "", err
	}
	if _, err := io.Copy(f, src); err != nil {
		f.Close()
		os.Remove(target)
		return "", err
	}
	return target, f.Close()
}

var containerName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`)

// OpenTerminal opens the desktop's own terminal window with a shell inside
// the container: bash where the image has it, else sh.
func (a *App) OpenTerminal(name string) error {
	if !containerName.MatchString(name) {
		return fmt.Errorf("%q is not a container name", name)
	}
	sh := "sh"
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if s, err := a.eng().Containers().Exec(ctx, name, []string{"sh", "-c", "command -v bash"}, 80, 24); err == nil {
		found := make(chan bool, 1)
		go func() {
			out, _ := io.ReadAll(io.LimitReader(s, 4096))
			found <- strings.Contains(string(out), "bash")
		}()
		select {
		case ok := <-found:
			if ok {
				sh = "bash"
			}
		case <-ctx.Done():
		}
		_ = s.Close()
	}
	cmd, args, env := a.docker("exec", "-it", name, sh)
	for _, kv := range env {
		// The terminal's command inherits the app's environment.
		if k, v, ok := strings.Cut(kv, "="); ok {
			os.Setenv(k, v)
			defer os.Unsetenv(k)
		}
	}
	return extterm.Open(append([]string{cmd}, args...))
}

// Setting returns a value the page stored with SetSetting, "" when none.
func (a *App) Setting(key string) string { return engines.Setting(key) }

// SetSetting keeps a value for the page across restarts.
func (a *App) SetSetting(key, value string) error { return engines.SetSetting(key, value) }

// SetupStatus says whether BoxForge can install an engine on this PC, and
// how far an installation has come. Progress arrives as "setup" events.
func (a *App) SetupStatus() provision.Status { return a.setup.Status() }

// SetupStart begins installing an engine in the background, into the
// Linux the options choose.
func (a *App) SetupStart(o provision.Options) bool { return a.setup.Start(o) }

// SetupCancel stops the installation under way.
func (a *App) SetupCancel() { a.setup.Cancel() }

// RemoveBoxForgeEngine deletes the engine BoxForge installed, with every
// image, container and volume in it, after switching away from it.
func (a *App) RemoveBoxForgeEngine() error {
	a.emu.RLock()
	current := a.target.ID
	a.emu.RUnlock()
	if current == provision.EngineID {
		if err := a.UseEngine(engines.Default.ID); err != nil {
			return fmt.Errorf("switch to another engine first: %w", err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	return provision.Remove(ctx)
}

// CopyState is the payload of a "copy" event: bytes of an image sent to
// another engine so far.
type CopyState struct {
	Ref  string `json:"ref"`
	Done int64  `json:"done"`
}

// counting reports how much has been read through it, a few times a second.
type counting struct {
	r    io.Reader
	n    int64
	last time.Time
	tell func(int64)
}

func (c *counting) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	if time.Since(c.last) > 200*time.Millisecond || err != nil {
		c.last = time.Now()
		c.tell(c.n)
	}
	return n, err
}

// CopyImage sends an image from the engine in use to another one, as
// `docker save | docker load` across the two does. Progress arrives as
// "copy" events.
func (a *App) CopyImage(ref, targetID string) error {
	a.emu.RLock()
	current := a.target.ID
	a.emu.RUnlock()
	if targetID == current {
		return fmt.Errorf("that is the engine the image is already on")
	}
	t := engines.Find(targetID)
	if t.ID != targetID {
		return fmt.Errorf("that engine is no longer in the list")
	}
	dst, err := connect(t)
	if err != nil {
		return err
	}
	defer dst.Close()
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	// Ask the target first: better to learn now that it is not running
	// than after the source has packed the image.
	if _, err := dst.Info(ctx); err != nil {
		return fmt.Errorf("the other engine does not answer: %w", err)
	}
	rc, err := a.eng().Images().Save(ctx, ref)
	if err != nil {
		return err
	}
	defer rc.Close()
	return dst.Images().Load(ctx, &counting{r: rc, tell: func(n int64) {
		a.emit("copy", CopyState{Ref: ref, Done: n})
	}})
}

// EngineLabel says in a few words which engine is in use.
func (a *App) EngineLabel() string {
	a.emu.RLock()
	defer a.emu.RUnlock()
	return engines.Describe(a.target)
}

// MemoryUsed adds up the memory the running containers use right now.
func (a *App) MemoryUsed() int64 {
	rt := a.eng()
	var ids []string
	for _, c := range a.mirror().Containers() {
		if c.State == "running" {
			ids = append(ids, c.ID)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	var (
		wg    sync.WaitGroup
		mu    sync.Mutex
		total int64
		slots = make(chan struct{}, 8) // at most this many asked at a time
	)
	for _, id := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			slots <- struct{}{}
			defer func() { <-slots }()
			if s, err := rt.Containers().StatsOnce(ctx, id); err == nil {
				mu.Lock()
				total += s.MemUsed
				mu.Unlock()
			}
		}()
	}
	wg.Wait()
	return total
}

// Transfer is the payload of a "transfer" event: what a copy to another
// engine is doing now.
type Transfer struct {
	Key  string `json:"key"`
	Text string `json:"text"`
}

// other opens the engine a copy goes to. The caller closes it.
func (a *App) other(ctx context.Context, targetID string) (engine.Runtime, error) {
	a.emu.RLock()
	current := a.target.ID
	a.emu.RUnlock()
	if targetID == current {
		return nil, fmt.Errorf("that is the engine it is already on")
	}
	t := engines.Find(targetID)
	if t.ID != targetID {
		return nil, fmt.Errorf("that engine is no longer in the list")
	}
	dst, err := connect(t)
	if err != nil {
		return nil, err
	}
	if _, err := dst.Info(ctx); err != nil {
		dst.Close()
		return nil, fmt.Errorf("the other engine does not answer: %w", err)
	}
	return dst, nil
}

// sendImage moves one image from src to dst.
func sendImage(ctx context.Context, src, dst engine.Runtime, ref string, sent func(int64)) error {
	rc, err := src.Images().Save(ctx, ref)
	if err != nil {
		return err
	}
	defer rc.Close()
	return dst.Images().Load(ctx, &counting{r: rc, tell: sent})
}

// smallImage picks an image to make helper containers from: a small one
// with a shell if there is one, else the smallest.
func smallImage(list []engine.Image) string {
	best, score := "", int64(-1)
	for _, im := range list {
		for _, tag := range im.Tags {
			s := im.Size
			if strings.Contains(tag, "busybox") || strings.Contains(tag, "alpine") {
				s = 0
			}
			if score < 0 || s < score {
				best, score = tag, s
			}
		}
	}
	return best
}

// sendVolume copies a volume's data from src to dst.
func sendVolume(ctx context.Context, src, dst engine.Runtime, name string, say func(string)) error {
	// Writing into a volume takes a container, and a container an image:
	// an engine with none is lent a small one.
	if have, err := dst.Images().List(ctx); err == nil && smallImage(have) == "" {
		mine, _ := src.Images().List(ctx)
		if tool := smallImage(mine); tool != "" {
			say("받는 쪽에 이미지가 하나도 없어 도구용 이미지(" + tool + ")를 먼저 보냅니다")
			if err := sendImage(ctx, src, dst, tool, func(int64) {}); err != nil {
				return err
			}
		}
	}
	say("볼륨 " + name + "의 데이터를 보내는 중")
	rc, err := src.Volumes().Archive(ctx, name, "/")
	if err != nil {
		return err
	}
	defer rc.Close()
	return dst.Volumes().Restore(ctx, name, rc)
}

// CopyVolume copies a volume and its data to another engine. A volume of
// that name there is filled, files of the same name replaced.
func (a *App) CopyVolume(key, name, targetID string) error {
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	dst, err := a.other(ctx, targetID)
	if err != nil {
		return err
	}
	defer dst.Close()
	return sendVolume(ctx, a.eng(), dst, name, func(text string) { a.emit("transfer", Transfer{Key: key, Text: text}) })
}

// CopyOptions says how much of a container goes along.
type CopyOptions struct {
	Changes bool `json:"changes"` // the files written in the container since it was made
	Volumes bool `json:"volumes"` // the data of the volumes it uses
}

// CopyContainer makes a container like this one on another engine, without
// starting it there. It returns notes on what could not be carried over:
// "network:<name>" for a network of the user's making, "bind:<path>" for a
// folder of this PC it mounts.
func (a *App) CopyContainer(key, id, targetID string, o CopyOptions) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	say := func(text string) { a.emit("transfer", Transfer{Key: key, Text: text}) }
	dst, err := a.other(ctx, targetID)
	if err != nil {
		return nil, err
	}
	defer dst.Close()
	src := a.eng()
	raw, err := src.Containers().Inspect(ctx, id)
	if err != nil {
		return nil, err
	}
	var info struct {
		Name   string
		Config struct{ Image string }
		Mounts []struct{ Type, Name string }
	}
	if err := json.Unmarshal(raw, &info); err != nil {
		return nil, err
	}
	name := strings.TrimPrefix(info.Name, "/")

	ref := info.Config.Image
	if o.Changes {
		// The container as it is now, made into an image for the journey.
		ref = "boxforge-copy/" + strings.ToLower(name) + ":" + time.Now().Format("20060102-150405")
		say("컨테이너의 지금 상태를 이미지로 만드는 중")
		if err := src.Containers().Commit(ctx, id, ref); err != nil {
			return nil, err
		}
		defer func() {
			// Its own context: the copy's may be spent.
			ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
			defer cancel()
			_ = src.Images().Remove(ctx, ref, false)
		}()
	}
	// What a copy that fails brought along is taken away again.
	had := dst.Images().Exists(ctx, ref)
	undo := func() {
		if !had {
			ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
			defer cancel()
			_ = dst.Images().Remove(ctx, ref, false)
		}
	}
	say("이미지를 보내는 중")
	var last time.Time
	err = sendImage(ctx, src, dst, ref, func(n int64) {
		if time.Since(last) > 500*time.Millisecond {
			last = time.Now()
			say(fmt.Sprintf("이미지를 보내는 중 · %.1f MB", float64(n)/(1<<20)))
		}
	})
	if err != nil {
		undo()
		return nil, err
	}
	if o.Volumes {
		for _, m := range info.Mounts {
			if m.Type == "volume" && m.Name != "" {
				if err := sendVolume(ctx, src, dst, m.Name, say); err != nil {
					undo()
					return nil, fmt.Errorf("volume %s: %w", m.Name, err)
				}
			}
		}
	}
	say("받는 쪽에 컨테이너를 만드는 중")
	_, notes, err := dst.Containers().CreateFrom(ctx, raw, ref)
	if notes == nil {
		notes = []string{}
	}
	if err != nil {
		undo()
		err = portHint(err)
	}
	return notes, err
}

// portHint adds, to an engine's complaint that a port is taken, what
// usually took it: the very container being copied, still running.
func portHint(err error) error {
	low := strings.ToLower(err.Error())
	if strings.Contains(low, "port") && (strings.Contains(low, "already") || strings.Contains(low, "in use") || strings.Contains(low, "conflict")) {
		return fmt.Errorf("%w\n\n같은 PC의 다른 엔진으로 복사할 때는 원본 컨테이너가 그 포트를 쓰고 있기 때문인 경우가 많습니다. 원본을 중지한 뒤 다시 복사하세요", err)
	}
	return err
}

// ---- engines on other machines

// AddRemoteEngine remembers an engine on another machine, reached over
// SSH as user@host[:port]. Sign-in there is by key, not password.
func (a *App) AddRemoteEngine(addr string) error { return engines.AddRemote(addr) }

// RemoveRemoteEngine forgets a remote engine, switching away from it first.
func (a *App) RemoveRemoteEngine(id string) error {
	a.emu.RLock()
	current := a.target.ID
	a.emu.RUnlock()
	if current == id {
		if err := a.UseEngine(engines.Default.ID); err != nil {
			return fmt.Errorf("switch to another engine first: %w", err)
		}
	}
	return engines.RemoveRemote(strings.TrimPrefix(id, "ssh:"))
}

// ---- the network the engine is on: proxy and certificates

// setProxyEnv makes this program's own downloads (updates, the installer)
// go through the proxy.
func setProxyEnv(proxy, noProxy string) {
	for _, k := range []string{"HTTP_PROXY", "HTTPS_PROXY"} {
		if proxy == "" {
			os.Unsetenv(k)
		} else {
			os.Setenv(k, proxy)
		}
	}
	if noProxy == "" {
		os.Unsetenv("NO_PROXY")
	} else {
		os.Setenv("NO_PROXY", noProxy)
	}
}

// NetworkSettings is the proxy BoxForge was given, and whether the engine
// in use is one it can configure (one inside a WSL distribution).
type NetworkSettings struct {
	Proxy     string `json:"proxy"`
	NoProxy   string `json:"noProxy"`
	CanEngine bool   `json:"canEngine"`
	Keep      bool   `json:"keep"`
}

// wslTarget returns the distribution of the engine in use, "" when the
// engine is not inside WSL.
func (a *App) wslTarget() string {
	a.emu.RLock()
	defer a.emu.RUnlock()
	if a.target.Kind == "wsl" {
		return a.target.Distro
	}
	return ""
}

// Network returns the network settings.
func (a *App) Network() NetworkSettings {
	return NetworkSettings{
		Proxy: engines.Setting("proxy.url"), NoProxy: engines.Setting("proxy.no"),
		CanEngine: a.wslTarget() != "", Keep: engines.Setting("engine.keep") == "on",
	}
}

// SetProxy sets the proxy ("" for none) for BoxForge's own downloads and,
// when the engine is inside WSL, for the engine, which is restarted.
func (a *App) SetProxy(proxy, noProxy string) error {
	proxy, noProxy = strings.TrimSpace(proxy), strings.TrimSpace(noProxy)
	if proxy != "" && !strings.HasPrefix(proxy, "http://") && !strings.HasPrefix(proxy, "https://") {
		return fmt.Errorf("the proxy address starts with http:// or https://")
	}
	if err := engines.SetSetting("proxy.url", proxy); err != nil {
		return err
	}
	if err := engines.SetSetting("proxy.no", noProxy); err != nil {
		return err
	}
	setProxyEnv(proxy, noProxy)
	if distro := a.wslTarget(); distro != "" {
		ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
		defer cancel()
		return provision.SetProxy(ctx, distro, proxy, noProxy)
	}
	return nil
}

// TrustCertificate adds a certificate file (PEM) to those the engine
// trusts, and restarts the engine. Only for an engine inside WSL.
func (a *App) TrustCertificate(file string) error {
	distro := a.wslTarget()
	if distro == "" {
		return fmt.Errorf("this can be done only for an engine inside WSL")
	}
	if _, err := os.Stat(file); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	return provision.TrustCA(ctx, distro, file)
}

// keepAlive applies the "keep the engine running" setting to the engine in use.
func (a *App) keepAlive() {
	if distro := a.wslTarget(); distro != "" && engines.Setting("engine.keep") == "on" {
		_ = provision.Keep(distro, true)
	}
}

// SetKeepEngine chooses whether an engine inside WSL goes on running
// after BoxForge is closed.
func (a *App) SetKeepEngine(on bool) error {
	value := "off"
	if on {
		value = "on"
	}
	if err := engines.SetSetting("engine.keep", value); err != nil {
		return err
	}
	if distro := a.wslTarget(); distro != "" {
		return provision.Keep(distro, on)
	}
	return nil
}
