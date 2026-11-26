package webserver

import (
	"net/http"
	"net/http/httputil"
	"net/url"
)

// ShareHandler serves one port of a box to the browsers signed in here,
// on a port of its own (a web page an agent shows, OpenClaw's, keeps to
// its own address and is not served under a path of this one): every
// request, websockets too, needs the sign-in of this site, sent along by
// the browser (a cookie is the host's, whatever the port). A sign-in that
// may only look is refused, as is anyone else. The request goes on to
// target as if made on the server itself: the page there sees its own
// address (127.0.0.1:port) as host and origin, as when opened on the
// server, and the browser's cookies for this site stay here.
func (s *Server) ShareHandler(target string) http.Handler {
	to := &url.URL{Scheme: "http", Host: target}
	p := &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(to)
			r.Out.Host = target
			if r.In.Header.Get("Origin") != "" {
				r.Out.Header.Set("Origin", "http://"+target)
			}
			r.Out.Header.Del("Cookie")
			r.Out.Header.Del("Authorization")
		},
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if ok, viewer := s.who(r); !ok || viewer {
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte("BoxForge에 (보기 전용이 아닌 비밀번호로) 로그인한 브라우저에서만 열립니다. BoxForge 화면에서 다시 여세요.\nOnly a browser signed in to BoxForge (not look-only) can open this. Open it again from BoxForge.\n"))
			return
		}
		p.ServeHTTP(w, r)
	})
}
