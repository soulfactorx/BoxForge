//go:build !windows

package provision

// registryDisks: WSL is on Windows only.
func registryDisks() map[string]string { return map[string]string{} }
