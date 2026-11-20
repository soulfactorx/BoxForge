// Package engine defines the runtime-neutral model and the interface every
// container runtime adapter (Docker now; Podman and containerd later)
// implements. The UI only ever sees these types.
package engine

import (
	"context"
	"strings"
)

// Container is the common view of a container across runtimes.
type Container struct {
	ID      string            `json:"id"`
	Name    string            `json:"name"`
	Image   string            `json:"image"`
	State   string            `json:"state"`  // running, exited, paused, created, restarting, dead
	Status  string            `json:"status"` // human text from the engine, e.g. "Up 4 minutes"
	Failed  bool              `json:"failed"` // ended by its own failure, see FailedStatus
	Created int64             `json:"created"`
	Ports   []Port            `json:"ports"`
	Project string            `json:"project"` // Compose project, "" when none
	Service string            `json:"service"` // Compose service, "" when none
	Labels  map[string]string `json:"labels"`
}

// Port is one port mapping. Public is 0 when the port is not published.
type Port struct {
	IP      string `json:"ip"`
	Private uint16 `json:"private"`
	Public  uint16 `json:"public"`
	Proto   string `json:"proto"`
}

// Info describes the engine itself.
type Info struct {
	Runtime    string `json:"runtime"` // "docker", "fake", ...
	Name       string `json:"name"`
	Version    string `json:"version"`
	OS         string `json:"os"`
	Arch       string `json:"arch"`
	CPUs       int    `json:"cpus"`
	MemTotal   int64  `json:"memTotal"`
	Containers int    `json:"containers"`
	Running    int    `json:"running"`
	Images     int    `json:"images"`
}

// Event is a change notification from the engine.
type Event struct {
	Type   string `json:"type"`   // container, image, volume, network
	Action string `json:"action"` // start, die, rename, destroy, ...
	ID     string `json:"id"`
}

// Capability names a feature an adapter supports. The UI hides what is absent.
type Capability string

const (
	CapPause  Capability = "container.pause"
	CapRename Capability = "container.rename"
)

// Runtime is one connected container engine.
type Runtime interface {
	Info(ctx context.Context) (Info, error)
	Capabilities() []Capability
	// Events streams changes until ctx ends or the connection drops; the
	// error channel then yields one value and both channels close.
	Events(ctx context.Context) (<-chan Event, <-chan error)
	Containers() ContainerService
	Close() error
}

// ContainerService is the container half of a Runtime.
type ContainerService interface {
	List(ctx context.Context) ([]Container, error)
	Start(ctx context.Context, id string) error
	Stop(ctx context.Context, id string) error
	Restart(ctx context.Context, id string) error
	Pause(ctx context.Context, id string) error
	Unpause(ctx context.Context, id string) error
	Kill(ctx context.Context, id string) error
	Rename(ctx context.Context, id, name string) error
	Remove(ctx context.Context, id string, force, volumes bool) error
}

// Labels Compose puts on the containers it creates.
const (
	LabelComposeProject = "com.docker.compose.project"
	LabelComposeService = "com.docker.compose.service"
)

// FailedStatus reports whether an engine status line such as "Exited (1)
// 2 hours ago" says the container ended by its own failure.
func FailedStatus(state, status string) bool {
	if state == "dead" {
		return true
	}
	if state != "exited" {
		return false
	}
	open := strings.Index(status, "(")
	end := strings.Index(status, ")")
	if open < 0 || end < open {
		return false
	}
	switch status[open+1 : end] {
	// 0 is success; 130, 137 and 143 are what a container reports when it
	// was interrupted, killed or asked to stop, which is what `docker stop`
	// and `docker kill` do. The list alone can't tell those from an
	// out-of-memory kill (also 137); that needs the container's inspect.
	case "0", "130", "137", "143":
		return false
	}
	return true
}
