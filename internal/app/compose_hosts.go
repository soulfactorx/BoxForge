package app

// A project that reaches one of its own services through the PC: an app
// whose database address is host.docker.internal:1521, the database a
// service of the same project publishing 1521. On Docker Desktop and Kiri
// the engine takes that name to the PC and back; on a plain Docker engine
// (Linux) the way goes out through the PC's firewall, which often stops it,
// and the app never gets its database. Giving the database the network
// alias host.docker.internal sends that name straight to it instead, on
// every engine. These find the case and write that alias in.

import (
	"bytes"
	"context"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/soulfactorx/boxforge/internal/engine"
)

// ComposeHint is something about a compose file worth doing: here, a
// service the others reach as host.docker.internal:Port.
type ComposeHint struct {
	Kind   string   `json:"kind"`   // "host-alias"
	Target string   `json:"target"` // the service that has the port
	Port   int      `json:"port"`
	From   []string `json:"from"` // the services that reach it so
}

var hostRef = regexp.MustCompile(`host\.docker\.internal:(\d+)`)

const hostName = "host.docker.internal"

// ComposeHints looks at a compose file's text for what could stop it
// working on the engine in use: a service reached through the PC where the
// engine doesn't take that name to the PC by itself.
func (a *App) ComposeHints(text string) ([]ComposeHint, error) {
	out := []ComposeHint{}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if g, ok := a.eng().Containers().(engine.HostNameGiver); !ok || g.GivesHostName(ctx) {
		return out, nil
	}
	return hostHints(text), nil
}

// hostHints finds, in a compose file's text, the services reached as
// host.docker.internal:port where another service publishes that port.
func hostHints(text string) []ComposeHint {
	out := []ComposeHint{}
	var doc yaml.Node
	if yaml.Unmarshal([]byte(text), &doc) != nil {
		return out
	}
	all, err := services(&doc, false)
	if err != nil {
		return out
	}
	publishes := map[int]string{} // published port → service
	wants := map[int][]string{}   // port → services that reach it so
	aliased := map[string]bool{}
	for i := 0; i+1 < len(all.Content); i += 2 {
		name, svc := all.Content[i].Value, all.Content[i+1]
		if svc.Kind != yaml.MappingNode {
			continue
		}
		if ports, ok := list(get(svc, "ports"), ""); ok {
			for _, p := range ports {
				if n := publishedPort(p); n > 0 {
					publishes[n] = name
				}
			}
		}
		env, _ := list(get(svc, "environment"), "=")
		for _, e := range env {
			for _, m := range hostRef.FindAllStringSubmatch(e, -1) {
				if n, err := strconv.Atoi(m[1]); err == nil && !contains(wants[n], name) {
					wants[n] = append(wants[n], name)
				}
			}
		}
		aliased[name] = hasAlias(get(svc, "networks"), hostName)
	}
	ports := make([]int, 0, len(wants))
	for p := range wants {
		ports = append(ports, p)
	}
	sort.Ints(ports)
	for _, p := range ports {
		target := publishes[p]
		if target == "" || aliased[target] {
			continue
		}
		var from []string
		for _, f := range wants[p] {
			if f != target {
				from = append(from, f)
			}
		}
		if len(from) > 0 {
			out = append(out, ComposeHint{Kind: "host-alias", Target: target, Port: p, From: from})
		}
	}
	return out
}

// publishedPort reads the port a short-form ports entry opens on the PC
// ("1521:1521", "127.0.0.1:8080:80", "8443:8443/tcp").
func publishedPort(p string) int {
	p = strings.Trim(p, `"`)
	p, _, _ = strings.Cut(p, "/")
	parts := strings.Split(p, ":")
	if len(parts) < 2 {
		return 0
	}
	n, err := strconv.Atoi(parts[len(parts)-2])
	if err != nil {
		return 0
	}
	return n
}

// hasAlias reports whether a service's networks give it the alias.
func hasAlias(nets *yaml.Node, alias string) bool {
	if nets == nil || nets.Kind != yaml.MappingNode {
		return false
	}
	for i := 0; i+1 < len(nets.Content); i += 2 {
		if v := nets.Content[i+1]; v.Kind == yaml.MappingNode {
			if as, ok := list(get(v, "aliases"), ""); ok && contains(as, alias) {
				return true
			}
		}
	}
	return false
}

// ComposeAliasHost writes the fix into a compose file's text: target gets
// the network alias host.docker.internal on each network it is on (the
// project's default one when it names none), and the extra_hosts entries
// that sent that name to the PC are taken out of every service (they would
// win over the alias). Comments stay. Nothing is saved: the text is shown.
func (a *App) ComposeAliasHost(text, target string) (string, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(text), &doc); err != nil {
		return "", fmt.Errorf("the compose file can't be read: %w", err)
	}
	all, err := services(&doc, false)
	if err != nil {
		return "", err
	}
	svc := get(all, target)
	if svc == nil || svc.Kind != yaml.MappingNode {
		return "", fmt.Errorf("the compose file has no service %q", target)
	}
	if get(svc, "network_mode") != nil {
		return "", fmt.Errorf("service %q uses network_mode: it can't have an alias", target)
	}
	nets := get(svc, "networks")
	switch {
	case nets == nil:
		nets = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		nets.Content = append(nets.Content, scalar("default"), &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"})
		set(svc, "networks", nets)
	case nets.Kind == yaml.SequenceNode: // [backend, front]: each becomes a key
		m := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		for _, n := range nets.Content {
			m.Content = append(m.Content, scalar(n.Value), &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"})
		}
		set(svc, "networks", m)
		nets = m
	}
	for i := 0; i+1 < len(nets.Content); i += 2 {
		v := nets.Content[i+1]
		if v.Kind != yaml.MappingNode { // "default:" with nothing after it
			v = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
			nets.Content[i+1] = v
		}
		as := get(v, "aliases")
		if as == nil {
			as = &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
			set(v, "aliases", as)
		}
		if have, _ := list(as, ""); !contains(have, hostName) {
			as.Content = append(as.Content, scalar(hostName))
		}
	}
	// The entries that sent the name to the PC.
	for i := 0; i+1 < len(all.Content); i += 2 {
		s := all.Content[i+1]
		if s.Kind != yaml.MappingNode {
			continue
		}
		eh := get(s, "extra_hosts")
		if eh == nil || eh.Kind != yaml.SequenceNode {
			continue
		}
		var keep []*yaml.Node
		for _, e := range eh.Content {
			if strings.HasPrefix(e.Value, hostName+":") || strings.HasPrefix(e.Value, hostName+"=") {
				continue
			}
			keep = append(keep, e)
		}
		if len(keep) == 0 {
			drop(s, "extra_hosts")
		} else {
			eh.Content = keep
		}
	}
	var out bytes.Buffer
	enc := yaml.NewEncoder(&out)
	enc.SetIndent(2)
	if err := enc.Encode(&doc); err != nil {
		return "", err
	}
	_ = enc.Close()
	return out.String(), nil
}
