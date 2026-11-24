package app

import (
	"strings"
	"testing"
)

const hostsCompose = `services:
  my_oracle:
    image: gvenzl/oracle-xe
    ports:
      - "1521:1521" # the database
  nexadmin:
    image: nexadmin:v1
    environment:
      DB_URL: jdbc:oracle:thin:@host.docker.internal:1521/XE
    extra_hosts:
      - "host.docker.internal:host-gateway"
      - "other:10.0.0.1"
  ide:
    image: ide-server
    environment:
      - SPRING_DATASOURCE_URL=jdbc:oracle:thin:@host.docker.internal:1521/XE
    extra_hosts:
      - host.docker.internal=host-gateway
  web:
    image: web
    environment:
      - API=http://host.docker.internal:9999
`

func TestHostHints(t *testing.T) {
	h := hostHints(hostsCompose)
	if len(h) != 1 || h[0].Target != "my_oracle" || h[0].Port != 1521 || strings.Join(h[0].From, ",") != "nexadmin,ide" {
		t.Fatalf("hints = %+v", h)
	}
	if hostHints("not: [yaml") == nil || len(hostHints("services: {}")) != 0 {
		t.Fatal("no hints expected")
	}
}

func TestComposeAliasHost(t *testing.T) {
	out, err := (&App{}).ComposeAliasHost(hostsCompose, "my_oracle")
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"# the database", "networks:\n      default:\n        aliases:\n          - host.docker.internal", `"other:10.0.0.1"`} {
		if !strings.Contains(out, want) {
			t.Fatalf("missing %q in:\n%s", want, out)
		}
	}
	if strings.Contains(out, "host-gateway") {
		t.Fatalf("host-gateway left:\n%s", out)
	}
	if len(hostHints(out)) != 0 {
		t.Fatalf("still a hint after the fix:\n%s", out)
	}
	// Named networks each get the alias; done twice it adds nothing more.
	named := "services:\n  db:\n    image: x\n    networks: [back, front]\n"
	out, err = (&App{}).ComposeAliasHost(named, "db")
	if err == nil {
		out, err = (&App{}).ComposeAliasHost(out, "db")
	}
	if err != nil || strings.Count(out, "host.docker.internal") != 2 || !strings.Contains(out, "front:\n") {
		t.Fatalf("named networks: %v\n%s", err, out)
	}
	if _, err := (&App{}).ComposeAliasHost(named, "nope"); err == nil {
		t.Fatal("no error for a missing service")
	}
}
