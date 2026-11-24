package app

import "os"

// fileOwner: Windows files have no numeric owner.
func fileOwner(os.FileInfo) (int, bool) { return 0, false }

// writable: Windows doesn't keep root's files from the user this way.
func writable(string) bool { return true }
