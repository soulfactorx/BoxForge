package hub

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/soulfactorx/boxforge/internal/engine"
	"github.com/soulfactorx/boxforge/internal/engine/fake"
)

// collect records emitted container lists.
type collect struct {
	mu    sync.Mutex
	lists [][]engine.Container
}

func (c *collect) emit(event string, data any) {
	if event != EventContainers {
		return
	}
	c.mu.Lock()
	c.lists = append(c.lists, data.([]engine.Container))
	c.mu.Unlock()
}

func (c *collect) waitFor(t *testing.T, ok func([]engine.Container) bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		c.mu.Lock()
		n := len(c.lists)
		var last []engine.Container
		if n > 0 {
			last = c.lists[n-1]
		}
		c.mu.Unlock()
		if n > 0 && ok(last) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("the expected container list was never emitted")
}

func find(list []engine.Container, id string) *engine.Container {
	for i := range list {
		if list[i].ID == id {
			return &list[i]
		}
	}
	return nil
}

func TestHubPushesChangesMadeOutsideIt(t *testing.T) {
	rt := fake.New()
	var c collect
	h := New(rt, c.emit)
	h.Debounce = 5 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go h.Run(ctx)

	c.waitFor(t, func(l []engine.Container) bool { return find(l, "a1") != nil })
	if !h.Status().Connected {
		t.Fatal("hub is not connected after its first load")
	}

	// The change goes to the engine directly, as a terminal command would.
	if err := rt.Containers().Rename(ctx, "a1", "frontend"); err != nil {
		t.Fatal(err)
	}
	c.waitFor(t, func(l []engine.Container) bool {
		it := find(l, "a1")
		return it != nil && it.Name == "frontend"
	})

	if err := rt.Containers().Remove(ctx, "a5", false, false); err != nil {
		t.Fatal(err)
	}
	c.waitFor(t, func(l []engine.Container) bool { return find(l, "a5") == nil })
}
