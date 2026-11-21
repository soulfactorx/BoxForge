package app

import (
	"fmt"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
)

// Looking through the folders of the machine BoxForge runs on. The
// desktop app has the system's own file windows for this; a browser on
// another machine has nothing, so the page draws its own from these.

// DirEntry is one name in a folder.
type DirEntry struct {
	Name string `json:"name"`
	Dir  bool   `json:"dir"`
}

// DirListing is a folder's contents.
type DirListing struct {
	Path    string     `json:"path"`   // the folder, as a whole path
	Parent  string     `json:"parent"` // the folder above; "" at the top
	Home    string     `json:"home"`
	Entries []DirEntry `json:"entries"` // folders first, then files; names that start with a dot left out
	Sep     string     `json:"sep"`     // what joins names on this machine: "/" or "\"
}

// Browse lists a folder: the home folder when dir is "", and on Windows
// the drives when dir is "drives".
func (a *App) Browse(dir string) (DirListing, error) {
	home, _ := os.UserHomeDir()
	out := DirListing{Home: home, Entries: []DirEntry{}, Sep: string(filepath.Separator)}
	dir = strings.TrimSpace(dir)
	if dir == "drives" && runtime.GOOS == "windows" {
		out.Path = "drives"
		for c := 'A'; c <= 'Z'; c++ {
			root := string(c) + `:\`
			if _, err := os.Stat(root); err == nil {
				out.Entries = append(out.Entries, DirEntry{Name: root, Dir: true})
			}
		}
		return out, nil
	}
	if dir == "" {
		dir = home
	}
	if !filepath.IsAbs(dir) {
		return out, fmt.Errorf("write the folder's whole path")
	}
	dir = filepath.Clean(dir)
	list, err := os.ReadDir(dir)
	if err != nil {
		return out, err
	}
	out.Path = dir
	if parent := filepath.Dir(dir); parent != dir {
		out.Parent = parent
	} else if runtime.GOOS == "windows" {
		out.Parent = "drives"
	}
	for _, e := range list {
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		isDir := e.IsDir()
		if !isDir && e.Type()&os.ModeSymlink != 0 {
			if st, err := os.Stat(filepath.Join(dir, e.Name())); err == nil {
				isDir = st.IsDir()
			}
		}
		out.Entries = append(out.Entries, DirEntry{Name: e.Name(), Dir: isDir})
		if len(out.Entries) >= 3000 {
			break
		}
	}
	sort.SliceStable(out.Entries, func(i, j int) bool {
		if out.Entries[i].Dir != out.Entries[j].Dir {
			return out.Entries[i].Dir
		}
		return strings.ToLower(out.Entries[i].Name) < strings.ToLower(out.Entries[j].Name)
	})
	return out, nil
}

// PortsInUse returns which of the ports are taken on this machine: by a
// container that publishes them, or by any other program. It can only
// tell for an engine on this very machine; for one elsewhere (inside WSL,
// over SSH) it knows the containers' ports alone.
func (a *App) PortsInUse(ports []int) []int {
	taken := map[int]bool{}
	for _, c := range a.mirror().Containers() {
		if c.State != "running" {
			continue
		}
		for _, p := range c.Ports {
			if p.Public != 0 {
				taken[int(p.Public)] = true
			}
		}
	}
	a.emu.RLock()
	kind := a.target.Kind
	a.emu.RUnlock()
	local := kind != "wsl" && kind != "ssh"
	out := []int{}
	for _, p := range ports {
		if p < 1 || p > 65535 {
			continue
		}
		busy := taken[p]
		if !busy && local {
			ln, err := net.Listen("tcp", ":"+strconv.Itoa(p))
			if err != nil {
				busy = true
			} else {
				_ = ln.Close()
			}
		}
		if busy {
			out = append(out, p)
		}
	}
	return out
}
