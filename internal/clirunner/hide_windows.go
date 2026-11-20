package clirunner

import (
	"os/exec"
	"syscall"
)

// HideWindow keeps a console window from flashing up for each command a
// windowed app runs.
func HideWindow(cmd *exec.Cmd) {
	const createNoWindow = 0x08000000
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
}
