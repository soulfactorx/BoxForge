// Package desktop puts BoxForge in the Linux desktop's application menu.
//
// BoxForge is one downloaded file, with no installer to do this. Without
// a menu entry the desktop has no icon to show for its window either:
// Wayland desktops take a window's icon from the entry whose name matches
// the program's (Name below), never from the window itself.
package desktop

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
)

// Name is the program's name to the desktop: the window's class, and the
// menu entry's file name.
const Name = "boxforge"

// Register writes the menu entry and its icon under the user's own data
// directory, pointing at the program that is running. It changes nothing
// when they are already right.
func Register(icon []byte) error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	if strings.Contains(exe, "go-build") { // go run, tests: not a program to keep
		return nil
	}
	data := os.Getenv("XDG_DATA_HOME")
	if data == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		data = filepath.Join(home, ".local", "share")
	}
	png := filepath.Join(data, "icons", "hicolor", "1024x1024", "apps", Name+".png")
	if err := put(png, icon); err != nil {
		return err
	}
	entry := "[Desktop Entry]\nType=Application\nName=BoxForge\n" +
		"Comment=Docker made easy\nComment[ko]=Docker를 쉽게\n" +
		"Exec=" + quote(exe) + "\nIcon=" + png + "\nTerminal=false\n" +
		"Categories=Development;\nStartupWMClass=" + Name + "\n"
	return put(filepath.Join(data, "applications", Name+".desktop"), []byte(entry))
}

// quote writes a path as one argument of a desktop entry's Exec line.
func quote(s string) string {
	r := strings.NewReplacer(`\`, `\\\\`, `"`, `\\"`, "`", "\\\\`", `$`, `\\$`, `%`, `%%`)
	return `"` + r.Replace(s) + `"`
}

func put(file string, content []byte) error {
	if have, err := os.ReadFile(file); err == nil && bytes.Equal(have, content) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	return os.WriteFile(file, content, 0o644)
}
