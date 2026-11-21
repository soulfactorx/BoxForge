// Package webserver serves BoxForge to a browser: the UI and, over HTTP,
// the same methods the desktop window calls.
//
// Whoever can call those methods controls the container engine, which is
// as good as being root on its machine. So, unless told it is only for
// development on this machine (Options.Open), the server lets nothing but
// the sign-in through without a session, counts wrong passwords, refuses
// requests that come from another site's page, and can speak TLS with a
// certificate of its own making.
package webserver

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"
)

// Options says how to serve.
type Options struct {
	// UI is the built pages.
	UI fs.FS
	// Open serves without sign-in: for development, on 127.0.0.1 only.
	Open bool
	// Check reports whether a password is the right one.
	Check func(password string) bool
	// CheckViewer reports whether a password is the one that lets its
	// holder look and change nothing; nil when there is no such password.
	CheckViewer func(password string) bool
	// ViewerMethods are the methods that only read: all a viewer may call.
	ViewerMethods []string
	// Secure says the server is reached over TLS: cookies are then marked
	// to travel no other way.
	Secure bool
	// Outbox is where files for the browser to fetch are written, and
	// Inbox where files it sends arrive. Empty: neither is offered.
	Outbox, Inbox string
	// Denied names methods that make no sense from a browser on another
	// machine (opening a terminal window on the server, say).
	Denied []string
}

var errorType = reflect.TypeOf((*error)(nil)).Elem()

// Server is the HTTP side of one app.
type Server struct {
	o      Options
	target reflect.Value
	denied map[string]bool

	mu       sync.Mutex
	subs     map[chan []byte]struct{}
	sessions map[string]session // by the cookie's value
	viewer   map[string]bool
	failures map[string]*failure // by client address
}

// session is one sign-in: until when, and whether it may only look.
type session struct {
	end    time.Time
	viewer bool
}

type failure struct {
	count int
	until time.Time // no sign-in before this
}

// How long a sign-in lasts, how many wrong passwords one address may give
// before it has to wait, and for how long.
const (
	sessionLife = 30 * 24 * time.Hour
	maxFailures = 5
	lockout     = time.Minute
	cookieName  = "boxforge_session"
)

// New makes the server for target, whose exported methods become
// POST /api/call/<Method>.
func New(target any, o Options) *Server {
	s := &Server{
		o: o, target: reflect.ValueOf(target), denied: map[string]bool{},
		subs: map[chan []byte]struct{}{}, sessions: map[string]session{}, failures: map[string]*failure{}, viewer: map[string]bool{},
	}
	for _, m := range o.ViewerMethods {
		s.viewer[m] = true
	}
	for _, m := range o.Denied {
		s.denied[m] = true
	}
	return s
}

// Emit sends an event to every page that is listening.
func (s *Server) Emit(event string, data any) {
	msg, err := json.Marshal(map[string]any{"event": event, "data": data})
	if err != nil {
		log.Printf("event %s: %v", event, err)
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.subs {
		select {
		case ch <- msg:
		default: // a stalled page misses an event rather than stalling the hub
		}
	}
}

// Handler is the whole site.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/session", s.session)
	mux.HandleFunc("POST /api/login", s.login)
	mux.HandleFunc("POST /api/logout", s.logout)
	mux.HandleFunc("POST /api/call/{method}", s.guard(s.call))
	mux.HandleFunc("GET /api/events", s.guard(s.events))
	mux.HandleFunc("GET /api/outbox/{name}", s.guard(s.full(s.fetch)))
	mux.HandleFunc("POST /api/upload", s.guard(s.full(s.upload)))
	mux.Handle("/", http.FileServerFS(s.o.UI))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
		if strings.HasPrefix(r.URL.Path, "/api/") {
			h.Set("Cache-Control", "no-store")
			// A page of another site must not get to make these requests
			// with this browser's sign-in.
			if r.Method != http.MethodGet && !sameOrigin(r) {
				reply(w, http.StatusForbidden, map[string]any{"error": "this request came from another site"})
				return
			}
		}
		mux.ServeHTTP(w, r)
	})
}

// sameOrigin reports whether the request was made by a page of this very
// site. Browsers say where a request comes from; a request with no such
// word is not from a page at all (a script, a test).
func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return r.Header.Get("Sec-Fetch-Site") == "" || r.Header.Get("Sec-Fetch-Site") == "same-origin" || r.Header.Get("Sec-Fetch-Site") == "none"
	}
	u, err := url.Parse(origin)
	return err == nil && u.Host == r.Host
}

func reply(w http.ResponseWriter, status int, body map[string]any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

// signedIn reports whether the request carries a session that is good.
func (s *Server) signedIn(r *http.Request) bool {
	ok, _ := s.who(r)
	return ok
}

// who reports whether the request is signed in, and whether as a viewer.
func (s *Server) who(r *http.Request) (ok, viewer bool) {
	if s.o.Open {
		return true, false
	}
	c, err := r.Cookie(cookieName)
	if err != nil {
		return false, false
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	sess, ok := s.sessions[c.Value]
	if ok && time.Now().After(sess.end) {
		delete(s.sessions, c.Value)
		ok = false
	}
	return ok, sess.viewer
}

// full lets through only a sign-in that may change things.
func (s *Server) full(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, viewer := s.who(r); viewer {
			reply(w, http.StatusForbidden, map[string]any{"error": "this sign-in may only look"})
			return
		}
		next(w, r)
	}
}

func (s *Server) guard(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.signedIn(r) {
			reply(w, http.StatusUnauthorized, map[string]any{"error": "sign in first"})
			return
		}
		next(w, r)
	}
}

// session tells the page whether it is signed in, and what kind of
// server this is.
func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	ok, viewer := s.who(r)
	body := map[string]any{"auth": ok, "remote": !s.o.Open}
	if ok {
		body["outbox"] = s.o.Outbox
		body["viewer"] = viewer
	}
	reply(w, http.StatusOK, body)
}

// client is the address a request comes from, for counting failures.
func client(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Password string `json:"password"`
	}
	_ = json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&in)
	who := client(r)
	s.mu.Lock()
	f := s.failures[who]
	if f != nil && time.Now().Before(f.until) {
		wait := int(time.Until(f.until).Seconds()) + 1
		s.mu.Unlock()
		reply(w, http.StatusTooManyRequests, map[string]any{"error": "too many wrong passwords", "wait": wait})
		return
	}
	s.mu.Unlock()

	full := s.o.Check != nil && s.o.Check(in.Password)
	viewer := !full && s.o.CheckViewer != nil && s.o.CheckViewer(in.Password)
	if !full && !viewer {
		// Slow, so that guessing is; and counted, so that it stops.
		time.Sleep(700 * time.Millisecond)
		s.mu.Lock()
		if f == nil {
			f = &failure{}
			s.failures[who] = f
		}
		f.count++
		if f.count >= maxFailures {
			f.count, f.until = 0, time.Now().Add(lockout)
		}
		s.mu.Unlock()
		log.Printf("sign-in refused for %s", who)
		reply(w, http.StatusUnauthorized, map[string]any{"error": "wrong password"})
		return
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		reply(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	id := hex.EncodeToString(raw)
	s.mu.Lock()
	delete(s.failures, who)
	s.sessions[id] = session{end: time.Now().Add(sessionLife), viewer: viewer}
	s.mu.Unlock()
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: id, Path: "/", MaxAge: int(sessionLife.Seconds()),
		HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: s.o.Secure,
	})
	if viewer {
		log.Printf("signed in to look only: %s", who)
	} else {
		log.Printf("signed in: %s", who)
	}
	reply(w, http.StatusOK, map[string]any{"auth": true, "viewer": viewer})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(cookieName); err == nil {
		s.mu.Lock()
		delete(s.sessions, c.Value)
		s.mu.Unlock()
	}
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: s.o.Secure})
	reply(w, http.StatusOK, map[string]any{"auth": false})
}

// SameSecret compares two secrets without telling, by how long it takes,
// how alike they are.
func SameSecret(a, b []byte) bool { return subtle.ConstantTimeCompare(a, b) == 1 }

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	ch := make(chan []byte, 64)
	s.mu.Lock()
	s.subs[ch] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.subs, ch)
		s.mu.Unlock()
	}()
	fl, _ := w.(http.Flusher)
	fmt.Fprint(w, ": ready\n\n")
	if fl != nil {
		fl.Flush()
	}
	// A line now and then keeps the connection from being cut as idle by
	// whatever stands between a phone and the server.
	beat := time.NewTicker(25 * time.Second)
	defer beat.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-beat.C:
			fmt.Fprint(w, ": still here\n\n")
		case msg := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", msg)
		}
		if fl != nil {
			fl.Flush()
		}
	}
}

// call invokes the method named in the path with the JSON array in the
// body as its arguments, and answers {"result": …} or {"error": "…"}.
func (s *Server) call(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("method")
	if _, viewer := s.who(r); viewer && !s.viewer[name] {
		reply(w, http.StatusOK, map[string]any{"error": "viewer"})
		return
	}
	if s.denied[name] {
		reply(w, http.StatusOK, map[string]any{"error": "this cannot be done from a browser on another machine"})
		return
	}
	m := s.target.MethodByName(name)
	if !m.IsValid() {
		reply(w, http.StatusNotFound, map[string]any{"error": "no such method"})
		return
	}
	var raw []json.RawMessage
	if err := json.NewDecoder(io.LimitReader(r.Body, 32<<20)).Decode(&raw); err != nil {
		reply(w, http.StatusBadRequest, map[string]any{"error": "body must be a JSON array of arguments"})
		return
	}
	t := m.Type()
	if len(raw) != t.NumIn() {
		reply(w, http.StatusBadRequest, map[string]any{"error": fmt.Sprintf("want %d arguments, got %d", t.NumIn(), len(raw))})
		return
	}
	args := make([]reflect.Value, len(raw))
	for i := range raw {
		p := reflect.New(t.In(i))
		if err := json.Unmarshal(raw[i], p.Interface()); err != nil {
			reply(w, http.StatusBadRequest, map[string]any{"error": fmt.Sprintf("argument %d: %v", i+1, err)})
			return
		}
		args[i] = p.Elem()
	}
	var result any
	for _, out := range m.Call(args) {
		if out.Type().Implements(errorType) {
			if !out.IsNil() {
				reply(w, http.StatusOK, map[string]any{"error": out.Interface().(error).Error()})
				return
			}
			continue
		}
		result = out.Interface()
	}
	reply(w, http.StatusOK, map[string]any{"result": result})
}

// plain reports whether name is one file's name and nothing more: no
// folder in it to climb out by.
func plain(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsAny(name, `/\`) && filepath.Base(name) == name
}

// fetch hands the browser a file the app wrote for it, once.
func (s *Server) fetch(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	if s.o.Outbox == "" || !plain(name) {
		http.NotFound(w, r)
		return
	}
	file := filepath.Join(s.o.Outbox, name)
	f, err := os.Open(file)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() {
		f.Close()
		os.Remove(file)
	}()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename*=UTF-8''"+url.PathEscape(name))
	http.ServeContent(w, r, "", st.ModTime(), f)
}

// upload takes a file from the browser (the request's body; its name in
// the X-File-Name header) and answers where it was put.
func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	if s.o.Inbox == "" {
		http.NotFound(w, r)
		return
	}
	name, err := url.PathUnescape(r.Header.Get("X-File-Name"))
	if err != nil || !plain(name) {
		reply(w, http.StatusBadRequest, map[string]any{"error": "the file has no usable name"})
		return
	}
	if err := os.MkdirAll(s.o.Inbox, 0o700); err != nil {
		reply(w, http.StatusOK, map[string]any{"error": err.Error()})
		return
	}
	file := filepath.Join(s.o.Inbox, name)
	f, err := os.OpenFile(file, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		reply(w, http.StatusOK, map[string]any{"error": err.Error()})
		return
	}
	_, err = io.Copy(f, r.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(file)
		reply(w, http.StatusOK, map[string]any{"error": err.Error()})
		return
	}
	reply(w, http.StatusOK, map[string]any{"result": file})
}
