package main

import (
	"os"
	"os/exec"
)

// again starts the program at exe as this one was started, and ends this
// one: Windows cannot replace a running process in place.
func again(exe string) error {
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	os.Exit(0)
	return nil
}
