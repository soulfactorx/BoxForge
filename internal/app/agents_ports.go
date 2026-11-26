package app

// A box's ports, open on this PC while BoxForge runs. Docker fixes a
// container's published ports when it is made, so adding one would mean
// making the box again; and on "AI services only" the box's network can't
// publish any. Instead BoxForge listens on this PC and carries each
// connection into the box through the engine (as Kubernetes ports are),
// to the port on the box's own localhost: a port is opened or closed at
// once, on any of the box's networks, and a program that listens only on
// localhost (OpenClaw's gateway does) is reached all the same.

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// AgentPort is one of a box's ports and where it is open on this PC
// (0 while it isn't).
type AgentPort struct {
	Port   int `json:"port"`
	Local  int `json:"local"`
	Shared int `json:"shared"` // open to other devices on this web server's port (0: not)
}

type boxPort struct {
	local int
	ln    net.Listener
	stop  context.CancelFunc
}

var boxPorts = struct {
	sync.Mutex
	all map[string]*boxPort // by box name and port: "name:port"
}{all: map[string]*boxPort{}}

// boxRelay carries one connection to a port on the box's localhost: with
// node where the box has it (every box BoxForge builds), else with nc as
// the Kubernetes relay does.
const boxRelay = `if command -v node >/dev/null 2>&1; then
exec node -e 'const s=require("net").connect(+process.argv[1],"127.0.0.1");process.stdin.pipe(s);s.pipe(process.stdout);s.on("error",()=>process.exit(1));s.on("close",()=>process.exit(0))' "$1"
fi
set -- 127.0.0.1 "$1"
` + forwardRelay

// portHolderName is the container a box's ports are in: the service's
// when it has one (a gateway's page), else the box's own. The browser box
// shares that container's network, so its port is there too.
func portHolderName(s AgentSpec) string { return agentProject(s.Name) + "-" + portHolder(s) }

// browserPort is the browser box's own page, in the holder's network.
const browserPort = 5800

// AgentPortOpen opens one of a box's ports on this PC: the same number
// when it is free, else the next free one. It returns where.
func (a *App) AgentPortOpen(name string, port int) (int, error) {
	s, _, err := readAgent(name)
	if err != nil {
		return 0, err
	}
	if port < 1 || port > 65535 {
		return 0, fmt.Errorf("%d is not a port", port)
	}
	key := fmt.Sprintf("%s:%d", name, port)
	boxPorts.Lock()
	if p := boxPorts.all[key]; p != nil {
		boxPorts.Unlock()
		return p.local, nil
	}
	boxPorts.Unlock()
	var ln net.Listener
	if shareHook != nil {
		// On the web server the number is for other devices (the shared
		// port, on every address): kept free for it, this one takes any.
		ln, err = net.Listen("tcp", "127.0.0.1:0")
	} else {
		for try := port; try < port+20 && try <= 65535; try++ {
			if ln, err = net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(try))); err == nil {
				break
			}
		}
	}
	if ln == nil {
		return 0, fmt.Errorf("ports %d to %d on this PC are all in use by other programs", port, min(port+19, 65535))
	}
	run, stop := context.WithCancel(context.Background())
	p := &boxPort{local: ln.Addr().(*net.TCPAddr).Port, ln: ln, stop: stop}
	boxPorts.Lock()
	if old := boxPorts.all[key]; old != nil { // opened meanwhile
		boxPorts.Unlock()
		stop()
		ln.Close()
		return old.local, nil
	}
	boxPorts.all[key] = p
	boxPorts.Unlock()
	rt := a.eng()
	holder := portHolderName(s)
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go carryIn(run, rt, holder, conn, []string{"sh", "-c", boxRelay, "sh", strconv.Itoa(port)})
		}
	}()
	return p.local, nil
}

// AgentPortClose closes one of a box's ports on this PC.
func (a *App) AgentPortClose(name string, port int) {
	key := fmt.Sprintf("%s:%d", name, port)
	unshare(key, true)
	boxPorts.Lock()
	p := boxPorts.all[key]
	delete(boxPorts.all, key)
	boxPorts.Unlock()
	if p != nil {
		p.stop()
		p.ln.Close()
	}
}

// closeBoxPorts closes all of a box's ports (it is being taken away).
func closeBoxPorts(name string) {
	unshare(name+":", false)
	boxPorts.Lock()
	var gone []*boxPort
	for k, p := range boxPorts.all {
		if strings.HasPrefix(k, name+":") {
			gone = append(gone, p)
			delete(boxPorts.all, k)
		}
	}
	boxPorts.Unlock()
	for _, p := range gone {
		p.stop()
		p.ln.Close()
	}
}

// AgentPorts lists a box's ports (those its settings name, and any opened
// besides) and where each is open now.
func (a *App) AgentPorts(name string) ([]AgentPort, error) {
	s, _, err := readAgent(name)
	if err != nil {
		return nil, err
	}
	seen := map[int]bool{}
	out := []AgentPort{}
	boxPorts.Lock()
	for _, port := range s.Ports {
		if !seen[port] {
			seen[port] = true
			ap := AgentPort{Port: port}
			if p := boxPorts.all[fmt.Sprintf("%s:%d", name, port)]; p != nil {
				ap.Local = p.local
			}
			shares.Lock()
			if sp := shares.all[fmt.Sprintf("%s:%d", name, port)]; sp != nil {
				ap.Shared = sp.ext
			}
			shares.Unlock()
			out = append(out, ap)
		}
	}
	boxPorts.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].Port < out[j].Port })
	return out, nil
}

// AgentPortsEnsure opens every port a box's settings name: done when its
// control panel is opened and the box runs (after BoxForge started again).
func (a *App) AgentPortsEnsure(name string) ([]AgentPort, error) {
	s, _, err := readAgent(name)
	if err != nil {
		return nil, err
	}
	for _, port := range s.Ports {
		if _, err := a.AgentPortOpen(name, port); err != nil {
			return nil, err
		}
	}
	return a.AgentPorts(name)
}

// AgentPortAdd adds a port to a box's settings and opens it, the box
// running on as it is: nothing is made again.
func (a *App) AgentPortAdd(name string, port int) (int, error) {
	s, dir, err := readAgent(name)
	if err != nil {
		return 0, err
	}
	if port < 1 || port > 65535 {
		return 0, fmt.Errorf("%d is not a port", port)
	}
	have := false
	for _, p := range s.Ports {
		have = have || p == port
	}
	if !have {
		s.Ports = append(s.Ports, port)
		if err := writeAgentSpec(dir, s); err != nil {
			return 0, err
		}
	}
	return a.AgentPortOpen(name, port)
}

// AgentPortRemove takes a port out of a box's settings and closes it.
func (a *App) AgentPortRemove(name string, port int) error {
	s, dir, err := readAgent(name)
	if err != nil {
		return err
	}
	var kept []int
	for _, p := range s.Ports {
		if p != port {
			kept = append(kept, p)
		}
	}
	s.Ports = kept
	a.AgentPortClose(name, port)
	return writeAgentSpec(dir, s)
}

var webURL = regexp.MustCompile(`^https?://[^\s"'\\<>]+$`)

// AgentBrowserOpen shows an address in the box's browser: written as the
// start page in its profile, and the browser started again (the image
// starts it again by itself when it ends). A new profile's first-run pages
// (welcome, import) would come first: they are turned off with it. Its page
// then opens on this PC.
// It returns where that page is open.
func (a *App) AgentBrowserOpen(name, url string) (int, error) {
	s, _, err := readAgent(name)
	if err != nil {
		return 0, err
	}
	if !s.Browser {
		return 0, fmt.Errorf("the box has no browser box: turn it on in the box's settings")
	}
	if url != "" {
		if !webURL.MatchString(url) {
			return 0, fmt.Errorf("%q is not a web address", url)
		}
		script := `p=/config/profile
[ -d "$p" ] || exit 3
cat > "$p/user.js" <<EOF
user_pref("browser.startup.page", 1);
user_pref("browser.startup.homepage", "$1");
user_pref("browser.sessionstore.resume_from_crash", false);
user_pref("browser.startup.firstrunSkipsHomepage", false);
user_pref("browser.aboutwelcome.enabled", false);
user_pref("trailhead.firstrun.didSeeAboutWelcome", true);
user_pref("browser.startup.homepage_override.mstone", "ignore");
user_pref("startup.homepage_welcome_url", "");
user_pref("startup.homepage_welcome_url.additional", "");
user_pref("browser.shell.checkDefaultBrowser", false);
user_pref("datareporting.policy.dataSubmissionPolicyBypassNotification", true);
EOF
for d in /proc/[0-9]*; do
  c=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)
  case "$c" in *"firefox --profile $p"*setDefaultBrowser*) kill "${d#/proc/}";; esac
done
true`
		// Just made, it sets itself up first (its profile comes with its
		// first start): waited for, as a person would wait.
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		var errOut string
		var code int
		for {
			_, errOut, code, err = a.eng().Containers().Output(ctx, agentProject(name)+"-browser", []string{"sh", "-c", script, "boxforge", url}, nil)
			if err != nil || code != 3 {
				break
			}
			select {
			case <-ctx.Done():
				return 0, fmt.Errorf("브라우저 상자가 아직 준비되지 않았습니다(1분 넘게 시작하는 중). 잠시 뒤 다시 눌러 주세요")
			case <-time.After(2 * time.Second):
			}
		}
		if err != nil {
			return 0, err
		}
		if code != 0 {
			return 0, fmt.Errorf("the browser box couldn't be told the address: %s", strings.TrimSpace(errOut))
		}
	}
	local, err := a.AgentPortOpen(name, browserPort)
	if err != nil {
		return 0, err
	}
	// Its page comes up a little after the box does: answered before it is
	// opened, so that a page that can't load yet isn't what is shown.
	client := &http.Client{Timeout: 3 * time.Second}
	for end := time.Now().Add(60 * time.Second); ; {
		res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d/", local))
		if err == nil {
			res.Body.Close()
			if res.StatusCode < 500 {
				return local, nil
			}
		}
		if time.Now().After(end) {
			return 0, fmt.Errorf("브라우저 상자의 화면이 아직 열리지 않습니다(1분 넘게 시작하는 중). 잠시 뒤 다시 눌러 주세요")
		}
		time.Sleep(time.Second)
	}
}

// AgentWebLink asks an agent with a web page of its own for the address to
// open it at, signed in: OpenClaw's one-time link (openclaw dashboard
// --json). The address is as the box sees it (its localhost).
func (a *App) AgentWebLink(name string) (string, error) {
	s, _, err := readAgent(name)
	if err != nil {
		return "", err
	}
	has := false
	for _, id := range s.Agents {
		has = has || id == "openclaw"
	}
	if !has {
		return "", fmt.Errorf("the box has no agent with a sign-in link")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	// Killed in the box if it takes too long: an exec given up on goes on there.
	cmd := []string{"timeout", "-s", "KILL", "50", "sh", agentRunPath, "openclaw", "dashboard", "--json"}
	if !a.hasRun(ctx, portHolderName(s)) {
		cmd = []string{"timeout", "-s", "KILL", "50", "sh", "-c", agentWrap, "boxforge", "openclaw", "dashboard", "--json"}
	}
	out, errOut, _, err := a.eng().Containers().Output(ctx, portHolderName(s), cmd, nil)
	if err != nil {
		return "", err
	}
	var r struct {
		OK         *bool  `json:"ok"`
		BrowserURL string `json:"browserUrl"`
		URL        string `json:"url"`
		Reason     string `json:"reason"`
		Error      struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	text := strings.TrimSpace(out)
	if i := strings.Index(text, "{"); i >= 0 {
		text = text[i:]
	}
	if json.Unmarshal([]byte(text), &r) != nil {
		return "", fmt.Errorf("OpenClaw didn't give an address: %s", strings.TrimSpace(firstLine(errOut+"\n"+out)))
	}
	if r.OK != nil && !*r.OK {
		why := r.Error.Message
		if why == "" {
			why = r.Reason
		}
		if s.Service == "" {
			return "", fmt.Errorf("OpenClaw 게이트웨이가 켜져 있지 않습니다(%s). \"웹 · 포트\" 탭에서 \"게이트웨이 늘 켜 두기\"를 누르세요", why)
		}
		return "", fmt.Errorf("OpenClaw 게이트웨이가 아직 준비되지 않았습니다(%s). \"웹 · 포트\" 탭의 게이트웨이 기록에서 이유를 보고 \"게이트웨이 다시 켜기\"를 누르세요", why)
	}
	link := r.BrowserURL
	if link == "" {
		link = r.URL
	}
	if link == "" {
		return "", fmt.Errorf("OpenClaw didn't give an address")
	}
	return link, nil
}

func firstLine(s string) string {
	for _, l := range strings.Split(strings.TrimSpace(s), "\n") {
		if strings.TrimSpace(l) != "" {
			return l
		}
	}
	return ""
}

// Sharing a box's port with other devices: only BoxForge's web server can,
// and only over its own HTTPS, to the browsers signed in to it (see
// webserver.ShareHandler). The desktop app shares nothing.

var shareHook func(port int, target string) (int, func(), error)

// SetShare gives the app the web server's way of sharing a port: it serves
// target on port (or the next free one) and says which, and how to stop.
func SetShare(f func(port int, target string) (int, func(), error)) { shareHook = f }

type sharedPort struct {
	ext  int
	stop func()
}

var shares = struct {
	sync.Mutex
	all map[string]*sharedPort // like boxPorts, by "name:port"
}{all: map[string]*sharedPort{}}

// AgentPortShare opens one of a box's ports for the browsers signed in to
// this web server, from other devices: on the server's own port of the same
// number (or the next free one), over its HTTPS. It returns that port.
func (a *App) AgentPortShare(name string, port int) (int, error) {
	if shareHook == nil {
		return 0, fmt.Errorf("다른 기기에서 여는 것은 BoxForge 웹 서버에서만 됩니다")
	}
	key := fmt.Sprintf("%s:%d", name, port)
	shares.Lock()
	if sp := shares.all[key]; sp != nil {
		shares.Unlock()
		return sp.ext, nil
	}
	shares.Unlock()
	// One of the box's ports from now on, as one opened on its page is.
	local, err := a.AgentPortAdd(name, port)
	if err != nil {
		return 0, err
	}
	ext, stop, err := shareHook(port, fmt.Sprintf("127.0.0.1:%d", local))
	if err != nil {
		return 0, err
	}
	shares.Lock()
	if old := shares.all[key]; old != nil { // shared meanwhile
		shares.Unlock()
		stop()
		return old.ext, nil
	}
	shares.all[key] = &sharedPort{ext: ext, stop: stop}
	shares.Unlock()
	return ext, nil
}

// unshare stops sharing what matches: one port ("name:port") or a whole
// box ("name:").
func unshare(prefix string, exact bool) {
	shares.Lock()
	var gone []*sharedPort
	for k, sp := range shares.all {
		if (exact && k == prefix) || (!exact && strings.HasPrefix(k, prefix)) {
			gone = append(gone, sp)
			delete(shares.all, k)
		}
	}
	shares.Unlock()
	for _, sp := range gone {
		sp.stop()
	}
}

// AgentServiceLog gives the last lines the box's kept-running service (a
// gateway) wrote: why it isn't up, when it isn't.
func (a *App) AgentServiceLog(name string) (string, error) {
	if _, _, err := readAgent(name); err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var b strings.Builder
	err := a.eng().Containers().Logs(ctx, agentProject(name)+"-service", 60, &b)
	if err != nil && b.Len() == 0 && ctx.Err() == nil {
		return "", err
	}
	return b.String(), nil
}
