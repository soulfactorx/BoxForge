package app

// A Compose project, moved to Kubernetes: a namespace of its own (so that
// its services find each other by the same names they used), and for each
// service a Deployment, a Service when it serves ports, and a
// PersistentVolumeClaim for each named volume. What has no counterpart is
// said, not guessed at.

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// KubePlan is what a Compose project becomes in Kubernetes.
type KubePlan struct {
	Namespace   string   `json:"namespace"`
	YAML        string   `json:"yaml"`
	Deployments []string `json:"deployments"`
	// Built: images the project builds here, which the cluster can't fetch.
	Built []string `json:"built"`
	// Images: every image the project runs.
	Images []string `json:"images"`
	// Notes: what doesn't carry over, in plain words.
	Notes []string `json:"notes"`
}

// ComposeToKube reads a Compose project as Compose itself does and turns it
// into Kubernetes objects.
func (a *App) ComposeToKube(project string, files []string) (KubePlan, error) {
	raw, err := a.ComposeConfig(project, files)
	if err != nil {
		return KubePlan{}, err
	}
	return composeToKube(project, []byte(raw))
}

var notDNS = regexp.MustCompile(`[^a-z0-9-]+`)

// dnsName is a name Kubernetes takes: lower case letters, digits and "-".
func dnsName(s string) string {
	s = strings.Trim(notDNS.ReplaceAllString(strings.ToLower(s), "-"), "-")
	if len(s) > 63 {
		s = strings.TrimRight(s[:63], "-")
	}
	if s == "" {
		s = "app"
	}
	return s
}

type composeFile struct {
	Name     string                        `json:"name"`
	Services map[string]kubeComposeService `json:"services"`
	Volumes  map[string]struct {
		External bool `json:"external"`
	} `json:"volumes"`
}

type kubeComposeService struct {
	Image       string             `json:"image"`
	Build       *json.RawMessage   `json:"build"`
	Command     []string           `json:"command"`
	Entrypoint  []string           `json:"entrypoint"`
	Environment map[string]*string `json:"environment"`
	Ports       []struct {
		Target    int    `json:"target"`
		Published string `json:"published"`
		Protocol  string `json:"protocol"`
	} `json:"ports"`
	Expose  []string `json:"expose"`
	Volumes []struct {
		Type     string `json:"type"`
		Source   string `json:"source"`
		Target   string `json:"target"`
		ReadOnly bool   `json:"read_only"`
	} `json:"volumes"`
	Tty         bool                       `json:"tty"`
	StdinOpen   bool                       `json:"stdin_open"`
	WorkingDir  string                     `json:"working_dir"`
	DependsOn   map[string]json.RawMessage `json:"depends_on"`
	Healthcheck *json.RawMessage           `json:"healthcheck"`
	Deploy      *struct {
		Replicas *int `json:"replicas"`
	} `json:"deploy"`
	Scale *int `json:"scale"`
	// Settings with no plain counterpart: named in the notes.
	Privileged  bool             `json:"privileged"`
	NetworkMode string           `json:"network_mode"`
	CapAdd      []string         `json:"cap_add"`
	Devices     *json.RawMessage `json:"devices"`
	ExtraHosts  *json.RawMessage `json:"extra_hosts"`
	User        string           `json:"user"`
}

func composeToKube(project string, raw []byte) (KubePlan, error) {
	var c composeFile
	if err := json.Unmarshal(raw, &c); err != nil {
		return KubePlan{}, err
	}
	if c.Name != "" {
		project = c.Name
	}
	ns := dnsName(project)
	plan := KubePlan{Namespace: ns, Deployments: []string{}, Built: []string{}, Images: []string{}, Notes: []string{}}
	note := func(format string, args ...any) { plan.Notes = append(plan.Notes, fmt.Sprintf(format, args...)) }

	docs := []map[string]any{{
		"apiVersion": "v1", "kind": "Namespace",
		"metadata": map[string]any{"name": ns, "labels": map[string]any{"boxforge.compose/project": project}},
	}}
	names := make([]string, 0, len(c.Services))
	for name := range c.Services {
		names = append(names, name)
	}
	sort.Strings(names)

	claims := map[string]bool{}
	var waits []string
	for _, svc := range names {
		s := c.Services[svc]
		name := dnsName(svc)
		if name != svc {
			note("서비스 %s는 Kubernetes에서 %s라는 이름입니다. 다른 서비스가 %s로 찾던 곳은 %s로 고쳐야 합니다.", svc, name, svc, name)
		}
		image := s.Image
		if image == "" && s.Build != nil {
			// Compose names what it builds after the project and the service.
			image = project + "-" + svc
		}
		if image == "" {
			note("서비스 %s에는 이미지가 없어 건너뜁니다.", svc)
			continue
		}
		if s.Build != nil {
			plan.Built = append(plan.Built, image)
		}
		plan.Images = append(plan.Images, image)

		container := map[string]any{"name": name, "image": image}
		if s.Build != nil {
			// Built here: what the cluster has, not fetched from anywhere.
			container["imagePullPolicy"] = "IfNotPresent"
		}
		// Compose's entrypoint is the program, its command the arguments:
		// Kubernetes calls them command and args.
		if len(s.Entrypoint) > 0 {
			container["command"] = s.Entrypoint
		}
		if len(s.Command) > 0 {
			container["args"] = s.Command
		}
		if s.WorkingDir != "" {
			container["workingDir"] = s.WorkingDir
		}
		if s.Tty {
			container["tty"] = true
		}
		if s.StdinOpen || s.Tty {
			container["stdin"] = true
		}

		var env []map[string]any
		keys := make([]string, 0, len(s.Environment))
		for k := range s.Environment {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if v := s.Environment[k]; v != nil {
				env = append(env, map[string]any{"name": k, "value": *v})
			} else {
				note("서비스 %s의 환경변수 %s는 값이 없어(이 PC의 환경에서 가져오는 것) 빠집니다.", svc, k)
			}
		}
		if env != nil {
			container["env"] = env
		}

		// The ports it serves: those published and those only exposed.
		var ports []int
		seen := map[int]bool{}
		add := func(p int) {
			if p > 0 && p < 65536 && !seen[p] {
				seen[p] = true
				ports = append(ports, p)
			}
		}
		published := []string{}
		for _, p := range s.Ports {
			if p.Protocol != "" && p.Protocol != "tcp" {
				note("서비스 %s의 %d/%s 포트는 TCP가 아니라 옮기지 않습니다.", svc, p.Target, p.Protocol)
				continue
			}
			add(p.Target)
			if p.Published != "" {
				published = append(published, p.Published+"→"+strconv.Itoa(p.Target))
			}
		}
		for _, e := range s.Expose {
			n, proto, _ := strings.Cut(e, "/")
			if v, err := strconv.Atoi(n); err == nil && (proto == "" || proto == "tcp") {
				add(v)
			}
		}
		if len(ports) > 0 {
			var cps []map[string]any
			for _, p := range ports {
				cps = append(cps, map[string]any{"containerPort": p})
			}
			container["ports"] = cps
		}
		if len(published) > 0 {
			note("서비스 %s를 이 PC의 포트(%s)로 열던 것은, Kubernetes 화면의 서비스 탭에서 \"내 PC로 연결\"로 엽니다.", svc, strings.Join(published, ", "))
		}

		var mounts, volumes []map[string]any
		for i, v := range s.Volumes {
			vol := fmt.Sprintf("v%d", i)
			switch {
			case v.Type == "volume" && v.Source != "":
				claim := dnsName(v.Source)
				if !claims[claim] {
					claims[claim] = true
					docs = append(docs, map[string]any{
						"apiVersion": "v1", "kind": "PersistentVolumeClaim",
						"metadata": map[string]any{"name": claim, "namespace": ns},
						"spec": map[string]any{
							"accessModes": []string{"ReadWriteOnce"},
							"resources":   map[string]any{"requests": map[string]any{"storage": "1Gi"}},
						},
					})
					note("볼륨 %s는 새 저장소 %s(1GB)가 됩니다. 지금 볼륨에 든 데이터는 옮겨지지 않습니다.", v.Source, claim)
				}
				volumes = append(volumes, map[string]any{"name": vol, "persistentVolumeClaim": map[string]any{"claimName": claim}})
			case v.Type == "volume" || v.Type == "tmpfs":
				// Anonymous: kept only while the pod lives, as Compose's are
				// in practice.
				ed := map[string]any{}
				if v.Type == "tmpfs" {
					ed["medium"] = "Memory"
				}
				volumes = append(volumes, map[string]any{"name": vol, "emptyDir": ed})
			default:
				note("서비스 %s가 쓰는 이 PC의 폴더 %s(→ %s)는 클러스터로 옮길 수 없어 빠집니다. 필요한 파일은 이미지에 넣거나 ConfigMap으로 주세요.", svc, v.Source, v.Target)
				continue
			}
			m := map[string]any{"name": vol, "mountPath": v.Target}
			if v.ReadOnly {
				m["readOnly"] = true
			}
			mounts = append(mounts, m)
		}
		if mounts != nil {
			container["volumeMounts"] = mounts
		}

		replicas := 1
		if s.Deploy != nil && s.Deploy.Replicas != nil {
			replicas = *s.Deploy.Replicas
		} else if s.Scale != nil {
			replicas = *s.Scale
		}
		if replicas > 1 && len(volumes) > 0 {
			note("서비스 %s는 파드 %d개가 같은 저장소를 씁니다. 이 클러스터(노드 하나)에서는 되지만, 동시에 쓰면 안 되는 앱(데이터베이스 등)은 1개로 두세요.", svc, replicas)
		}

		labels := map[string]any{"app": name}
		pod := map[string]any{"containers": []any{container}}
		if volumes != nil {
			pod["volumes"] = volumes
		}
		docs = append(docs, map[string]any{
			"apiVersion": "apps/v1", "kind": "Deployment",
			"metadata": map[string]any{"name": name, "namespace": ns, "labels": map[string]any{"app": name, "boxforge.compose/service": svc}},
			"spec": map[string]any{
				"replicas": replicas,
				"selector": map[string]any{"matchLabels": labels},
				"template": map[string]any{"metadata": map[string]any{"labels": labels}, "spec": pod},
			},
		})
		plan.Deployments = append(plan.Deployments, name)

		if len(ports) > 0 {
			var sps []map[string]any
			for _, p := range ports {
				sps = append(sps, map[string]any{"name": fmt.Sprintf("p%d", p), "port": p, "targetPort": p})
			}
			docs = append(docs, map[string]any{
				"apiVersion": "v1", "kind": "Service",
				"metadata": map[string]any{"name": name, "namespace": ns},
				"spec":     map[string]any{"selector": labels, "ports": sps},
			})
		}

		if len(s.DependsOn) > 0 {
			waits = append(waits, svc)
		}
		if s.Healthcheck != nil {
			note("서비스 %s의 상태 검사(healthcheck)는 옮기지 않습니다.", svc)
		}
		var odd []string
		if s.Privileged {
			odd = append(odd, "privileged")
		}
		if s.NetworkMode != "" {
			odd = append(odd, "network_mode")
		}
		if len(s.CapAdd) > 0 {
			odd = append(odd, "cap_add")
		}
		if s.Devices != nil {
			odd = append(odd, "devices")
		}
		if s.ExtraHosts != nil {
			odd = append(odd, "extra_hosts")
		}
		if s.User != "" {
			odd = append(odd, "user")
		}
		if len(odd) > 0 {
			note("서비스 %s의 %s 설정은 옮기지 않습니다. 필요하면 만들어진 YAML을 고치세요.", svc, strings.Join(odd, ", "))
		}
	}
	if len(waits) > 0 {
		note("Kubernetes에는 depends_on(먼저 시작할 서비스)이 없습니다. %s는 기다리지 않고 함께 시작하니, 상대가 준비될 때까지 다시 시도하지 못하는 앱은 처음에 몇 번 다시 켜질 수 있습니다.", strings.Join(waits, ", "))
	}
	for name, v := range c.Volumes {
		if v.External {
			note("외부 볼륨 %s는 옮기지 않습니다.", name)
		}
	}
	if len(plan.Built) > 0 {
		note("이 PC에서 빌드하는 이미지(%s)는 클러스터가 받아 올 곳이 없어, 엔진의 것을 클러스터에 넣어서 씁니다. 먼저 Compose로 한 번 빌드(올리기)해 두어야 합니다.", strings.Join(plan.Built, ", "))
	}

	var out strings.Builder
	for i, d := range docs {
		if i > 0 {
			out.WriteString("---\n")
		}
		b, err := yaml.Marshal(d)
		if err != nil {
			return KubePlan{}, err
		}
		out.Write(b)
	}
	plan.YAML = out.String()
	return plan, nil
}
