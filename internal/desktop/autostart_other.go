//go:build !linux && !windows

package desktop

import "errors"

// Autostart: not made for this system yet.
func Autostart() bool { return false }

// SetAutostart: not made for this system yet (macOS: System Settings →
// General → Login Items).
func SetAutostart(bool) error {
	return errors.New("on macOS, add BoxForge in System Settings → General → Login Items")
}

// AutostartSupported reports whether this system can do it.
func AutostartSupported() bool { return false }
