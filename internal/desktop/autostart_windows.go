package desktop

import (
	"golang.org/x/sys/windows/registry"
)

const runKey = `Software\Microsoft\Windows\CurrentVersion\Run`

// Autostart reports whether BoxForge starts when the user signs in.
func Autostart() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue("BoxForge")
	return err == nil
}

// SetAutostart makes BoxForge start (to the tray) when the user signs in:
// the user's own list of programs to run, no administrator rights needed.
func SetAutostart(on bool) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if !on {
		err := k.DeleteValue("BoxForge")
		if err == registry.ErrNotExist {
			return nil
		}
		return err
	}
	exe, err := program()
	if err != nil {
		return err
	}
	return k.SetStringValue("BoxForge", `"`+exe+`" `+HiddenFlag)
}

// AutostartSupported reports whether this system can do it.
func AutostartSupported() bool { return true }
