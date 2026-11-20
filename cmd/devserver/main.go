// devserver serves the UI and the app's bindings over HTTP, for working on
// the UI in an ordinary browser and for browser tests, on machines where
// the desktop shell can't be built. Development only: anyone who can reach
// its port controls the engine, so it listens on 127.0.0.1 and nowhere else.
//
//	go run ./cmd/devserver                      # real Docker
//	BOXFORGE_ENGINE=fake go run ./cmd/devserver # in-memory engine
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"reflect"
	"sync"

	"github.com/soulfactorx/boxforge/internal/app"
)

var errorType = reflect.TypeOf((*error)(nil)).Elem()

// broker fans events out to every open /api/events stream.
type broker struct {
	mu   sync.Mutex
	subs map[chan []byte]struct{}
}

func (b *broker) emit(event string, data any) {
	msg, err := json.Marshal(map[string]any{"event": event, "data": data})
	if err != nil {
		log.Printf("event %s: %v", event, err)
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	for ch := range b.subs {
		select {
		case ch <- msg:
		default: // a stalled page misses an event rather than stalling the hub
		}
	}
}

func (b *broker) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	ch := make(chan []byte, 64)
	b.mu.Lock()
	b.subs[ch] = struct{}{}
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.subs, ch)
		b.mu.Unlock()
	}()
	fl, _ := w.(http.Flusher)
	fmt.Fprint(w, ": ready\n\n")
	if fl != nil {
		fl.Flush()
	}
	for {
		select {
		case <-r.Context().Done():
			return
		case msg := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", msg)
			if fl != nil {
				fl.Flush()
			}
		}
	}
}

// call invokes the bound method named in the path with the JSON array in
// the body as its arguments, and answers {"result": …} or {"error": "…"}.
func call(target any) http.HandlerFunc {
	v := reflect.ValueOf(target)
	return func(w http.ResponseWriter, r *http.Request) {
		reply := func(status int, body map[string]any) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(body)
		}
		m := v.MethodByName(r.PathValue("method"))
		if !m.IsValid() {
			reply(http.StatusNotFound, map[string]any{"error": "no such method"})
			return
		}
		var raw []json.RawMessage
		if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
			reply(http.StatusBadRequest, map[string]any{"error": "body must be a JSON array of arguments"})
			return
		}
		t := m.Type()
		if len(raw) != t.NumIn() {
			reply(http.StatusBadRequest, map[string]any{"error": fmt.Sprintf("want %d arguments, got %d", t.NumIn(), len(raw))})
			return
		}
		args := make([]reflect.Value, len(raw))
		for i := range raw {
			p := reflect.New(t.In(i))
			if err := json.Unmarshal(raw[i], p.Interface()); err != nil {
				reply(http.StatusBadRequest, map[string]any{"error": fmt.Sprintf("argument %d: %v", i+1, err)})
				return
			}
			args[i] = p.Elem()
		}
		var result any
		for _, out := range m.Call(args) {
			if out.Type().Implements(errorType) {
				if !out.IsNil() {
					reply(http.StatusOK, map[string]any{"error": out.Interface().(error).Error()})
					return
				}
				continue
			}
			result = out.Interface()
		}
		reply(http.StatusOK, map[string]any{"result": result})
	}
}

func main() {
	port := flag.Int("port", 34116, "port on 127.0.0.1")
	dist := flag.String("dist", "frontend/dist", "built UI to serve")
	flag.Parse()

	a, err := app.New()
	if err != nil {
		log.Fatal(err)
	}
	b := &broker{subs: map[chan []byte]struct{}{}}
	app.Start(a, b.emit)
	defer app.Stop(a)

	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/call/{method}", call(a))
	mux.HandleFunc("GET /api/events", b.serve)
	mux.Handle("/", http.FileServer(http.Dir(*dist)))
	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	log.Printf("BoxForge dev server on http://%s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
}
