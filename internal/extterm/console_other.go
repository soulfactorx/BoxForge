//go:build !windows

package extterm

import "os/exec"

func newConsole(*exec.Cmd) {}
