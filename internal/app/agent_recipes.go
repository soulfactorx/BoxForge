package app

// Agent recipes: what an agent a box can have needs, one YAML file each.
// BoxForge's own are built in (recipes/); more, or changed ones, are files
// the user puts in the agent-recipes folder beside the boxes' (a file with
// the id of a built-in one takes its place). The format is in
// docs/AGENT-RECIPES.md.
//
// An agent is one of three kinds of thing:
//   - ready: settled and light (Pi, Claude Code): put in when the image is
//     built, as root, like any program.
//   - hot: many-sided agents that move fast (OpenClaw, Hermes): installed as
//     their makers have it, as the box's user into the box's home, which a
//     volume keeps: they add their plugins and tools and update themselves
//     there, and the box is set up around them (memory, network, the
//     programs kept running, their page, their setup, their doctor).
//   - guide: put in by hand from the box's terminal, by the steps shown
//     (Codex, Gemini, Copilot, Cursor, Grok: their packages are particular
//     about the CPU and the machine).

import (
	"embed"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"

	"gopkg.in/yaml.v3"
)

// AgentKind is an agent a box can have put in: a recipe.
type AgentKind struct {
	ID      string `json:"id" yaml:"id"`
	Name    string `json:"name" yaml:"name"`
	Group   string `json:"group" yaml:"group"` // ready, hot or guide
	Order   int    `json:"-" yaml:"order"`
	Command string `json:"command" yaml:"command"` // what starts it in the box
	About   string `json:"about,omitempty" yaml:"about"`
	Docs    string `json:"docs,omitempty" yaml:"docs"`
	// What it is put in with: system packages (installed once for the
	// image), Dockerfile lines run as root (ready), as the box's user with
	// its home (hot), or steps for the user to run (guide).
	Apt         []string    `json:"apt,omitempty" yaml:"apt"`
	Install     string      `json:"install,omitempty" yaml:"install"`
	HomeInstall string      `json:"homeInstall,omitempty" yaml:"homeInstall"`
	Guide       []GuideStep `json:"guide,omitempty" yaml:"guide"`
	Keys        []string    `json:"keys" yaml:"keys"`   // the API key settings it reads
	Hosts       []string    `json:"hosts" yaml:"hosts"` // what it needs to reach, for "AI services only"
	Note        string      `json:"note" yaml:"note"`   // how to sign in, in a few words
	// Service is what is kept running beside it, a command a line (its
	// gateway, its page), and Port the port its own page is on; Link how
	// that page is opened signed in ("openclaw": its one-time link).
	Service string `json:"service,omitempty" yaml:"service"`
	Port    int    `json:"port,omitempty" yaml:"port"`
	Link    string `json:"link,omitempty" yaml:"link"`
	// Setup is the command that sets it up first, and Ready a shell test
	// that ends 0 once that is done (1 when it isn't; anything else: can't
	// tell). Gate: what is kept running waits for that.
	Setup string `json:"setup,omitempty" yaml:"setup"`
	Ready string `json:"ready,omitempty" yaml:"ready"`
	Gate  bool   `json:"gate,omitempty" yaml:"gate"`
	// Its own commands for a check-up, an update, and its version.
	Doctor  string `json:"doctor,omitempty" yaml:"doctor"`
	Update  string `json:"update,omitempty" yaml:"update"`
	Version string `json:"version,omitempty" yaml:"version"`
	// What a box made for it starts with: the least memory (GB) and
	// processes it runs well in, and its network.
	Memory  float64 `json:"memory,omitempty" yaml:"memory"`
	Pids    int     `json:"pids,omitempty" yaml:"pids"`
	Network string  `json:"network,omitempty" yaml:"network"`
	Source  string  `json:"source" yaml:"-"` // "" built in, else the file it came from
}

// GuideStep is a step put in by hand: what it does, and the command.
type GuideStep struct {
	Title   string `json:"title" yaml:"title"`
	Command string `json:"command" yaml:"command"`
}

//go:embed recipes/*.yaml
var builtinRecipes embed.FS

// Host groups a recipe can name ("@anthropic") instead of listing them.
var hostGroups = map[string][]string{
	"anthropic": {"api.anthropic.com", "console.anthropic.com", "claude.ai", "platform.claude.com", "statsig.anthropic.com"},
	"openai":    {"api.openai.com", "auth.openai.com", "chatgpt.com", "*.chatgpt.com"},
	"google":    {"generativelanguage.googleapis.com", "cloudcode-pa.googleapis.com", "oauth2.googleapis.com", "accounts.google.com", "www.googleapis.com", "play.googleapis.com"},
	"copilot":   {"github.com", "api.github.com", "api.githubcopilot.com", "*.githubcopilot.com", "copilot-proxy.githubusercontent.com"},
}

// Tests a recipe can name instead of writing them out.
var readyChecks = map[string]string{"openclaw-config": openclawReady}

var (
	recipeID = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,30}$`)
	aptName  = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]*$`)
)

// recipesDir is where the user's own recipes are: beside the boxes' folder.
func recipesDir() string {
	if d := os.Getenv("BOXFORGE_AGENT_RECIPES"); d != "" {
		return d
	}
	if d := agentsDir(); d != "" {
		return filepath.Join(filepath.Dir(d), "agent-recipes")
	}
	return ""
}

// parseRecipe reads one recipe and makes it whole.
func parseRecipe(data []byte, source string) (AgentKind, error) {
	var k AgentKind
	dec := yaml.NewDecoder(strings.NewReader(string(data)))
	dec.KnownFields(true)
	if err := dec.Decode(&k); err != nil {
		return k, err
	}
	k.Source = source
	k.ID = strings.TrimSpace(k.ID)
	if !recipeID.MatchString(k.ID) {
		return k, fmt.Errorf("id %q: small letters, digits and -", k.ID)
	}
	if strings.TrimSpace(k.Name) == "" || len(strings.Fields(k.Command)) == 0 {
		return k, fmt.Errorf("%s: name and command are needed", k.ID)
	}
	switch k.Group {
	case "":
		k.Group = "ready"
	case "ready", "hot", "guide":
	default:
		return k, fmt.Errorf("%s: group is ready, hot or guide, not %q", k.ID, k.Group)
	}
	switch k.Network {
	case "", "ai", "full", "none":
	default:
		return k, fmt.Errorf("%s: network is ai, full or none, not %q", k.ID, k.Network)
	}
	if k.Port < 0 || k.Port > 65535 || k.Memory < 0 || k.Pids < 0 {
		return k, fmt.Errorf("%s: port, memory or pids out of range", k.ID)
	}
	for _, p := range k.Apt {
		if !aptName.MatchString(p) {
			return k, fmt.Errorf("%s: %q isn't a package name", k.ID, p)
		}
	}
	for _, key := range k.Keys {
		if !keyName.MatchString(key) {
			return k, fmt.Errorf("%s: %q isn't a setting name", k.ID, key)
		}
	}
	if r, ok := readyChecks[k.Ready]; ok {
		k.Ready = r
	}
	// A guide's agent is there once its command is.
	if k.Group == "guide" && k.Ready == "" {
		k.Ready = "command -v " + strings.Fields(k.Command)[0] + " >/dev/null 2>&1"
	}
	var hosts []string
	for _, h := range k.Hosts {
		if g, ok := strings.CutPrefix(h, "@"); ok {
			if g == "packages" || g == "github" {
				hosts = append(hosts, AgentPresets[g]...)
			} else {
				hosts = append(hosts, hostGroups[g]...)
			}
			continue
		}
		hosts = append(hosts, h)
	}
	k.Hosts = hosts
	k.Service = strings.TrimSpace(k.Service)
	k.Install = strings.TrimRight(k.Install, "\n")
	k.HomeInstall = strings.TrimRight(k.HomeInstall, "\n")
	return k, nil
}

var (
	builtinOnce sync.Once
	builtins    []AgentKind
)

// loadRecipes is every agent a box can have: the built-in ones, and the
// user's (which take the place of a built-in one of the same id), in their
// order. A file that can't be read is said, not used.
func loadRecipes() ([]AgentKind, []string) {
	builtinOnce.Do(func() {
		entries, _ := builtinRecipes.ReadDir("recipes")
		for _, e := range entries {
			data, _ := builtinRecipes.ReadFile("recipes/" + e.Name())
			k, err := parseRecipe(data, "")
			if err != nil {
				panic("built-in recipe " + e.Name() + ": " + err.Error())
			}
			builtins = append(builtins, k)
		}
	})
	byID := map[string]AgentKind{}
	var problems []string
	for _, k := range builtins {
		byID[k.ID] = k
	}
	if dir := recipesDir(); dir != "" {
		files, _ := filepath.Glob(filepath.Join(dir, "*.yaml"))
		more, _ := filepath.Glob(filepath.Join(dir, "*.yml"))
		for _, f := range append(files, more...) {
			data, err := os.ReadFile(f)
			if err == nil {
				var k AgentKind
				if k, err = parseRecipe(data, f); err == nil {
					if k.Order == 0 {
						// In the place of the one it takes the place of, else last.
						k.Order = 1000
						if was, ok := byID[k.ID]; ok {
							k.Order = was.Order
						}
					}
					byID[k.ID] = k
					continue
				}
			}
			problems = append(problems, filepath.Base(f)+": "+err.Error())
		}
	}
	out := make([]AgentKind, 0, len(byID))
	for _, k := range byID {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Order != out[j].Order {
			return out[i].Order < out[j].Order
		}
		return out[i].ID < out[j].ID
	})
	return out, problems
}

// AgentCatalog gives the screen what agents a box can have, the address
// groups it can open, and where the user's own recipes go.
func (a *App) AgentCatalog() map[string]any {
	kinds, problems := loadRecipes()
	return map[string]any{"kinds": kinds, "presets": AgentPresets, "recipes": recipesDir(), "problems": problems}
}

func agentKind(id string) (AgentKind, bool) {
	kinds, _ := loadRecipes()
	for _, k := range kinds {
		if k.ID == id {
			return k, true
		}
	}
	return AgentKind{}, false
}
