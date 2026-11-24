//go:build !windows

package app

import (
	"os"
	"syscall"
)

// fileOwner is the user a file belongs to.
func fileOwner(st os.FileInfo) (int, bool) {
	sys, ok := st.Sys().(*syscall.Stat_t)
	if !ok {
		return 0, false
	}
	return int(sys.Uid), true
}

// writable reports whether this process may write p.
func writable(p string) bool { return syscall.Access(p, 2) == nil }
