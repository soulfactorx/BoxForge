package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/soulfactorx/boxforge/internal/engine"
	"github.com/soulfactorx/boxforge/internal/engines"
)

// Kubernetes here is k3s, a whole single-node cluster in one container on
// the engine in use. Everything is asked of it with the kubectl inside
// that container, so it works the same on every engine and needs no way
// from this PC to the cluster's own network.

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
	out, err := a.kubectl(ctx, nil, "get", "nodes", "-o", "json")
	if err != nil {
		return false, ""
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
		return false, ""
	}
	n := list.Items[0].Status
	for _, c := range n.Conditions {
		if c.Type == "Ready" && c.Status == "True" {
			return true, n.NodeInfo.KubeletVersion
		}
	}
	return false, n.NodeInfo.KubeletVersion
}

// KubeStatus says where the cluster stands.
func (a *App) KubeStatus() KubeState {
	st := KubeState{Image: kubeImage()}
	c := a.kubeContainer()
	if c == nil {
		return st
	}
	st.Exists, st.Running = true, c.State == "running"
	if st.Running {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		st.Ready, st.Version = a.nodeReady(ctx)
	}
	return st
}

// How long a cluster may take from its container's start to a Ready node.
const kubeBoot = 3 * time.Minute

// KubeStart makes the cluster if there is none, starts it, and waits for
// its node. What it is doing arrives as "kube" events (plain text).
func (a *App) KubeStart() error {
	say := func(text string) { a.emit("kube", text) }
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	switch c := a.kubeContainer(); {
	case c == nil:
		img := kubeImage()
		if !a.eng().Images().Exists(ctx, img) {
			say("k3s 이미지를 내려받는 중 (약 300MB)")
			if err := a.pull(ctx, img); err != nil {
				return err
			}
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
		_, err := a.eng().Containers().Run(ctx, engine.RunSpec{
			Image: img, Name: kubeContainer, Command: []string{"server"},
			// k3s runs containers of its own inside this one.
			Privileged: true, Tmpfs: []string{"/run", "/var/run"},
			Env:     env,
			Ports:   []engine.PortSpec{{Host: 6443, Container: 6443}},
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
	say("Kubernetes가 준비되기를 기다리는 중")
	deadline := time.Now().Add(kubeBoot)
	for {
		probe, stop := context.WithTimeout(ctx, 10*time.Second)
		ready, _ := a.nodeReady(probe)
		stop()
		if ready {
			return nil
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("the cluster did not become ready in time; its container's log says why")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(2 * time.Second):
		}
	}
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
	"configmaps": "configmaps", "persistentvolumeclaims": "persistentvolumeclaims",
}

// The kinds an action (describe, delete, scale, restart) may name.
var kubeTargets = map[string]bool{
	"pod": true, "deployment": true, "statefulset": true, "daemonset": true, "service": true,
	"ingress": true, "configmap": true, "persistentvolumeclaim": true, "namespace": true,
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
	return a.kubectl(ctx, nil, "get", resource, "-A", "-o", "json")
}

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
	text := strings.NewReplacer(
		"name: default", "name: boxforge", "cluster: default", "cluster: boxforge",
		"user: default", "user: boxforge", "current-context: default", "current-context: boxforge",
	).Replace(stdout)
	// It holds the cluster's admin key: for this user only.
	return file, os.WriteFile(file, []byte(text), 0o600)
}
