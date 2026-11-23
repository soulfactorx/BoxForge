package docker

// Putting a container back as it was: on its own networks (made again when
// the engine lacks them, with the same subnet when it is free), with its
// aliases, its fixed address and its MAC address, and with the settings no
// form shows (hostname, capabilities, extra hosts, devices, …). Images that
// check where they run (a licence bound to a MAC address or a hostname)
// rely on these.

import (
	"context"
	"net"
	"sort"
	"strconv"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/errdefs"

	"github.com/soulfactorx/boxforge/internal/engine"
)

// joined is a container's place on its networks: the one it is made on and
// the endpoints, by network name; the others are connected after.
type joined struct {
	primary string
	first   *network.EndpointSettings
	rest    map[string]*network.EndpointSettings
}

// rejoin works out (and makes what is missing of) the networks a container
// described by in was on. mac is the MAC address the user gave, if any.
func (c containers) rejoin(ctx context.Context, in container.InspectResponse, mac string) (joined, []string) {
	var notes []string
	j := joined{primary: string(in.HostConfig.NetworkMode), rest: map[string]*network.EndpointSettings{}}
	if j.primary == "" || j.primary == "default" {
		j.primary = "bridge"
	}
	if j.primary == "host" || j.primary == "none" || strings.HasPrefix(j.primary, "container:") {
		return j, nil
	}
	var nets map[string]*network.EndpointSettings
	if in.NetworkSettings != nil {
		nets = in.NetworkSettings.Networks
	}
	names := make([]string, 0, len(nets))
	for name := range nets {
		names = append(names, name)
	}
	sort.Strings(names)
	if _, ok := nets[j.primary]; !ok {
		names = append([]string{j.primary}, names...)
	}
	short := ""
	if len(in.ID) >= 12 {
		short = in.ID[:12]
	}
	for _, name := range names {
		was := nets[name]
		if was == nil {
			was = &network.EndpointSettings{}
		}
		ep := &network.EndpointSettings{}
		if name == j.primary && mac != "" {
			ep.MacAddress = mac
		}
		if engine.BuiltinNetwork(name) {
			// The engine's own: always there; no aliases or fixed address.
			if name == j.primary {
				j.first = ep
			} else {
				j.rest[name] = ep
			}
			continue
		}
		subnetKept := true
		if _, err := c.cli.NetworkInspect(ctx, name, network.InspectOptions{}); errdefs.IsNotFound(err) {
			made, kept := c.remake(ctx, name, in.Config.Labels, was)
			if !made {
				notes = append(notes, "network:"+name)
				if name == j.primary {
					j.primary = "bridge"
					j.first = &network.EndpointSettings{MacAddress: ep.MacAddress}
				}
				continue
			}
			subnetKept = kept
			notes = append(notes, "network-made:"+name)
		}
		for _, a := range was.Aliases {
			if a != short && a != "" && a != strings.TrimPrefix(in.Name, "/") {
				ep.Aliases = append(ep.Aliases, a)
			}
		}
		if was.IPAMConfig != nil && (was.IPAMConfig.IPv4Address != "" || was.IPAMConfig.IPv6Address != "") {
			if subnetKept {
				ep.IPAMConfig = &network.EndpointIPAMConfig{IPv4Address: was.IPAMConfig.IPv4Address, IPv6Address: was.IPAMConfig.IPv6Address}
			} else {
				notes = append(notes, "ip:"+name+"="+was.IPAMConfig.IPv4Address)
			}
		}
		if name == j.primary {
			j.first = ep
		} else {
			j.rest[name] = ep
		}
	}
	return j, notes
}

// remake makes a network a container was on, as near as can be told from
// the container's side: a bridge with the subnet its address was in, owned
// by its Compose project when it was one of the project's (Compose checks).
// kept says whether the subnet is the same.
func (c containers) remake(ctx context.Context, name string, labels map[string]string, ep *network.EndpointSettings) (made, kept bool) {
	opts := network.CreateOptions{Driver: "bridge", Labels: map[string]string{}}
	if p := labels["com.docker.compose.project"]; p != "" && strings.HasPrefix(name, p+"_") {
		opts.Labels["com.docker.compose.project"] = p
		opts.Labels["com.docker.compose.network"] = strings.TrimPrefix(name, p+"_")
		if v := labels["com.docker.compose.version"]; v != "" {
			opts.Labels["com.docker.compose.version"] = v
		}
	}
	// The subnet: the one its address was in, or, for a container that
	// never ran (no address yet), the /24 around its fixed one.
	cidr, gateway := "", ""
	if ep.IPAddress != "" && ep.IPPrefixLen > 0 {
		cidr, gateway = ep.IPAddress+"/"+strconv.Itoa(ep.IPPrefixLen), ep.Gateway
	} else if ep.IPAMConfig != nil && ep.IPAMConfig.IPv4Address != "" {
		cidr = ep.IPAMConfig.IPv4Address + "/24"
	}
	if _, sub, err := net.ParseCIDR(cidr); err == nil {
		with := opts
		with.IPAM = &network.IPAM{Config: []network.IPAMConfig{{Subnet: sub.String(), Gateway: gateway}}}
		if _, err := c.cli.NetworkCreate(ctx, name, with); err == nil {
			return true, true
		}
	}
	// Taken here (another network has that subnet): one the engine picks,
	// and a fixed address can't be kept.
	if _, err := c.cli.NetworkCreate(ctx, name, opts); err != nil {
		return false, false
	}
	return true, ep.IPAMConfig == nil || ep.IPAMConfig.IPv4Address == ""
}

// networking is what ContainerCreate takes for the first network.
func (j joined) networking() *network.NetworkingConfig {
	if j.first == nil {
		return nil
	}
	return &network.NetworkingConfig{EndpointsConfig: map[string]*network.EndpointSettings{j.primary: j.first}}
}

// connectRest puts a made container on its other networks.
func (c containers) connectRest(ctx context.Context, id string, j joined) []string {
	var notes []string
	names := make([]string, 0, len(j.rest))
	for name := range j.rest {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := c.cli.NetworkConnect(ctx, name, id, j.rest[name]); err != nil {
			notes = append(notes, "network:"+name)
		}
	}
	return notes
}

// keepUnshown copies onto a new container's settings what the run form
// doesn't show, from the container it replaces.
func keepUnshown(cfg *container.Config, host *container.HostConfig, in container.InspectResponse) {
	old, oh := in.Config, in.HostConfig
	if old.Hostname != "" && !strings.HasPrefix(in.ID, old.Hostname) {
		cfg.Hostname = old.Hostname
	}
	cfg.Domainname = old.Domainname
	cfg.MacAddress = old.MacAddress //nolint:staticcheck // what API 1.51 still reports
	cfg.User = old.User
	cfg.StopSignal = old.StopSignal
	if old.Image == cfg.Image || strings.TrimPrefix(old.Image, "docker.io/") == cfg.Image {
		cfg.Entrypoint = old.Entrypoint
		cfg.WorkingDir = old.WorkingDir
	}
	host.CapAdd, host.CapDrop = oh.CapAdd, oh.CapDrop
	host.ExtraHosts = oh.ExtraHosts
	host.DNS, host.DNSSearch, host.DNSOptions = oh.DNS, oh.DNSSearch, oh.DNSOptions
	host.SecurityOpt = oh.SecurityOpt
	host.Sysctls = oh.Sysctls
	host.ShmSize = oh.ShmSize
	host.Init = oh.Init
	host.Resources.Devices = oh.Resources.Devices
	host.Resources.Ulimits = oh.Resources.Ulimits
	host.Resources.Memory, host.Resources.MemorySwap, host.Resources.NanoCPUs = oh.Resources.Memory, oh.Resources.MemorySwap, oh.Resources.NanoCPUs
}
