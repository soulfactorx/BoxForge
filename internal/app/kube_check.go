package app

// Looking into a project moved to Kubernetes as a whole: the logs of all
// its pods in one list, in time order, and a check of how its services
// reach each other (each name found, each port answering).

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"
)

// KubeLogLine is one line of a pod's log.
type KubeLogLine struct {
	Time      string `json:"time"` // RFC 3339
	Pod       string `json:"pod"`
	Container string `json:"container"`
	Text      string `json:"text"`
}

// KubeProjectLogs is the last lines of every pod in a namespace (init
// containers too: a MAC address that couldn't be set shows there), merged
// in time order.
func (a *App) KubeProjectLogs(namespace string, tail int) ([]KubeLogLine, error) {
	if _, err := kubeRef("namespace", "", namespace); err != nil {
		return nil, err
	}
	if tail <= 0 || tail > 2000 {
		tail = 300
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	out, err := a.kubectl(ctx, nil, "logs", "-n", namespace, "-l", "app", "--all-containers", "--prefix", "--timestamps",
		"--tail="+strconv.Itoa(tail), "--max-log-requests=50", "--ignore-errors")
	if err != nil && out == "" {
		return nil, err
	}
	return mergeLogs(out), nil
}

// mergeLogs reads `kubectl logs --prefix --timestamps` lines
// ("[pod/name/container] 2026-…Z text") and orders them by time.
func mergeLogs(out string) []KubeLogLine {
	type timed struct {
		at time.Time
		l  KubeLogLine
	}
	var all []timed
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(line, "[pod/") {
			continue
		}
		head, rest, ok := strings.Cut(line, "] ")
		if !ok {
			continue
		}
		parts := strings.Split(strings.TrimPrefix(head, "[pod/"), "/")
		if len(parts) != 2 {
			continue
		}
		stamp, text, _ := strings.Cut(rest, " ")
		at, err := time.Parse(time.RFC3339Nano, stamp)
		if err != nil {
			text = rest
		}
		all = append(all, timed{at, KubeLogLine{Time: stamp, Pod: parts[0], Container: parts[1], Text: text}})
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].at.Before(all[j].at) })
	lines := make([]KubeLogLine, len(all))
	for i, t := range all {
		lines[i] = t.l
	}
	return lines
}

// KubeReach is one service of a project, as the others reach it.
type KubeReach struct {
	Service string `json:"service"`
	// Found is what its name gives inside the cluster (pod or service
	// addresses); empty when it gives nothing.
	Found   []string     `json:"found"`
	Ports   []int        `json:"ports"`
	Targets []KubeTarget `json:"targets"`
	Waiting []string     `json:"waiting"` // pods it has that aren't ready
}

// KubeTarget is one pod port and whether it answers.
type KubeTarget struct {
	Pod  string `json:"pod"`
	IP   string `json:"ip"`
	Port int    `json:"port"`
	Open bool   `json:"open"`
}

// The check, run once in the forwarding helper (it is on the cluster's
// network): for each "name ip port" line, whether the name resolves with
// the cluster's DNS, and whether the port answers.
const kubeCheckScript = `dns="$1"; shift
for n in "$@"; do
  echo "name $n $(nslookup "$n" "$dns" 2>/dev/null | awk '/^Address/ && !/#53/ {print $NF}' | tr '\n' ' ')"
done
while read -r ip port; do
  [ -n "$ip" ] || continue
  if nc -z -w 2 "$ip" "$port" 2>/dev/null; then echo "port $ip $port open"; else echo "port $ip $port shut"; fi
done`

// KubeCheck checks how a namespace's services reach each other: each
// service's name, as the cluster's DNS gives it, and each port of each of
// its pods, tried from inside the cluster's network.
func (a *App) KubeCheck(namespace string) ([]KubeReach, error) {
	if _, err := kubeRef("namespace", "", namespace); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	raw, err := a.kubectl(ctx, nil, "get", "services,endpoints", "-n", namespace, "-o", "json")
	if err != nil {
		return nil, err
	}
	var list struct {
		Items []struct {
			Kind     string `json:"kind"`
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Spec struct {
				ClusterIP string `json:"clusterIP"`
				Ports     []struct {
					Port       int             `json:"port"`
					TargetPort json.RawMessage `json:"targetPort"`
					Protocol   string          `json:"protocol"`
				} `json:"ports"`
			} `json:"spec"`
			Subsets []struct {
				Addresses []struct {
					IP        string `json:"ip"`
					TargetRef *struct {
						Name string `json:"name"`
					} `json:"targetRef"`
				} `json:"addresses"`
			} `json:"subsets"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil, err
	}
	type addr struct{ pod, ip string }
	ready, waiting := map[string][]addr{}, map[string][]string{}
	for _, it := range list.Items {
		if it.Kind != "Endpoints" {
			continue
		}
		for _, s := range it.Subsets {
			for _, ad := range s.Addresses {
				p := ""
				if ad.TargetRef != nil {
					p = ad.TargetRef.Name
				}
				ready[it.Metadata.Name] = append(ready[it.Metadata.Name], addr{p, ad.IP})
			}
		}
	}
	// Not-ready ones are listed apart (their json key differs).
	var nr struct {
		Items []struct {
			Kind     string `json:"kind"`
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
			Subsets []struct {
				NotReady []struct {
					TargetRef *struct {
						Name string `json:"name"`
					} `json:"targetRef"`
				} `json:"notReadyAddresses"`
			} `json:"subsets"`
		} `json:"items"`
	}
	_ = json.Unmarshal([]byte(raw), &nr)
	for _, it := range nr.Items {
		for _, s := range it.Subsets {
			for _, ad := range s.NotReady {
				if ad.TargetRef != nil {
					waiting[it.Metadata.Name] = append(waiting[it.Metadata.Name], ad.TargetRef.Name)
				}
			}
		}
	}

	var reach []KubeReach
	var names []string
	var probes strings.Builder
	for _, it := range list.Items {
		if it.Kind != "Service" {
			continue
		}
		r := KubeReach{Service: it.Metadata.Name, Found: []string{}, Ports: []int{}, Targets: []KubeTarget{}, Waiting: waiting[it.Metadata.Name]}
		for _, p := range it.Spec.Ports {
			if p.Protocol != "" && p.Protocol != "TCP" {
				continue
			}
			port := p.Port
			// The pod's port, when given as a number.
			if n, err := strconv.Atoi(strings.Trim(string(p.TargetPort), `"`)); err == nil && n > 0 {
				port = n
			}
			r.Ports = append(r.Ports, port)
			for _, ad := range ready[r.Service] {
				r.Targets = append(r.Targets, KubeTarget{Pod: ad.pod, IP: ad.ip, Port: port})
				fmt.Fprintf(&probes, "%s %d\n", ad.ip, port)
			}
		}
		if r.Waiting == nil {
			r.Waiting = []string{}
		}
		names = append(names, r.Service+"."+namespace+".svc.cluster.local")
		reach = append(reach, r)
	}
	if len(reach) == 0 {
		return []KubeReach{}, nil
	}
	dns, _ := a.kubectl(ctx, nil, "get", "service", "kube-dns", "-n", "kube-system", "-o", "jsonpath={.spec.clusterIP}")
	if dns = strings.TrimSpace(dns); dns == "" {
		dns = "10.43.0.10"
	}
	if err := a.forwardReady(ctx); err != nil {
		return nil, err
	}
	out, _, _, err := a.eng().Containers().Output(ctx, forwardHelper, append([]string{"sh", "-c", kubeCheckScript, "sh", dns}, names...), []byte(probes.String()))
	if err != nil {
		return nil, err
	}
	found := map[string][]string{}
	open := map[string]bool{}
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		switch {
		case len(f) >= 2 && f[0] == "name":
			found[f[1]] = f[2:]
		case len(f) == 4 && f[0] == "port":
			open[f[1]+":"+f[2]] = f[3] == "open"
		}
	}
	for i := range reach {
		if ips := found[reach[i].Service+"."+namespace+".svc.cluster.local"]; ips != nil {
			reach[i].Found = ips
		}
		for j := range reach[i].Targets {
			t := &reach[i].Targets[j]
			t.Open = open[t.IP+":"+strconv.Itoa(t.Port)]
		}
	}
	return reach, nil
}
