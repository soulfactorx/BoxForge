//go:build !linux

package engines

import "os/exec"

// tie: only Linux can end a helper with its parent; elsewhere it is
// stopped when BoxForge closes in the ordinary way.
func tie(*exec.Cmd) {}
