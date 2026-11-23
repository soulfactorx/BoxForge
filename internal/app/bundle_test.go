package app

import (
	"fmt"
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
