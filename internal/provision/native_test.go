package provision

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestNativeLinux runs the Linux installation with stand-ins for pkexec
// and docker: the steps go through and root is asked for the script.
func TestNativeLinux(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the Linux installation")
	}
	dir := t.TempDir()
	asked := filepath.Join(dir, "asked")
	_ = os.WriteFile(filepath.Join(dir, "pkexec"), []byte("#!/bin/sh\necho \"$*\" >> "+asked+"\necho installing\n"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "docker"), []byte("#!/bin/sh\necho 29.0.0\n"), 0o755)
	t.Setenv("BOXFORGE_NATIVE_PATH", dir)
	t.Setenv("BOXFORGE_WSL", "")

	in := &Installer{}
	st := in.Status()
	if !st.Supported || st.Kind != "linux" || st.Engine != "default" || len(st.Steps) != 3 || st.Flavors != nil {
		t.Fatalf("status: %+v", st)
	}
	if !in.Start(Options{Proxy: "http://proxy:3128"}) {
		t.Fatal("did not start")
	}
	for i := 0; i < 100; i++ {
		if st = in.Status(); !st.Running {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if !st.Installed || st.Error != "" {
		t.Fatalf("after the run: %+v", st)
	}
	b, _ := os.ReadFile(asked)
	if !strings.Contains(string(b), "env HTTP_PROXY=http://proxy:3128") || !strings.Contains(string(b), "boxforge-install-") {
		t.Errorf("root was asked for: %q", b)
	}
}

func TestNativeNoRoot(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the Linux installation")
	}
	t.Setenv("BOXFORGE_NATIVE_PATH", t.TempDir()) // nothing in it: no pkexec
	t.Setenv("BOXFORGE_WSL", "")
	if ok, why := nativeSupported(); ok || why == "" {
		t.Errorf("supported with no way to be root: %v %q", ok, why)
	}
}
