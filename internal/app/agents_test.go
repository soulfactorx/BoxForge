package app

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func TestAgentFiles(t *testing.T) {
	ws := t.TempDir()
	s := AgentSpec{Name: "pi-work", Agents: []string{"pi", "openclaw", "pi"}, Workspace: ws, Network: "ai",
		Allow: []string{"API.anthropic.com", "# note", "*.example.com", "host.docker.internal:11434"}, Ports: []int{18789},
		Memory: 4, CPUs: 2, Pids: 512, Service: "openclaw gateway --port 18789 --bind loopback", Browser: true}
	if err := s.check(); err != nil {
		t.Fatal(err)
	}
	if len(s.Agents) != 2 || strings.Join(s.Allow, ",") != "api.anthropic.com,*.example.com,host.docker.internal:11434" {
		t.Fatalf("spec = %+v", s)
	}
	f := agentFiles(s, func(p string) string { return p })
	c := f["compose.yaml"]
	for _, want := range []string{"name: bfa-pi-work", "container_name: bfa-pi-work-agent", "container_name: bfa-pi-work-service", "container_name: bfa-pi-work-egress",
		"cap_drop: [ALL]", "no-new-privileges:true", "pids_limit: 512", "mem_limit: 4096m", "cpus: 2", "internal: true", "HTTPS_PROXY: http://egress:8888",
		"file: ./secrets.env", "container_name: bfa-pi-work-browser", `network_mode: "service:agent"`, `pid: "service:agent"`, "cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID, KILL, NET_BIND_SERVICE]", "browser: {}", `"` + ws + `:/workspace"`, "home:/home/agent"} {
		if !strings.Contains(c, want) {
			t.Fatalf("compose.yaml lacks %q:\n%s", want, c)
		}
	}
	// The gateway waits for its setup, then starts: in a script of its own.
	sv := f["service.sh"]
	if !strings.Contains(c, "./service.sh:"+agentServicePath+":ro") || !strings.Contains(c, "exec sh "+agentServicePath) ||
		!strings.Contains(sv, "until ready") || !strings.Contains(sv, "exec openclaw gateway --port 18789 --bind loopback") {
		t.Fatalf("service:\n%s\n%s", c, sv)
	}
	if cmd, err := agentCommand(s, "setup:openclaw", true); err != nil || strings.Join(cmd, " ") != "sh "+agentRunPath+" openclaw onboard --mode local --no-install-daemon" {
		t.Fatalf("setup = %v, %v", cmd, err)
	}
	if _, err := agentCommand(s, "setup:pi", true); err == nil {
		t.Fatal("pi has no setup")
	}
	// Ports are opened by BoxForge, never published by the engine.
	if strings.Contains(c, "ports:") || strings.Contains(c, "FORWARD") {
		t.Fatalf("compose.yaml publishes ports:\n%s", c)
	}
	// Pi as root, like any program; OpenClaw as the user, into its home.
	df := f["Dockerfile"]
	pi, user, oc := strings.Index(df, "@earendil-works/pi-coding-agent"), strings.Index(df, "USER agent"), strings.Index(df, "openclaw@latest")
	if pi < 0 || user < pi || oc < user || !strings.Contains(df, "libatomic1") {
		t.Fatalf("Dockerfile:\n%s", df)
	}
	if !strings.Contains(f["egress/allow.txt"], "*.example.com\n") || f["egress/proxy.js"] == "" {
		t.Fatal("egress files")
	}
	for _, bad := range []AgentSpec{
		{Name: "Bad Name", Agents: []string{"pi"}, Workspace: ws, Network: "ai"},
		{Name: "x", Workspace: ws, Network: "ai"},
		{Name: "x", Agents: []string{"nope"}, Workspace: ws, Network: "ai"},
		{Name: "x", Agents: []string{"pi"}, Workspace: "relative", Network: "ai"},
		{Name: "x", Agents: []string{"pi"}, Workspace: ws, Network: "ai", Allow: []string{"http://x.com/a"}},
		{Name: "x", Image: "alpine", Workspace: ws, Network: "full"},
	} {
		if err := bad.check(); err == nil {
			t.Fatalf("no error for %+v", bad)
		}
	}
}

func TestParseConnections(t *testing.T) {
	log := `{"t":1,"host":"api.anthropic.com","port":443,"ok":true,"how":"connect"}
noise
2026-11-24T00:00:00Z {"t":5,"host":"evil.example","port":443,"ok":false,"how":"connect"}
{"t":3,"host":"api.anthropic.com","port":443,"ok":true,"how":"connect"}`
	c := parseConnections(log)
	if len(c) != 2 || c[0].Host != "evil.example" || c[0].OK || c[1].Count != 2 || c[1].Last != 3 {
		t.Fatalf("%+v", c)
	}
}

// A terminal outside the app gets its command line read again by cmd.exe
// and by WSL's shell: only plain words survive both.
func TestAgentCommandPlainWords(t *testing.T) {
	plain := regexp.MustCompile(`^[A-Za-z0-9_./:=@-]+$`) // @: a package's version, as cmd.exe and sh leave it
	kinds, problems := loadRecipes()
	if len(problems) > 0 || len(kinds) < 9 {
		t.Fatalf("recipes: %d, %v", len(kinds), problems)
	}
	for _, k := range kinds {
		s := AgentSpec{Name: "x", Agents: []string{k.ID}}
		whiches := []string{k.ID, "main", "shell"}
		for _, a := range []struct{ name, cmd string }{{"setup", k.Setup}, {"doctor", k.Doctor}, {"update", k.Update}} {
			if a.cmd != "" {
				whiches = append(whiches, a.name+":"+k.ID)
			}
		}
		for _, which := range whiches {
			cmd, err := agentCommand(s, which, true)
			if err != nil {
				t.Fatal(err)
			}
			if cmd[0] != "sh" || cmd[1] != agentRunPath {
				t.Fatalf("%s/%s: %q", k.ID, which, cmd)
			}
			for _, w := range cmd {
				if !plain.MatchString(w) {
					t.Fatalf("%s/%s: %q is not a plain word", k.ID, which, w)
				}
			}
		}
	}
	own := AgentSpec{Name: "x", Image: "me/agent", Command: "my-agent --fast"}
	if cmd, _ := agentCommand(own, "main", true); strings.Join(cmd, " ") != "sh "+agentRunPath+" my-agent --fast" {
		t.Fatalf("%q", cmd)
	}
	if _, err := agentCommand(AgentSpec{Agents: []string{"pi"}}, "claude", true); err == nil {
		t.Fatal("an agent the box doesn't have")
	}
	f := agentFiles(AgentSpec{Name: "x", Agents: []string{"pi"}, Workspace: "/w", Network: "none"}, func(p string) string { return p })
	if !strings.Contains(f["compose.yaml"], "./run.sh:/opt/boxforge/run:ro") || !strings.Contains(f["run.sh"], `exec "$@"`) {
		t.Fatal("run.sh isn't put in the box")
	}
}

// Hermes keeps two programs running, and doesn't wait for its setup (its
// page is where it is set up too); each started, the service ends when one does.
func TestAgentServiceScript(t *testing.T) {
	k, _ := agentKind("hermes")
	s := AgentSpec{Name: "h", Agents: []string{"hermes"}, Service: k.Service}
	sv := serviceScript(s)
	if strings.Contains(sv, "until ready") || !strings.Contains(sv, "keep 'hermes dashboard --host 127.0.0.1 --port 9119 --no-open' &") ||
		!strings.Contains(sv, "keep 'hermes gateway' &") || strings.Contains(sv, "exit 1") {
		t.Fatalf("%s", sv)
	}
	files := agentFiles(s, func(p string) string { return p })
	// Built once, for the box; the service takes that image.
	if c := files["compose.yaml"]; strings.Count(c, "build:") != 1 || !strings.Contains(c, "pull_policy: never") {
		t.Fatalf("%s", c)
	}
	df := files["Dockerfile"]
	if !strings.Contains(df, "WORKDIR /home/agent") || !strings.Contains(df, "hermes-agent/main/scripts/install.sh") || !strings.Contains(df, "ffmpeg") {
		t.Fatalf("%s", df)
	}
	// A guide's agent isn't put in.
	g := agentFiles(AgentSpec{Name: "g", Agents: []string{"codex"}}, func(p string) string { return p })["Dockerfile"]
	if strings.Contains(g, "@openai/codex") {
		t.Fatalf("%s", g)
	}
	if cmd, err := agentCommand(AgentSpec{Agents: []string{"cursor"}}, "guide:cursor:0", true); err != nil || cmd[2] != "sh" || cmd[3] != "-c" || !strings.Contains(cmd[4], "| bash") {
		t.Fatalf("%q %v", cmd, err)
	}
}

// The user's recipes: a new one, one in place of a built-in one, a bad one said.
func TestUserRecipes(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("BOXFORGE_AGENT_RECIPES", dir)
	os.WriteFile(filepath.Join(dir, "newbot.yaml"), []byte("id: newbot\nname: New Bot\ngroup: hot\ncommand: newbot\nhosts: [\"@anthropic\", x.example]\nhomeInstall: RUN npm install -g newbot\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "pi.yaml"), []byte("id: pi\nname: My Pi\ncommand: pi\ninstall: RUN true\n"), 0o644)
	os.WriteFile(filepath.Join(dir, "bad.yaml"), []byte("id: Bad Id\nname: x\ncommand: x\n"), 0o644)
	kinds, problems := loadRecipes()
	byID := map[string]AgentKind{}
	for _, k := range kinds {
		byID[k.ID] = k
	}
	if byID["newbot"].Group != "hot" || !slices.Contains(byID["newbot"].Hosts, "api.anthropic.com") || byID["pi"].Name != "My Pi" || len(problems) != 1 {
		t.Fatalf("%+v %v", byID["newbot"], problems)
	}
	if g := byID["gemini"].Ready; !strings.HasSuffix(g, "|| exit 1") {
		t.Fatalf("a guide's agent not there is 1, not dash's 127: %q", g)
	}
	if kinds[len(kinds)-1].ID != "newbot" {
		t.Fatal("the user's own come last")
	}
}
