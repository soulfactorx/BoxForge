package provision

import (
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
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

var compressedSize = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetCompressedFileSizeW")

// onDisk is what a file takes on the drive (less than its length when it
// is sparse), and whether it is sparse.
func onDisk(p string) (int64, bool) {
	st, err := os.Stat(p)
	if err != nil {
		return 0, false
	}
	name, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return st.Size(), false
	}
	sparse := false
	if attrs, err := windows.GetFileAttributes(name); err == nil {
		sparse = attrs&windows.FILE_ATTRIBUTE_SPARSE_FILE != 0
	}
	var high uint32
	low, _, callErr := compressedSize.Call(uintptr(unsafe.Pointer(name)), uintptr(unsafe.Pointer(&high)))
	if uint32(low) == 0xFFFFFFFF && callErr != windows.ERROR_SUCCESS {
		return st.Size(), sparse
	}
	return int64(high)<<32 | int64(uint32(low)), sparse
}
