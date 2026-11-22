package app

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/soulfactorx/boxforge/internal/engine"
	"github.com/soulfactorx/boxforge/internal/engines"
)

// Kubernetes here is k3s, a whole single-node cluster in one container on
// the engine in use. Everything is asked of it with the kubectl inside
// that container, so it works the same on every engine and needs no way
// from this PC to the cluster's own network.

// kubeMade marks how a cluster container was made (label kubeMadeLabel).
// A stopped one made otherwise is made again at its next start, its data
// kept in the volume: what changed reaches clusters made before.
//
//	2: --disable-network-policy, --node-name, the API port on 127.0.0.1 only
const (
	kubeMadeLabel = "dev.boxforge.k3s"
	kubeMade      = "2"
	kubeNode      = "boxforge"
)

// The k3s server's arguments. The network policy controller is left out:
// it finds its network device by the node's address as last recorded, and
// a container's address changes when the engine restarts it, which stops
// the cluster from starting ("failed to find interface with specified node
// ip"). It is also memory a small machine is short of. The node's name is
// fixed so that a container made again is the same node.
var kubeArgs = []string{"server", "--disable-network-policy", "--node-name", kubeNode}

// kubeContainer is the cluster's container, and kubeVolume its data.
const (
	kubeContainer = engine.ClusterName
	kubeVolume    = "boxforge-k3s"
)

// kubeImage is the k3s to run; BOXFORGE_K3S_IMAGE names another for tests.
func kubeImage() string {
	if i := os.Getenv("BOXFORGE_K3S_IMAGE"); i != "" {
		return i
	}
	return "rancher/k3s:v1.33.5-k3s1"
}

// KubeState is where the cluster stands.
type KubeState struct {
	Exists  bool   `json:"exists"`  // the container is there
	Running bool   `json:"running"` // and runs
	Ready   bool   `json:"ready"`   // and its node answers Ready
	Version string `json:"version"`
	Image   string `json:"image"` // what would be run
	Port    int    `json:"port"`  // where this PC reaches its API server; 0 when not published
	// Other Kubernetes clusters on the same engine (Kiri's own, one made by
	// hand): separate from this one, each with its own memory and CPU.
	Others []OtherCluster `json:"others"`
}

// OtherCluster is a k3s that BoxForge did not make.
type OtherCluster struct {
	Name    string `json:"name"`
	Maker   string `json:"maker"` // "Kiri" when Kiri made it, else ""
	Running bool   `json:"running"`
	Port    int    `json:"port"`
}

// The API server's port in the cluster, and how many after the first
// choice on this PC a start tries when that one is taken.
const (
	kubeAPIPort   = 6443
	kubePortTries = 20
)

// apiPort is the port this PC reaches a cluster container's API server on.
func apiPort(c engine.Container) int {
	for _, p := range c.Ports {
		if p.Private == kubeAPIPort && p.Public != 0 {
			return int(p.Public)
		}
	}
	return 0
}

// otherClusters lists the k3s containers on the engine that are not BoxForge's.
func (a *App) otherClusters() []OtherCluster {
	out := []OtherCluster{}
	for _, c := range a.mirror().Containers() {
		if c.Name == kubeContainer || !strings.Contains(c.Image, "rancher/k3s") {
			continue
		}
		maker := ""
		if c.Labels["dev.kiri.k8s"] != "" || c.Name == "kiri-k8s" {
			maker = "Kiri"
		}
		out = append(out, OtherCluster{Name: c.Name, Maker: maker, Running: c.State == "running", Port: apiPort(c)})
	}
	return out
}

// freeKubePort picks the port the API server is published on: 6443, or
// the first after it that no container on the engine publishes and no
// program on this PC holds. Two clusters can't share one: another app's
// (Kiri makes its own) may have it already.
func (a *App) freeKubePort() (int, error) {
	taken := map[int]bool{}
	for _, c := range a.mirror().Containers() {
		for _, p := range c.Ports {
			taken[int(p.Public)] = true
		}
	}
	for p := kubeAPIPort; p <= kubeAPIPort+kubePortTries; p++ {
		if taken[p] {
			continue
		}
		if ln, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p))); err == nil {
			ln.Close()
			return p, nil
		}
	}
	return 0, fmt.Errorf("ports %d to %d are all in use, so the cluster's API server has none to take; stop what holds them, such as another Kubernetes", kubeAPIPort, kubeAPIPort+kubePortTries)
}

func (a *App) kubeContainer() *engine.Container {
	for _, c := range a.mirror().Containers() {
		if c.Name == kubeContainer {
			return &c
		}
	}
	return nil
}

// kubectl runs the cluster's kubectl and returns what it printed. A
// failure carries kubectl's own message.
func (a *App) kubectl(ctx context.Context, stdin []byte, args ...string) (string, error) {
	stdout, stderr, code, err := a.eng().Containers().Output(ctx, kubeContainer, append([]string{"kubectl"}, args...), stdin)
	if err != nil {
		return "", err
	}
	if code != 0 {
		msg := strings.TrimSpace(stderr)
		if msg == "" {
			msg = strings.TrimSpace(stdout)
		}
		if i := strings.LastIndex(msg, "\n"); i >= 0 {
			msg = msg[i+1:]
		}
		return stdout, fmt.Errorf("%s", strings.TrimPrefix(msg, "error: "))
	}
	return stdout, nil
}

// nodeReady asks the cluster whether its node is Ready, and its version.
func (a *App) nodeReady(ctx context.Context) (bool, string) {
	ready, version, _ := a.nodeState(ctx)
	return ready, version
}

// nodeState is nodeReady, and whether the cluster answered at all.
func (a *App) nodeState(ctx context.Context) (ready bool, version string, known bool) {
	out, err := a.kubectl(ctx, nil, "get", "nodes", "-o", "json")
	if err != nil {
		return false, "", false
	}
	var list struct {
		Items []struct {
			Status struct {
				NodeInfo   struct{ KubeletVersion string }
				Conditions []struct{ Type, Status string }
			}
		}
	}
	if json.Unmarshal([]byte(out), &list) != nil || len(list.Items) == 0 {
		return false, "", false
	}
	// Any node that is Ready: one an older cluster left behind never will be.
	version = list.Items[0].Status.NodeInfo.KubeletVersion
	for _, n := range list.Items {
		for _, c := range n.Status.Conditions {
			if c.Type == "Ready" && c.Status == "True" {
				return true, n.Status.NodeInfo.KubeletVersion, true
			}
		}
	}
	return false, version, true
}

// KubeStatus says where the cluster stands.
func (a *App) KubeStatus() KubeState {
	st := KubeState{Image: kubeImage(), Others: a.otherClusters()}
	c := a.kubeContainer()
	if c == nil {
		return st
	}
	st.Exists, st.Running, st.Port = true, c.State == "running", apiPort(*c)
	if st.Running {
		st.Ready, st.Version = a.kubeReady(c.ID)
	} else {
		readiness.forget()
	}
	return st
}

// readiness is the last answer to "is the node Ready?". Asking runs
// kubectl in the cluster, which on a slow machine takes seconds and now and
// then gets no answer in time: a cluster found Ready is not asked again for
// a while, and a question that got no answer doesn't make it "starting".
var readiness readyMemo

type readyMemo struct {
	sync.Mutex
	id      string // the container it was asked of
	ready   bool
	version string
	at      time.Time // when it was last found Ready
}

func (r *readyMemo) forget() {
	r.Lock()
	r.id, r.ready = "", false
	r.Unlock()
}

const (
	readyFresh = 15 * time.Second // a Ready answer is used this long without asking
	readyTrust = 2 * time.Minute  // and this long when asking gets no answer
)

func (a *App) kubeReady(id string) (bool, string) {
	r := &readiness
	r.Lock()
	if r.id == id && r.ready && time.Since(r.at) < readyFresh {
		defer r.Unlock()
		return true, r.version
	}
	r.Unlock()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	ready, version, known := a.nodeState(ctx)

	r.Lock()
	defer r.Unlock()
	if !known {
		// No answer: what was known a moment ago still holds.
		if r.id == id && r.ready && time.Since(r.at) < readyTrust {
			return true, r.version
		}
		return false, version
	}
	r.id, r.ready, r.version = id, ready, version
	if ready {
		r.at = time.Now()
	}
	return ready, version
}

// How long a cluster may take from its container's start to a Ready node.
// A slow machine (a small VM) can take many minutes; the start waits as
// long as the container keeps running, up to this.
const kubeBoot = 25 * time.Minute

// KubeStart makes the cluster if there is none, starts it, and waits for
// its node. What it is doing arrives as "kube" events (plain text).
func (a *App) KubeStart() error {
	say := func(text string) { a.emit("kube", text) }
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	fresh := false
	c := a.kubeContainer()
	if c != nil && c.State != "running" && c.Labels[kubeMadeLabel] != kubeMade {
		say("클러스터 컨테이너를 새 설정으로 다시 만드는 중 (안의 데이터는 그대로)")
		// The container only: its volume, the cluster's state, stays.
		if err := a.eng().Containers().Remove(ctx, c.ID, true, false); err != nil {
			return err
		}
		c = nil
	}
	switch {
	case c == nil:
		fresh = true
		img := kubeImage()
		if !a.eng().Images().Exists(ctx, img) {
			say("k3s 이미지를 내려받는 중 (약 300MB)")
			if err := a.pull(ctx, img); err != nil {
				return err
			}
		}
		port, err := a.freeKubePort()
		if err != nil {
			return err
		}
		if port != kubeAPIPort {
			say(fmt.Sprintf("%d번 포트를 다른 프로그램이 쓰고 있어서 %d번 포트를 씁니다", kubeAPIPort, port))
		}
		say("클러스터 컨테이너를 만드는 중")
		env := []string{"K3S_KUBECONFIG_MODE=644"}
		if proxy := engines.Setting("proxy.url"); proxy != "" {
			// The cluster fetches its images itself: behind a proxy, through it.
			// Addresses inside the cluster never go that way.
			no := "localhost,127.0.0.1,10.42.0.0/16,10.43.0.0/16,.svc,.cluster.local"
			if more := engines.Setting("proxy.no"); more != "" {
				no += "," + more
			}
			env = append(env, "HTTP_PROXY="+proxy, "HTTPS_PROXY="+proxy, "NO_PROXY="+no)
		}
		_, err = a.eng().Containers().Run(ctx, engine.RunSpec{
			Image: img, Name: kubeContainer, Command: kubeArgs,
			Labels: map[string]string{kubeMadeLabel: kubeMade},
			// k3s runs containers of its own inside this one.
			Privileged: true, Tmpfs: []string{"/run", "/var/run"},
			Env: env,
			// This PC only: the API server is the cluster's admin door.
			Ports:   []engine.PortSpec{{Host: uint16(port), Container: kubeAPIPort, IP: "127.0.0.1"}},
			Mounts:  []engine.MountSpec{{Source: kubeVolume, Target: "/var/lib/rancher/k3s"}},
			Restart: "unless-stopped",
		})
		if err != nil {
			return err
		}
	case c.State != "running":
		say("클러스터 컨테이너를 시작하는 중")
		if err := a.eng().Containers().Start(ctx, c.ID); err != nil {
			return err
		}
	}
	// What the cluster itself says while it comes up, for the screen.
	logs, stopLogs := context.WithCancel(ctx)
	defer stopLogs()
	go a.kubeBootLog(logs)

	if len(trustedCAs()) > 0 {
		say("사내 인증서를 클러스터에 넣는 중")
		// A cluster just made is restarted whatever the script says: a
		// first try may have written the list as the cluster was reading it.
		if err := a.kubeTrustNow(ctx, fresh); err != nil {
			say("인증서를 넣지 못했습니다: " + err.Error())
		}
	}
	say("Kubernetes가 준비되기를 기다리는 중")
	begun := time.Now()
	deadline := begun.Add(kubeBoot)
	for {
		probe, stop := context.WithTimeout(ctx, 10*time.Second)
		ready, version := a.nodeReady(probe)
		stop()
		if ready {
			a.dropOldNodes(ctx)
			if c := a.kubeContainer(); c != nil {
				readiness.Lock()
				readiness.id, readiness.ready, readiness.version, readiness.at = c.ID, true, version, time.Now()
				readiness.Unlock()
			}
			return nil
		}
		waited := waitedText(time.Since(begun))
		if version == "" {
			say(fmt.Sprintf("Kubernetes가 준비되기를 기다리는 중: API 서버를 시작하는 중 (%s)", waited))
		} else {
			say(fmt.Sprintf("Kubernetes가 준비되기를 기다리는 중: 노드를 준비하는 중 (%s)", waited))
		}
		// A container that ended won't get ready: no point waiting it out.
		if c := a.kubeContainer(); c == nil || c.State == "exited" || c.State == "dead" {
			return fmt.Errorf("the cluster's container stopped while starting; its log above says why")
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the cluster did not become ready in %d minutes; it may still be starting, and the screen changes by itself when it is", int(kubeBoot.Minutes()))
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
}

// dropOldNodes removes nodes a cluster made before kubeMade 2 left
// behind: there the node was named after the container, so a container
// made again came back as a new node, the old one never ready. Their pods
// move to the node that is.
func (a *App) dropOldNodes(ctx context.Context) {
	out, err := a.kubectl(ctx, nil, "get", "nodes", "-o", "jsonpath={.items[*].metadata.name}")
	if err != nil {
		return
	}
	for _, n := range strings.Fields(out) {
		if n != kubeNode {
			_, _ = a.kubectl(ctx, nil, "delete", "node", n, "--wait=false")
		}
	}
}

// waitedText is a time waited, in seconds, or minutes and seconds.
func waitedText(d time.Duration) string {
	s := int(d.Seconds())
	if s < 60 {
		return fmt.Sprintf("%d초", s)
	}
	return fmt.Sprintf("%d분 %d초", s/60, s%60)
}

// KubeLogTail returns the last lines the cluster's container wrote, made
// short as during a start: for a cluster still coming up after the screen
// was left, or one that failed to.
func (a *App) KubeLogTail(lines int) ([]string, error) {
	if lines < 1 || lines > 500 {
		lines = 100
	}
	if a.kubeContainer() == nil {
		return []string{}, nil
	}
	// The log is followed: what has been written arrives at once, then
	// the wait for more is cut short.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	w := &lineBatch{}
	_ = a.eng().Containers().Logs(ctx, kubeContainer, lines, w)
	out := w.take()
	if out == nil {
		out = []string{}
	}
	return out, nil
}

// kubeBootLog sends the cluster container's log lines to the screen as
// "kube-log" events, a few at a time, until ctx ends.
func (a *App) kubeBootLog(ctx context.Context) {
	w := &lineBatch{}
	go func() {
		tick := time.NewTicker(500 * time.Millisecond)
		defer tick.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-tick.C:
				if lines := w.take(); len(lines) > 0 {
					a.emit("kube-log", lines)
				}
			}
		}
	}()
	_ = a.eng().Containers().Logs(ctx, kubeContainer, 30, w)
}

// lineBatch collects written text as lines, in k3s's words made short.
type lineBatch struct {
	mu    sync.Mutex
	part  string
	lines []string
}

func (b *lineBatch) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	text := b.part + string(p)
	parts := strings.Split(text, "\n")
	b.part = parts[len(parts)-1]
	for _, l := range parts[:len(parts)-1] {
		if l = shortLog(l); l != "" {
			b.lines = append(b.lines, l)
		}
	}
	// A burst is cut to its end: the screen keeps the last lines anyway.
	if len(b.lines) > 200 {
		b.lines = b.lines[len(b.lines)-200:]
	}
	return len(p), nil
}

func (b *lineBatch) take() []string {
	b.mu.Lock()
	defer b.mu.Unlock()
	out := b.lines
	b.lines = nil
	return out
}

// k3s writes `time="…" level=info msg="Starting k3s"`, and the kubelet's
// own lines `I1121 12:00:00.000 1 file.go:12] text`.
var (
	k3sLine    = regexp.MustCompile(`level=(\w+) msg="((?:[^"\\]|\\.)*)"`)
	klogLine   = regexp.MustCompile(`^([IWEF])\d{4} [\d:.]+\s+\d+ [^\]]+\] (.*)$`)
	klogLevels = map[string]string{"I": "info", "W": "warning", "E": "error", "F": "fatal"}
)

// shortLog is one log line as "level: message", or "" for an empty one.
func shortLog(l string) string {
	l = strings.TrimSpace(strings.TrimRight(l, "\r"))
	if m := k3sLine.FindStringSubmatch(l); m != nil {
		return m[1] + ": " + strings.ReplaceAll(m[2], `\"`, `"`)
	}
	if m := klogLine.FindStringSubmatch(l); m != nil {
		return klogLevels[m[1]] + ": " + m[2]
	}
	if len(l) > 300 {
		l = l[:300] + "…"
	}
	return l
}

// KubeStop stops the cluster, keeping everything in it.
func (a *App) KubeStop() error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	a.stopForwards(true)
	return a.eng().Containers().Stop(ctx, kubeContainer)
}

// KubeRemove deletes the cluster and everything deployed in it.
func (a *App) KubeRemove() error {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	a.stopForwards(true)
	if a.kubeContainer() != nil {
		if err := a.eng().Containers().Remove(ctx, kubeContainer, true, true); err != nil {
			return err
		}
	}
	// The volume may be gone already, or held a moment longer: either way
	// the cluster is.
	_ = a.eng().Volumes().Remove(ctx, kubeVolume)
	return nil
}

// What KubeGet may list. "workloads" is the three kinds that run pods.
var kubeKinds = map[string]string{
	"pods": "pods", "services": "services", "events": "events", "namespaces": "namespaces", "nodes": "nodes",
	"workloads": "deployments,statefulsets,daemonsets", "ingresses": "ingresses",
	"configmaps": "configmaps", "persistentvolumeclaims": "persistentvolumeclaims", "secrets": "secrets",
}

// The kinds an action (describe, delete, scale, restart) may name.
var kubeTargets = map[string]bool{
	"pod": true, "deployment": true, "statefulset": true, "daemonset": true, "service": true,
	"ingress": true, "configmap": true, "persistentvolumeclaim": true, "namespace": true, "secret": true,
}

// A Kubernetes object name: lower-case letters, digits, "-" and ".".
var kubeName = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)

func kubeRef(kind, namespace, name string) ([]string, error) {
	if !kubeTargets[kind] {
		return nil, fmt.Errorf("unknown kind %q", kind)
	}
	if !kubeName.MatchString(name) || (namespace != "" && !kubeName.MatchString(namespace)) {
		return nil, fmt.Errorf("%q is not a Kubernetes name", name)
	}
	args := []string{kind, name}
	if namespace != "" {
		args = append(args, "-n", namespace)
	}
	return args, nil
}

// KubeGet lists objects of a kind in every namespace, as kubectl's JSON.
func (a *App) KubeGet(kind string) (string, error) {
	resource, ok := kubeKinds[kind]
	if !ok {
		return "", fmt.Errorf("unknown kind %q", kind)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, err := a.kubectl(ctx, nil, "get", resource, "-A", "-o", "json")
	if err != nil || kind != "secrets" {
		return out, err
	}
	return hideSecrets(out)
}

// hideSecrets keeps a secret list's names and keys and drops the values:
// the screen shows what a secret holds, never the secret, and nothing that
// can only look (the web server's look-only password) ever reads one.
func hideSecrets(list string) (string, error) {
	var l struct {
		Items []map[string]any `json:"items"`
	}
	if err := json.Unmarshal([]byte(list), &l); err != nil {
		return "", err
	}
	for _, item := range l.Items {
		sizes := map[string]any{}
		if data, ok := item["data"].(map[string]any); ok {
			for k, v := range data {
				s, _ := v.(string)
				b, _ := base64.StdEncoding.DecodeString(s)
				sizes[k] = len(b)
			}
		}
		delete(item, "data")
		delete(item, "stringData")
		item["sizes"] = sizes
		if meta, ok := item["metadata"].(map[string]any); ok {
			// kubectl apply keeps the whole object, values and all, here.
			delete(meta, "annotations")
			delete(meta, "managedFields")
		}
	}
	b, err := json.Marshal(l)
	return string(b), err
}

// KubeCreateData makes a ConfigMap or a Secret of the given keys and
// values. Made with "kubectl create", not apply: apply would keep a copy
// of the values in an annotation anyone who can read the object sees.
func (a *App) KubeCreateData(kind, namespace, name string, data map[string]string) error {
	if kind != "configmap" && kind != "secret" {
		return fmt.Errorf("unknown kind %q", kind)
	}
	if _, err := kubeRef(kind, namespace, name); err != nil {
		return err
	}
	if len(data) == 0 {
		return fmt.Errorf("add at least one key")
	}
	for k := range data {
		if !kubeKey.MatchString(k) {
			return fmt.Errorf("%q is not a key name: letters, digits, \"-\", \"_\" and \".\"", k)
		}
	}
	obj := map[string]any{
		"apiVersion": "v1",
		"metadata":   map[string]any{"name": name, "namespace": namespace},
	}
	if kind == "secret" {
		obj["kind"], obj["type"], obj["stringData"] = "Secret", "Opaque", data
	} else {
		obj["kind"], obj["data"] = "ConfigMap", data
	}
	b, _ := json.Marshal(obj)
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	_, err := a.kubectl(ctx, b, "create", "-f", "-")
	return err
}

// A ConfigMap's or Secret's key.
var kubeKey = regexp.MustCompile(`^[-._a-zA-Z0-9]{1,253}$`)

// KubeDescribe returns kubectl's description of one object.
func (a *App) KubeDescribe(kind, namespace, name string) (string, error) {
	ref, err := kubeRef(kind, namespace, name)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return a.kubectl(ctx, nil, append([]string{"describe"}, ref...)...)
}

// KubeLogs returns the last lines every container of a pod wrote.
func (a *App) KubeLogs(namespace, pod string) (string, error) {
	ref, err := kubeRef("pod", namespace, pod)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return a.kubectl(ctx, nil, append([]string{"logs", "--all-containers", "--prefix", "--tail=500"}, ref[1:]...)...)
}

// KubeTermOpen starts a shell in a pod on a terminal of the given size and
// returns the session's ID, as TermOpen does for a container.
func (a *App) KubeTermOpen(namespace, pod string, cols, rows int) (string, error) {
	ref, err := kubeRef("pod", namespace, pod)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	cmd := append([]string{"kubectl", "exec", "-it"}, ref[1:]...)
	cmd = append(cmd, "--", "sh", "-c", shell[2])
	s, err := a.eng().Containers().Exec(ctx, kubeContainer, cmd, uint(max(cols, 1)), uint(max(rows, 1)))
	if err != nil {
		return "", err
	}
	return a.attach(s), nil
}

// KubeDelete deletes one object.
func (a *App) KubeDelete(kind, namespace, name string) error {
	ref, err := kubeRef(kind, namespace, name)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	// Not waited for: a pod takes its time to end, and the list shows it.
	_, err = a.kubectl(ctx, nil, append([]string{"delete", "--wait=false"}, ref...)...)
	return err
}

// KubeScale sets how many pods a deployment or statefulset keeps.
func (a *App) KubeScale(kind, namespace, name string, replicas int) error {
	ref, err := kubeRef(kind, namespace, name)
	if err != nil {
		return err
	}
	if replicas < 0 || replicas > 100 {
		return fmt.Errorf("between 0 and 100 pods")
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	_, err = a.kubectl(ctx, nil, append([]string{"scale", "--replicas=" + strconv.Itoa(replicas)}, ref...)...)
	return err
}

// KubeRestart replaces a workload's pods with new ones, a few at a time.
func (a *App) KubeRestart(kind, namespace, name string) error {
	ref, err := kubeRef(kind, namespace, name)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	_, err = a.kubectl(ctx, nil, append([]string{"rollout", "restart"}, ref...)...)
	return err
}

// KubeApply creates or updates what the YAML describes and returns
// kubectl's lines ("deployment.apps/web created").
func (a *App) KubeApply(yaml string) (string, error) {
	if strings.TrimSpace(yaml) == "" {
		return "", fmt.Errorf("the YAML is empty")
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.kubectl(ctx, []byte(yaml), "apply", "-f", "-")
}

// KubeConfig saves the cluster's kubeconfig under ~/.kube and returns the
// file's path, for kubectl and other tools on this PC.
func (a *App) KubeConfig() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	stdout, stderr, code, err := a.eng().Containers().Output(ctx, kubeContainer, []string{"cat", "/etc/rancher/k3s/k3s.yaml"}, nil)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", fmt.Errorf("%s", strings.TrimSpace(stderr))
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	dir := filepath.Join(home, ".kube")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	// The names inside are k3s's "default": made BoxForge's own, so that
	// merged with other kubeconfigs they clash with nothing.
	file := filepath.Join(dir, "boxforge.yaml")
	port := kubeAPIPort
	if c := a.kubeContainer(); c != nil && apiPort(*c) != 0 {
		port = apiPort(*c)
	}
	text := strings.NewReplacer(
		fmt.Sprintf("127.0.0.1:%d", kubeAPIPort), fmt.Sprintf("127.0.0.1:%d", port),
		"name: default", "name: boxforge", "cluster: default", "cluster: boxforge",
		"user: default", "user: boxforge", "current-context: default", "current-context: boxforge",
	).Replace(stdout)
	// It holds the cluster's admin key: for this user only.
	return file, os.WriteFile(file, []byte(text), 0o600)
}

// The cluster's list of certificate authorities, and the copy of it as it
// came, which the user's certificates are added to each time.
const (
	kubeBundle      = "/etc/ssl/certs/ca-certificates.crt"
	kubeTrustScript = `set -e
b=` + kubeBundle + `
[ -f "$b.boxforge-orig" ] || cp "$b" "$b.boxforge-orig"
cat > /tmp/boxforge-ca.pem
cat "$b.boxforge-orig" /tmp/boxforge-ca.pem > "$b.new"
if cmp -s "$b.new" "$b"; then rm -f "$b.new"; echo same; else mv "$b.new" "$b"; echo changed; fi
rm -f /tmp/boxforge-ca.pem
`
)

// kubeTrust makes the cluster trust the certificates the user added: the
// cluster fetches its images itself, and behind a company's inspecting
// proxy it can't without them. The cluster restarts when the list changed,
// which is when its image fetcher reads it.
func (a *App) kubeTrust(ctx context.Context) error { return a.kubeTrustNow(ctx, false) }

func (a *App) kubeTrustNow(ctx context.Context, restart bool) error {
	cas := trustedCAs()
	if len(cas) == 0 {
		return nil
	}
	cs := a.eng().Containers()
	// The container is up before k3s is: a moment for it to take commands.
	var stdout, stderr string
	var code int
	var err error
	for i := 0; i < 20; i++ {
		stdout, stderr, code, err = cs.Output(ctx, kubeContainer, []string{"sh", "-c", kubeTrustScript}, cas)
		if err == nil && code == 0 {
			break
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("%s", strings.TrimSpace(stderr))
	}
	if restart || strings.Contains(stdout, "changed") {
		return cs.Restart(ctx, kubeContainer)
	}
	return nil
}
