package app

import (
	"archive/tar"
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// Putting a file of this machine into a container or a volume. In the
// desktop app the file is one the user chose with the system's window; in
// a browser it is one the browser sent to the web server's inbox first.

// anyPicker asks for any file; the desktop shell sets it.
var anyPicker func() (string, error)

// SetAnyFilePicker gives the app the shell's window for choosing a file.
func SetAnyFilePicker(f func() (string, error)) { anyPicker = f }

// PickUploadFile asks which file to put somewhere; "" when cancelled.
func (a *App) PickUploadFile() (string, error) {
	if anyPicker == nil {
		return "", fmt.Errorf("no file window here")
	}
	return anyPicker()
}

// tarOf is the file as a tar stream of one entry, under its own name.
func tarOf(file string) (io.ReadCloser, string, error) {
	f, err := os.Open(file)
	if err != nil {
		return nil, "", err
	}
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		f.Close()
		if err == nil {
			err = fmt.Errorf("%s is a folder: choose a file", filepath.Base(file))
		}
		return nil, "", err
	}
	name := filepath.Base(file)
	pr, pw := io.Pipe()
	go func() {
		defer f.Close()
		tw := tar.NewWriter(pw)
		err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: st.Size(), ModTime: st.ModTime(), Typeflag: tar.TypeReg})
		if err == nil {
			_, err = io.Copy(tw, f)
		}
		if err == nil {
			err = tw.Close()
		}
		pw.CloseWithError(err)
	}()
	return pr, name, nil
}

// fromInbox removes a file the browser sent, once it has been put where
// it was going: the server keeps no copy.
func fromInbox(file string) {
	if inbox := os.Getenv("BOXFORGE_INBOX"); inbox != "" && strings.HasPrefix(filepath.Clean(file), filepath.Clean(inbox)+string(filepath.Separator)) {
		os.Remove(file)
	}
}

// ContainerUpload puts a file of this machine into a folder of the
// container, and returns the path it has there.
func (a *App) ContainerUpload(id, dir, file string) (string, error) {
	defer fromInbox(file)
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	t, name, err := tarOf(file)
	if err != nil {
		return "", err
	}
	defer t.Close()
	dir = path.Clean("/" + dir)
	if err := a.eng().Containers().Put(ctx, id, dir, t); err != nil {
		return "", err
	}
	return path.Join(dir, name), nil
}

// VolumeUpload puts a file of this machine into a folder of the volume.
func (a *App) VolumeUpload(volume, dir, file string) (string, error) {
	defer fromInbox(file)
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	t, name, err := tarOf(file)
	if err != nil {
		return "", err
	}
	defer t.Close()
	dir = path.Clean("/" + dir)
	if err := a.eng().Volumes().Put(ctx, volume, dir, t); err != nil {
		return "", err
	}
	return path.Join(dir, name), nil
}

// Limits is how much a container may use: memory in bytes and CPU in
// cores, 0 for no limit.
type Limits struct {
	Memory int64   `json:"memory"`
	CPUs   float64 `json:"cpus"`
}

// LimitContainer changes a running container's limits without remaking it.
func (a *App) LimitContainer(id string, l Limits) error {
	if l.Memory < 0 || l.CPUs < 0 {
		return fmt.Errorf("a limit can't be below zero")
	}
	if l.Memory > 0 && l.Memory < 6<<20 {
		return fmt.Errorf("the memory limit must be at least 6 MB")
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.eng().Containers().Limit(ctx, id, l.Memory, l.CPUs)
}

// Leftovers are the images BoxForge made for its own work (copying,
// exporting, keeping a container to undo a remake) that are still there:
// normally removed as the work ends, they stay when it was cut short.
func (a *App) Leftovers() []string {
	out := []string{}
	for _, im := range a.mirror().Images() {
		if im.InUse > 0 {
			continue
		}
		for _, t := range im.Tags {
			if strings.HasPrefix(t, "boxforge-copy/") || strings.HasPrefix(t, "boxforge-export/") || strings.HasPrefix(t, "boxforge-undo/") {
				out = append(out, t)
			}
		}
	}
	return out
}

// RemoveLeftovers removes those images and returns how many went.
func (a *App) RemoveLeftovers() (int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	n := 0
	var first error
	for _, t := range a.Leftovers() {
		if err := a.eng().Images().Remove(ctx, t, false); err != nil {
			if first == nil {
				first = err
			}
			continue
		}
		n++
	}
	return n, first
}
