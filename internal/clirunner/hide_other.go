//go:build !windows

package clirunner

import "os/exec"

func hideWindow(*exec.Cmd) {}
