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
	Health   string            `json:"health"`   // healthy, unhealthy, starting; "" when the image has no health check
	ExitCode int               `json:"exitCode"` // of a stopped container; 0 when unknown
	System   bool              `json:"system"`   // a tool's own helper (a build worker), hidden by default
	Created  int64             `json:"created"`
	Ports    []Port            `json:"ports"`
	Project  string            `json:"project"`  // Compose project, "" when none
	Service  string            `json:"service"`  // Compose service, "" when none
	Volumes  []string          `json:"volumes"`  // names of the volumes it mounts
	Networks []Attachment      `json:"networks"` // the networks it is on
	Labels   map[string]string `json:"labels"`
}

// Attachment is a container's place on one network.
type Attachment struct {
	Network string `json:"network"`
	IP      string `json:"ip"`
}

// Volume is a named place for data that outlives containers.
type Volume struct {
	Name    string `json:"name"`
	Driver  string `json:"driver"`
	Created int64  `json:"created"` // 0 when the engine doesn't say
	Project string `json:"project"` // Compose project, "" when none
}

// Network is a private network containers can join.
type Network struct {
	ID       string `json:"id"`
	Name     string `json:"name"`
	Driver   string `json:"driver"`
	Subnet   string `json:"subnet"`
	Gateway  string `json:"gateway"`
	Internal bool   `json:"internal"` // no way out to the internet
	Builtin  bool   `json:"builtin"`  // the engine's own: bridge, host, none
	Created  int64  `json:"created"`
	Project  string `json:"project"`
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

// Layer is one step of an image's making: the command that made it and
// what it added. Size is 0 for steps that changed no files.
type Layer struct {
	Command string `json:"command"`
	Size    int64  `json:"size"`
	Created int64  `json:"created"`
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
	// IP is the host address to listen on: "" for every one, "127.0.0.1"
	// for this machine only.
	IP string `json:"ip,omitempty"`
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
	// For containers that run containers of their own (a Kubernetes node):
	// every right on the engine's machine, and memory-backed directories.
	Privileged bool     `json:"privileged"`
	Tmpfs      []string `json:"tmpfs"`
	// Interactive keeps a terminal and the input open, as `docker run -it`
	// does: what a bare shell needs to stay running.
	Interactive bool `json:"interactive"`
	// Network is whose network the container uses instead of one of its
	// own: "container:<name>" shares that container's.
	Network string `json:"network"`
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

// Usage is disk space by kind of thing: what each takes, and how much of
// that nothing is using (so could be freed).
type Usage struct {
	Images         int64 `json:"images"`
	ImagesFree     int64 `json:"imagesFree"`
	Containers     int64 `json:"containers"`
	ContainersFree int64 `json:"containersFree"`
	Volumes        int64 `json:"volumes"`
	VolumesFree    int64 `json:"volumesFree"`
	BuildCache     int64 `json:"buildCache"`
	BuildCacheFree int64 `json:"buildCacheFree"`
	StoppedCount   int   `json:"stoppedCount"`
	UnusedVolumes  int   `json:"unusedVolumes"`
	UnusedImages   int   `json:"unusedImages"`
}

// ImageDefaults is what an image says it expects of a container.
type ImageDefaults struct {
	Ports   []PortSpec `json:"ports"`   // the ports its program listens on
	Volumes []string   `json:"volumes"` // the folders it keeps data in
	// Shell: what the image runs by default is a bare shell, which ends
	// at once unless it has a terminal to wait at.
	Shell bool `json:"shell"`
}

// OwnMount reports whether a mount in a container's description is one
// the engine made for itself (nerdctl lists the resolv.conf, hosts and
// hostname files it puts in every container), not one the user asked for.
func OwnMount(source, target string) bool {
	switch target {
	case "/etc/resolv.conf", "/etc/hosts", "/etc/hostname":
		return strings.Contains(source, "/nerdctl/")
	}
	return false
}

// BareShell reports whether an image's default command is nothing but a
// shell: what base images (alpine, ubuntu, debian, busybox) run.
func BareShell(entrypoint, cmd []string) bool {
	if len(entrypoint) != 0 || len(cmd) != 1 {
		return false
	}
	name := cmd[0][strings.LastIndex(cmd[0], "/")+1:]
	switch name {
	case "sh", "bash", "ash", "dash", "zsh", "ksh", "fish":
		return true
	}
	return false
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
	// Usage measures the disk the engine's things take. Slow.
	Usage(ctx context.Context) (Usage, error)
	Images() ImageService
	Volumes() VolumeService
	Networks() NetworkService
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
	// Output runs cmd in a running container with no terminal, gives it
	// stdin (nil for none), and returns what it wrote and its exit code.
	Output(ctx context.Context, id string, cmd []string, stdin []byte) (stdout, stderr string, code int, err error)
	// Pipe starts cmd in a running container with no terminal: writes go
	// to its input, reads are its output, byte for byte.
	Pipe(ctx context.Context, id string, cmd []string) (io.ReadWriteCloser, error)
	// Files lists one directory inside the container.
	Files(ctx context.Context, id, path string) ([]FileEntry, error)
	// Archive returns the file or directory at path as a tar stream.
	Archive(ctx context.Context, id, path string) (io.ReadCloser, error)
	// Put unpacks a tar stream into the folder dir of the container.
	Put(ctx context.Context, id, dir string, tar io.Reader) error
	// Limit changes how much memory (bytes) and CPU (in cores, e.g. 1.5) the
	// container may use; 0 for no limit.
	Limit(ctx context.Context, id string, memory int64, cpus float64) error
	// Prune deletes every stopped container and returns the bytes freed.
	Prune(ctx context.Context) (int64, error)
	// Commit makes an image of the container as it is now: its image plus
	// everything written in it since.
	Commit(ctx context.Context, id, ref string) error
	// CreateFrom makes, without starting it, a container like the one an
	// Inspect of this kind of runtime describes, from the named image. The
	// notes say what could not be carried over.
	CreateFrom(ctx context.Context, inspect []byte, image string) (id string, notes []string, err error)
	// StatsOnce returns one sample at once. Its CPU is not filled in:
	// that takes two samples.
	StatsOnce(ctx context.Context, id string) (Stats, error)
}

// VolumeService is the volume part of a Runtime.
type VolumeService interface {
	List(ctx context.Context) ([]Volume, error)
	Create(ctx context.Context, name string) error
	Remove(ctx context.Context, name string) error
	// Prune deletes every volume no container uses, and returns the bytes freed.
	Prune(ctx context.Context) (int64, error)
	// Sizes measures each volume's data, by name. Slow, like container sizes.
	Sizes(ctx context.Context) (map[string]int64, error)
	// Files lists one directory inside the volume; path "/" is its top.
	Files(ctx context.Context, name, path string) ([]FileEntry, error)
	// Archive returns the file or directory at path as a tar stream.
	Archive(ctx context.Context, name, path string) (io.ReadCloser, error)
	// Put unpacks a tar stream into the folder dir of the volume.
	Put(ctx context.Context, name, dir string, tar io.Reader) error
	// Restore fills the volume, made if need be, from what Archive(name,
	// "/") gave on another engine.
	Restore(ctx context.Context, name string, tar io.Reader) error
}

// FileEntry is one name in a directory listing.
type FileEntry struct {
	Name     string `json:"name"`
	Kind     string `json:"kind"` // dir, file, link, other
	Size     int64  `json:"size"`
	Modified int64  `json:"modified"`
}

// NetworkService is the network part of a Runtime.
type NetworkService interface {
	List(ctx context.Context) ([]Network, error)
	// Create makes a bridge network; subnet ("172.30.0.0/16") may be empty
	// for the engine to choose.
	Create(ctx context.Context, name, subnet string) error
	Remove(ctx context.Context, id string) error
	Connect(ctx context.Context, network, container string) error
	Disconnect(ctx context.Context, network, container string) error
	// Prune deletes every network no container is on.
	Prune(ctx context.Context) error
}

// BuiltinNetwork reports whether the engine made the network itself; those
// can't be removed.
func BuiltinNetwork(name string) bool {
	return name == "bridge" || name == "host" || name == "none"
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
	// Defaults returns the ports and data folders the image declares.
	Defaults(ctx context.Context, ref string) (ImageDefaults, error)
	// History returns the steps the image was built in, newest first.
	History(ctx context.Context, ref string) ([]Layer, error)
	// Save returns the image as a tar stream, as `docker save` writes it.
	Save(ctx context.Context, ref string) (io.ReadCloser, error)
	// Load takes in such a stream, as `docker load` does.
	Load(ctx context.Context, r io.Reader) error
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

// HelperPrefix starts the name of the short-lived containers BoxForge makes
// for itself, to look inside a volume.
const HelperPrefix = "boxforge-helper-"

// ClusterName is the container BoxForge runs its Kubernetes cluster in.
const ClusterName = "boxforge-k3s"

// SystemName reports whether a container name belongs to a tool's helper:
// buildx names its build workers buildx_buildkit_<builder>.
func SystemName(name string) bool {
	return strings.HasPrefix(name, "buildx_buildkit_") || strings.HasPrefix(name, HelperPrefix) || name == ClusterName
}

// HealthOf reads the health from a status line such as "Up 2 minutes
// (healthy)"; "" when it names none.
func HealthOf(status string) string {
	switch {
	case strings.Contains(status, "(healthy)"):
		return "healthy"
	case strings.Contains(status, "(unhealthy)"):
		return "unhealthy"
	case strings.Contains(status, "(health: starting)"):
		return "starting"
	}
	return ""
}
