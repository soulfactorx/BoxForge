// boxforge-server is BoxForge without a window: it runs on the machine
// that has the container engine and is used from a browser, on a phone or
// another PC.
//
//	boxforge-server                       # this machine only (127.0.0.1:8088)
//	boxforge-server -listen :8088 -tls    # the network, over TLS
//	boxforge-server -set-password         # choose the password
//
// Whoever signs in controls the engine, which is as good as being root
// on this machine: see docs/SERVER.md before opening it to a network.
package main

import (
	"bufio"
	"crypto/tls"
	"flag"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/soulfactorx/boxforge/frontend"
	"github.com/soulfactorx/boxforge/internal/app"
	"github.com/soulfactorx/boxforge/internal/version"
	"github.com/soulfactorx/boxforge/internal/webserver"
)

func main() {
	listen := flag.String("listen", "127.0.0.1:8088", "address to listen on; \":8088\" for every network of this machine")
	useTLS := flag.Bool("tls", false, "serve over TLS with a certificate of the server's own making")
	certFile := flag.String("cert", "", "TLS certificate file (with -key), in place of the server's own")
	keyFile := flag.String("key", "", "TLS key file")
	setPassword := flag.Bool("set-password", false, "choose the password and exit")
	newPassword := flag.Bool("new-password", false, "make up a new password, show it and exit")
	insecure := flag.Bool("insecure-network", false, "allow listening on a network without TLS (a proxy in front provides it)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()
	if *showVersion {
		fmt.Println(version.Version)
		return
	}

	cfg, err := os.UserConfigDir()
	if err != nil {
		log.Fatal(err)
	}
	dir := filepath.Join(cfg, "BoxForge")
	passwords := webserver.PasswordsIn(dir)
	switch {
	case *setPassword:
		fmt.Print("새 비밀번호 (8자 이상): ")
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		if err := passwords.Set(strings.TrimRight(line, "\r\n")); err != nil {
			log.Fatal(err)
		}
		fmt.Println("비밀번호를 바꿨습니다.")
		return
	case *newPassword:
		pw, err := passwords.Generate()
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println("새 비밀번호:", pw)
		return
	}

	host, _, err := net.SplitHostPort(*listen)
	if err != nil {
		log.Fatalf("-listen %q: %v", *listen, err)
	}
	local := host == "localhost" || (net.ParseIP(host) != nil && net.ParseIP(host).IsLoopback())
	secure := *useTLS || *certFile != ""
	if !local && !secure && !*insecure {
		log.Fatal("네트워크에 열려면 -tls 를 함께 주세요. 암호화 없이는 비밀번호와 모든 조작이 같은 네트워크의 누구에게나 보입니다.\n" +
			"(앞단의 프록시나 VPN이 암호화를 맡는다면 -insecure-network 로 넘어갈 수 있습니다.)")
	}

	fresh := ""
	if env := os.Getenv("BOXFORGE_PASSWORD"); env != "" {
		if err := passwords.Set(env); err != nil {
			log.Fatal("BOXFORGE_PASSWORD: ", err)
		}
	} else if !passwords.Exists() {
		if fresh, err = passwords.Generate(); err != nil {
			log.Fatal(err)
		}
	}

	ui, err := fs.Sub(frontend.Dist, "dist")
	if err != nil {
		log.Fatal(err)
	}
	tmp := filepath.Join(os.TempDir(), "boxforge-server")
	outbox, inbox := filepath.Join(tmp, "out"), filepath.Join(tmp, "in")
	// What an earlier run left to be fetched or sent is not kept.
	_ = os.RemoveAll(tmp)
	if err := os.MkdirAll(outbox, 0o700); err != nil {
		log.Fatal(err)
	}
	app.SetRemote(outbox)
	a, err := app.New()
	if err != nil {
		log.Fatal(err)
	}
	srv := webserver.New(a, webserver.Options{
		UI: ui, Check: passwords.Check, Secure: secure, Outbox: outbox, Inbox: inbox,
		// A window on the server's own screen, and replacing the server's
		// program with the desktop one, are not for a browser elsewhere.
		Denied: []string{"OpenTerminal", "Restart", "ApplyUpdate", "CloseTo", "SetupStart"},
	})
	app.Start(a, srv.Emit)
	defer app.Stop(a)

	hs := &http.Server{Addr: *listen, Handler: srv.Handler(), ReadHeaderTimeout: 15 * time.Second}
	scheme := "http"
	if secure {
		scheme = "https"
	}
	fmt.Printf("BoxForge 서버 %s\n", version.Version)
	for _, addr := range addresses(host, *listen) {
		fmt.Printf("  %s://%s\n", scheme, addr)
	}
	if fresh != "" {
		fmt.Printf("\n비밀번호: %s\n(처음 한 번만 보여 줍니다. 바꾸려면 -set-password, 잊었으면 -new-password)\n", fresh)
	}
	if *certFile != "" {
		log.Fatal(hs.ListenAndServeTLS(*certFile, *keyFile))
	}
	if *useTLS {
		cert, print, err := webserver.Certificate(dir)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("\n이 서버가 직접 만든 인증서를 씁니다. 브라우저가 처음에 경고를 보여 주면,\n인증서의 SHA-256 지문이 아래와 같은지 확인하고 계속하세요.\n  %s\n", print)
		hs.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
		log.Fatal(hs.ListenAndServeTLS("", ""))
	}
	log.Fatal(hs.ListenAndServe())
}

// addresses lists where the server can be reached, for telling the user.
func addresses(host, listen string) []string {
	_, port, _ := net.SplitHostPort(listen)
	if host != "" && host != "0.0.0.0" && host != "::" {
		return []string{listen}
	}
	out := []string{net.JoinHostPort("localhost", port)}
	if addrs, err := net.InterfaceAddrs(); err == nil {
		for _, a := range addrs {
			if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && n.IP.To4() != nil {
				out = append(out, net.JoinHostPort(n.IP.String(), port))
			}
		}
	}
	return out
}
