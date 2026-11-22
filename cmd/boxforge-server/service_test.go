package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestServiceArgs(t *testing.T) {
	for _, c := range []struct {
		set  map[string]string
		want []string
	}{
		{map[string]string{}, []string{"-listen", ":8088", "-tls"}},
		{map[string]string{"install": "true", "user": "me"}, []string{"-listen", ":8088", "-tls"}},
		{map[string]string{"listen": "127.0.0.1:9000"}, []string{"-listen", "127.0.0.1:9000"}},
		{map[string]string{"listen": ":443", "cert": "/etc/c.pem", "key": "/etc/k.pem"}, []string{"-listen", ":443", "-cert", "/etc/c.pem", "-key", "/etc/k.pem"}},
		{map[string]string{"insecure-network": "true"}, []string{"-listen", ":8088", "-insecure-network"}},
	} {
		if got := serviceArgs(c.set); !reflect.DeepEqual(got, c.want) {
			t.Errorf("%v: %q, want %q", c.set, got, c.want)
		}
	}
}

func TestServiceFiles(t *testing.T) {
	s := service{Exe: "/opt/boxforge/boxforge-server", Args: []string{"-listen", ":8088", "-tls", "-cert", "/my certs/c.pem"}, User: "me", Home: "/home/me"}
	unit := s.systemdUnit()
	for _, want := range []string{"User=me\n", "Environment=HOME=/home/me\n", `ExecStart=/opt/boxforge/boxforge-server -listen :8088 -tls -cert "/my certs/c.pem"` + "\n", "Restart=on-failure", "WantedBy=multi-user.target"} {
		if !strings.Contains(unit, want) {
			t.Errorf("systemd unit lacks %q:\n%s", want, unit)
		}
	}
	rc := s.openrcScript()
	for _, want := range []string{"#!/sbin/openrc-run\n", `command="/opt/boxforge/boxforge-server"`, `command_args="-listen :8088 -tls -cert \"/my certs/c.pem\""`, `command_user="me"`, `supervisor="supervise-daemon"`, `export HOME="/home/me"`, "checkpath -f -o me /var/log/boxforge.log"} {
		if !strings.Contains(rc, want) {
			t.Errorf("OpenRC script lacks %q:\n%s", want, rc)
		}
	}
}

func TestWithoutFlag(t *testing.T) {
	got := withoutFlag([]string{"-daemon", "-listen", ":8088", "--daemon", "-daemon=true", "-tls"}, "daemon")
	if want := []string{"-listen", ":8088", "-tls"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("%q", got)
	}
}
