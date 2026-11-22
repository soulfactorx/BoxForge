// boxforge-server is BoxForge without a window: it runs on the machine
// that has the container engine and is used from a browser, on a phone or
// another PC.
//
//	boxforge-server                       # this machine only (127.0.0.1:8088)
//	boxforge-server -listen :8088 -tls    # the network, over TLS
//	boxforge-server -set-password         # choose the password
//	boxforge-server -daemon -listen :8088 -tls   # in the background, now
//	boxforge-server -stop | -status
//	boxforge-server -update               # the newest version, now
//	sudo boxforge-server -install         # a service that starts with the machine
//	sudo boxforge-server -uninstall
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
	"strconv"
	"strings"
	"time"

	"github.com/soulfactorx/boxforge/frontend"
	"github.com/soulfactorx/boxforge/internal/app"
	"github.com/soulfactorx/boxforge/internal/update"
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
	setViewer := flag.Bool("set-viewer-password", false, "choose a second password that can look but change nothing, and exit (empty: remove it)")
	insecure := flag.Bool("insecure-network", false, "allow listening on a network without TLS (a proxy in front provides it)")
	showVersion := flag.Bool("version", false, "print the version and exit")
	daemon := flag.Bool("daemon", false, "run in the background (with the other options given), its output in server.log; -stop ends it")
	stop := flag.Bool("stop", false, "end the server -daemon started")
	status := flag.Bool("status", false, "say whether the server runs (in the background or as a service)")
	doInstall := flag.Bool("install", false, "as root: put the program in "+installDir+" and make it a service (systemd or OpenRC) that starts with the machine, then start it; without -listen it serves every network over TLS on 8088")
	doUninstall := flag.Bool("uninstall", false, "as root: stop and remove the service (the program and settings stay)")
	doUpdate := flag.Bool("update", false, "fetch the newest release's server program in place of this one (checked against its checksums), then start the running server (-daemon or service) again on it")
	forceUpdate := flag.Bool("force", false, "with -update: fetch the newest even when this one is as new")
	runAs := flag.String("user", "", "with -install: the user the service runs as (default: the one who ran sudo)")
	flag.Parse()
	if *showVersion {
		fmt.Println(version.Version)
		return
	}
	if *doInstall || *doUninstall {
		var err error
		if *doInstall {
			set := map[string]string{}
			flag.Visit(func(f *flag.Flag) { set[f.Name] = f.Value.String() })
			err = install(*runAs, set)
		} else {
			err = uninstall()
		}
		if err != nil {
			log.SetFlags(0)
			log.Fatal(err)
		}
		return
	}

	cfg, err := os.UserConfigDir()
	if err != nil {
		log.Fatal(err)
	}
	dir := filepath.Join(cfg, "BoxForge")
	passwords := webserver.PasswordsIn(dir)
	if *doUpdate {
		log.SetFlags(0)
		if err := selfUpdate(dir, *forceUpdate); err != nil {
			log.Fatal(err)
		}
		return
	}
	if *daemon || *stop || *status {
		log.SetFlags(0)
		switch {
		case *stop:
			if err := stopDaemon(dir); err != nil {
				log.Fatal(err)
			}
		case *status:
			showStatus(dir)
		default:
			if err := startDaemon(dir, withoutFlag(os.Args[1:], "daemon")); err != nil {
				log.Fatal(err)
			}
		}
		return
	}
	switch {
	case *setPassword:
		fmt.Print("새 비밀번호 (8자 이상): ")
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		if err := passwords.Set(strings.TrimRight(line, "\r\n")); err != nil {
			log.Fatal(err)
		}
		fmt.Println("비밀번호를 바꿨습니다.")
		return
	case *setViewer:
		viewers := webserver.ViewerPasswordsIn(dir)
		fmt.Print("보기 전용 비밀번호 (8자 이상, 비워 두면 없앰): ")
		line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if err := viewers.Clear(); err != nil {
				log.Fatal(err)
			}
			fmt.Println("보기 전용 비밀번호를 없앴습니다.")
			return
		}
		if passwords.Check(line) {
			log.Fatal("관리용 비밀번호와 같은 것은 쓸 수 없습니다.")
		}
		if err := viewers.Set(line); err != nil {
			log.Fatal(err)
		}
		fmt.Println("보기 전용 비밀번호를 정했습니다.")
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
	// One for each user: a folder another user (root, trying it out once)
	// left in a shared /tmp can't be written to.
	tmp := filepath.Join(os.TempDir(), "boxforge-server")
	if uid := os.Getuid(); uid >= 0 {
		tmp += "-" + strconv.Itoa(uid)
	}
	outbox, inbox := filepath.Join(tmp, "out"), filepath.Join(tmp, "in")
	// What an earlier run left to be fetched or sent is not kept.
	_ = os.RemoveAll(tmp)
	if err := os.MkdirAll(outbox, 0o700); err != nil {
		log.Fatal(err)
	}
	app.SetRemote(outbox)
	os.Setenv("BOXFORGE_INBOX", inbox)
	// The server updates itself with the server's program, and starts
	// afresh as it was started: same arguments, same address.
	update.Server = true
	var hs *http.Server
	app.SetRestart(func() error {
		exe, err := update.Program()
		if err != nil {
			return err
		}
		go func() {
			time.Sleep(500 * time.Millisecond) // let the answer to this very call go out
			if hs != nil {
				_ = hs.Close() // the port, free for the new one
			}
			if err := again(exe); err != nil {
				log.Fatalf("could not start afresh: %v; start the server by hand", err)
			}
		}()
		return nil
	})
	a, err := app.New()
	if err != nil {
		log.Fatal(err)
	}
	srv := webserver.New(a, webserver.Options{
		UI: ui, Check: passwords.Check, Secure: secure, Outbox: outbox, Inbox: inbox,
		CheckViewer: viewerCheck(dir), ViewerMethods: lookOnly,
		// A window on the server's own screen is not for a browser elsewhere.
		Denied: []string{"OpenTerminal", "CloseTo", "SetupStart", "SetSignIn"},
	})
	app.Start(a, srv.Emit)
	defer app.Stop(a)
	notePid(dir)

	hs = &http.Server{Addr: *listen, Handler: srv.Handler(), ReadHeaderTimeout: 15 * time.Second}
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
		served(hs.ListenAndServeTLS(*certFile, *keyFile))
		return
	}
	if *useTLS {
		cert, print, err := webserver.Certificate(dir)
		if err != nil {
			log.Fatal(err)
		}
		fmt.Printf("\n이 서버가 직접 만든 인증서를 씁니다. 브라우저가 처음에 경고를 보여 주면,\n인증서의 SHA-256 지문이 아래와 같은지 확인하고 계속하세요.\n  %s\n", print)
		hs.TLSConfig = &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}
		served(hs.ListenAndServeTLS("", ""))
		return
	}
	served(hs.ListenAndServe())
}

// withoutFlag is the arguments with -name (or --name, -name=…) taken out.
func withoutFlag(args []string, name string) []string {
	out := []string{}
	for _, a := range args {
		bare := strings.TrimLeft(a, "-")
		if strings.HasPrefix(a, "-") && (bare == name || strings.HasPrefix(bare, name+"=")) {
			continue
		}
		out = append(out, a)
	}
	return out
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

// served waits after the server stops: closed on purpose (to start
// afresh), the new program takes over from here; anything else is fatal.
func served(err error) {
	if err == http.ErrServerClosed {
		select {}
	}
	log.Fatal(err)
}

// viewerCheck is the check of the look-only password, nil when none is set.
func viewerCheck(dir string) func(string) bool {
	viewers := webserver.ViewerPasswordsIn(dir)
	if env := os.Getenv("BOXFORGE_VIEWER_PASSWORD"); env != "" {
		if err := viewers.Set(env); err != nil {
			log.Fatal("BOXFORGE_VIEWER_PASSWORD: ", err)
		}
	}
	if !viewers.Exists() {
		return nil
	}
	return viewers.Check
}

// lookOnly is what a look-only sign-in may call: the methods that read
// lists, states, logs and figures, and change nothing. Reading files out
// of containers and volumes, terminals and the cluster's credentials are
// left out on purpose.
var lookOnly = []string{
	"Engine", "Engines", "EngineLabel", "MemoryUsed", "Version", "CheckUpdate", "Setting", "Network", "Tray", "SetupStatus", "DockerCLI",
	"Containers", "InspectContainer", "StartLogs", "StopLogs", "StartStats", "StopStats", "ContainerSizes",
	"Images", "ImageDefaults", "ImageHistory", "SearchImages", "Volumes", "VolumeSizes", "Networks", "DiskUsage", "Registries",
	"ComposeVersion", "ComposeLogs",
	"Refresh", "KubeStatus", "KubeLogTail", "KubeGet", "KubeYAML", "KubeDescribe", "KubeLogs", "KubeForwards",
}
