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

// TestKiriShapeLive makes a container from a description the way Kiri's
// engine writes one (seen in the field): folders only among Mounts, no
// Binds; the MAC address the user gave only as the top-level MacAddress;
// a network of the project with nothing filled in. Its folder, volume,
// MAC address, hostname, alias and host.docker.internal must all be there.
func TestKiriShapeLive(t *testing.T) {
	img := os.Getenv("BOXFORGE_DOCKER_IMAGE")
	if img == "" {
		t.Skip("BOXFORGE_DOCKER_IMAGE is not set")
	}
	dir := t.TempDir()
	if err := os.WriteFile(dir+"/license.xml", []byte("ok"), 0o644); err != nil {
		t.Fatal(err)
	}
	clean := func() {
		_ = exec.Command("docker", "rm", "-f", "bfk-ide").Run()
		_ = exec.Command("docker", "network", "rm", "bfkiri_default").Run()
		_ = exec.Command("docker", "volume", "rm", "bfk_oracle_vol").Run()
	}
	clean()
	t.Cleanup(clean)
	raw := `{
  "Id": "d4d66088e1a7657365cb1a1945c3c2a87930689193380af7be09ab046b5d3b37",
  "Name": "/bfk-ide", "Path": "sleep", "Args": ["600"],
  "Config": {"Hostname": "SKAX26N00713", "Image": "x", "Entrypoint": ["sleep", "600"], "Cmd": [],
    "Env": ["SPRING_DATASOURCE_URL=jdbc:oracle:thin:@host.docker.internal:1521/XE"],
    "Labels": {"com.docker.compose.project": "bfkiri", "com.docker.compose.service": "ide-server"}},
  "HostConfig": {"NetworkMode": "bfkiri_default", "RestartPolicy": {"Name": "unless-stopped"}, "CapAdd": [], "Devices": []},
  "Mounts": [
    {"Type": "bind", "Source": "` + dir + `", "Destination": "/app/license", "RW": true},
    {"Type": "volume", "Name": "bfk_oracle_vol", "Source": "/var/lib/kiri/volumes/bfk_oracle_vol/_data", "Destination": "/data", "RW": true}
  ],
  "NetworkSettings": {"MacAddress": "80:13:16:f7:54:fe", "Networks": {"bfkiri_default": {"Aliases": ["ide-server", "ide-server"], "IPAddress": "", "MacAddress": ""}}},
  "State": {"Status": "exited"}
}`
	rt, err := Connect("")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, _, err := rt.Containers().CreateFrom(ctx, []byte(raw), img); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command("docker", "start", "bfk-ide").CombinedOutput()
	if err != nil {
		t.Fatalf("start: %v %s", err, out)
	}
	got, _ := exec.Command("docker", "exec", "bfk-ide", "sh", "-c",
		`cat /app/license/license.xml; echo; hostname; cat /sys/class/net/eth0/address; grep -c host.docker.internal /etc/hosts; ls -d /data`).CombinedOutput()
	if want := "ok\nSKAX26N00713\n80:13:16:f7:54:fe\n1\n/data\n"; string(got) != want {
		t.Fatalf("inside the container:\n%s\nwant:\n%s", got, want)
	}
	aliases, _ := exec.Command("docker", "inspect", "bfk-ide", "--format", `{{(index .NetworkSettings.Networks "bfkiri_default").Aliases}}`).Output()
	if !strings.Contains(string(aliases), "ide-server") {
		t.Fatalf("aliases %s", aliases)
	}
}

// TestVolumeOwnersLive takes a volume's data out and puts it into another
// volume: owners and modes stay (an Oracle database's files are its own
// user's, mode 0640, and it can't open them as root's).
func TestVolumeOwnersLive(t *testing.T) {
	img := os.Getenv("BOXFORGE_DOCKER_IMAGE")
	if img == "" {
		t.Skip("BOXFORGE_DOCKER_IMAGE is not set")
	}
	run := func(args ...string) string {
		out, err := exec.Command("docker", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("docker %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	clean := func() { _ = exec.Command("docker", "volume", "rm", "-f", "bfk-own-a", "bfk-own-b").Run() }
	clean()
	t.Cleanup(clean)
	run("run", "--rm", "-v", "bfk-own-a:/v", img, "sh", "-c", "mkdir -p /v/dbs && echo x > /v/dbs/spfile.ora && chown -R 54321:54322 /v/dbs && chmod 0640 /v/dbs/spfile.ora")
	rt, err := Connect("")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	rc, err := rt.Volumes().Archive(ctx, "bfk-own-a", "/")
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	if err := rt.Volumes().Restore(ctx, "bfk-own-b", rc); err != nil {
		t.Fatal(err)
	}
	if got := run("run", "--rm", "-v", "bfk-own-b:/v", img, "stat", "-c", "%u:%g %a", "/v/dbs/spfile.ora", "/v/dbs"); got != "54321:54322 640\n54321:54322 755" {
		t.Fatalf("owners after restore:\n%s", got)
	}
}
