package app

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/soulfactorx/boxforge/internal/clirunner"
)

// ComposeLine is the payload of a "compose" event: one line of a running
// compose command's output, tagged with the key the page gave the command.
type ComposeLine struct {
	Key  string `json:"key"`
	Line string `json:"line"`
}

// ComposeVersion returns the installed Compose's version, or an error when
// the docker command or its compose plugin is not on this PC.
func (a *App) ComposeVersion() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	name, args, env := a.docker("compose", "version", "--short")
	v, err := clirunner.Output(ctx, env, name, args...)
	if err != nil {
		return "", fmt.Errorf("the docker compose command was not found on this PC")
	}
	return v, nil
}

// ComposeRequest names a project and what to do with it.
type ComposeRequest struct {
	Key     string   `json:"key"`     // tags the output events
	Project string   `json:"project"` // "" to let Compose name it from the file
	WorkDir string   `json:"workDir"`
	Files   []string `json:"files"` // compose files; may be empty for a known project
	Action  string   `json:"action"`
}

// What each action runs after `docker compose -p <project>`.
var composeActions = map[string][]string{
	"up":      {"up", "-d", "--remove-orphans"},
	"down":    {"down"},
	"stop":    {"stop"},
	"start":   {"start"},
	"restart": {"restart"},
	"pull":    {"pull"},
}

// Actions that read the compose file; the others work from the project's
// name alone.
var composeNeedsFile = map[string]bool{"up": true, "pull": true}

// ComposeAction runs one compose command, sending its output as "compose"
// events, and returns when it has ended.
func (a *App) ComposeAction(req ComposeRequest) error {
	tail, ok := composeActions[req.Action]
	if !ok {
		return fmt.Errorf("unknown compose action %q", req.Action)
	}
	args := []string{"compose", "--ansi", "never", "--progress", "plain"}
	if req.Project == "" && len(req.Files) == 0 {
		return fmt.Errorf("name a project or a compose file")
	}
	if req.Project != "" {
		args = append(args, "-p", req.Project)
	}
	// A project started somewhere this PC can't see (inside WSL, on another
	// machine) names files that aren't here; name-only actions still work.
	found := 0
	for _, f := range req.Files {
		if _, err := os.Stat(f); err == nil {
			args = append(args, "-f", a.hostPath(f))
			found++
		}
	}
	if composeNeedsFile[req.Action] && found == 0 {
		return fmt.Errorf("the project's compose file can't be found on this PC, so it can't be brought up or pulled from here")
	}
	dir := req.WorkDir
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		dir = ""
	}
	name, full, env := a.docker(append(args, tail...)...)
	if name != "docker" {
		// Run inside WSL: this PC's folder means nothing there, and the
		// files were named in full.
		dir = ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	return clirunner.Run(ctx, dir, env, name, full, func(line string) {
		a.emit("compose", ComposeLine{Key: req.Key, Line: line})
	})
}

// The largest compose file ComposeFile will read.
const composeFileLimit = 1 << 20

// ComposeFile returns a compose file's text.
func (a *App) ComposeFile(file string) (string, error) {
	switch strings.ToLower(filepath.Ext(file)) {
	case ".yml", ".yaml":
	default:
		return "", fmt.Errorf("%s is not a .yml or .yaml file", filepath.Base(file))
	}
	st, err := os.Stat(file)
	if err != nil {
		return "", err
	}
	if st.Size() > composeFileLimit {
		return "", fmt.Errorf("%s is too large to show", filepath.Base(file))
	}
	b, err := os.ReadFile(file)
	return string(b), err
}

// picker asks the user to choose a compose file; the desktop shell sets it.
var picker func() (string, error)

// SetFilePicker gives the app the shell's file dialog.
func SetFilePicker(f func() (string, error)) { picker = f }

// PickComposeFile opens a file dialog and returns the chosen path, "" when
// the user cancelled.
func (a *App) PickComposeFile() (string, error) {
	if picker == nil {
		return "", fmt.Errorf("no file dialog here: type the path")
	}
	return picker()
}
