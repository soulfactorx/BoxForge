package main

import "github.com/godbus/dbus/v5"

// trayHost reports whether this desktop shows tray icons: whether anyone
// answers for the tray on the session bus. GNOME without an extension for
// it does not.
func trayHost() bool {
	conn, err := dbus.SessionBus()
	if err != nil {
		return false
	}
	var has bool
	err = conn.BusObject().Call("org.freedesktop.DBus.NameHasOwner", 0, "org.kde.StatusNotifierWatcher").Store(&has)
	return err == nil && has
}
