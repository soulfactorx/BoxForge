package nerdctl

import (
	"context"
	"errors"
	"io"
	"os/exec"
	"path"
	"strings"

	"github.com/soulfactorx/boxforge/internal/clirunner"
	"github.com/soulfactorx/boxforge/internal/engine"
	"github.com/soulfactorx/boxforge/internal/engine/docker"
)

func hide(c *exec.Cmd) { clirunner.HideWindow(c) }

type volumes struct{ r *runtime }

// Where a helper container sees the volume it was made to look into: the
// same place as with Docker, so that an archive made on one engine
// unpacks on the other.
const mount = "/boxforge-volume"

func (s volumes) List(ctx context.Context) ([]engine.Volume, error) {
	b, err := s.r.out(ctx, "volume", "ls", "--format", "{{json .}}")
	if err != nil {
		return nil, err
	}
	list := []engine.Volume{}
	for _, v := range lines[struct{ Name, Driver, Labels string }](b) {
		vol := engine.Volume{Name: v.Name, Driver: v.Driver}
		for _, kv := range strings.Split(v.Labels, ",") {
			if k, val, ok := strings.Cut(kv, "="); ok && k == engine.LabelComposeProject {
				vol.Project = val
			}
		}
		list = append(list, vol)
	}
	return list, nil
}

func (s volumes) Create(ctx context.Context, name string) error {
	return s.r.do(ctx, "volume", "volume", "create", name)
}

func (s volumes) Remove(ctx context.Context, name string) error {
	return s.r.do(ctx, "volume", "volume", "rm", name)
}

func (s volumes) total(ctx context.Context) int64 {
	var n int64
	sizes, _ := s.Sizes(ctx)
	for _, v := range sizes {
		n += v
	}
	return n
}

// Prune: nerdctl does not say how much it freed; the difference does.
func (s volumes) Prune(ctx context.Context) (int64, error) {
	before := s.total(ctx)
	err := s.r.do(ctx, "volume", "volume", "prune", "-f", "--all")
	return max(before-s.total(ctx), 0), err
}

func (s volumes) Sizes(ctx context.Context) (map[string]int64, error) {
	b, err := s.r.out(ctx, "volume", "ls", "--size", "--format", "{{json .}}")
	if err != nil {
		return nil, err
	}
	sizes := map[string]int64{}
	for _, v := range lines[struct{ Name, Size string }](b) {
		sizes[v.Name] = size(v.Size)
	}
	return sizes, nil
}

// helperImage picks the image a helper container is made from: a small
// one with a shell and tar, of those that are here.
func (s volumes) helperImage(ctx context.Context) (string, error) {
	ims, err := images{s.r}.List(ctx)
	if err != nil {
		return "", err
	}
	best, bestSize := "", int64(-1)
	for _, im := range ims {
		for _, tag := range im.Tags {
			sz := im.Size
			if strings.Contains(tag, "busybox") || strings.Contains(tag, "alpine") {
				sz = 0
			}
			if bestSize < 0 || sz < bestSize {
				best, bestSize = tag, sz
			}
		}
	}
	if best == "" {
		return "", errors.New("looking inside a volume needs one image on this engine, any image; pull one (busybox is the smallest) and try again")
	}
	return best, nil
}

// helper is the start of a command that runs once in a container with
// the volume attached.
func (s volumes) helper(ctx context.Context, name, mode string, flags ...string) ([]string, error) {
	img, err := s.helperImage(ctx)
	if err != nil {
		return nil, err
	}
	args := append([]string{"run", "--rm", "--pull", "never", "--network", "none"}, flags...)
	return append(args, "-v", name+":"+mount+mode, "--entrypoint", "", img), nil
}

func (s volumes) Files(ctx context.Context, name, p string) ([]engine.FileEntry, error) {
	args, err := s.helper(ctx, name, ":ro")
	if err != nil {
		return nil, err
	}
	b, err := s.r.out(ctx, append(args, "/bin/sh", "-c", docker.ListScript, "sh", path.Join(mount, path.Clean("/"+p)))...)
	if err != nil {
		return nil, err
	}
	entries, ok := docker.ParseListing(string(b))
	if !ok {
		return nil, errors.New("the folder's listing could not be read")
	}
	return entries, nil
}

func (s volumes) Archive(ctx context.Context, name, p string) (io.ReadCloser, error) {
	args, err := s.helper(ctx, name, ":ro")
	if err != nil {
		return nil, err
	}
	dir, base := path.Split(path.Join(mount, path.Clean("/"+p)))
	return s.r.reading(ctx, append(args, "tar", "-cf", "-", "-C", dir, base)...)
}

// Restore unpacks at the top of the helper: the archive's first name is
// the mount point itself.
func (s volumes) Restore(ctx context.Context, name string, tar io.Reader) error {
	if err := s.Create(ctx, name); err != nil {
		return err
	}
	args, err := s.helper(ctx, name, "", "-i")
	if err != nil {
		return err
	}
	return s.r.writing(ctx, tar, append(args, "tar", "-xf", "-", "-C", "/")...)
}
