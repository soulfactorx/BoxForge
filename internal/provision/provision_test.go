package provision

import (
	"strings"
	"testing"
)

func TestFindSum(t *testing.T) {
	list := "2a790896740b14d637dbdc583cce1ba081ac53b9e9cdb46dc09a2f73abbd9934  ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz\n" +
		"BB415D824822C4B878125729AF451A5D18FB13D1CF5CBED9A7393AD64AC6039E *other.wsl\n" +
		"short  x\n"
	got, err := findSum(strings.NewReader(list), "ubuntu-noble-wsl-amd64-24.04lts.rootfs.tar.gz")
	if err != nil || got != "2a790896740b14d637dbdc583cce1ba081ac53b9e9cdb46dc09a2f73abbd9934" {
		t.Errorf("got %q, %v", got, err)
	}
	if got, _ := findSum(strings.NewReader(list), "other.wsl"); got != "bb415d824822c4b878125729af451a5d18fb13d1cf5cbed9a7393ad64ac6039e" {
		t.Errorf("starred, upper-case line: got %q", got)
	}
	if _, err := findSum(strings.NewReader(list), "missing"); err == nil {
		t.Error("no error for a name not in the list")
	}
	if _, err := findSum(strings.NewReader(list), "x"); err == nil {
		t.Error("a sum of the wrong length was accepted")
	}
}

func TestDecodeUTF16(t *testing.T) {
	raw := []byte{'O', 0, 'K', 0, '\r', 0, '\n', 0}
	if got := decode(raw); got != "OK\r\n" {
		t.Errorf("decode = %q", got)
	}
	if got := decode([]byte("plain")); got != "plain" {
		t.Errorf("decode = %q", got)
	}
}

func TestAlpineRootfs(t *testing.T) {
	index := `---
-
  title: "Standard"
  flavor: alpine-standard
  file: alpine-standard-3.22.1-x86_64.iso
  sha256: 1111111111111111111111111111111111111111111111111111111111111111
-
  title: "Mini root filesystem"
  desc: |
    Minimal root filesystem.
    For use in containers
    and minimal chroots.
  branch: v3.22
  arch: x86_64
  version: 3.22.1
  flavor: alpine-minirootfs
  file: alpine-minirootfs-3.22.1-x86_64.tar.gz
  iso: alpine-minirootfs-3.22.1-x86_64.tar.gz
  size: 3464252
  sha256: 2A2ACE7E1E3F0EBA4B0D4A9E7F6FDF50C4D2B4AB3D1D2D0E2C8A4F8C6E6F1A9B
  sha512: abcdef
-
  title: "Virtual"
  flavor: alpine-virt
  file: alpine-virt-3.22.1-x86_64.iso
  sha256: 3333333333333333333333333333333333333333333333333333333333333333
`
	name, sum, err := alpineRootfs(index)
	if err != nil || name != "alpine-minirootfs-3.22.1-x86_64.tar.gz" || sum != "2a2ace7e1e3f0eba4b0d4a9e7f6fdf50c4d2b4ab3d1d2d0e2c8a4f8c6e6f1a9b" {
		t.Errorf("got %q %q %v", name, sum, err)
	}
	if _, _, err := alpineRootfs("-\n  flavor: alpine-standard\n  file: x.iso\n"); err == nil {
		t.Error("no error when the list has no mini root filesystem")
	}
}

func TestParseDistros(t *testing.T) {
	sum := strings.Repeat("ab", 32)
	raw := `{"ModernDistributions":{
	 "Ubuntu":[
	  {"Name":"Ubuntu","FriendlyName":"Ubuntu","Default":true,"Amd64Url":{"Url":"https://x/ubuntu-26.04.1-wsl-amd64.wsl","Sha256":"` + sum + `"},"Arm64Url":{"Url":"https://x/ubuntu-26.04.1-wsl-arm64.wsl","Sha256":"` + sum + `"}},
	  {"Name":"Ubuntu-26.04","FriendlyName":"Ubuntu 26.04 LTS","Amd64Url":{"Url":"https://x/ubuntu-26.04.1-wsl-amd64.wsl","Sha256":"` + sum + `"},"Arm64Url":{"Url":"https://x/ubuntu-26.04.1-wsl-arm64.wsl","Sha256":"` + sum + `"}},
	  {"Name":"Ubuntu-24.04","FriendlyName":"Ubuntu 24.04 LTS","Amd64Url":{"Url":"https://x/ubuntu-24.04.5-wsl-amd64.wsl","Sha256":"0x` + strings.ToUpper(sum) + `"},"Arm64Url":{"Url":"https://x/ubuntu-24.04.5-wsl-arm64.wsl","Sha256":"` + sum + `"}},
	  {"Name":"Ubuntu-20.04","FriendlyName":"Ubuntu 20.04 LTS","Amd64Url":{"Url":"https://x/focal.wsl","Sha256":"` + sum + `"},"Arm64Url":{"Url":"https://x/focal-arm.wsl","Sha256":"` + sum + `"}}],
	 "Debian":[{"Name":"Debian","FriendlyName":"Debian GNU/Linux","Amd64Url":{"Url":"https://d/Debian.wsl","Sha256":"` + sum + `"},"Arm64Url":{"Url":"https://d/Debian-arm.wsl","Sha256":"` + sum + `"}}],
	 "Fedora":[{"Name":"FedoraLinux-45","FriendlyName":"Fedora Linux 45","Amd64Url":{"Url":"https://f/F.wsl","Sha256":"` + sum + `"},"Arm64Url":{"Url":"https://f/F-arm.wsl","Sha256":"` + sum + `"}}],
	 "archlinux":[{"Name":"archlinux","FriendlyName":"Arch Linux","Amd64Url":{"Url":"https://a/a.wsl","Sha256":"nope"}}]}}`
	byID, flavors := parseDistros(raw)
	var ids []string
	for _, f := range flavors {
		ids = append(ids, f.ID)
	}
	// One entry per download, newest Ubuntu first, the retired 20.04 and
	// the families with no installer left out.
	if got := strings.Join(ids, ","); got != "ms:Ubuntu,ms:Ubuntu-24.04,ms:Debian" {
		t.Errorf("flavors = %s", got)
	}
	if !strings.HasPrefix(flavors[0].Label, "ubuntu-26.04.1-wsl-") {
		t.Errorf("the plain Ubuntu entry should say its version: %q", flavors[0].Label)
	}
	if _, sum24 := byID["ms:Ubuntu-24.04"].download(); sum24 != sum {
		t.Errorf("0x-prefixed upper-case checksum not normalised: %q", sum24)
	}
	if _, f := parseDistros("not json"); f != nil {
		t.Error("garbage gave flavors")
	}
}
