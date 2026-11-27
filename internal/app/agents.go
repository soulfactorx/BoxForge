package app

// AI agent boxes. An agent (Pi, Claude Code, OpenClaw...) is given a
// container of its own to work in: it sees one work folder and its own home,
// runs as an ordinary user with no extra rights, within a CPU, memory and
// process budget, and reaches the network only as the box allows: the AI
// services alone (through a small proxy that lets through only the
// addresses on the box's list, and writes down every try), the whole
// internet, or nothing. Its API keys are handed in as a file only the box
// reads, not as settings the engine shows.
//
// A box is a Compose project BoxForge writes: compose.yaml, the agent's
// Dockerfile, the proxy and its list, in a folder of BoxForge's settings,
// so the Compose screen shows and runs it like any other, and what was made
// can be read and changed.

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"sort"
	"strconv"
	"strings"
)

// AgentPresets are more addresses a box with "AI services only" can be
// let to reach, by what they are for.
var AgentPresets = map[string][]string{
	"packages":  {"registry.npmjs.org", "pypi.org", "files.pythonhosted.org", "deb.debian.org"},
	"github":    {"github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com"},
	"messenger": {"api.telegram.org", "discord.com", "*.discord.com", "gateway.discord.gg", "*.discord.gg", "cdn.discordapp.com", "slack.com", "*.slack.com", "web.whatsapp.com", "*.whatsapp.net", "*.whatsapp.com"},
	"local-ai":  {"host.docker.internal:11434", "host.docker.internal:1234"},
}

// AgentSpec is a box as the user chose it; kept as spec.json beside its files.
type AgentSpec struct {
	Name   string   `json:"name"`
	Agents []string `json:"agents"` // agent kinds put in, the first one the main one
	// Image, for a box from an image of the user's own (no agent put in):
	// the image and the command that starts its agent.
	Image   string `json:"image,omitempty"`
	Command string `json:"command,omitempty"`

	Workspace string   `json:"workspace"`          // the one folder of this PC it works in
	ReadOnly  []string `json:"readOnly,omitempty"` // more folders it may read, not change

	Network string   `json:"network"` // "ai": only the listed addresses; "full"; "none"
	Allow   []string `json:"allow"`   // the addresses, for "ai"
	Ports   []int    `json:"ports,omitempty"`

	Memory       float64 `json:"memory"` // GB; 0 for no limit
	CPUs         float64 `json:"cpus"`   // cores; 0 for no limit
	Pids         int     `json:"pids"`   // processes; 0 for no limit
	ReadOnlyRoot bool    `json:"readOnlyRoot"`

	// Service keeps an agent running as a service (a chat gateway) beside
	// the box's own shell: its command, "" for none.
	Service string `json:"service,omitempty"`
	// Browser puts a browser box beside it, to see its web page in.
	Browser bool `json:"browser,omitempty"`

	Mark int64 `json:"mark"` // when the files were last saved (or the box made): "changed" is since then
}

var agentName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,30}$`)
var keyName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
var allowLine = regexp.MustCompile(`^(\*\.)?[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$`)

// agentProject is the Compose project of a box, and the start of its
// containers' names.
func agentProject(name string) string { return "bfa-" + name }

// agentsDir is where boxes are kept, one folder each.
func agentsDir() string {
	if d := os.Getenv("BOXFORGE_AGENTS_DIR"); d != "" {
		return d
	}
	dir, err := os.UserConfigDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "BoxForge", "agents")
}

// agentBrowser is the image of a box's browser: Firefox, seen through its
// own web page.
func agentBrowser() string {
	if b := os.Getenv("BOXFORGE_BROWSER_IMAGE"); b != "" {
		return b
	}
	return "jlesage/firefox:latest"
}

// agentBase is the image agents are built on, and the proxy runs on.
func agentBase() string {
	if b := os.Getenv("BOXFORGE_AGENT_BASE"); b != "" {
		return b
	}
	return "node:24-bookworm-slim"
}

// check makes a spec whole and says what is wrong with it.
func (s *AgentSpec) check() error {
	s.Name = strings.TrimSpace(s.Name)
	if !agentName.MatchString(s.Name) {
		return fmt.Errorf("the box's name may have small letters, digits and -, up to 31 (like pi-work)")
	}
	s.Image = strings.TrimSpace(s.Image)
	if s.Image == "" {
		if len(s.Agents) == 0 {
			return fmt.Errorf("choose at least one agent")
		}
		seen := map[string]bool{}
		var kept []string
		for _, id := range s.Agents {
			if _, ok := agentKind(id); !ok {
				return fmt.Errorf("unknown agent %q", id)
			}
			if !seen[id] {
				seen[id] = true
				kept = append(kept, id)
			}
		}
		s.Agents = kept
	} else {
		s.Agents = nil
		if strings.ContainsAny(s.Image, " \t\n\"'") {
			return fmt.Errorf("%q is not an image name", s.Image)
		}
		if strings.TrimSpace(s.Command) == "" {
			return fmt.Errorf("write the command that starts the agent in that image")
		}
	}
	if strings.ContainsAny(s.Command, "\n\r") {
		return fmt.Errorf("a command is one line")
	}
	// What is kept running: a program a line.
	s.Service = strings.TrimSpace(strings.ReplaceAll(s.Service, "\r", ""))
	s.Workspace = strings.TrimSpace(s.Workspace)
	if !filepath.IsAbs(s.Workspace) && !strings.HasPrefix(s.Workspace, "/") {
		return fmt.Errorf("write the work folder's whole path (like /home/me/project or C:\\work\\project)")
	}
	if st, err := os.Stat(s.Workspace); err != nil || !st.IsDir() {
		return fmt.Errorf("the work folder %s isn't there", s.Workspace)
	}
	for _, p := range s.ReadOnly {
		if st, err := os.Stat(p); err != nil || !st.IsDir() {
			return fmt.Errorf("the folder %s isn't there", p)
		}
	}
	switch s.Network {
	case "ai", "full", "none":
	default:
		return fmt.Errorf("unknown network choice %q", s.Network)
	}
	var allow []string
	for _, h := range s.Allow {
		h = strings.ToLower(strings.TrimSpace(h))
		if h == "" || strings.HasPrefix(h, "#") {
			continue
		}
		if !allowLine.MatchString(h) {
			return fmt.Errorf("%q is not an address (write a name like api.example.com, *.example.com or host:port)", h)
		}
		allow = append(allow, h)
	}
	s.Allow = allow
	for _, p := range s.Ports {
		if p < 1 || p > 65535 {
			return fmt.Errorf("%d is not a port", p)
		}
	}
	if s.Memory < 0 || s.CPUs < 0 || s.Pids < 0 {
		return fmt.Errorf("limits can't be below 0")
	}
	return nil
}

// agentIDs reports the user and group the agent runs as: the user's own on
// Linux, so what it writes in the work folder is the user's; the first
// ordinary user elsewhere (WSL, where it is the distribution's user).
func agentIDs() (int, int) {
	if runtime.GOOS == "windows" {
		return 1000, 1000
	}
	uid, gid := os.Getuid(), os.Getgid()
	if uid <= 0 {
		return 1000, 1000
	}
	return uid, gid
}

func y(s string) string { b, _ := json.Marshal(s); return string(b) }

// agentRun is put in the box as /opt/boxforge/run: what is asked of the
// box starts through it, its keys read from their file and the work folder
// where it starts. A terminal outside the app is asked for with plain words
// only ("sh /opt/boxforge/run pi"): on Windows its command line is read
// again by cmd.exe and by the WSL distribution's shell, which a script
// given on the command line would not survive.
const agentRun = `#!/bin/sh
# BoxForge: starts what is asked in the box, with the box's keys.
if (: < /run/secrets/agent_env) 2>/dev/null; then set -a; . /run/secrets/agent_env; set +a; fi
cd /workspace 2>/dev/null
# A terminal BoxForge opens names itself: what it starts can be found again
# (its session) and stopped when the terminal is closed.
if [ "$1" = --term ]; then mkdir -p /tmp/.boxforge 2>/dev/null; echo $$ > "/tmp/.boxforge/$2" 2>/dev/null; shift 2; fi
if [ "$1" = shell ]; then command -v bash >/dev/null && exec bash; exec sh; fi
exec "$@"
`

// agentRunPath is where agentRun is in the box.
const agentRunPath = "/opt/boxforge/run"

// agentWrap does what agentRun does, given on the command line: for the
// box's own command (in compose.yaml), and boxes made before agentRun.
const agentWrap = `if (: < /run/secrets/agent_env) 2>/dev/null; then set -a; . /run/secrets/agent_env; set +a; fi; cd /workspace 2>/dev/null; exec "$@"`

// agentFiles writes out a box: its files by name, relative to its folder.
// host turns a path of this PC into one the engine can mount.
func agentFiles(s AgentSpec, host func(string) string) map[string]string {
	uid, gid := agentIDs()
	files := map[string]string{}
	var kinds []AgentKind
	for _, id := range s.Agents {
		k, _ := agentKind(id)
		kinds = append(kinds, k)
	}
	project := agentProject(s.Name)
	image := s.Image
	var b strings.Builder
	w := func(format string, args ...any) { fmt.Fprintf(&b, format, args...) }
	w("# BoxForge AI agent box %q, written by BoxForge:\n", s.Name)
	w("# changing the box's settings writes it again (changes made by hand are lost).\n")
	w("name: %s\n\nservices:\n", project)

	agent := func(service, command string) {
		w("  %s:\n", service)
		if image == "" {
			// The same for the service: Compose builds it once, and doesn't
			// go looking for an image of that name on Docker Hub.
			w("    build:\n      context: .\n      args:\n        BASE: %s\n        UID: %q\n        GID: %q\n", y(agentBase()), strconv.Itoa(uid), strconv.Itoa(gid))
			w("    image: boxforge-agent/%s:latest\n", s.Name)
		} else {
			w("    image: %s\n", y(image))
		}
		if image != "" {
			// An image of the user's own runs as the same ordinary user,
			// with a home where it can always write.
			w("    user: \"%d:%d\"\n", uid, gid)
		}
		w("    container_name: %s-%s\n", project, service)
		w("    init: true\n")
		w("    command: [\"sh\", \"-c\", %s, \"boxforge\", \"sh\", \"-c\", %s]\n", y(agentWrap), y(command))
		w("    working_dir: /workspace\n")
		if service != "agent" {
			// One box with the agent: the same processes seen (a gateway
			// started in a terminal is known to the one kept running, and a
			// lock it left is checked, not guessed at) and the same
			// localhost.
			w("    restart: unless-stopped\n    depends_on: [agent]\n    pid: \"service:agent\"\n")
		}
		w("    labels:\n      io.boxforge.agent: %s\n      io.boxforge.agent.part: %s\n", y(s.Name), service)
		w("    volumes:\n      - %s\n", y(host(s.Workspace)+":/workspace"))
		w("      - ./run.sh:%s:ro\n", agentRunPath)
		if service != "agent" {
			w("      - ./service.sh:%s:ro\n", agentServicePath)
		}
		if image == "" {
			w("      - home:/home/agent\n")
		}
		for _, p := range s.ReadOnly {
			w("      - %s\n", y(host(p)+":/mnt/read-only/"+filepath.Base(filepath.Clean(p))+":ro"))
		}
		w("    secrets:\n      - agent_env\n")
		w("    environment:\n      NO_BROWSER: \"true\"\n      DISABLE_AUTOUPDATER: \"1\"\n")
		if image != "" {
			w("      HOME: /tmp\n")
		}
		if s.Network == "ai" {
			for _, k := range []string{"HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"} {
				w("      %s: http://egress:8888\n", k)
			}
			w("      NO_PROXY: localhost,127.0.0.1\n      no_proxy: localhost,127.0.0.1\n      NODE_USE_ENV_PROXY: \"1\"\n")
		}
		w("    cap_drop: [ALL]\n    security_opt: [\"no-new-privileges:true\"]\n")
		if s.Pids > 0 {
			w("    pids_limit: %d\n", s.Pids)
		}
		if s.Memory > 0 {
			w("    mem_limit: %dm\n", int64(s.Memory*1024))
		}
		if s.CPUs > 0 {
			w("    cpus: %s\n", strconv.FormatFloat(s.CPUs, 'f', -1, 64))
		}
		if s.ReadOnlyRoot {
			w("    read_only: true\n    tmpfs: [/tmp]\n")
		}
		switch {
		case service != "agent":
			w("    network_mode: \"service:agent\"\n")
		case s.Network == "none":
			w("    network_mode: none\n")
		case s.Network == "ai":
			w("    networks: [inside]\n")
		}
		// No published ports: they are opened on this PC by BoxForge
		// (agents_ports.go), at once and on any network.
	}
	main := "exec tail -f /dev/null"
	agent("agent", main)
	if s.Service != "" {
		agent("service", "exec sh "+agentServicePath)
	}
	if s.Network == "ai" {
		w("  egress:\n    image: %s\n    container_name: %s-egress\n    init: true\n", y(agentBase()), project)
		w("    user: node\n    command: [\"node\", \"/egress/proxy.js\"]\n")
		w("    restart: unless-stopped\n")
		w("    labels:\n      io.boxforge.agent: %s\n      io.boxforge.agent.part: egress\n", y(s.Name))
		w("    volumes:\n      - ./egress:/egress:ro\n")
		w("    extra_hosts: [\"host.docker.internal:host-gateway\"]\n")
		w("    cap_drop: [ALL]\n    security_opt: [\"no-new-privileges:true\"]\n    read_only: true\n    mem_limit: 256m\n    pids_limit: 256\n")
		w("    networks: [inside, outside]\n")
	}
	if s.Browser {
		// A browser of its own, beside the box: it shares the network of the
		// part that shows the web page, so that page is its localhost (a
		// page that asks for a secure address, as OpenClaw's does, takes
		// localhost as one) and it reaches nothing else the box can't. On
		// this PC only its picture is seen (its own page, port 5800).
		holder := portHolder(s)
		uid, gid := agentIDs()
		w("  browser:\n    image: %s\n    container_name: %s-browser\n", y(agentBrowser()), project)
		w("    network_mode: \"service:%s\"\n    depends_on: [%s]\n    restart: unless-stopped\n", holder, holder)
		w("    labels:\n      io.boxforge.agent: %s\n      io.boxforge.agent.part: browser\n", y(s.Name))
		w("    environment:\n      USER_ID: \"%d\"\n      GROUP_ID: \"%d\"\n      KEEP_APP_RUNNING: \"1\"\n", uid, gid)
		w("    volumes:\n      - browser:/config\n")
		w("    shm_size: 1g\n    mem_limit: 2g\n")
		// What its start-up needs (it begins as root and drops to the user), nothing more.
		w("    cap_drop: [ALL]\n    cap_add: [CHOWN, DAC_OVERRIDE, FOWNER, SETGID, SETUID, KILL, NET_BIND_SERVICE]\n")
		w("    security_opt: [\"no-new-privileges:true\"]\n")
	}
	if s.Network == "ai" {
		w("\nnetworks:\n  inside:\n    internal: true\n  outside: {}\n")
	}
	if image == "" || s.Browser {
		w("\nvolumes:\n")
		if image == "" {
			w("  home: {}\n")
		}
		if s.Browser {
			w("  browser: {}\n")
		}
	}
	w("\nsecrets:\n  agent_env:\n    file: ./secrets.env\n")
	files["compose.yaml"] = b.String()
	files["run.sh"] = agentRun
	if s.Service != "" {
		files["service.sh"] = serviceScript(s)
	}

	if image == "" {
		var d strings.Builder
		d.WriteString("# The agent's image: BoxForge writes it for the box.\nARG BASE=node:24-bookworm-slim\nFROM ${BASE}\nARG UID=1000\nARG GID=1000\n")
		// The system's part, once for all its agents: what they all may
		// use, and what each one's recipe asks for.
		pkgs := []string{"git", "curl", "ca-certificates", "ripgrep", "python3", "python3-venv", "procps", "less", "jq", "openssh-client", "xz-utils", "unzip", "libatomic1"}
		for _, k := range kinds {
			for _, p := range k.Apt {
				if !slices.Contains(pkgs, p) {
					pkgs = append(pkgs, p)
				}
			}
		}
		d.WriteString("RUN apt-get update && apt-get install -y --no-install-recommends \\\n    " + strings.Join(pkgs, " ") + " \\\n && rm -rf /var/lib/apt/lists/*\n")
		d.WriteString("RUN userdel -r node 2>/dev/null; (getent group $GID >/dev/null || groupadd -g $GID agent) \\\n && useradd -m -o -u $UID -g $GID -s /bin/bash agent\n")
		for _, k := range kinds {
			if k.Install != "" {
				d.WriteString("# " + k.Name + "\n" + k.Install + "\n")
			}
		}
		d.WriteString("ENV HOME=/home/agent NPM_CONFIG_PREFIX=/home/agent/.npm-global PATH=/home/agent/.npm-global/bin:/home/agent/.local/bin:$PATH\n")
		d.WriteString("USER agent\n")
		// Into the user's home, as the user: the box's home volume starts
		// as a copy of it, and keeps what the agent adds and updates there.
		home := false
		for _, k := range kinds {
			if k.HomeInstall != "" {
				if !home {
					d.WriteString("WORKDIR /home/agent\n")
					home = true
				}
				d.WriteString("# " + k.Name + " (into the home)\n" + k.HomeInstall + "\n")
			}
		}
		d.WriteString("WORKDIR /workspace\n")
		files["Dockerfile"] = d.String()
		files[".dockerignore"] = "*\n"
	}
	if s.Network == "ai" {
		files["egress/proxy.js"] = egressProxy
		files["egress/allow.txt"] = "# Where this box may connect, one a line. *.example.com is everything under it,\n# host:port that port only; with no port, 443 and 80.\n" + strings.Join(s.Allow, "\n") + "\n"
	}
	return files
}

// portHolder is the part of the box its ports lead to: the service when
// there is one (a gateway's page), else the box itself.
func portHolder(s AgentSpec) string {
	// The service shares the agent's network: its pages are the agent's localhost.
	return "agent"
}

// agentAllowFor is the list a box starts with: what its agents need.
func agentAllowFor(ids []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, id := range ids {
		k, _ := agentKind(id)
		for _, h := range k.Hosts {
			if !seen[h] {
				seen[h] = true
				out = append(out, h)
			}
		}
	}
	sort.Strings(out)
	return out
}

// egressProxy lets through only what allow.txt names, and writes one line
// of JSON for every try: what the box's connection record shows. The list
// is read again when it changes, so an address let through works at once.
const egressProxy = `// BoxForge: the way out of an AI agent box. Only the addresses in
// allow.txt are let through; every try is written down, one JSON line each.
"use strict";
const http = require("http"), net = require("net"), fs = require("fs");
const LIST = "/egress/allow.txt";
let rules = [], stamp = -1;
function load() {
  try {
    const st = fs.statSync(LIST);
    if (st.mtimeMs === stamp) return;
    stamp = st.mtimeMs;
    rules = fs.readFileSync(LIST, "utf8").split(/\r?\n/)
      .map((l) => l.replace(/#.*/, "").trim().toLowerCase()).filter(Boolean)
      .map((l) => {
        const m = /^(.*?)(?::(\d+))?$/.exec(l);
        return { wild: m[1].startsWith("*."), host: m[1].replace(/^\*\./, ""), port: m[2] ? +m[2] : 0 };
      });
  } catch { rules = []; }
}
function allowed(host, port) {
  load();
  host = host.toLowerCase().replace(/\.$/, "");
  return rules.some((r) => (r.port ? r.port === port : port === 443 || port === 80) &&
    (host === r.host || (r.wild && host.endsWith("." + r.host))));
}
function log(host, port, ok, how) {
  console.log(JSON.stringify({ t: Date.now(), host, port, ok, how }));
}
function split(hp, dflt) {
  const m = /^\[?([^\]]*?)\]?(?::(\d+))?$/.exec(hp || "");
  return m ? [m[1], m[2] ? +m[2] : dflt] : ["", 0];
}
const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url); } catch { res.writeHead(400); return res.end("BoxForge: use this as a proxy\n"); }
  const port = u.port ? +u.port : 80;
  if (!allowed(u.hostname, port)) {
    log(u.hostname, port, false, "http");
    res.writeHead(403, { "content-type": "text/plain" });
    return res.end("BoxForge: " + u.hostname + " is not on this box's list of addresses\n");
  }
  log(u.hostname, port, true, "http");
  const headers = { ...req.headers };
  delete headers["proxy-connection"];
  delete headers["proxy-authorization"];
  const up = http.request({ host: u.hostname, port, method: req.method, path: u.pathname + u.search, headers }, (r) => {
    res.writeHead(r.statusCode, r.headers);
    r.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
});
server.on("connect", (req, sock, head) => {
  const [host, port] = split(req.url, 443);
  if (!host || !allowed(host, port)) {
    log(host, port, false, "connect");
    return sock.end("HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nBoxForge: " + host + " is not on this box's list of addresses\n");
  }
  log(host, port, true, "connect");
  const up = net.connect(port, host, () => {
    sock.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head && head.length) up.write(head);
    up.pipe(sock);
    sock.pipe(up);
  });
  up.on("error", () => sock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n"));
  sock.on("error", () => up.destroy());
});
server.listen(8888);
`

// agentServicePath is where the service's script is in the box.
const agentServicePath = "/opt/boxforge/service"

// serviceScript is what the kept-running service runs: each line of the
// box's service a program (Hermes keeps its page and its gateway). An
// agent's gateway that has to be set up first waits for that (quietly,
// saying so once) instead of failing at once again and again, and starts as
// soon as the setup in the box's terminal is done. When one of them ends,
// the service ends, and the engine starts it all again.
func serviceScript(s AgentSpec) string {
	var b strings.Builder
	b.WriteString("#!/bin/sh\n# BoxForge: what this box keeps running (written by BoxForge).\n")
	if k, ok := serviceKind(s); ok && k.Gate && k.Ready != "" {
		fmt.Fprintf(&b, "ready() {\n%s\n}\n", k.Ready)
		fmt.Fprintf(&b, "if ! ready; then\n  echo %s\n  until ready; do sleep 10; done\nfi\n",
			shQuote(fmt.Sprintf("BoxForge: %s 설정을 기다리는 중입니다. 터미널 탭의 \"%s 설정\"(셸에서 %s)으로 설정을 마치면 바로 켜집니다.", k.Name, k.Name, k.Setup)))
	}
	var lines []string
	for _, l := range strings.Split(s.Service, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) == 1 {
		b.WriteString("exec " + lines[0] + "\n")
		return b.String()
	}
	b.WriteString("pids=\n")
	for _, l := range lines {
		fmt.Fprintf(&b, "echo %s\n%s &\npids=\"$pids $!\"\n", shQuote("BoxForge: 켭니다: "+l), l)
	}
	b.WriteString("while :; do\n  sleep 5\n  for p in $pids; do\n    if ! kill -0 \"$p\" 2>/dev/null; then echo 'BoxForge: 하나가 끝나서 모두 다시 켭니다.'; exit 1; fi\n  done\ndone\n")
	return b.String()
}

// shQuote is s as one word for sh.
func shQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }

// openclawReady is true (0) once OpenClaw is set up: its config names the
// gateway's mode. Read by a few lines of node (tens of milliseconds, tens of
// MB), not by the openclaw command (seconds, hundreds of MB, dozens of
// threads): it is asked every few seconds while the screen waits, and in the
// gateway's wait. A config node can't read as JSON is asked of openclaw.
// 1 is "not set up"; any other code is "can't tell".
const openclawReady = `node -e 'const f=(process.env.OPENCLAW_CONFIG_PATH||process.env.HOME+"/.openclaw/openclaw.json");let c;try{c=JSON.parse(require("fs").readFileSync(f,"utf8"))}catch(e){if(e.code==="ENOENT")process.exit(1);const r=require("child_process").spawnSync("openclaw",["config","get","gateway.mode"],{stdio:"ignore"});process.exit(r.status===0?0:r.status===1?1:3)}process.exit(c&&c.gateway&&c.gateway.mode?0:1)'`

// serviceKind is the agent whose gateway the box's service runs (OpenClaw's
// "openclaw gateway …"), if it is one.
func serviceKind(s AgentSpec) (AgentKind, bool) {
	for _, id := range s.Agents {
		k, _ := agentKind(id)
		if k.Service != "" && s.Service != "" && strings.HasPrefix(s.Service+" ", strings.Fields(k.Service)[0]+" ") {
			return k, true
		}
	}
	return AgentKind{}, false
}
