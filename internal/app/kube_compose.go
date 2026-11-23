package app

// A Compose project, moved to Kubernetes: a namespace of its own (so that
// its services find each other by the same names they used), and for each
// service a Deployment, a Service when it serves ports, and a
// PersistentVolumeClaim for each named volume. What has no counterpart is
// said, not guessed at.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"

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
	// Volumes: the project's named volumes, each become a claim, whose data
	// can be copied over after the deployment.
	Volumes []KubeVolume `json:"volumes"`
}

// KubeVolume is one of a project's volumes and the claim it becomes.
type KubeVolume struct {
	Volume      string   `json:"volume"` // the engine's volume ("project_name")
	Claim       string   `json:"claim"`
	Deployments []string `json:"deployments"` // those that mount it
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
		Name     string `json:"name"`
		External bool   `json:"external"`
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
	Scale      *int            `json:"scale"`
	Privileged bool            `json:"privileged"`
	CapAdd     []string        `json:"cap_add"`
	CapDrop    []string        `json:"cap_drop"`
	ExtraHosts json.RawMessage `json:"extra_hosts"`
	User       string          `json:"user"`
	Hostname   string          `json:"hostname"`
	Domainname string          `json:"domainname"`
	MacAddress string          `json:"mac_address"`
	Networks   map[string]*struct {
		Aliases    []string `json:"aliases"`
		IPv4       string   `json:"ipv4_address"`
		IPv6       string   `json:"ipv6_address"`
		MacAddress string   `json:"mac_address"`
	} `json:"networks"`
	// Settings with no plain counterpart: named in the notes.
	NetworkMode string           `json:"network_mode"`
	Devices     *json.RawMessage `json:"devices"`
}

// extraHosts reads Compose's extra_hosts, a list ("name=ip", or "name:ip"
// in older versions) or a map, as ip → names.
func extraHosts(raw json.RawMessage) (map[string][]string, []string) {
	out := map[string][]string{}
	var skipped []string
	addOne := func(name, ip string) {
		name, ip = strings.TrimSpace(name), strings.Trim(strings.TrimSpace(ip), "[]")
		if net.ParseIP(ip) == nil {
			skipped = append(skipped, name+"="+ip) // host-gateway and the like
			return
		}
		out[ip] = append(out[ip], name)
	}
	var list []string
	var dict map[string]any
	switch {
	case len(raw) == 0 || string(raw) == "null":
	case json.Unmarshal(raw, &list) == nil:
		for _, e := range list {
			if name, ip, ok := strings.Cut(e, "="); ok {
				addOne(name, ip)
			} else if name, ip, ok := strings.Cut(e, ":"); ok {
				addOne(name, ip)
			}
		}
	case json.Unmarshal(raw, &dict) == nil:
		for name, v := range dict {
			switch v := v.(type) {
			case string:
				addOne(name, v)
			case []any:
				for _, ip := range v {
					addOne(name, fmt.Sprint(ip))
				}
			}
		}
	}
	return out, skipped
}

// kubeMacScript gives a pod's network the MAC address the service had in
// Compose (software licensed to a MAC address checks it). It runs in an
// init container, which shares the pod's network, with the cluster node's
// own static ip and busybox mounted in (the app's image may have neither),
// and changes the address in place, or, where the interface won't, with it
// briefly down and its routes put back.
const kubeMacScript = `set -e
mac="$1"
if ! /bf/ip link set dev eth0 address "$mac" 2>/dev/null; then
  routes=$(/bf/ip route show)
  /bf/ip link set dev eth0 down
  /bf/ip link set dev eth0 address "$mac"
  /bf/ip link set dev eth0 up
  echo "$routes" | while read -r r; do [ -n "$r" ] && /bf/ip route replace $r || true; done
fi
/bf/ip -o link show dev eth0`

func composeToKube(project string, raw []byte) (KubePlan, error) {
	var c composeFile
	if err := json.Unmarshal(raw, &c); err != nil {
		return KubePlan{}, err
	}
	if c.Name != "" {
		project = c.Name
	}
	ns := dnsName(project)
	plan := KubePlan{Namespace: ns, Deployments: []string{}, Built: []string{}, Images: []string{}, Notes: []string{}, Volumes: []KubeVolume{}}
	byClaim := map[string]int{} // claim → index in plan.Volumes
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
		// Once each: services often share an image.
		if s.Build != nil && !slices.Contains(plan.Built, image) {
			plan.Built = append(plan.Built, image)
		}
		if !slices.Contains(plan.Images, image) {
			plan.Images = append(plan.Images, image)
		}

		// What the cluster has is used before anything is fetched: the
		// project's images are put in from the engine when it has them (a
		// project often runs images made or tagged on this PC alone, not
		// only the ones it builds), and ":latest" would otherwise be
		// fetched again every time, and fail for those.
		container := map[string]any{"name": name, "image": image, "imagePullPolicy": "IfNotPresent"}
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
					engineName := c.Volumes[v.Source].Name
					if engineName == "" {
						engineName = project + "_" + v.Source
					}
					byClaim[claim] = len(plan.Volumes)
					plan.Volumes = append(plan.Volumes, KubeVolume{Volume: engineName, Claim: claim, Deployments: []string{}})
					note("볼륨 %s는 새 저장소 %s(1GB)가 됩니다.", v.Source, claim)
				}
				kv := &plan.Volumes[byClaim[claim]]
				if len(kv.Deployments) == 0 || kv.Deployments[len(kv.Deployments)-1] != name {
					kv.Deployments = append(kv.Deployments, name)
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

		// Who it runs as, and what it may do.
		sec := map[string]any{}
		if s.Privileged {
			sec["privileged"] = true
		}
		caps := map[string]any{}
		if len(s.CapAdd) > 0 {
			caps["add"] = capNames(s.CapAdd)
		}
		if len(s.CapDrop) > 0 {
			caps["drop"] = capNames(s.CapDrop)
		}
		if len(caps) > 0 {
			sec["capabilities"] = caps
		}
		if s.User != "" {
			u, g, _ := strings.Cut(s.User, ":")
			uid, err1 := strconv.Atoi(u)
			gid, err2 := strconv.Atoi(g)
			switch {
			case err1 == nil && (g == "" || err2 == nil):
				sec["runAsUser"] = uid
				if g != "" {
					sec["runAsGroup"] = gid
				}
			default:
				note("서비스 %s의 user(%s)는 이름이라 옮기지 않습니다. Kubernetes는 숫자(UID)만 받습니다. 그 이름의 UID를 YAML의 runAsUser에 넣으세요.", svc, s.User)
			}
		}
		if len(sec) > 0 {
			container["securityContext"] = sec
		}

		labels := map[string]any{"app": name}
		pod := map[string]any{"containers": []any{container}}

		// Its name and the names it was given for other machines.
		if s.Hostname != "" {
			h, rest, _ := strings.Cut(s.Hostname, ".")
			pod["hostname"] = dnsName(h)
			if rest != "" || dnsName(h) != h {
				note("서비스 %s의 hostname %s는 Kubernetes에서 %s입니다(점 뒤는 빠짐).", svc, s.Hostname, dnsName(h))
			}
		}
		if s.Domainname != "" {
			note("서비스 %s의 domainname(%s)은 옮기지 않습니다.", svc, s.Domainname)
		}
		hosts, skipped := extraHosts(s.ExtraHosts)
		if len(hosts) > 0 {
			ips := make([]string, 0, len(hosts))
			for ip := range hosts {
				ips = append(ips, ip)
			}
			sort.Strings(ips)
			var ha []map[string]any
			for _, ip := range ips {
				ha = append(ha, map[string]any{"ip": ip, "hostnames": hosts[ip]})
			}
			pod["hostAliases"] = ha
		}
		if len(skipped) > 0 {
			note("서비스 %s의 extra_hosts 중 %s는 IP 주소가 아니라(host-gateway 등) 옮기지 않습니다.", svc, strings.Join(skipped, ", "))
		}

		// Its MAC address, given to the pod's network before the app starts.
		mac := s.MacAddress
		var aliases, fixed []string
		netNames := make([]string, 0, len(s.Networks))
		for n := range s.Networks {
			netNames = append(netNames, n)
		}
		sort.Strings(netNames)
		for _, n := range netNames {
			e := s.Networks[n]
			if e == nil {
				continue
			}
			if mac == "" && e.MacAddress != "" {
				mac = e.MacAddress
			}
			aliases = append(aliases, e.Aliases...)
			if e.IPv4 != "" {
				fixed = append(fixed, e.IPv4)
			}
			if e.IPv6 != "" {
				fixed = append(fixed, e.IPv6)
			}
		}
		if len(netNames) > 1 {
			note("서비스 %s는 Compose 네트워크 %d개(%s)에 있었습니다. Kubernetes에서는 프로젝트 전체가 한 네트워크라 서로 다 보입니다.", svc, len(netNames), strings.Join(netNames, ", "))
		}
		if len(fixed) > 0 {
			note("서비스 %s의 고정 IP(%s)는 옮길 수 없습니다. 파드는 클러스터가 주는 주소를 받습니다. 다른 서비스는 IP 대신 이름(%s)으로 찾게 하세요.", svc, strings.Join(fixed, ", "), name)
		}
		if mac != "" {
			if _, err := net.ParseMAC(mac); err != nil {
				note("서비스 %s의 MAC 주소 %s는 형식이 맞지 않아 옮기지 않습니다.", svc, mac)
			} else {
				file := "File"
				pod["initContainers"] = []any{map[string]any{
					"name": "set-mac", "image": image, "imagePullPolicy": "IfNotPresent",
					"command":         []string{"/bf/busybox", "sh", "-c", kubeMacScript, "sh", mac},
					"securityContext": map[string]any{"runAsUser": 0, "capabilities": map[string]any{"add": []string{"NET_ADMIN"}}},
					"volumeMounts": []map[string]any{
						{"name": "bf-busybox", "mountPath": "/bf/busybox", "readOnly": true},
						{"name": "bf-ip", "mountPath": "/bf/ip", "readOnly": true},
					},
				}}
				volumes = append(volumes,
					map[string]any{"name": "bf-busybox", "hostPath": map[string]any{"path": "/bin/busybox", "type": file}},
					map[string]any{"name": "bf-ip", "hostPath": map[string]any{"path": "/bin/ip", "type": file}},
				)
				note("서비스 %s의 MAC 주소 %s는 파드가 시작할 때 맞춥니다(BoxForge의 클러스터에서만 되는 방식: 노드의 도구를 씀). 파드마다 같은 MAC이 되니 파드는 1개로 두세요.", svc, mac)
			}
		}
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

		// Found by name on any port, as in Compose (where a service reaches
		// another on any port, declared or not): a headless Service, whose
		// name is the pods' own addresses. The ports listed are those known.
		// Its Compose aliases are names of the same kind.
		var sps []map[string]any
		for _, p := range ports {
			sps = append(sps, map[string]any{"name": fmt.Sprintf("p%d", p), "port": p, "targetPort": p})
		}
		svcNames := []string{name}
		for _, a := range aliases {
			if an := dnsName(a); an != "" && !slices.Contains(svcNames, an) {
				svcNames = append(svcNames, an)
			}
		}
		for _, sn := range svcNames {
			spec := map[string]any{"selector": labels, "clusterIP": "None", "publishNotReadyAddresses": true}
			if sps != nil {
				spec["ports"] = sps
			}
			docs = append(docs, map[string]any{
				"apiVersion": "v1", "kind": "Service",
				"metadata": map[string]any{"name": sn, "namespace": ns, "labels": map[string]any{"boxforge.compose/service": svc}},
				"spec":     spec,
			})
		}
		if len(svcNames) > 1 {
			note("서비스 %s의 별칭(%s)도 같은 파드를 가리키는 이름으로 만듭니다.", svc, strings.Join(svcNames[1:], ", "))
		}

		if len(s.DependsOn) > 0 {
			waits = append(waits, svc)
		}
		if s.Healthcheck != nil {
			note("서비스 %s의 상태 검사(healthcheck)는 옮기지 않습니다.", svc)
		}
		var odd []string
		if s.NetworkMode != "" {
			odd = append(odd, "network_mode")
		}
		if s.Devices != nil {
			odd = append(odd, "devices")
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

// The script that unpacks a volume's archive into a claim's folder in the
// cluster container, in place of what is there. An archive of a folder
// holds it under its own name: its content is what is copied.
const kubeFillScript = `set -e
d="$1"
t=$(mktemp -d)
tar -xf - -C "$t"
find "$d" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
set -- "$t"/*
if [ $# -eq 1 ] && [ -d "$1" ]; then src="$1"; else src="$t"; fi
cp -a "$src"/. "$d"/
rm -rf "$t"
echo copied`

// KubeMoveVolume copies an engine volume's data into a claim made from it.
// The claim gets its place once a pod uses it; the deployments using it are
// stopped meanwhile (an app such as a database must not run while its data
// is swapped under it, and one that made itself an empty one is given the
// real one), then started again as they were.
func (a *App) KubeMoveVolume(namespace, claim, volume string, deployments []string) error {
	if _, err := kubeRef("persistentvolumeclaim", namespace, claim); err != nil {
		return err
	}
	for _, d := range deployments {
		if _, err := kubeRef("deployment", namespace, d); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()

	// 1. Its place, made when a pod first uses it.
	var pv string
	for deadline := time.Now().Add(5 * time.Minute); ; {
		out, _ := a.kubectl(ctx, nil, "get", "pvc", claim, "-n", namespace, "-o", "jsonpath={.status.phase} {.spec.volumeName}")
		if f := strings.Fields(out); len(f) == 2 && f[0] == "Bound" {
			pv = f[1]
			break
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("storage %s got no place in 5 minutes (its pod hasn't started); its data was not copied", claim)
		}
		time.Sleep(2 * time.Second)
	}
	path, err := a.kubectl(ctx, nil, "get", "pv", pv, "-o", "jsonpath={.spec.hostPath.path}{.spec.local.path}")
	if err != nil {
		return err
	}
	if path = strings.TrimSpace(path); !strings.HasPrefix(path, "/") {
		return fmt.Errorf("storage %s is not a folder in the cluster (%q); its data was not copied", claim, path)
	}

	// 2. Its users stopped, to be started again whatever happens.
	replicas := map[string]string{}
	for _, d := range deployments {
		n, err := a.kubectl(ctx, nil, "get", "deployment", d, "-n", namespace, "-o", "jsonpath={.spec.replicas}")
		if err != nil {
			return err
		}
		replicas[d] = strings.TrimSpace(n)
		if _, err := a.kubectl(ctx, nil, "scale", "deployment", d, "-n", namespace, "--replicas=0"); err != nil {
			return err
		}
	}
	defer func() {
		back, stop := context.WithTimeout(context.Background(), time.Minute)
		defer stop()
		for d, n := range replicas {
			if n == "" {
				n = "1"
			}
			_, _ = a.kubectl(back, nil, "scale", "deployment", d, "-n", namespace, "--replicas="+n)
		}
	}()
	for _, d := range deployments {
		_, _ = a.kubectl(ctx, nil, "wait", "--for=delete", "pod", "-l", "app="+d, "-n", namespace, "--timeout=120s")
	}

	// 3. The data, from the engine's volume into its place.
	data, err := a.eng().Volumes().Archive(ctx, volume, "/")
	if err != nil {
		return err
	}
	defer data.Close()
	p, err := a.eng().Containers().Pipe(ctx, kubeContainer, []string{"sh", "-c", kubeFillScript, "sh", path})
	if err != nil {
		return err
	}
	defer p.Close()
	said := make(chan string, 1)
	go func() {
		b, _ := io.ReadAll(io.LimitReader(p, 1<<20))
		said <- string(b)
	}()
	if _, err := io.Copy(p, data); err != nil {
		return err
	}
	if c, ok := p.(interface{ CloseWrite() error }); ok {
		_ = c.CloseWrite()
	}
	select {
	case out := <-said:
		if !strings.Contains(out, "copied") {
			return fmt.Errorf("the data could not be put in place: %s", strings.TrimSpace(out))
		}
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// capNames is Compose's capabilities as Kubernetes writes them (no CAP_).
func capNames(list []string) []string {
	out := make([]string, 0, len(list))
	for _, c := range list {
		out = append(out, strings.TrimPrefix(strings.ToUpper(c), "CAP_"))
	}
	return out
}
