package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/soulfactorx/boxforge/internal/clirunner"
)

// BuildLine is the payload of a "build" event: one line of a running
// build's output, tagged with the key the page gave it.
type BuildLine struct {
	Key  string `json:"key"`
	Line string `json:"line"`
}

// BuildRequest is what `docker build` takes.
type BuildRequest struct {
	Key        string   `json:"key"`
	Context    string   `json:"context"`    // the folder whose files the build may use
	Dockerfile string   `json:"dockerfile"` // "" for Dockerfile in the context
	Tag        string   `json:"tag"`
	Args       []string `json:"args"`    // KEY=value build arguments
	NoCache    bool     `json:"noCache"` // run every step again
	Pull       bool     `json:"pull"`    // check for a newer base image
}

// DockerCLI returns the docker command's version, or an error when it is
// not on this PC. Building goes through it.
func (a *App) DockerCLI() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	name, args, env := a.docker("version", "--format", "{{.Client.Version}}")
	v, err := clirunner.Output(ctx, env, name, args...)
	if err != nil && v == "" {
		return "", fmt.Errorf("the docker command was not found on this PC")
	}
	return v, nil
}

// dockerfilePath is where the request's Dockerfile is.
func dockerfilePath(contextDir, dockerfile string) string {
	if dockerfile == "" {
		return filepath.Join(contextDir, "Dockerfile")
	}
	if filepath.IsAbs(dockerfile) {
		return dockerfile
	}
	return filepath.Join(contextDir, dockerfile)
}

// Build builds an image, sending the build's output as "build" events, and
// returns when it has ended.
func (a *App) Build(req BuildRequest) error {
	req.Context = strings.TrimSpace(req.Context)
	req.Tag = strings.TrimSpace(req.Tag)
	req.Dockerfile = strings.TrimSpace(req.Dockerfile)
	if st, err := os.Stat(req.Context); err != nil || !st.IsDir() {
		return fmt.Errorf("%s is not a folder on this PC", req.Context)
	}
	file := dockerfilePath(req.Context, req.Dockerfile)
	if _, err := os.Stat(file); err != nil {
		return fmt.Errorf("there is no Dockerfile at %s", file)
	}
	args := []string{"build", "--progress", "plain"}
	if req.Tag != "" {
		args = append(args, "-t", req.Tag)
	}
	if req.Dockerfile != "" {
		args = append(args, "-f", a.hostPath(file))
	}
	for _, kv := range req.Args {
		args = append(args, "--build-arg", kv)
	}
	if req.NoCache {
		args = append(args, "--no-cache")
	}
	if req.Pull {
		args = append(args, "--pull")
	}
	args = append(args, a.hostPath(req.Context))
	name, full, env := a.docker(args...)
	ctx, cancel := context.WithCancel(context.Background())
	a.mu.Lock()
	a.builds[req.Key] = cancel
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.builds, req.Key)
		a.mu.Unlock()
		cancel()
	}()
	err := clirunner.Run(ctx, "", env, name, full, func(line string) {
		a.emit("build", BuildLine{Key: req.Key, Line: line})
	})
	if ctx.Err() != nil {
		return fmt.Errorf("the build was cancelled")
	}
	return err
}

// CancelBuild stops a running build.
func (a *App) CancelBuild(key string) {
	a.mu.Lock()
	cancel := a.builds[key]
	a.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// PruneBuildCache deletes the build cache and returns the tool's summary line.
func (a *App) PruneBuildCache() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	last := ""
	prune := func() error {
		name, full, env := a.docker("builder", "prune", "-f")
		return clirunner.Run(ctx, "", env, name, full, func(line string) { last = line })
	}
	err := prune()
	if err != nil && strings.Contains(err.Error(), "driver not running") {
		// The builder is a container that some engines (Kiri's) stop while
		// nothing builds; its cache can't be reached until it is started.
		name, full, env := a.docker("buildx", "inspect", "--bootstrap")
		if clirunner.Run(ctx, "", env, name, full, nil) == nil {
			err = prune()
		}
	}
	return last, err
}

// The largest Dockerfile the editor will open.
const dockerfileLimit = 1 << 20

// Dockerfile returns the text of a build's Dockerfile.
func (a *App) Dockerfile(contextDir, dockerfile string) (string, error) {
	file := dockerfilePath(strings.TrimSpace(contextDir), strings.TrimSpace(dockerfile))
	st, err := os.Stat(file)
	if err != nil {
		return "", fmt.Errorf("there is no Dockerfile at %s", file)
	}
	if st.IsDir() || st.Size() > dockerfileLimit {
		return "", fmt.Errorf("%s can't be opened as a Dockerfile", file)
	}
	b, err := os.ReadFile(file)
	return string(b), err
}

// SaveDockerfile writes the Dockerfile's text back, keeping the file's
// permissions; it creates the file when the folder has none yet.
func (a *App) SaveDockerfile(contextDir, dockerfile, text string) error {
	contextDir = strings.TrimSpace(contextDir)
	if st, err := os.Stat(contextDir); err != nil || !st.IsDir() {
		return fmt.Errorf("%s is not a folder on this PC", contextDir)
	}
	file := dockerfilePath(contextDir, strings.TrimSpace(dockerfile))
	mode := os.FileMode(0o644)
	if st, err := os.Stat(file); err == nil {
		if st.IsDir() {
			return fmt.Errorf("%s is a folder", file)
		}
		mode = st.Mode().Perm()
	}
	// Written beside the file and moved over it, so a failure midway
	// leaves the old text.
	tmp := file + ".boxforge-tmp"
	if err := os.WriteFile(tmp, []byte(text), mode); err != nil {
		return err
	}
	if err := os.Rename(tmp, file); err != nil {
		os.Remove(tmp)
		return err
	}
	return nil
}

// folderPicker asks the user to choose a folder; the desktop shell sets it.
var folderPicker func() (string, error)

// SetFolderPicker gives the app the shell's folder dialog.
func SetFolderPicker(f func() (string, error)) { folderPicker = f }

// PickFolder opens a folder dialog and returns the chosen path, "" when
// the user cancelled.
func (a *App) PickFolder() (string, error) {
	if folderPicker == nil {
		return "", fmt.Errorf("no folder dialog here: type the path")
	}
	return folderPicker()
}
