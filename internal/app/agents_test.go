package app

import (
	"strings"
	"testing"
)

func TestAgentFiles(t *testing.T) {
	ws := t.TempDir()
	s := AgentSpec{Name: "pi-work", Agents: []string{"pi", "openclaw", "pi"}, Workspace: ws, Network: "ai",
		Allow: []string{"API.anthropic.com", "# note", "*.example.com", "host.docker.internal:11434"}, Ports: []int{18789},
		Memory: 4, CPUs: 2, Pids: 512, Service: "openclaw gateway --port 18789 --bind lan"}
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
		`FORWARD: "18789:service:18789"`, `"127.0.0.1:18789:18789"`, "file: ./secrets.env", `"` + ws + `:/workspace"`, "home:/home/agent"} {
		if !strings.Contains(c, want) {
			t.Fatalf("compose.yaml lacks %q:\n%s", want, c)
		}
	}
	if !strings.Contains(f["Dockerfile"], "@mariozechner/pi-coding-agent") || !strings.Contains(f["Dockerfile"], "openclaw@latest") {
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
		{Name: "x", Agents: []string{"pi"}, Workspace: ws, Network: "none", Ports: []int{80}},
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
