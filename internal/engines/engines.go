// Package engines knows which container engines this PC can reach and how
// to reach each: by address, through a Docker context, or inside a WSL
// distribution.
package engines

import (
	"bytes"
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/soulfactorx/boxforge/internal/clirunner"
)

// Target is one engine the user can choose.
type Target struct {
	ID     string `json:"id"`     // "default", "context:<name>", "wsl:<distro>"
	Kind   string `json:"kind"`   // default, context, wsl
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
		out = append(out, Target{ID: "wsl:" + d, Kind: "wsl", Label: "WSL: " + d + " 안의 Docker", Distro: d})
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

// Dialer returns the way to connect to a WSL target's engine.
func (t Target) Dialer() func(ctx context.Context, network, addr string) (net.Conn, error) {
	return func(ctx context.Context, _, _ string) (net.Conn, error) {
		name, args := InWSL(t.Distro, "docker", "system", "dial-stdio")
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
