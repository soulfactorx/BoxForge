package engines

import (
	"os/exec"
	"syscall"
)

// tie makes a helper process end when BoxForge does, however BoxForge
// ends: a helper nobody is left to use should not stay behind.
func tie(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGTERM}
}
