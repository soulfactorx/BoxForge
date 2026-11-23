package app

import (
	"context"
	"fmt"
	"io"
	"net"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/soulfactorx/boxforge/internal/engine"
)

// Port forwarding: a port on this PC that leads to a service in the
// cluster, as `kubectl port-forward` does.
//
// The cluster lives in a container on an engine that may be inside WSL or
// on another machine, so its addresses can't be dialled from here. What
// can always be reached is the engine: BoxForge listens on this PC and,
// for each connection, runs `nc <service address>` in a helper container
// that shares the cluster container's network, carrying the bytes over
// the engine's own connection.

// forwardHelper is the helper container's name.
const forwardHelper = "boxforge-forward"

// Forward is one forwarded port.
type Forward struct {
	ID        string `json:"id"`
	Namespace string `json:"namespace"`
	Service   string `json:"service"`
	Port      int    `json:"port"`  // the service's
	Local     int    `json:"local"` // on this PC
}

type forward struct {
	Forward
	ln   net.Listener
	stop context.CancelFunc
}

var forwards = struct {
	sync.Mutex
	seq int
	all map[string]*forward
}{all: map[string]*forward{}}

// KubeForwards lists the forwarded ports.
func (a *App) KubeForwards() []Forward {
	forwards.Lock()
	defer forwards.Unlock()
	list := make([]Forward, 0, len(forwards.all))
	for _, f := range forwards.all {
		list = append(list, f.Forward)
	}
	sort.Slice(list, func(i, j int) bool { return list[i].Local < list[j].Local })
	return list
}

// helperImage picks the image the helper runs: one with nc that is here
// already, or busybox, fetched.
func (a *App) forwardImage(ctx context.Context) (string, error) {
	for _, im := range a.mirror().Images() {
		for _, tag := range im.Tags {
			if strings.Contains(tag, "busybox") || strings.Contains(tag, "alpine") {
				return tag, nil
			}
		}
	}
	const img = "busybox:stable"
	return img, a.pull(ctx, img)
}

// forwardReady makes sure the helper is running beside the cluster.
func (a *App) forwardReady(ctx context.Context) error {
	cs := a.eng().Containers()
	if _, _, code, err := cs.Output(ctx, forwardHelper, []string{"true"}, nil); err == nil && code == 0 {
		return nil
	}
	_ = cs.Remove(ctx, forwardHelper, true, false)
	img, err := a.forwardImage(ctx)
	if err != nil {
		return err
	}
	_, err = cs.Run(ctx, engine.RunSpec{
		Image: img, Name: forwardHelper, Network: "container:" + kubeContainer,
		// A shell that waits, as its first process: it also clears away the
		// relays' finished processes, which would otherwise pile up.
		Command: []string{"sh", "-c", "trap exit TERM; while :; do sleep 3600 & wait; done"},
	})
	return err
}

// KubeForward opens a port on this PC (local; 0 picks a free one) that
// leads to a service's port.
func (a *App) KubeForward(namespace, service string, port, local int) (Forward, error) {
	ref, err := kubeRef("service", namespace, service)
	if err != nil {
		return Forward{}, err
	}
	if port < 1 || port > 65535 || local < 0 || local > 65535 {
		return Forward{}, fmt.Errorf("a port is a number from 1 to 65535")
	}
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	ip, err := a.kubectl(ctx, nil, append([]string{"get", "-o", "jsonpath={.spec.clusterIP}"}, ref...)...)
	if err != nil {
		return Forward{}, err
	}
	ip = strings.TrimSpace(ip)
	// A headless service (as a moved Compose project's are) has no address
	// of its own: each connection goes to one of its pods, looked up then
	// (pods come and go with new addresses).
	headless := ip == "None"
	podIP := func(ctx context.Context) (string, error) {
		out, err := a.kubectl(ctx, nil, "get", "endpoints", service, "-n", namespace, "-o", "jsonpath={.subsets[*].addresses[*].ip}")
		if f := strings.Fields(out); err == nil && len(f) > 0 {
			return f[0], nil
		}
		return "", fmt.Errorf("no pod of the service is running")
	}
	if headless {
		if _, err := podIP(ctx); err != nil {
			return Forward{}, fmt.Errorf("the service has no running pod to connect to yet")
		}
	} else if net.ParseIP(ip) == nil {
		return Forward{}, fmt.Errorf("the service has no address inside the cluster to connect to")
	}
	if err := a.forwardReady(ctx); err != nil {
		return Forward{}, err
	}
	// The port asked for, or, when another program holds it, the next free
	// one: the forward made says which it got.
	var ln net.Listener
	for try := local; ; try++ {
		ln, err = net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(try)))
		if err == nil || local == 0 || try >= local+20 || try >= 65535 {
			break
		}
	}
	if err != nil {
		return Forward{}, fmt.Errorf("ports %d to %d on this PC are all in use by other programs; leave the port empty to take any free one", local, min(local+20, 65535))
	}
	run, stop := context.WithCancel(context.Background())
	forwards.Lock()
	forwards.seq++
	f := &forward{
		Forward: Forward{
			ID: fmt.Sprintf("f%d", forwards.seq), Namespace: namespace, Service: service,
			Port: port, Local: ln.Addr().(*net.TCPAddr).Port,
		},
		ln: ln, stop: stop,
	}
	forwards.all[f.ID] = f
	forwards.Unlock()

	rt := a.eng()
	go func() {
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			go func() {
				to := ip
				if headless {
					ctx, cancel := context.WithTimeout(run, 20*time.Second)
					to, err = podIP(ctx)
					cancel()
					if err != nil {
						conn.Close()
						return
					}
				}
				carry(run, rt, conn, []string{"sh", "-c", forwardRelay, "sh", to, strconv.Itoa(port)})
			}()
		}
	}()
	return f.Forward, nil
}

// forwardRelay carries one connection in the helper. A plain `nc HOST PORT`
// keeps running after the far side closes, as long as its input is open, so
// an answer whose end is the close (HTTP/1.0, an error page) never ended in
// the browser. With -e, nc hands the connection to a small program that
// copies both ways (the relay's own input and output reach it as fds 7 and
// 8) and, as soon as either side ends, ends every process of the relay
// (kill 0: each exec is a process group of its own), so none is left.
// dd, not cat: busybox's cat moves data with sendfile, which between a pipe
// and a socket sometimes stalls (seen as TLS handshakes that never end).
// A busybox without -e falls back to plain nc; -w 10: a connection that
// can't be made fails in 10 seconds instead of waiting.
const forwardRelay = `exec 7<&0 8>&1
nc -w 10 "$1" "$2" -e sh -c 'exec 2>/dev/null 6<&0
{ dd bs=65536 <&6 >&8; kill 0; } &
dd bs=65536 <&7; kill 0' 2>/dev/null || exec nc -w 10 "$1" "$2"`

// carry joins one connection to the command's input and output. When the
// far side has said all it will (it closed, so nc ended), the connection is
// closed at once: a browser waits for that end when the answer has no
// length (HTTP/1.0, an error page), and would otherwise wait forever. When
// the browser is done sending, the far side is told so and its answer still
// comes back.
func carry(ctx context.Context, rt engine.Runtime, conn net.Conn, cmd []string) {
	defer conn.Close()
	p, err := rt.Containers().Pipe(ctx, forwardHelper, cmd)
	if err != nil {
		return
	}
	defer p.Close()
	answered := make(chan struct{})
	go func() {
		_, _ = io.Copy(p, conn)
		if h, ok := p.(interface{ CloseWrite() error }); ok {
			_ = h.CloseWrite()
		}
	}()
	go func() {
		_, _ = io.Copy(conn, p)
		close(answered)
	}()
	select {
	case <-answered:
	case <-ctx.Done():
	}
}

// KubeForwardStop closes one forwarded port.
func (a *App) KubeForwardStop(id string) {
	forwards.Lock()
	f := forwards.all[id]
	delete(forwards.all, id)
	left := len(forwards.all)
	forwards.Unlock()
	if f == nil {
		return
	}
	f.stop()
	_ = f.ln.Close()
	if left == 0 {
		a.dropForwardHelper()
	}
}

// stopForwards closes every forwarded port: the cluster or the engine is
// going away. With helper, the helper container goes too.
func (a *App) stopForwards(helper bool) {
	forwards.Lock()
	all := forwards.all
	forwards.all = map[string]*forward{}
	forwards.Unlock()
	for _, f := range all {
		f.stop()
		_ = f.ln.Close()
	}
	if helper && len(all) > 0 {
		a.dropForwardHelper()
	}
}

func (a *App) dropForwardHelper() {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	_ = a.eng().Containers().Remove(ctx, forwardHelper, true, false)
}
