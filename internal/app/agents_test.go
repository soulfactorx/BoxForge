package app

import (
	"regexp"
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
		"file: ./secrets.env", "container_name: bfa-pi-work-browser", `network_mode: "service:service"`, "cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID, KILL, NET_BIND_SERVICE]", "browser: {}", `"` + ws + `:/workspace"`, "home:/home/agent"} {
		if !strings.Contains(c, want) {
			t.Fatalf("compose.yaml lacks %q:\n%s", want, c)
		}
	}
	// Ports are opened by BoxForge, never published by the engine.
	if strings.Contains(c, "ports:") || strings.Contains(c, "FORWARD") {
		t.Fatalf("compose.yaml publishes ports:\n%s", c)
	}
	if !strings.Contains(f["Dockerfile"], "@earendil-works/pi-coding-agent") || !strings.Contains(f["Dockerfile"], "openclaw@latest") {
		t.Fatalf("Dockerfile:\n%s", f["Dockerfile"])
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
	plain := regexp.MustCompile(`^[A-Za-z0-9_./:=-]+$`)
	for _, k := range agentKinds {
		s := AgentSpec{Name: "x", Agents: []string{k.ID}}
		for _, which := range []string{k.ID, "main", "shell"} {
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
