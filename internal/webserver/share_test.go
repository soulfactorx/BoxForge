package webserver

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestShareHandler(t *testing.T) {
	var got *http.Request
	box := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r
		_, _ = w.Write([]byte("the agent's page"))
	}))
	defer box.Close()
	target := strings.TrimPrefix(box.URL, "http://")
	s := New(struct{}{}, Options{Check: func(p string) bool { return p == "pw" }, CheckViewer: func(p string) bool { return p == "look" }})
	share := httptest.NewServer(s.ShareHandler(target))
	defer share.Close()

	get := func(cookie string) (int, string) {
		req, _ := http.NewRequest("GET", share.URL+"/x?y=1", nil)
		req.Header.Set("Origin", "https://vm.example:18789")
		if cookie != "" {
			req.AddCookie(&http.Cookie{Name: cookieName, Value: cookie})
		}
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		b, _ := io.ReadAll(res.Body)
		return res.StatusCode, string(b)
	}
	// Not signed in, or a made-up cookie: not let through.
	for _, c := range []string{"", "nonsense"} {
		if code, _ := get(c); code != http.StatusForbidden || got != nil {
			t.Fatalf("cookie %q: %d, reached the box: %v", c, code, got != nil)
		}
	}
	sign := func(pw string) string {
		h := s.Handler()
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"password":"`+pw+`"}`)))
		for _, c := range rec.Result().Cookies() {
			if c.Name == cookieName {
				return c.Value
			}
		}
		t.Fatalf("no sign-in for %q: %d %s", pw, rec.Code, rec.Body.String())
		return ""
	}
	// A look-only sign-in: not let through either.
	if code, _ := get(sign("look")); code != http.StatusForbidden || got != nil {
		t.Fatalf("viewer: %d", code)
	}
	// Signed in: the box's page, asked as on the server; this site's cookie stays here.
	code, body := get(sign("pw"))
	if code != 200 || body != "the agent's page" || got == nil {
		t.Fatalf("signed in: %d %q", code, body)
	}
	if got.Host != target || got.Header.Get("Origin") != "http://"+target || got.Header.Get("Cookie") != "" || got.URL.RequestURI() != "/x?y=1" {
		t.Fatalf("as the box saw it: host %q origin %q cookie %q uri %q", got.Host, got.Header.Get("Origin"), got.Header.Get("Cookie"), got.URL.RequestURI())
	}
}
