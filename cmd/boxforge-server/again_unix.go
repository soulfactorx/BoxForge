//go:build !windows

package main

import (
	"os"
	"syscall"
)

// again replaces this process with the program at exe, started as this
// one was. The process keeps its number, so whatever watches over it (a
// service manager, a terminal) sees one program that never stopped.
func again(exe string) error {
	return syscall.Exec(exe, os.Args, os.Environ())
}
