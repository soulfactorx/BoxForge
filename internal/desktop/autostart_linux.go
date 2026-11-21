package desktop

import (
	"os"
	"path/filepath"
)

// autostartFile is the desktop's list of programs to start at sign-in.
func autostartFile() string {
	dir := os.Getenv("XDG_CONFIG_HOME")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".config")
	}
	return filepath.Join(dir, "autostart", Name+".desktop")
}

// Autostart reports whether BoxForge starts when the user signs in.
func Autostart() bool {
	_, err := os.Stat(autostartFile())
	return err == nil
}

// SetAutostart makes BoxForge start (to the tray) when the user signs in.
func SetAutostart(on bool) error {
	file := autostartFile()
	if !on {
		err := os.Remove(file)
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	exe, err := program()
	if err != nil {
		return err
	}
	entry := "[Desktop Entry]\nType=Application\nName=BoxForge\nComment=Docker made easy\n" +
		"Exec=" + quote(exe) + " " + HiddenFlag + "\nTerminal=false\nX-GNOME-Autostart-enabled=true\n"
	return put(file, []byte(entry))
}

// AutostartSupported reports whether this system can do it.
func AutostartSupported() bool { return true }
