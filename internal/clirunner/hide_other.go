//go:build !windows

package clirunner

import "os/exec"

func HideWindow(*exec.Cmd) {}
