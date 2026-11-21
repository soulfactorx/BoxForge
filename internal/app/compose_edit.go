package app

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Editing a compose file from the picture of its services.
//
// The file stays the truth: an edit made in a form is written into the
// file's text, keeping everything else in it (comments, order, the parts
// the form knows nothing of), and the result goes to the same review the
// hand-edited file gets before anything is applied.

// ServiceEdit is a service as the form shows it, and a change to make.
// The lists are in compose's short forms: "8080:80", "KEY=value",
// "data:/var/lib/data".
type ServiceEdit struct {
	Op          string   `json:"op"` // set, add, remove
	Name        string   `json:"name"`
	Image       string   `json:"image"`
	Ports       []string `json:"ports"`
	Environment []string `json:"environment"`
	Volumes     []string `json:"volumes"`
	Restart     string   `json:"restart"`
	DependsOn   []string `json:"dependsOn"`
	// Locked names the fields written in a way the form can't show (the
	// long forms): they are left as they are.
	Locked []string `json:"locked"`
	// Build says the service is built from source rather than an image.
	Build bool `json:"build"`
}

var serviceName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

// services finds the "services" mapping of a compose document, making it
// when asked to.
func services(doc *yaml.Node, make bool) (*yaml.Node, error) {
	if doc.Kind != yaml.DocumentNode || len(doc.Content) == 0 {
		if !make {
			return nil, fmt.Errorf("the compose file is empty")
		}
		doc.Kind = yaml.DocumentNode
		doc.Content = []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}
	}
	root := doc.Content[0]
	if root.Kind != yaml.MappingNode {
		return nil, fmt.Errorf("the compose file is not a mapping at its top")
	}
	if s := get(root, "services"); s != nil {
		if s.Kind != yaml.MappingNode {
			return nil, fmt.Errorf("\"services\" in the compose file is not a mapping")
		}
		return s, nil
	}
	if !make {
		return nil, fmt.Errorf("the compose file has no services")
	}
	s := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
	root.Content = append(root.Content, scalar("services"), s)
	return s, nil
}

func scalar(v string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: v}
}

// quoted is a scalar written in quotes: for values YAML would otherwise
// read as something else ("8080:80" is fine, "80:80" is a base-60 number
// to old parsers; compose's own advice is to quote ports).
func quoted(v string) *yaml.Node {
	return &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!str", Value: v, Style: yaml.DoubleQuotedStyle}
}

// get returns the value of key in a mapping, nil when it has none.
func get(m *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

// set puts key: value in a mapping, in the key's place if it is there.
func set(m *yaml.Node, key string, value *yaml.Node) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			old := m.Content[i+1]
			// The comments written beside the old value stay with the new.
			value.HeadComment, value.LineComment, value.FootComment = old.HeadComment, old.LineComment, old.FootComment
			if old.Kind == yaml.ScalarNode && value.Kind == yaml.ScalarNode && old.Value == value.Value {
				return // unchanged: left exactly as it is written
			}
			m.Content[i+1] = value
			return
		}
	}
	m.Content = append(m.Content, scalar(key), value)
}

func drop(m *yaml.Node, key string) {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			m.Content = append(m.Content[:i], m.Content[i+2:]...)
			return
		}
	}
}

// list reads a field as short-form strings. ok is false when it is
// written in a way that can't be shown so.
func list(n *yaml.Node, pair string) (out []string, ok bool) {
	out = []string{}
	if n == nil {
		return out, true
	}
	switch n.Kind {
	case yaml.SequenceNode:
		for _, item := range n.Content {
			if item.Kind != yaml.ScalarNode {
				return nil, false // the long form: a mapping per entry
			}
			out = append(out, item.Value)
		}
		return out, true
	case yaml.MappingNode:
		if pair == "" {
			return nil, false
		}
		for i := 0; i+1 < len(n.Content); i += 2 {
			if n.Content[i+1].Kind != yaml.ScalarNode {
				return nil, false
			}
			if n.Content[i+1].Tag == "!!null" {
				out = append(out, n.Content[i].Value)
			} else {
				out = append(out, n.Content[i].Value+pair+n.Content[i+1].Value)
			}
		}
		return out, true
	}
	return nil, false
}

// ComposeService reads one service out of a compose file's text, for the
// form. An empty name lists the services' names in Locked instead.
func (a *App) ComposeService(text, name string) (ServiceEdit, error) {
	var doc yaml.Node
	if err := yaml.Unmarshal([]byte(text), &doc); err != nil {
		return ServiceEdit{}, fmt.Errorf("the compose file can't be read: %w", err)
	}
	all, err := services(&doc, false)
	if err != nil {
		return ServiceEdit{}, err
	}
	svc := get(all, name)
	if svc == nil || svc.Kind != yaml.MappingNode {
		return ServiceEdit{}, fmt.Errorf("service %q is not in this file (it may be in another of the project's files)", name)
	}
	e := ServiceEdit{Op: "set", Name: name, Locked: []string{}}
	if n := get(svc, "image"); n != nil {
		e.Image = n.Value
	}
	e.Build = get(svc, "build") != nil
	if n := get(svc, "restart"); n != nil {
		e.Restart = n.Value
	}
	read := func(key, pair string) []string {
		l, ok := list(get(svc, key), pair)
		if !ok {
			e.Locked = append(e.Locked, key)
			return []string{}
		}
		return l
	}
	e.Ports = read("ports", "")
	e.Volumes = read("volumes", "")
	e.Environment = read("environment", "=")
	// depends_on as a mapping carries conditions: its names are shown, and
	// it is left alone unless the names change.
	if n := get(svc, "depends_on"); n != nil && n.Kind == yaml.MappingNode {
		e.DependsOn = []string{}
		for i := 0; i+1 < len(n.Content); i += 2 {
			e.DependsOn = append(e.DependsOn, n.Content[i].Value)
		}
	} else {
		e.DependsOn = read("depends_on", "")
	}
	return e, nil
}

func clean(in []string) []string {
	out := []string{}
	for _, s := range in {
		if s = strings.TrimSpace(s); s != "" {
			out = append(out, s)
		}
	}
	return out
}

func same(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// ComposeEdit applies an edit to a compose file's text and returns the
// new text. Nothing is saved: the caller shows it for review.
func (a *App) ComposeEdit(text string, e ServiceEdit) (string, error) {
	e.Name = strings.TrimSpace(e.Name)
	if !serviceName.MatchString(e.Name) {
		return "", fmt.Errorf("a service's name is letters, digits, dots, dashes and underscores")
	}
	var doc yaml.Node
	if strings.TrimSpace(text) != "" {
		if err := yaml.Unmarshal([]byte(text), &doc); err != nil {
			return "", fmt.Errorf("the compose file can't be read: %w", err)
		}
	}
	all, err := services(&doc, e.Op == "add")
	if err != nil {
		return "", err
	}
	svc := get(all, e.Name)
	switch e.Op {
	case "remove":
		if svc == nil {
			return "", fmt.Errorf("service %q is not in this file", e.Name)
		}
		drop(all, e.Name)
		// Nobody can depend on what is gone.
		for i := 1; i < len(all.Content); i += 2 {
			other := all.Content[i]
			dep := get(other, "depends_on")
			if dep == nil {
				continue
			}
			switch dep.Kind {
			case yaml.SequenceNode:
				kept := dep.Content[:0]
				for _, item := range dep.Content {
					if item.Value != e.Name {
						kept = append(kept, item)
					}
				}
				dep.Content = kept
			case yaml.MappingNode:
				drop(dep, e.Name)
			}
			if len(dep.Content) == 0 {
				drop(other, "depends_on")
			}
		}
	case "add":
		if svc != nil {
			return "", fmt.Errorf("there is a service named %q already", e.Name)
		}
		if strings.TrimSpace(e.Image) == "" {
			return "", fmt.Errorf("a new service needs an image")
		}
		svc = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
		all.Content = append(all.Content, scalar(e.Name), svc)
		fallthrough
	case "set":
		if svc == nil || svc.Kind != yaml.MappingNode {
			return "", fmt.Errorf("service %q is not in this file", e.Name)
		}
		locked := map[string]bool{}
		for _, k := range e.Locked {
			locked[k] = true
		}
		if img := strings.TrimSpace(e.Image); img != "" {
			set(svc, "image", scalar(img))
		}
		if r := strings.TrimSpace(e.Restart); r != "" {
			set(svc, "restart", scalar(r))
		} else {
			drop(svc, "restart")
		}
		put := func(key string, values []string, quote bool) {
			if locked[key] {
				return
			}
			values = clean(values)
			if len(values) == 0 {
				drop(svc, key)
				return
			}
			seq := &yaml.Node{Kind: yaml.SequenceNode, Tag: "!!seq"}
			for _, v := range values {
				if quote {
					seq.Content = append(seq.Content, quoted(v))
				} else {
					seq.Content = append(seq.Content, scalar(v))
				}
			}
			set(svc, key, seq)
		}
		put("ports", e.Ports, true)
		put("volumes", e.Volumes, false)
		// Variables keep the form they are written in: a mapping stays one.
		if !locked["environment"] {
			env := clean(e.Environment)
			if old := get(svc, "environment"); old != nil && old.Kind == yaml.MappingNode && len(env) > 0 {
				m := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
				for _, kv := range env {
					k, v, has := strings.Cut(kv, "=")
					val := quoted(v)
					if !has {
						val = &yaml.Node{Kind: yaml.ScalarNode, Tag: "!!null"}
					}
					m.Content = append(m.Content, scalar(strings.TrimSpace(k)), val)
				}
				set(svc, "environment", m)
			} else {
				put("environment", env, false)
			}
		}
		if !locked["depends_on"] {
			deps := clean(e.DependsOn)
			old := get(svc, "depends_on")
			if old != nil && old.Kind == yaml.MappingNode {
				// With conditions: only names that went away are taken out,
				// and new ones are added the plain way.
				have := []string{}
				for i := 0; i+1 < len(old.Content); i += 2 {
					have = append(have, old.Content[i].Value)
				}
				if !same(have, deps) {
					want := map[string]bool{}
					for _, d := range deps {
						want[d] = true
					}
					for _, h := range have {
						if !want[h] {
							drop(old, h)
						}
						delete(want, h)
					}
					for _, d := range deps {
						if want[d] {
							cond := &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map"}
							cond.Content = append(cond.Content, scalar("condition"), scalar("service_started"))
							old.Content = append(old.Content, scalar(d), cond)
						}
					}
					if len(old.Content) == 0 {
						drop(svc, "depends_on")
					}
				}
			} else {
				put("depends_on", deps, false)
			}
		}
	default:
		return "", fmt.Errorf("unknown edit %q", e.Op)
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
