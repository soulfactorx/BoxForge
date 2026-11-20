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
