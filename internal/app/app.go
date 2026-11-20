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
	"strings"
	"sync"
	"time"
	"unicode/utf8"

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

	mu     sync.Mutex
	logs   map[string]context.CancelFunc // open log streams, by container ID
	stats  map[string]context.CancelFunc // open stats streams, by container ID
	terms  map[string]engine.Session     // open terminals, by session ID
	builds map[string]context.CancelFunc // running builds, by the page's key
	seq    int
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
	a.stats = map[string]context.CancelFunc{}
	a.terms = map[string]engine.Session{}
	a.builds = map[string]context.CancelFunc{}
	a.hub = hub.New(a.rt, emit)
	go a.hub.Run(ctx)
}

// Stop ends the mirroring and closes the engine connection.
func Stop(a *App) {
	if a.cancel != nil {
		a.cancel()
	}
	a.mu.Lock()
	for _, cancel := range a.logs {
		cancel()
	}
	for _, cancel := range a.stats {
		cancel()
	}
	for _, s := range a.terms {
		_ = s.Close()
	}
	a.mu.Unlock()
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

// Measuring disk use walks every container's files.
const sizeTimeout = 2 * time.Minute

// ContainerSizes measures every container's disk use, by container ID.
func (a *App) ContainerSizes() (map[string]engine.Size, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	return a.rt.Containers().Sizes(ctx)
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
		_ = a.rt.Containers().Stats(ctx, id, func(s engine.Stats) {
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
	s, err := a.rt.Containers().Exec(ctx, id, shell, uint(max(cols, 1)), uint(max(rows, 1)))
	if err != nil {
		return "", err
	}
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
	return session, nil
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
func (a *App) Volumes() []engine.Volume { return a.hub.Volumes() }

// CreateVolume makes an empty volume.
func (a *App) CreateVolume(name string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("the volume name is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.rt.Volumes().Create(ctx, name)
}

// RemoveVolume deletes a volume and the data in it.
func (a *App) RemoveVolume(name string) error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.rt.Volumes().Remove(ctx, name)
}

// PruneVolumes deletes every volume no container uses and returns the bytes freed.
func (a *App) PruneVolumes() (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	return a.rt.Volumes().Prune(ctx)
}

// VolumeSizes measures each volume's data, by volume name.
func (a *App) VolumeSizes() (map[string]int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	return a.rt.Volumes().Sizes(ctx)
}

// Networks returns the current network list. Later changes arrive as "networks" events.
func (a *App) Networks() []engine.Network { return a.hub.Networks() }

// CreateNetwork makes a network; subnet may be empty.
func (a *App) CreateNetwork(name, subnet string) error {
	name = strings.TrimSpace(name)
	if name == "" {
		return fmt.Errorf("the network name is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.rt.Networks().Create(ctx, name, strings.TrimSpace(subnet))
}

// RemoveNetwork deletes a network no container is on.
func (a *App) RemoveNetwork(id string) error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.rt.Networks().Remove(ctx, id)
}

// ConnectNetwork puts a container on a network.
func (a *App) ConnectNetwork(network, container string) error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.rt.Networks().Connect(ctx, network, container)
}

// DisconnectNetwork takes a container off a network.
func (a *App) DisconnectNetwork(network, container string) error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.rt.Networks().Disconnect(ctx, network, container)
}

// PruneNetworks deletes every network no container is on.
func (a *App) PruneNetworks() error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.rt.Networks().Prune(ctx)
}

// VolumeFiles lists one directory inside a volume; "/" is its top.
func (a *App) VolumeFiles(name, dir string) ([]engine.FileEntry, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	list, err := a.rt.Volumes().Files(ctx, name, dir)
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

// VolumePreview returns the start of a file inside a volume.
func (a *App) VolumePreview(name, file string) (FilePreview, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	rc, err := a.rt.Volumes().Archive(ctx, name, file)
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
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, "Downloads")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	rc, err := a.rt.Volumes().Archive(ctx, name, item)
	if err != nil {
		return "", err
	}
	defer rc.Close()

	leaf := path.Base(path.Clean("/" + item))
	if leaf == "/" || leaf == "." {
		leaf = name
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
		again, err := a.rt.Volumes().Archive(ctx, name, item)
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
