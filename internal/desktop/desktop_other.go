//go:build !linux

// Package desktop puts BoxForge in the Linux desktop's application menu.
// Windows and macOS take the icon from the program itself.
package desktop

// Name is the program's name to the desktop.
const Name = "boxforge"

// Register does nothing here.
func Register([]byte) error { return nil }
