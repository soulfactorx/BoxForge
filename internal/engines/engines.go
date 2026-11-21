// Package engines knows which container engines this PC can reach and how
// to reach each: by address, through a Docker context, or inside a WSL
// distribution.
package engines

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/soulfactorx/boxforge/internal/clirunner"
)

// Target is one engine the user can choose.
type Target struct {
	ID     string `json:"id"`     // "default", "context:<name>", "wsl:<distro>", "ssh:<user@host>", "podman:<n>"
	Kind   string `json:"kind"`   // default, context, wsl, ssh, podman
	Label  string `json:"label"`  // what the list shows
	Host   string `json:"host"`   // the engine's address, for a context
	Distro string `json:"distro"` // the WSL distribution, for wsl
}

// Default follows the docker command's own choice: DOCKER_HOST, else the
// current Docker context, else the standard socket.
var Default = Target{ID: "default", Kind: "default", Label: "docker 명령과 같은 엔진"}

// wslExe is the WSL launcher; BOXFORGE_WSL names a stand-in for tests.
func wslExe() string {
	if p := os.Getenv("BOXFORGE_WSL"); p != "" {
		return p
	}
	if runtime.GOOS == "windows" {
		return "wsl.exe"
	}
	return ""
}

func dockerDir() string {
	if d := os.Getenv("DOCKER_CONFIG"); d != "" {
		return d
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".docker")
}

// contexts reads the Docker CLI's contexts: name → engine address.
func contexts() map[string]string {
	out := map[string]string{}
	metas, _ := filepath.Glob(filepath.Join(dockerDir(), "contexts", "meta", "*", "meta.json"))
	for _, f := range metas {
		b, err := os.ReadFile(f)
		if err != nil {
			continue
		}
		var m struct {
			Name      string
			Endpoints map[string]struct{ Host string }
		}
		if json.Unmarshal(b, &m) == nil && m.Name != "" && m.Endpoints["docker"].Host != "" {
			out[m.Name] = m.Endpoints["docker"].Host
		}
	}
	return out
}

// currentContext is the context the docker command uses when nothing
// overrides it; "" for the built-in default.
func currentContext() string {
	if c := os.Getenv("DOCKER_CONTEXT"); c != "" {
		return c
	}
	b, err := os.ReadFile(filepath.Join(dockerDir(), "config.json"))
	if err != nil {
		return ""
	}
	var cfg struct{ CurrentContext string }
	_ = json.Unmarshal(b, &cfg)
	if cfg.CurrentContext == "default" {
		return ""
	}
	return cfg.CurrentContext
}

// Describe says in a few words which engine a target is.
func Describe(t Target) string {
	if t.Kind != "default" {
		return t.Label
	}
	// The default follows the docker command: say where that leads.
	switch {
	case os.Getenv("DOCKER_HOST") != "":
		return "기본 엔진 (DOCKER_HOST)"
	case currentContext() != "":
		return "기본 엔진 (context: " + currentContext() + ")"
	}
	return "기본 엔진"
}

// DefaultHost is the address Default stands for; "" means the platform's
// standard socket.
func DefaultHost() string {
	if h := os.Getenv("DOCKER_HOST"); h != "" {
		return h
	}
	return contexts()[currentContext()]
}

// Distros lists the WSL distributions, without starting any.
func Distros() []string {
	exe := wslExe()
	if exe == "" {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "-l", "-q")
	clirunner.HideWindow(cmd)
	raw, err := cmd.Output()
	if err != nil {
		return nil
	}
	// wsl.exe prints UTF-16 unless told otherwise.
	text := string(raw)
	if bytes.IndexByte(raw, 0) >= 0 {
		u := make([]uint16, 0, len(raw)/2)
		for i := 0; i+1 < len(raw); i += 2 {
			u = append(u, uint16(raw[i])|uint16(raw[i+1])<<8)
		}
		text = string(utf16.Decode(u))
	}
	var out []string
	for _, line := range strings.Split(text, "\n") {
		name := strings.TrimSpace(strings.TrimPrefix(line, "\ufeff"))
		// Docker Desktop's own distributions are its internals, not a place
		// to run an engine of one's own.
		if name == "" || strings.HasPrefix(name, "docker-desktop") {
			continue
		}
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// Discover lists the engines to choose from. It starts nothing: whether a
// WSL distribution has Docker shows when it is chosen.
func Discover() []Target {
	out := []Target{Default}
	ctxs := contexts()
	names := make([]string, 0, len(ctxs))
	for n := range ctxs {
		names = append(names, n)
	}
	sort.Strings(names)
	for _, n := range names {
		// Docker Desktop is left out on purpose: BoxForge is for the
		// engines that are free to use.
		if strings.HasPrefix(n, "desktop-") {
			continue
		}
		out = append(out, Target{ID: "context:" + n, Kind: "context", Label: "Docker context: " + n, Host: ctxs[n]})
	}
	for _, d := range Distros() {
		out = append(out, Target{ID: "wsl:" + d, Kind: "wsl", Label: "WSL: " + d + " 안의 엔진", Distro: d})
	}
	// containerd with no Docker in front of it is driven with nerdctl.
	if runtime.GOOS != "windows" {
		if _, err := exec.LookPath("nerdctl"); err == nil {
			out = append(out, Target{ID: "containerd", Kind: "containerd", Label: "containerd (nerdctl, 실험적)"})
		}
	}
	socks := podmanSockets()
	for i, sock := range socks {
		out = append(out, Target{ID: fmt.Sprintf("podman:%d", i), Kind: "podman", Label: "Podman (Docker 호환, 실험적)", Host: sock})
	}
	// Podman with no API switched on (it has no service running until
	// asked): offered all the same, and its API started when chosen.
	if len(socks) == 0 && runtime.GOOS != "windows" {
		if _, err := exec.LookPath("podman"); err == nil {
			out = append(out, Target{ID: "podman:own", Kind: "podman", Label: "Podman (Docker 호환, 실험적)"})
		}
	}
	for _, addr := range load().Remotes {
		out = append(out, Target{ID: "ssh:" + addr, Kind: "ssh", Label: "원격(SSH): " + addr, Host: addr})
	}
	return out
}

// Find returns the target with the ID, or Default when there is none.
func Find(id string) Target {
	for _, t := range Discover() {
		if t.ID == id {
			return t
		}
	}
	return Default
}

// InWSL is the command that runs args inside the distribution, as root:
// the engine's socket there belongs to root and the docker group.
func InWSL(distro string, args ...string) (string, []string) {
	return wslExe(), append([]string{"-d", distro, "-u", "root", "--"}, args...)
}

// podmanSockets finds Podman's Docker-compatible API on this PC.
func podmanSockets() []string {
	var out []string
	if runtime.GOOS == "windows" {
		for _, pipe := range []string{`\\.\pipe\podman-machine-default`} {
			if _, err := os.Stat(pipe); err == nil {
				out = append(out, "npipe://"+strings.ReplaceAll(pipe, `\`, "/"))
			}
		}
		return out
	}
	candidates := []string{"/run/podman/podman.sock"}
	if dir := os.Getenv("XDG_RUNTIME_DIR"); dir != "" {
		candidates = append([]string{filepath.Join(dir, "podman", "podman.sock")}, candidates...)
	}
	for _, sock := range candidates {
		if st, err := os.Stat(sock); err == nil && st.Mode()&os.ModeSocket != 0 {
			out = append(out, "unix://"+sock)
		}
	}
	return out
}

// sshExe is the SSH client; BOXFORGE_SSH names a stand-in for tests.
func sshExe() string {
	if p := os.Getenv("BOXFORGE_SSH"); p != "" {
		return p
	}
	return "ssh"
}

// A remote engine's address: user@host, with an optional :port. It starts
// with a letter or digit, so it can never be read as an option of ssh.
var remoteAddr = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*(:[0-9]{1,5})?$`)

// SSHCommand is the command that runs args on a remote engine's machine.
// It never asks for a password: sign-in is by key, as the docker command's
// own ssh:// connections are.
func SSHCommand(addr string, args ...string) (string, []string) {
	host, port, _ := strings.Cut(addr, ":")
	full := []string{"-o", "BatchMode=yes", "-o", "ConnectTimeout=10"}
	if port != "" {
		full = append(full, "-p", port)
	}
	return sshExe(), append(append(full, host), args...)
}

// AddRemote remembers a remote engine reached over SSH.
func AddRemote(addr string) error {
	addr = strings.TrimSpace(strings.TrimPrefix(addr, "ssh://"))
	if !remoteAddr.MatchString(addr) {
		return fmt.Errorf("write the address as user@host or user@host:port")
	}
	c := load()
	for _, have := range c.Remotes {
		if have == addr {
			return nil
		}
	}
	c.Remotes = append(c.Remotes, addr)
	sort.Strings(c.Remotes)
	return store(c)
}

// RemoveRemote forgets a remote engine.
func RemoveRemote(addr string) error {
	c := load()
	kept := c.Remotes[:0]
	for _, have := range c.Remotes {
		if have != addr {
			kept = append(kept, have)
		}
	}
	c.Remotes = kept
	return store(c)
}

// Dialer returns the way to connect to an engine reached through a helper
// command: one inside a WSL distribution, or on another machine over SSH.
func (t Target) Dialer() func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, _, _ string) (net.Conn, error) {
		var name string
		var args []string
		if t.Kind == "ssh" {
			name, args = SSHCommand(t.Host, "docker", "system", "dial-stdio")
		} else {
			name, args = InWSL(t.Distro, "docker", "system", "dial-stdio")
		}
		return dialCommand(ctx, name, args...)
	}
}

var drive = regexp.MustCompile(`^([A-Za-z]):[\\/](.*)$`)
var wslShare = regexp.MustCompile(`^\\\\(?:wsl\$|wsl\.localhost)\\[^\\]+(\\.*)?$`)

// WSLPath turns a Windows path into the same place as seen from inside WSL:
// C:\a\b is /mnt/c/a/b, and \\wsl$\Ubuntu\home\me is /home/me. Anything
// else is returned as it is.
func WSLPath(p string) string {
	if m := drive.FindStringSubmatch(p); m != nil {
		return "/mnt/" + strings.ToLower(m[1]) + "/" + strings.ReplaceAll(m[2], `\`, "/")
	}
	if m := wslShare.FindStringSubmatch(p); m != nil {
		if m[1] == "" {
			return "/"
		}
		return strings.ReplaceAll(m[1], `\`, "/")
	}
	return p
}

// configFile is where the chosen engine is remembered.
func configFile() string {
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "BoxForge", "config.json")
}

type config struct {
	Engine   string            `json:"engine"`
	Remotes  []string          `json:"remotes,omitempty"` // engines on other machines: user@host[:port]
	Settings map[string]string `json:"settings,omitempty"`
}

func load() config {
	var c config
	if b, err := os.ReadFile(configFile()); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	return c
}

func store(c config) error {
	f := configFile()
	if f == "" {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(c, "", "  ")
	// Beside the file and moved over it: a crash midway keeps the old one.
	tmp := f + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, f)
}

// Setting returns a value the UI stored, "" when there is none.
func Setting(key string) string { return load().Settings[key] }

// SetSetting stores a value for the UI.
func SetSetting(key, value string) error {
	c := load()
	if c.Settings == nil {
		c.Settings = map[string]string{}
	}
	c.Settings[key] = value
	return store(c)
}

// Saved returns the ID of the engine chosen last time, "default" when none.
func Saved() string {
	if e := load().Engine; e != "" {
		return e
	}
	return Default.ID
}

// Save remembers the chosen engine.
func Save(id string) error {
	c := load()
	c.Engine = id
	return store(c)
}

// The Podman API BoxForge started itself, when none was running.
var ownPodman struct {
	sync.Mutex
	cmd  *exec.Cmd
	host string
}

// PodmanHost returns the address of a Podman target's Docker-compatible
// API. A target with none (Podman installed, its API not switched on) has
// it started here: `podman system service`, on a socket of BoxForge's
// own, for as long as BoxForge runs.
func PodmanHost(t Target) (string, error) {
	if t.Host != "" {
		return t.Host, nil
	}
	ownPodman.Lock()
	defer ownPodman.Unlock()
	if ownPodman.cmd != nil && ownPodman.cmd.ProcessState == nil && ownPodman.host != "" {
		return ownPodman.host, nil
	}
	dir := os.Getenv("XDG_RUNTIME_DIR")
	if dir == "" {
		dir = os.TempDir()
	}
	sock := filepath.Join(dir, fmt.Sprintf("boxforge-podman-%d.sock", os.Getuid()))
	_ = os.Remove(sock)
	cmd := exec.Command("podman", "system", "service", "--time=0", "unix://"+sock)
	clirunner.HideWindow(cmd)
	tie(cmd)
	var said bytes.Buffer
	cmd.Stderr = &said
	if err := cmd.Start(); err != nil {
		return "", err
	}
	ended := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(ended)
	}()
	for i := 0; i < 100; i++ {
		if st, err := os.Stat(sock); err == nil && st.Mode()&os.ModeSocket != 0 {
			ownPodman.cmd, ownPodman.host = cmd, "unix://"+sock
			return ownPodman.host, nil
		}
		select {
		case <-ended:
			return "", fmt.Errorf("podman could not start its API: %s", strings.TrimSpace(said.String()))
		case <-time.After(100 * time.Millisecond):
		}
	}
	_ = cmd.Process.Kill()
	return "", errors.New("podman did not open its API in time")
}

// StopPodman ends the Podman API BoxForge started, if it did.
func StopPodman() {
	ownPodman.Lock()
	defer ownPodman.Unlock()
	if ownPodman.cmd != nil && ownPodman.cmd.Process != nil {
		_ = ownPodman.cmd.Process.Kill()
	}
	ownPodman.cmd, ownPodman.host = nil, ""
}
