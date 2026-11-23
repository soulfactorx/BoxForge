//go:build !windows

package provision

import (
	"os"
	"syscall"
)

// registryDisks: WSL is on Windows only.
func registryDisks() map[string]string { return map[string]string{} }

// onDisk is what a file takes on the drive, and whether that is less than
// its length (sparse).
func onDisk(p string) (int64, bool) {
	st, err := os.Stat(p)
	if err != nil {
		return 0, false
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok {
		used := sys.Blocks * 512
		return used, used < st.Size()
	}
	return st.Size(), false
}
