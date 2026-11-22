package main

// The service files -install writes, kept apart from the installing so that
// they can be checked on any machine.

import (
	"fmt"
	"strings"
)

// The program's place once installed, and the service's name.
const (
	installDir  = "/opt/boxforge"
	serviceName = "boxforge"
)

// service is what a service file needs to say.
type service struct {
	Exe  string   // the program
	Args []string // its options
	User string   // who it runs as
	Home string   // that user's home: where its password and settings are
}

// command is the program and its options as one line, a word with a space quoted.
func (s service) command() string {
	words := append([]string{s.Exe}, s.Args...)
	for i, w := range words {
		if strings.ContainsAny(w, " \t\"'") {
			words[i] = fmt.Sprintf("%q", w)
		}
	}
	return strings.Join(words, " ")
}

// systemdUnit is /etc/systemd/system/boxforge.service.
func (s service) systemdUnit() string {
	return fmt.Sprintf(`# Made by boxforge-server -install; boxforge-server -uninstall removes it.
[Unit]
Description=BoxForge server
After=network-online.target docker.service podman.socket
Wants=network-online.target

[Service]
User=%s
Environment=HOME=%s
ExecStart=%s
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`, s.User, s.Home, s.command())
}

// openrcScript is /etc/init.d/boxforge (Alpine and others with OpenRC).
func (s service) openrcScript() string {
	args := strings.TrimPrefix(s.command(), s.Exe)
	return fmt.Sprintf(`#!/sbin/openrc-run
# Made by boxforge-server -install; boxforge-server -uninstall removes it.
name="BoxForge server"
command=%q
command_args=%q
command_user="%s"
supervisor="supervise-daemon"
respawn_delay=5
output_log="/var/log/boxforge.log"
error_log="/var/log/boxforge.log"
export HOME=%q

depend() {
	need net
	after docker containerd podman
}

start_pre() {
	checkpath -f -o %s /var/log/boxforge.log
}
`, s.Exe, strings.TrimSpace(args), s.User, s.Home, s.User)
}

// serviceArgs is the options the service runs with: those given with
// -install, or, without -listen, every network over TLS: a service is
// installed to be reached from elsewhere.
func serviceArgs(set map[string]string) []string {
	var args []string
	if _, ok := set["listen"]; !ok {
		args = append(args, "-listen", ":8088")
		if set["cert"] == "" && set["insecure-network"] != "true" {
			args = append(args, "-tls")
		}
	}
	for _, name := range []string{"listen", "tls", "cert", "key", "insecure-network"} {
		v, ok := set[name]
		switch {
		case !ok:
		case v == "true":
			args = append(args, "-"+name)
		case v == "false":
		default:
			args = append(args, "-"+name, v)
		}
	}
	return args
}
