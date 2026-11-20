// Package engine defines the runtime-neutral model and the interface every
// container runtime adapter (Docker now; Podman and containerd later)
// implements. The UI only ever sees these types.
package engine

import (
	"context"
	"io"
	"strconv"
	"strings"
)

// Container is the common view of a container across runtimes.
type Container struct {
	ID       string            `json:"id"`
	Name     string            `json:"name"`
	Image    string            `json:"image"`
	ImageID  string            `json:"imageId"`
	State    string            `json:"state"`    // running, exited, paused, created, restarting, dead
	Status   string            `json:"status"`   // human text from the engine, e.g. "Up 4 minutes"
	Failed   bool              `json:"failed"`   // ended by its own failure, see FailedStatus
	ExitCode int               `json:"exitCode"` // of a stopped container; 0 when unknown
	System   bool              `json:"system"`   // a tool's own helper (a build worker), hidden by default
	Created  int64             `json:"created"`
	Ports    []Port            `json:"ports"`
	Project  string            `json:"project"` // Compose project, "" when none
	Service  string            `json:"service"` // Compose service, "" when none
	Labels   map[string]string `json:"labels"`
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

// Image is the common view of a local image.
type Image struct {
	ID      string   `json:"id"`
	Tags    []string `json:"tags"` // empty for an untagged ("dangling") image
	Size    int64    `json:"size"`
	Created int64    `json:"created"`
	InUse   int      `json:"inUse"` // containers made from it; filled in by the hub
}

// PullProgress is one step of an image download. Total is 0 while unknown.
type PullProgress struct {
	Status  string `json:"status"`
	Current int64  `json:"current"`
	Total   int64  `json:"total"`
}

// PortSpec, MountSpec and RunSpec describe a container to create and start:
// what `docker run -d` takes.
type PortSpec struct {
	Host      uint16 `json:"host"`
	Container uint16 `json:"container"`
	Proto     string `json:"proto"` // tcp (default) or udp
}

type MountSpec struct {
	Source string `json:"source"` // a volume name or a host path
	Target string `json:"target"` // the path inside the container
}

type RunSpec struct {
	Image   string      `json:"image"`
	Name    string      `json:"name"`
	Ports   []PortSpec  `json:"ports"`
	Mounts  []MountSpec `json:"mounts"`
	Env     []string    `json:"env"`     // KEY=value
	Restart string      `json:"restart"` // "", always, unless-stopped, on-failure
	Command []string    `json:"command"` // empty: the image's own
}

// Size is the disk a container takes. RootFS is everything it sees, its
// image included; RW is only what it has written on top of the image.
type Size struct {
	RW     int64 `json:"rw"`
	RootFS int64 `json:"rootFs"`
}

// Stats is one sample of a running container's resource use. CPU is in
// percent of one core, as `docker stats` shows it: 200 is two cores busy.
type Stats struct {
	CPU      float64 `json:"cpu"`
	MemUsed  int64   `json:"memUsed"`
	MemLimit int64   `json:"memLimit"`
	NetRx    int64   `json:"netRx"` // bytes received since the container started
	NetTx    int64   `json:"netTx"`
}

// Session is a command running in a container with a terminal attached:
// reads are its output, writes its keyboard.
type Session interface {
	io.ReadWriteCloser
	Resize(ctx context.Context, cols, rows uint) error
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
	Images() ImageService
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
	// Inspect returns the engine's own JSON for the container, unchanged.
	Inspect(ctx context.Context, id string) ([]byte, error)
	// Logs writes the last tail lines and then every new one to w, until
	// ctx ends or the container's log does.
	Logs(ctx context.Context, id string, tail int, w io.Writer) error
	// Run creates and starts a container from an image that is present,
	// and returns its ID.
	Run(ctx context.Context, spec RunSpec) (string, error)
	// Sizes measures every container's disk use, by ID. The engine walks
	// each container's files for this, so it is slow and asked for apart
	// from List.
	Sizes(ctx context.Context) (map[string]Size, error)
	// Exec starts cmd in a running container on a terminal of the given size.
	Exec(ctx context.Context, id string, cmd []string, cols, rows uint) (Session, error)
	// Stats calls each with a new sample about once a second until ctx
	// ends or the container stops.
	Stats(ctx context.Context, id string, each func(Stats)) error
}

// ImageService is the image half of a Runtime.
type ImageService interface {
	List(ctx context.Context) ([]Image, error)
	Exists(ctx context.Context, ref string) bool
	Pull(ctx context.Context, ref string, progress func(PullProgress)) error
	Remove(ctx context.Context, id string, force bool) error
	Tag(ctx context.Context, source, target string) error
	// Prune deletes untagged images no container uses, and returns the bytes freed.
	Prune(ctx context.Context) (int64, error)
}

// Labels Compose puts on the containers it creates.
const (
	LabelComposeProject = "com.docker.compose.project"
	LabelComposeService = "com.docker.compose.service"
)

// ExitCode reads the code from an engine status line such as "Exited (137)
// 2 hours ago"; ok is false when the line names none.
func ExitCode(status string) (code int, ok bool) {
	open := strings.Index(status, "(")
	end := strings.Index(status, ")")
	if !strings.HasPrefix(status, "Exited") || open < 0 || end < open {
		return 0, false
	}
	code, err := strconv.Atoi(status[open+1 : end])
	return code, err == nil
}

// FailedStatus reports whether a container ended by its own failure.
func FailedStatus(state, status string) bool {
	if state == "dead" {
		return true
	}
	if state != "exited" {
		return false
	}
	code, ok := ExitCode(status)
	if !ok {
		return false
	}
	switch code {
	// 0 is success. 130, 137 and 143 are what a container reports when it
	// was interrupted, killed or asked to stop, which is what `docker stop`
	// and `docker kill` do; 255 is what containers are left with when the
	// engine or its VM went away under them. The list alone can't tell
	// those from an out-of-memory kill (also 137) or a program that
	// returned -1; the code is shown either way.
	case 0, 130, 137, 143, 255:
		return false
	}
	return true
}

// SystemName reports whether a container name belongs to a tool's helper:
// buildx names its build workers buildx_buildkit_<builder>.
func SystemName(name string) bool {
	return strings.HasPrefix(name, "buildx_buildkit_")
}
