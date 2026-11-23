package app

import (
	"archive/zip"
	"compress/flate"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/soulfactorx/boxforge/internal/engine"
	"github.com/soulfactorx/boxforge/internal/version"
)

// A bundle is containers put in one file to take to another PC: for each,
// its description, its image, and the data of its volumes. The file is a
// zip (so that parts of unknown size can be written as they come):
//
//	manifest.json                what is inside
//	containers/<n>.json          the engine's description of a container
//	images/<n>.tar               an image, as `docker save` writes it
//	volumes/<name>.tar           a volume's data
//	folders/<n>.tar              a folder (or file) of the engine's machine
//	                             a container mounts, and a Compose project's
//	                             files, to be put back at the same place
//
// Taking one in makes the images, volumes and containers on the engine in
// use; the containers are made, not started.

// BundleExt is the bundle file's ending.
const BundleExt = ".boxforge"

// BundleInfo is a bundle's manifest.
type BundleInfo struct {
	Format     int               `json:"format"`
	App        string            `json:"app"`     // the BoxForge version that wrote it
	Created    int64             `json:"created"` // when
	Runtime    string            `json:"runtime"` // the kind of engine it came from
	Containers []BundleContainer `json:"containers"`
	Volumes    []string          `json:"volumes"`
	Folders    []BundleFolder    `json:"folders,omitempty"`
}

// BundleFolder is a folder or file of the machine the engine ran on, kept
// to be put back at the same path: what a container mounts from there
// (a Compose project's ./config), and the project's Compose files.
type BundleFolder struct {
	Path    string `json:"path"`
	Archive string `json:"archive"`
	Compose bool   `json:"compose,omitempty"` // a Compose file of the project
}

// BundleContainer is one container in a bundle.
type BundleContainer struct {
	Name    string   `json:"name"`
	Image   string   `json:"image"`   // the name its image has in the bundle
	File    string   `json:"file"`    // its description
	Archive string   `json:"archive"` // its image
	Volumes []string `json:"volumes"`
}

// Pickers for the bundle file; the desktop shell sets them.
var (
	saveBundle func(name string) (string, error)
	openBundle func() (string, error)
)

// SetBundlePickers gives the app the shell's dialogs for saving and
// opening a bundle.
func SetBundlePickers(save func(name string) (string, error), open func() (string, error)) {
	saveBundle, openBundle = save, open
}

// PickExportFile asks where to save a bundle. In a browser there is no
// dialog: the Downloads folder is proposed.
func (a *App) PickExportFile(name string) (string, error) {
	name = strings.Map(func(r rune) rune {
		if strings.ContainsRune(`/\:*?"<>|`, r) {
			return '-'
		}
		return r
	}, name)
	if saveBundle != nil {
		return saveBundle(name + BundleExt)
	}
	dir, err := downloads()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, name+BundleExt), nil
}

// PickExportFileDefault proposes a place for a bundle without asking.
func (a *App) PickExportFileDefault(name string) (string, error) {
	save := saveBundle
	saveBundle = nil
	defer func() { saveBundle = save }()
	return a.PickExportFile(name)
}

// PickImportFile asks which bundle to open; "" when there is no dialog.
func (a *App) PickImportFile() (string, error) {
	if openBundle == nil {
		return "", nil
	}
	return openBundle()
}

// ExportBundle writes the containers to a bundle file. What it is doing
// arrives as "transfer" events.
func (a *App) ExportBundle(key string, ids []string, file string, o CopyOptions) (err error) {
	if len(ids) == 0 {
		return errors.New("choose at least one container")
	}
	file = strings.TrimSpace(file)
	if file == "" {
		return errors.New("the file to write is not named")
	}
	if !strings.HasSuffix(strings.ToLower(file), BundleExt) {
		file += BundleExt
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*pullTimeout)
	defer cancel()
	say := func(text string) { a.emit("transfer", Transfer{Key: key, Text: text}) }
	rt := a.eng()

	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	// Written beside its place and moved there when whole: a bundle that
	// exists is a bundle that is complete.
	part := file + ".part"
	f, err := os.Create(part)
	if err != nil {
		return err
	}
	defer func() {
		f.Close()
		if err != nil {
			os.Remove(part)
		}
	}()
	zw := zip.NewWriter(f)
	zw.RegisterCompressor(zip.Deflate, func(w io.Writer) (io.WriteCloser, error) { return flate.NewWriter(w, flate.BestSpeed) })
	put := func(name string, from io.Reader, told func(int64)) error {
		w, err := zw.Create(name)
		if err != nil {
			return err
		}
		_, err = io.Copy(w, &counting{r: from, tell: told})
		return err
	}

	info := BundleInfo{Format: 1, App: version.Version, Created: time.Now().Unix(), Volumes: []string{}}
	if ei, err := rt.Info(ctx); err == nil {
		info.Runtime = ei.Runtime
	}
	sent := map[string]string{} // image name → its file in the bundle
	folders := &hostPaths{}
	vols := map[string]bool{}
	for n, id := range ids {
		raw, err := rt.Containers().Inspect(ctx, id)
		if err != nil {
			return err
		}
		var c struct {
			Name   string
			Config struct {
				Image  string
				Labels map[string]string
			}
			Mounts []struct{ Type, Name, Source, Destination string }
		}
		if err := json.Unmarshal(raw, &c); err != nil {
			return err
		}
		name := strings.TrimPrefix(c.Name, "/")
		entry := BundleContainer{Name: name, Image: c.Config.Image, File: fmt.Sprintf("containers/%d.json", n), Volumes: []string{}}
		if entry.Image == "" {
			// containerd's description names the image at the top.
			var top struct{ Image string }
			_ = json.Unmarshal(raw, &top)
			entry.Image = top.Image
		}
		if o.Changes {
			// The container as it is now, made into an image for the journey.
			entry.Image = "boxforge-export/" + strings.ToLower(name) + ":" + time.Now().Format("20060102-150405")
			say(name + ": 지금 상태를 이미지로 만드는 중")
			if err := rt.Containers().Commit(ctx, id, entry.Image); err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
			defer func(ref string) {
				ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
				defer cancel()
				_ = rt.Images().Remove(ctx, ref, false)
			}(entry.Image)
		}
		if have := sent[entry.Image]; have != "" {
			entry.Archive = have
		} else {
			entry.Archive = fmt.Sprintf("images/%d.tar", n)
			sent[entry.Image] = entry.Archive
			say(name + ": 이미지를 담는 중")
			rc, err := rt.Images().Save(ctx, entry.Image)
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
			var last time.Time
			err = put(entry.Archive, rc, func(done int64) {
				if time.Since(last) > 500*time.Millisecond {
					last = time.Now()
					say(fmt.Sprintf("%s: 이미지를 담는 중 · %.1f MB", name, float64(done)/(1<<20)))
				}
			})
			rc.Close()
			if err != nil {
				return fmt.Errorf("%s: %w", name, err)
			}
		}
		if err := put(entry.File, strings.NewReader(string(raw)), func(int64) {}); err != nil {
			return err
		}
		for _, m := range c.Mounts {
			if m.Type != "volume" || m.Name == "" || !o.Volumes {
				continue
			}
			entry.Volumes = append(entry.Volumes, m.Name)
			if vols[m.Name] {
				continue
			}
			vols[m.Name] = true
			info.Volumes = append(info.Volumes, m.Name)
			say("볼륨 " + m.Name + "의 데이터를 담는 중")
			rc, err := rt.Volumes().Archive(ctx, m.Name, "/")
			if err != nil {
				return fmt.Errorf("volume %s: %w", m.Name, err)
			}
			err = put("volumes/"+m.Name+".tar", rc, func(int64) {})
			rc.Close()
			if err != nil {
				return fmt.Errorf("volume %s: %w", m.Name, err)
			}
		}
		if o.Folders {
			for _, m := range c.Mounts {
				if m.Type == "bind" && !engine.OwnMount(m.Source, m.Destination) {
					folders.add(m.Source, false)
				}
			}
			// The project's Compose files, so that it can be managed
			// (up, down, edited) where it is taken.
			for _, key := range []string{"com.docker.compose.project.config_files", "com.docker.compose.project.environment_file"} {
				for _, f := range strings.Split(c.Config.Labels[key], ",") {
					folders.add(strings.TrimSpace(f), true)
				}
			}
		}
		info.Containers = append(info.Containers, entry)
	}
	for i, f := range folders.list() {
		say(fmt.Sprintf("폴더 %s를 담는 중", f.path))
		dir, base := path.Split(f.path)
		rc, err := rt.Volumes().Archive(ctx, path.Clean(dir), base)
		if err != nil {
			// Gone from the machine (or not readable): said in the notes
			// of the import as a folder that isn't in the file.
			continue
		}
		bf := BundleFolder{Path: f.path, Archive: fmt.Sprintf("folders/%d.tar", i), Compose: f.compose}
		err = put(bf.Archive, rc, func(int64) {})
		rc.Close()
		if err != nil {
			return fmt.Errorf("folder %s: %w", f.path, err)
		}
		info.Folders = append(info.Folders, bf)
	}
	manifest, _ := json.MarshalIndent(info, "", "  ")
	if err := put("manifest.json", strings.NewReader(string(manifest)), func(int64) {}); err != nil {
		return err
	}
	if err := zw.Close(); err != nil {
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	say("파일을 마무리하는 중")
	return os.Rename(part, file)
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// readBundle opens a bundle and reads its manifest.
func readBundle(file string) (*zip.ReadCloser, BundleInfo, error) {
	var info BundleInfo
	zr, err := zip.OpenReader(file)
	if err != nil {
		return nil, info, fmt.Errorf("this is not a BoxForge bundle, or it is damaged: %w", err)
	}
	m, err := zr.Open("manifest.json")
	if err != nil {
		zr.Close()
		return nil, info, errors.New("this is not a BoxForge bundle: it has no manifest")
	}
	defer m.Close()
	if err := json.NewDecoder(io.LimitReader(m, 4<<20)).Decode(&info); err != nil || info.Format != 1 {
		zr.Close()
		return nil, info, errors.New("this bundle was written by a newer BoxForge; update and try again")
	}
	return zr, info, nil
}

// InspectBundle says what a bundle holds.
func (a *App) InspectBundle(file string) (BundleInfo, error) {
	zr, info, err := readBundle(strings.TrimSpace(file))
	if err != nil {
		return info, err
	}
	zr.Close()
	return info, nil
}

// ImportBundle makes a bundle's images, volumes and containers on the
// engine in use. Nothing that is there is replaced: a volume or container
// whose name is taken is left as it is and said so in the notes
// ("volume-kept:<name>", "container-kept:<name>"), beside the engine's own
// notes on what a container could not carry over.
func (a *App) ImportBundle(key, file string, start bool) ([]string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*pullTimeout)
	defer cancel()
	say := func(text string) { a.emit("transfer", Transfer{Key: key, Text: text}) }
	zr, info, err := readBundle(strings.TrimSpace(file))
	if err != nil {
		return nil, err
	}
	defer zr.Close()
	rt := a.eng()
	notes := []string{}

	loaded := map[string]bool{}
	for _, c := range info.Containers {
		if loaded[c.Archive] {
			continue
		}
		loaded[c.Archive] = true
		say(c.Name + ": 이미지를 넣는 중")
		in, err := zr.Open(c.Archive)
		if err != nil {
			return notes, fmt.Errorf("the bundle lacks %s", c.Archive)
		}
		var last time.Time
		err = rt.Images().Load(ctx, &counting{r: in, tell: func(done int64) {
			if time.Since(last) > 500*time.Millisecond {
				last = time.Now()
				say(fmt.Sprintf("%s: 이미지를 넣는 중 · %.1f MB", c.Name, float64(done)/(1<<20)))
			}
		}})
		in.Close()
		if err != nil {
			return notes, fmt.Errorf("%s: %w", c.Name, err)
		}
	}
	have := map[string]bool{}
	if list, err := rt.Volumes().List(ctx); err == nil {
		for _, v := range list {
			have[v.Name] = true
		}
	}
	for _, name := range info.Volumes {
		if have[name] {
			notes = append(notes, "volume-kept:"+name)
			continue
		}
		say("볼륨 " + name + "의 데이터를 넣는 중")
		in, err := zr.Open("volumes/" + name + ".tar")
		if err != nil {
			return notes, fmt.Errorf("the bundle lacks the data of volume %s", name)
		}
		err = rt.Volumes().Restore(ctx, name, in)
		in.Close()
		if err != nil {
			return notes, fmt.Errorf("volume %s: %w", name, err)
		}
	}
	// The folders, back at their paths on this engine's machine: where one
	// has content already (the same PC's drive, or taken before), it is kept.
	for _, f := range info.Folders {
		dir, base := path.Split(f.Path)
		dir = path.Clean(dir)
		if rc, err := rt.Volumes().Archive(ctx, dir, base); err == nil {
			rc.Close()
			notes = append(notes, "folder-kept:"+f.Path)
			continue
		}
		say(fmt.Sprintf("폴더 %s를 되살리는 중", f.Path))
		in, err := zr.Open(f.Archive)
		if err != nil {
			return notes, fmt.Errorf("the bundle lacks %s", f.Archive)
		}
		err = rt.Volumes().Put(ctx, dir, "/", in)
		in.Close()
		if err != nil {
			return notes, fmt.Errorf("folder %s: %w", f.Path, err)
		}
		notes = append(notes, "folder-made:"+f.Path)
	}

	names := map[string]bool{}
	if list, err := rt.Containers().List(ctx); err == nil {
		for _, c := range list {
			names[c.Name] = true
		}
	}
	var made []madeContainer
	for _, c := range info.Containers {
		if names[c.Name] {
			notes = append(notes, "container-kept:"+c.Name)
			continue
		}
		say(c.Name + ": 컨테이너를 만드는 중")
		in, err := zr.Open(c.File)
		if err != nil {
			return notes, fmt.Errorf("the bundle lacks %s", c.File)
		}
		raw, err := io.ReadAll(io.LimitReader(in, 16<<20))
		in.Close()
		if err != nil {
			return notes, err
		}
		id, more, err := rt.Containers().CreateFrom(ctx, raw, c.Image)
		if err != nil {
			return notes, fmt.Errorf("%s: %w", c.Name, portHint(err))
		}
		made = append(made, madeContainer{id: id, name: c.Name, raw: raw})
		for _, n := range more {
			if !contains(notes, n) {
				notes = append(notes, n)
			}
		}
	}
	if start {
		for _, m := range startOrder(made) {
			say(fmt.Sprintf("%s: 시작하는 중", m.name))
			if err := rt.Containers().Start(ctx, m.id); err != nil {
				notes = append(notes, "start-failed:"+m.name+"="+portHint(err).Error())
			}
		}
	}
	return notes, nil
}

// hostPaths gathers the folders and files of the engine's machine to put in
// a bundle: each once, none inside another already there, and none of the
// system's own (the engine's socket, /proc, …).
type hostPaths struct {
	all []struct {
		path    string
		compose bool
	}
}

func (h *hostPaths) add(p string, compose bool) {
	p = path.Clean(strings.ReplaceAll(p, "\\", "/"))
	if !path.IsAbs(p) || p == "/" || systemPath(p) {
		return
	}
	for i, have := range h.all {
		if have.path == p || strings.HasPrefix(p, have.path+"/") {
			return
		}
		if strings.HasPrefix(have.path, p+"/") {
			h.all[i].path = p // a folder that holds one already there
			return
		}
	}
	h.all = append(h.all, struct {
		path    string
		compose bool
	}{p, compose})
}

func (h *hostPaths) list() []struct {
	path    string
	compose bool
} {
	return h.all
}

// systemPath is a path of the machine itself, mounted for what it is there
// (the engine's socket, devices, the clock), not for its content.
func systemPath(p string) bool {
	for _, root := range []string{"/proc", "/sys", "/dev", "/run", "/var/run", "/var/lib/docker", "/etc/localtime", "/etc/timezone", "/tmp/.X11-unix", "/lib/modules", "/boot"} {
		if p == root || strings.HasPrefix(p, root+"/") {
			return true
		}
	}
	return false
}

type madeContainer struct {
	id, name string
	raw      []byte
}

// startOrder puts the containers of a Compose project after those they
// depend on (its depends_on, kept in a label), the others as they came.
func startOrder(made []madeContainer) []madeContainer {
	service := map[string]int{} // project/service → index
	needs := make([][]string, len(made))
	for i, m := range made {
		var c struct {
			Config struct{ Labels map[string]string }
		}
		_ = json.Unmarshal(m.raw, &c)
		l := c.Config.Labels
		p := l["com.docker.compose.project"]
		if s := l["com.docker.compose.service"]; s != "" {
			service[p+"/"+s] = i
		}
		for _, d := range strings.Split(l["com.docker.compose.depends_on"], ",") {
			if name, _, _ := strings.Cut(strings.TrimSpace(d), ":"); name != "" {
				needs[i] = append(needs[i], p+"/"+name)
			}
		}
	}
	var out []madeContainer
	done := make([]bool, len(made))
	var visit func(i int, depth int)
	visit = func(i int, depth int) {
		if done[i] || depth > len(made) {
			return
		}
		for _, n := range needs[i] {
			if j, ok := service[n]; ok {
				visit(j, depth+1)
			}
		}
		if !done[i] {
			done[i] = true
			out = append(out, made[i])
		}
	}
	for i := range made {
		visit(i, 0)
	}
	return out
}
