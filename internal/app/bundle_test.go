package app

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

func TestEnginePath(t *testing.T) {
	for in, want := range map[string]string{
		`C:\Users\07912\proj\docker-compose.yml`: "/mnt/c/Users/07912/proj/docker-compose.yml",
		"C:/Users/07912/Documents/GitHub/apps":   "/mnt/c/Users/07912/Documents/GitHub/apps",
		"/home/me/proj/./config":                 "/home/me/proj/config",
		"":                                       "",
	} {
		if got := enginePath(in); got != want {
			t.Errorf("enginePath(%q) = %q, want %q", in, got, want)
		}
	}
}

// The order a project seen in the field starts in: Kiri kept nexadmin's
// depends_on out of its label; the Compose file has it.
func TestStartOrder(t *testing.T) {
	c := func(name, service, deps string) madeContainer {
		return madeContainer{id: name, name: name, raw: []byte(fmt.Sprintf(
			`{"Config":{"Labels":{"com.docker.compose.project":"p","com.docker.compose.service":%q,"com.docker.compose.depends_on":%q}}}`, service, deps))}
	}
	made := []madeContainer{
		c("ide-server", "ide-server", "nexadmin:service_healthy:false"),
		c("my_oracle", "my_oracle", ""),
		c("nexadmin", "nexadmin", ""),
		c("nexcore-was", "was", "nexadmin:service_healthy:false"),
	}
	files := map[string][]dependency{"p/nexadmin": {{"my_oracle", "service_healthy"}}}
	order, waits := startOrder(made, files)
	var names []string
	for _, m := range order {
		names = append(names, m.name)
	}
	if got := strings.Join(names, ","); got != "my_oracle,nexadmin,ide-server,nexcore-was" {
		t.Fatalf("order %s", got)
	}
	if w := waits["nexadmin"]; len(w) != 1 || w[0].name != "my_oracle" {
		t.Fatalf("nexadmin waits for %+v", w)
	}
	if w := waits["nexcore-was"]; len(w) != 1 || w[0].name != "nexadmin" || w[0].condition != "service_healthy" {
		t.Fatalf("was waits for %+v", w)
	}
}

func TestHostPaths(t *testing.T) {
	h := &hostPaths{}
	h.add("/mnt/c/proj/logs/was", false)
	h.add("/mnt/c/proj", false)
	h.add("/var/run/docker.sock", false)
	h.add(`C:\proj\docker-compose.yml`, true)
	if l := h.list(); len(l) != 1 || l[0].path != "/mnt/c/proj" {
		t.Fatalf("%+v", l)
	}
}

func TestParseCompose(t *testing.T) {
	deps, images := parseCompose([]byte(`services:
  my_oracle:
    image: gvenzl/oracle-xe:latest
  nexadmin:
    image: nexadmin:v1
    depends_on:
      my_oracle:
        condition: service_healthy
  web:
    build: .
    depends_on: [nexadmin]
  tagged:
    image: app:${TAG}
`))
	if images["nexadmin"] != "nexadmin:v1" || images["my_oracle"] != "gvenzl/oracle-xe:latest" || images["web"] != "" || images["tagged"] != "" {
		t.Fatalf("images %v", images)
	}
	if d := deps["nexadmin"]; len(d) != 1 || d[0] != (dependency{"my_oracle", "service_healthy"}) {
		t.Fatalf("nexadmin deps %v", d)
	}
	if d := deps["web"]; len(d) != 1 || d[0] != (dependency{"nexadmin", "service_started"}) {
		t.Fatalf("web deps %v", d)
	}
	if !journeyName("boxforge-export/nexadmin:20261123-090000") || journeyName("nexadmin:v1") {
		t.Fatal("journeyName")
	}
}

// A project started on Windows, taken to Linux: its Compose file, named
// C:\…, is found where the bundle put it back, /mnt/c/….
func TestLocalFile(t *testing.T) {
	root := t.TempDir()
	dir := root + "/mnt/c/Users/07912/proj"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir+"/docker-compose.yml", []byte("services: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := localFileIn(root, `C:\Users\07912\proj\docker-compose.yml`); got != "/mnt/c/Users/07912/proj/docker-compose.yml" {
		t.Fatalf("got %q", got)
	}
	if got := localFileIn(root, `C:\Users\07912\other.yml`); got != `C:\Users\07912\other.yml` {
		t.Fatalf("a file that is nowhere stays as named: %q", got)
	}
}

// What putting a folder back makes: its highest folder not there yet.
func TestFirstMissing(t *testing.T) {
	root := t.TempDir()
	if got := firstMissing(root + "/mnt/c/Users/me/proj"); got != root+"/mnt" {
		t.Fatalf("got %q", got)
	}
	if got := firstMissing(root); got != "" {
		t.Fatalf("a folder that is there: %q", got)
	}
}

// A Compose folder this user can't write (as one an import made as root)
// is offered to them. Runs where the tests don't run as root (CI).
func TestComposeNotMine(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("root writes everywhere")
	}
	dir := t.TempDir()
	file := dir + "/compose.yaml"
	if err := os.WriteFile(file, []byte("services: {}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	a := &App{}
	if got := a.ComposeNotMine(file); got != "" {
		t.Fatalf("a folder of mine: %q", got)
	}
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(dir, 0o755) })
	if got := a.ComposeNotMine(file); got != dir {
		t.Fatalf("a folder I can't write: %q", got)
	}
}
