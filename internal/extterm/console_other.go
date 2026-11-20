//go:build !windows

package extterm

import "os/exec"

func openWindows([]string) *exec.Cmd { return nil }
