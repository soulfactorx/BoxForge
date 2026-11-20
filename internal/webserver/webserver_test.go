package webserver

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
)

type target struct{}

func (target) Hello(name string) string { return "hello " + name }
func (target) Secret() string           { return "s" }

func server(t *testing.T, o Options) *httptest.Server {
	t.Helper()
	o.UI = fstest.MapFS{"index.html": {Data: []byte("page")}}
	ts := httptest.NewServer(New(target{}, o).Handler())
	t.Cleanup(ts.Close)
	return ts
}

func post(t *testing.T, c *http.Client, url, body string, header ...string) (int, string) {
	t.Helper()
	req, _ := http.NewRequest("POST", url, strings.NewReader(body))
	for i := 0; i+1 < len(header); i += 2 {
		req.Header.Set(header[i], header[i+1])
	}
	res, err := c.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	b := make([]byte, 4096)
	n, _ := res.Body.Read(b)
	return res.StatusCode, string(b[:n])
}

func TestSignIn(t *testing.T) {
	ts := server(t, Options{Check: func(p string) bool { return p == "right-one" }, Denied: []string{"Secret"}})
	jar := &cookies{}
	c := &http.Client{Jar: jar}

	if code, _ := post(t, c, ts.URL+"/api/call/Hello", `["x"]`); code != http.StatusUnauthorized {
		t.Errorf("a call without sign-in: %d", code)
	}
	if res, _ := c.Get(ts.URL + "/api/events"); res.StatusCode != http.StatusUnauthorized {
		t.Errorf("events without sign-in: %d", res.StatusCode)
	}
	if res, _ := c.Get(ts.URL + "/"); res.StatusCode != http.StatusOK {
		t.Errorf("the page itself: %d", res.StatusCode)
	}
	if code, _ := post(t, c, ts.URL+"/api/login", `{"password":"wrong"}`); code != http.StatusUnauthorized {
		t.Errorf("a wrong password: %d", code)
	}
	if code, _ := post(t, c, ts.URL+"/api/login", `{"password":"right-one"}`); code != http.StatusOK {
		t.Fatalf("the right password: %d", code)
	}
	if code, body := post(t, c, ts.URL+"/api/call/Hello", `["x"]`); code != http.StatusOK || !strings.Contains(body, "hello x") {
		t.Errorf("a call when signed in: %d %s", code, body)
	}
	if _, body := post(t, c, ts.URL+"/api/call/Secret", `[]`); !strings.Contains(body, "cannot be done") {
		t.Errorf("a denied method answered: %s", body)
	}
	if code, _ := post(t, c, ts.URL+"/api/call/Hello", `["x"]`, "Origin", "https://elsewhere.example"); code != http.StatusForbidden {
		t.Errorf("a request from another site's page: %d", code)
	}
	if code, _ := post(t, c, ts.URL+"/api/logout", ``); code != http.StatusOK {
		t.Errorf("sign-out: %d", code)
	}
	if code, _ := post(t, c, ts.URL+"/api/call/Hello", `["x"]`); code != http.StatusUnauthorized {
		t.Errorf("a call after sign-out: %d", code)
	}
}

func TestOutboxKeepsToItsFolder(t *testing.T) {
	dir := t.TempDir()
	out := filepath.Join(dir, "out")
	_ = os.MkdirAll(out, 0o700)
	_ = os.WriteFile(filepath.Join(dir, "private"), []byte("no"), 0o600)
	_ = os.WriteFile(filepath.Join(out, "a.txt"), []byte("yes"), 0o600)
	ts := server(t, Options{Open: true, Outbox: out, Inbox: filepath.Join(dir, "in")})
	for _, name := range []string{"..%2fprivate", "%2e%2e%2fprivate", "..", "."} {
		if res, _ := http.Get(ts.URL + "/api/outbox/" + name); res.StatusCode == http.StatusOK {
			t.Errorf("%s was served", name)
		}
	}
	if res, _ := http.Get(ts.URL + "/api/outbox/a.txt"); res.StatusCode != http.StatusOK {
		t.Errorf("a file of the outbox: %d", res.StatusCode)
	}
	if _, err := os.Stat(filepath.Join(out, "a.txt")); err == nil {
		t.Error("a fetched file stays on the server")
	}
	if _, body := post(t, http.DefaultClient, ts.URL+"/api/upload", "x", "X-File-Name", "..%2Fevil"); !strings.Contains(body, "no usable name") {
		t.Errorf("an upload with a path for a name: %s", body)
	}
	if _, body := post(t, http.DefaultClient, ts.URL+"/api/upload", "data", "X-File-Name", "ok.boxforge"); !strings.Contains(body, "ok.boxforge") {
		t.Errorf("an upload: %s", body)
	}
}

func TestPasswords(t *testing.T) {
	p := PasswordsIn(t.TempDir())
	if p.Exists() || p.Check("") {
		t.Error("a password before one is set")
	}
	if err := p.Set("short"); err == nil {
		t.Error("a short password was taken")
	}
	pw, err := p.Generate()
	if err != nil || len(pw) < 20 {
		t.Fatalf("generate: %q %v", pw, err)
	}
	if !p.Check(pw) || p.Check(pw+"x") || p.Check("") {
		t.Error("check does not tell the password from others")
	}
}

// cookies is a jar that keeps one site's cookies, enough for the tests.
type cookies struct{ list []*http.Cookie }

func (c *cookies) SetCookies(_ *url.URL, list []*http.Cookie) {
	for _, n := range list {
		kept := c.list[:0]
		for _, have := range c.list {
			if have.Name != n.Name {
				kept = append(kept, have)
			}
		}
		c.list = kept
		if n.MaxAge >= 0 {
			c.list = append(c.list, n)
		}
	}
}
func (c *cookies) Cookies(*url.URL) []*http.Cookie { return c.list }
