package docker

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"testing"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"

	"github.com/soulfactorx/boxforge/internal/engine"
)

// TestKeepLive makes a container as an image bound to its place would need
// (fixed address, alias, MAC address, hostname, a capability, a second
// network), then makes it again from its description on an engine without
// its networks, and again with its settings changed: everything stays.
// Set BOXFORGE_DOCKER_IMAGE (any image with sh and sleep) to run it.
func TestKeepLive(t *testing.T) {
	img := os.Getenv("BOXFORGE_DOCKER_IMAGE")
	if img == "" {
		t.Skip("BOXFORGE_DOCKER_IMAGE is not set")
	}
	sh := func(args ...string) string {
		out, err := exec.Command("docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("docker %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	clean := func() {
		_ = exec.Command("docker", "rm", "-f", "bfk-a").Run()
		_ = exec.Command("docker", "network", "rm", "bfk_net", "bfk_two").Run()
	}
	clean()
	t.Cleanup(clean)
	sh("network", "create", "--subnet", "172.31.77.0/24", "--label", "com.docker.compose.project=bfk", "--label", "com.docker.compose.network=net", "bfk_net")
	sh("network", "create", "bfk_two")
	sh("create", "--name", "bfk-a", "--network", "bfk_net", "--ip", "172.31.77.50", "--network-alias", "lic",
		"--mac-address", "02:11:22:33:44:55", "--hostname", "lichost", "--cap-add", "NET_ADMIN",
		"--label", "com.docker.compose.project=bfk", img, "sleep", "600")
	sh("network", "connect", "--alias", "two", "bfk_two", "bfk-a")

	rt, err := Connect("")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	raw, err := rt.Containers().Inspect(ctx, "bfk-a")
	if err != nil {
		t.Fatal(err)
	}
	check := func(when string) {
		t.Helper()
		var in container.InspectResponse
		b, _ := rt.Containers().Inspect(ctx, "bfk-a")
		if err := json.Unmarshal(b, &in); err != nil {
			t.Fatal(err)
		}
		ep := in.NetworkSettings.Networks["bfk_net"]
		if ep == nil || ep.IPAMConfig == nil || ep.IPAMConfig.IPv4Address != "172.31.77.50" || ep.MacAddress != "02:11:22:33:44:55" || !contains(ep.Aliases, "lic") {
			t.Fatalf("%s: bfk_net endpoint %+v", when, ep)
		}
		if two := in.NetworkSettings.Networks["bfk_two"]; two == nil || !contains(two.Aliases, "two") {
			t.Fatalf("%s: bfk_two endpoint %+v", when, two)
		}
		if in.Config.Hostname != "lichost" || !(contains(in.HostConfig.CapAdd, "NET_ADMIN") || contains(in.HostConfig.CapAdd, "CAP_NET_ADMIN")) {
			t.Fatalf("%s: hostname %q caps %v", when, in.Config.Hostname, in.HostConfig.CapAdd)
		}
		// The interface on bfk_net (the order of eth0, eth1 isn't fixed).
		if got := sh("exec", "bfk-a", "sh", "-c", `cat /sys/class/net/$(ip -o -4 addr | awk '/172\.31\.77\.50/{print $2}')/address`); got != "02:11:22:33:44:55" {
			t.Fatalf("%s: MAC inside is %s", when, got)
		}
	}

	// Another engine: the networks aren't there.
	sh("rm", "-f", "bfk-a")
	sh("network", "rm", "bfk_net", "bfk_two")
	_, notes, err := rt.Containers().CreateFrom(ctx, raw, img)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(notes, "network-made:bfk_net") {
		t.Fatalf("notes %v", notes)
	}
	var n network.Inspect
	b, _ := exec.Command("docker", "network", "inspect", "bfk_net", "--format", "{{json .}}").Output()
	_ = json.Unmarshal(b, &n)
	if len(n.IPAM.Config) == 0 || n.IPAM.Config[0].Subnet != "172.31.77.0/24" || n.Labels["com.docker.compose.network"] != "net" {
		t.Fatalf("remade network %+v %v", n.IPAM, n.Labels)
	}
	sh("start", "bfk-a")
	check("copied")

	// Its settings changed: made again from the form, the rest kept.
	raw, _ = rt.Containers().Inspect(ctx, "bfk-a")
	sh("rm", "-f", "bfk-a")
	if _, err := rt.Containers().Run(ctx, engine.RunSpec{Image: img, Name: "bfk-a", Network: "bfk_net", Command: []string{"sleep", "601"}, From: raw}); err != nil {
		t.Fatal(err)
	}
	check("remade")
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}
