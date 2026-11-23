package provision

import (
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/registry"
)

// registryDisks reads where WSL keeps each distribution's disk.
func registryDisks() map[string]string {
	out := map[string]string{}
	k, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Lxss`, registry.ENUMERATE_SUB_KEYS|registry.QUERY_VALUE)
	if err != nil {
		return out
	}
	defer k.Close()
	ids, _ := k.ReadSubKeyNames(-1)
	for _, id := range ids {
		sub, err := registry.OpenKey(k, id, registry.QUERY_VALUE)
		if err != nil {
			continue
		}
		name, _, _ := sub.GetStringValue("DistributionName")
		base, _, _ := sub.GetStringValue("BasePath")
		file, _, _ := sub.GetStringValue("VhdFileName")
		sub.Close()
		if name == "" || base == "" {
			continue
		}
		if file == "" {
			file = "ext4.vhdx"
		}
		base = strings.TrimPrefix(base, `\\?\`)
		p := filepath.Join(base, file)
		if _, err := os.Stat(p); err == nil {
			out[name] = p
		}
	}
	return out
}
