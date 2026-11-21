package desktop

import (
	"os"
	"path/filepath"
)

// HiddenFlag is what BoxForge is started with at sign-in: it goes to the
// tray instead of opening its window.
const HiddenFlag = "--hidden"

// program is the running program's path, for starting it again later.
func program() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}
