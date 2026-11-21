package app

import (
	"strings"
	"testing"
)

const sample = `# my stack
services:
  web:
    image: nginx:1.27 # the front
    ports:
      - "8080:80"
    depends_on:
      db:
        condition: service_healthy
    labels:
      team: a
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: secret
    volumes:
      - type: volume
        source: pgdata
        target: /var/lib/postgresql/data
volumes:
  pgdata: {}
`

func TestComposeEdit(t *testing.T) {
	a := &App{}
	web, err := a.ComposeService(sample, "web")
	if err != nil || web.Image != "nginx:1.27" || len(web.Ports) != 1 || web.Ports[0] != "8080:80" || len(web.DependsOn) != 1 || web.DependsOn[0] != "db" {
		t.Fatalf("web: %+v %v", web, err)
	}
	db, err := a.ComposeService(sample, "db")
	if err != nil || len(db.Environment) != 1 || db.Environment[0] != "POSTGRES_PASSWORD=secret" || len(db.Locked) != 1 || db.Locked[0] != "volumes" {
		t.Fatalf("db: %+v %v", db, err)
	}

	web.Ports = []string{"8080:80", "8443:443"}
	web.Environment = []string{"MODE=prod"}
	web.Restart = "unless-stopped"
	out, err := a.ComposeEdit(sample, web)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"# my stack", "# the front", `- "8443:443"`, "MODE=prod", "restart: unless-stopped", "condition: service_healthy", "team: a", "pgdata: {}"} {
		if !strings.Contains(out, want) {
			t.Errorf("after editing web, the file lacks %q:\n%s", want, out)
		}
	}

	// the long-form volumes are left alone; the mapping of variables stays one
	db.Environment = append(db.Environment, "POSTGRES_DB=app")
	out, err = a.ComposeEdit(out, db)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"source: pgdata", `POSTGRES_DB: "app"`, "POSTGRES_PASSWORD:"} {
		if !strings.Contains(out, want) {
			t.Errorf("after editing db, the file lacks %q:\n%s", want, out)
		}
	}

	out, err = a.ComposeEdit(out, ServiceEdit{Op: "add", Name: "cache", Image: "redis:7", Ports: []string{"6379:6379"}})
	if err != nil || !strings.Contains(out, "cache:") || !strings.Contains(out, "image: redis:7") {
		t.Fatalf("add: %v\n%s", err, out)
	}
	if _, err := a.ComposeEdit(out, ServiceEdit{Op: "add", Name: "cache", Image: "redis:7"}); err == nil {
		t.Error("a second service of the same name was added")
	}
	out, err = a.ComposeEdit(out, ServiceEdit{Op: "remove", Name: "db"})
	if err != nil || strings.Contains(out, "postgres:17") || strings.Contains(out, "depends_on") {
		t.Fatalf("remove: %v\n%s", err, out)
	}
	if _, err := a.ComposeEdit(out, ServiceEdit{Op: "set", Name: "bad name"}); err == nil {
		t.Error("a name with a space was taken")
	}
	if out, err := a.ComposeEdit("", ServiceEdit{Op: "add", Name: "one", Image: "nginx"}); err != nil || !strings.Contains(out, "services:") {
		t.Errorf("adding to an empty file: %v %q", err, out)
	}
}
