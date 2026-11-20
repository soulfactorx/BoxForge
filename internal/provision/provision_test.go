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
