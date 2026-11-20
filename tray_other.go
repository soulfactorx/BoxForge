//go:build !windows && !linux

package main

// startTray: no tray here. On macOS the app stays in the Dock instead.
func startTray(show, quit func()) bool { return false }
