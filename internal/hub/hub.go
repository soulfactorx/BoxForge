// Package hub keeps a live copy of the engine's state and pushes it to the
// UI whenever the engine reports a change, so the UI never polls. Changes
// made outside the app (a `docker` command in a terminal) arrive the same way.
package hub

import (
	"context"
	"sync"
	"time"

	"github.com/soulfactorx/boxforge/internal/engine"
)

// Event names sent to the UI.
const (
	EventEngine     = "engine"     // payload: Status
	EventContainers = "containers" // payload: []engine.Container
	EventImages     = "images"     // payload: []engine.Image
	EventVolumes    = "volumes"    // payload: []engine.Volume
	EventNetworks   = "networks"   // payload: []engine.Network
)

// Status is whether the engine is reachable, and what it is.
type Status struct {
	Connected bool         `json:"connected"`
	Error     string       `json:"error"`
	Info      *engine.Info `json:"info"`
}

// Emit delivers one event to the UI.
type Emit func(event string, data any)

// Hub mirrors one engine.
type Hub struct {
	rt   engine.Runtime
	emit Emit

	// How long to collect a burst of engine events before reloading, and
	// the first and longest waits between connection attempts.
	Debounce           time.Duration
	RetryMin, RetryMax time.Duration

	mu         sync.Mutex
	status     Status
	containers []engine.Container
	images     []engine.Image
	volumes    []engine.Volume
	networks   []engine.Network
}

func New(rt engine.Runtime, emit Emit) *Hub {
	return &Hub{
		rt: rt, emit: emit, containers: []engine.Container{}, images: []engine.Image{},
		volumes: []engine.Volume{}, networks: []engine.Network{},
		Debounce: 150 * time.Millisecond, RetryMin: time.Second, RetryMax: 10 * time.Second,
	}
}

// Status returns the last known engine status.
func (h *Hub) Status() Status {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.status
}

// Containers returns the last known container list.
func (h *Hub) Containers() []engine.Container {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.containers
}

// Images returns the last known image list.
func (h *Hub) Images() []engine.Image {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.images
}

// Volumes returns the last known volume list.
func (h *Hub) Volumes() []engine.Volume {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.volumes
}

// Networks returns the last known network list.
func (h *Hub) Networks() []engine.Network {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.networks
}

// mirrored are the kinds of engine event that mean a list changed.
var mirrored = map[string]bool{"container": true, "image": true, "volume": true, "network": true}

// Run connects, mirrors, and reconnects after a lost connection, until ctx ends.
func (h *Hub) Run(ctx context.Context) {
	wait := h.RetryMin
	for ctx.Err() == nil {
		started := time.Now()
		err := h.session(ctx)
		if ctx.Err() != nil {
			return
		}
		msg := "engine connection closed"
		if err != nil {
			msg = err.Error()
		}
		h.setStatus(Status{Error: msg})
		// A session that lasted starts the backoff over.
		if time.Since(started) > h.RetryMax {
			wait = h.RetryMin
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
		if wait *= 2; wait > h.RetryMax {
			wait = h.RetryMax
		}
	}
}

// session is one connection's life: load everything, then follow events.
func (h *Hub) session(ctx context.Context) error {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	// Subscribe before the first load, so a change between the two is not lost.
	events, errs := h.rt.Events(ctx)
	if err := h.reload(ctx); err != nil {
		return err
	}
	var timer *time.Timer
	var due <-chan time.Time
	for {
		select {
		case ev, ok := <-events:
			if !ok {
				return <-errs
			}
			if !mirrored[ev.Type] || due != nil {
				continue
			}
			timer = time.NewTimer(h.Debounce)
			due = timer.C
		case <-due:
			due = nil
			if err := h.reload(ctx); err != nil {
				return err
			}
		case err := <-errs:
			if timer != nil {
				timer.Stop()
			}
			return err
		}
	}
}

func (h *Hub) reload(ctx context.Context) error {
	info, err := h.rt.Info(ctx)
	if err != nil {
		return err
	}
	list, err := h.rt.Containers().List(ctx)
	if err != nil {
		return err
	}
	if list == nil {
		list = []engine.Container{}
	}
	images, err := h.rt.Images().List(ctx)
	if err != nil {
		return err
	}
	if images == nil {
		images = []engine.Image{}
	}
	uses := map[string]int{}
	for _, c := range list {
		uses[c.ImageID]++
	}
	for i := range images {
		images[i].InUse = uses[images[i].ID]
	}
	// Volumes and networks are extras: an engine that can't list them still
	// gets its containers and images shown.
	volumes, err := h.rt.Volumes().List(ctx)
	if err != nil || volumes == nil {
		volumes = []engine.Volume{}
	}
	networks, err := h.rt.Networks().List(ctx)
	if err != nil || networks == nil {
		networks = []engine.Network{}
	}
	h.mu.Lock()
	h.containers = list
	h.images = images
	h.volumes = volumes
	h.networks = networks
	h.mu.Unlock()
	h.setStatus(Status{Connected: true, Info: &info})
	h.emit(EventContainers, list)
	h.emit(EventImages, images)
	h.emit(EventVolumes, volumes)
	h.emit(EventNetworks, networks)
	return nil
}

func (h *Hub) setStatus(s Status) {
	h.mu.Lock()
	h.status = s
	h.mu.Unlock()
	h.emit(EventEngine, s)
}
