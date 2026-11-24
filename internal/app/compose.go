package app

import (
	"context"
	"fmt"
	"github.com/soulfactorx/boxforge/internal/engine"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
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
	// Services narrows start, stop, restart and up to these; empty for all.
	Services []string `json:"services"`
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
	req.Files = localFiles(req.Files)
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
	for _, s := range req.Services {
		if !kubeName.MatchString(strings.ToLower(s)) && !composeService.MatchString(s) {
			return fmt.Errorf("%q is not a service name", s)
		}
	}
	if req.Action != "down" && req.Action != "pull" {
		tail = append(append([]string{}, tail...), req.Services...)
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

var composeService = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]*$`)

// composeArgs starts a compose command line for a project: its name, and
// those of its files that this PC can see.
func (a *App) composeArgs(project string, files []string) []string {
	args := []string{"compose", "--ansi", "never"}
	if project != "" {
		args = append(args, "-p", project)
	}
	for _, f := range localFiles(files) {
		if _, err := os.Stat(f); err == nil {
			args = append(args, "-f", a.hostPath(f))
		}
	}
	return args
}

// ComposeConfig returns the project as Compose reads its files, in JSON:
// every service with its image, ports, volumes and what it depends on.
func (a *App) ComposeConfig(project string, files []string) (string, error) {
	args := a.composeArgs(project, files)
	if len(args) < 5 {
		return "", fmt.Errorf("the project's compose file can't be found on this PC")
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	name, full, env := a.docker(append(args, "config", "--format", "json")...)
	return clirunner.Output(ctx, env, name, full...)
}

// ComposeLogs returns the last lines of every service of a project, each
// with its service's name and its time.
func (a *App) ComposeLogs(project string, tail int) (string, error) {
	if project == "" {
		return "", fmt.Errorf("name a project")
	}
	if tail <= 0 || tail > 5000 {
		tail = 300
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	name, full, env := a.docker("compose", "--ansi", "never", "-p", project, "logs", "--no-color", "--timestamps", "--tail", fmt.Sprint(tail))
	return clirunner.Output(ctx, env, name, full...)
}

// writeBeside writes text to file through a temporary beside it, keeping
// the file's permissions: a failure midway leaves the old text.
func writeBeside(file, text string) error {
	mode := os.FileMode(0o644)
	if st, err := os.Stat(file); err == nil {
		mode = st.Mode().Perm()
	}
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

func isYAML(file string) bool {
	switch strings.ToLower(filepath.Ext(file)) {
	case ".yml", ".yaml":
		return true
	}
	return false
}

// ComposeSave writes a compose file's text back.
func (a *App) ComposeSave(file, text string) error {
	file = localFile(file)
	if !isYAML(file) {
		return fmt.Errorf("%s is not a .yml or .yaml file", filepath.Base(file))
	}
	if _, err := os.Stat(file); err != nil {
		return err
	}
	return writeBeside(file, text)
}

// ComposeCreate starts a new project: it makes the folder if need be and
// writes compose.yaml in it. A folder that has a compose file already is
// refused: that one is opened, not written over. It returns the file.
func (a *App) ComposeCreate(dir, text string) (string, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return "", fmt.Errorf("name the folder for the project")
	}
	if !filepath.IsAbs(dir) {
		return "", fmt.Errorf("write the folder's whole path (one that begins at the top, like /home/me/shop or C:\\projects\\shop)")
	}
	if strings.TrimSpace(text) == "" {
		return "", fmt.Errorf("the compose file is empty")
	}
	for _, name := range []string{"compose.yaml", "compose.yml", "docker-compose.yml", "docker-compose.yaml"} {
		if _, err := os.Stat(filepath.Join(dir, name)); err == nil {
			return "", fmt.Errorf("this folder has a compose file already (%s): open that one instead", name)
		}
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	file := filepath.Join(dir, "compose.yaml")
	if err := os.WriteFile(file, []byte(text), 0o644); err != nil {
		return "", err
	}
	return file, nil
}

// Change is what bringing a project up would do to one of its parts.
type Change struct {
	Kind   string `json:"kind"` // Container, Network, Volume
	Name   string `json:"name"`
	Action string `json:"action"` // keep, create, recreate, start, remove
}

// What Compose's dry run says about an object, and what that comes to.
var dryActions = map[string]string{
	"Running": "keep", "Recreate": "recreate", "Recreated": "recreate",
	"Creating": "create", "Created": "create", "Starting": "start", "Started": "start",
	"Removing": "remove", "Removed": "remove",
}

// How much an action outranks another said of the same object: a
// container recreated is also started, and that is not the news.
var dryRank = map[string]int{"keep": 1, "start": 2, "create": 3, "remove": 4, "recreate": 5}

// parseDryRun reads the lines of `docker compose --dry-run up`.
func parseDryRun(lines []string) []Change {
	var out []Change
	at := map[string]int{}
	for _, line := range lines {
		f := strings.Fields(strings.TrimPrefix(strings.TrimSpace(line), "DRY-RUN MODE -"))
		if len(f) != 3 {
			continue
		}
		action, ok := dryActions[f[2]]
		if !ok || (f[0] != "Container" && f[0] != "Network" && f[0] != "Volume") {
			continue
		}
		key := f[0] + "/" + f[1]
		if i, seen := at[key]; seen {
			if dryRank[action] > dryRank[out[i].Action] {
				out[i].Action = action
			}
			continue
		}
		at[key] = len(out)
		out = append(out, Change{Kind: f[0], Name: f[1], Action: action})
	}
	return out
}

// ComposePreview says what bringing the project up would do if one of its
// files held text instead of what is saved: which containers stay, which
// are made anew, which go. Nothing is changed.
func (a *App) ComposePreview(project string, files []string, file, text string) ([]Change, error) {
	file, files = localFile(file), localFiles(files)
	if !isYAML(file) {
		return nil, fmt.Errorf("%s is not a .yml or .yaml file", filepath.Base(file))
	}
	// The trial copy sits beside the real file, so that paths in it that
	// are relative to the file mean the same.
	trial := filepath.Join(filepath.Dir(file), ".boxforge-preview-"+filepath.Base(file))
	if err := os.WriteFile(trial, []byte(text), 0o600); err != nil {
		return nil, err
	}
	defer os.Remove(trial)
	args := []string{"compose", "--dry-run", "--ansi", "never", "--progress", "plain"}
	if project != "" {
		args = append(args, "-p", project)
	}
	for _, f := range files {
		if f == file {
			f = trial
		} else if _, err := os.Stat(f); err != nil {
			continue
		}
		args = append(args, "-f", a.hostPath(f))
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	name, full, env := a.docker(append(args, "up", "-d", "--remove-orphans")...)
	var lines []string
	err := clirunner.Run(ctx, "", env, name, full, func(line string) { lines = append(lines, line) })
	if err != nil {
		// The trial file's name means nothing to the user.
		return nil, fmt.Errorf("%s", strings.ReplaceAll(err.Error(), trial, filepath.Base(file)))
	}
	changes := parseDryRun(lines)
	if changes == nil {
		changes = []Change{}
	}
	return changes, nil
}

// The largest compose file ComposeFile will read.
const composeFileLimit = 1 << 20

// ComposeFile returns a compose file's text.
func (a *App) ComposeFile(file string) (string, error) {
	file = localFile(file)
	if !isYAML(file) {
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

// localFile is a compose file's path as this PC sees it. Compose run on
// Windows names its files C:\…; a project taken to Linux in a BoxForge
// bundle has them put back under /mnt/c/… (where WSL sees that drive, and
// so where the engine looked for them), and they are found there.
func localFile(f string) string {
	if runtime.GOOS == "windows" {
		return f
	}
	return localFileIn("", f)
}

// localFileIn is localFile with the machine's root at root (for tests).
func localFileIn(root, f string) string {
	if _, err := os.Stat(root + f); err == nil {
		return f
	}
	if p := enginePath(f); p != f {
		if _, err := os.Stat(root + p); err == nil {
			return p
		}
	}
	return f
}

func localFiles(files []string) []string {
	out := make([]string, len(files))
	for i, f := range files {
		out[i] = localFile(f)
	}
	return out
}

// ComposeNotMine is, for a compose file this user can't write (put back by
// an import, which the engine did as root), the project folder that could
// be given to them; "" when there is nothing to do (or it can't be done
// from here: Windows, or BoxForge running as root).
func (a *App) ComposeNotMine(file string) string {
	file = localFile(file)
	if runtime.GOOS == "windows" || os.Getuid() <= 0 || !isYAML(file) {
		return ""
	}
	dir := filepath.Dir(file)
	if _, err := os.Stat(file); err != nil {
		return ""
	}
	if writable(dir) && writable(file) {
		return ""
	}
	return dir
}

// ComposeMakeMine gives a compose file's project folder, and all in it, to
// the user running BoxForge. It is done by the engine (as root), so only
// for an engine on this PC: the folder must be the one it sees.
func (a *App) ComposeMakeMine(file string) error {
	dir := a.ComposeNotMine(file)
	if dir == "" {
		return nil
	}
	o, ok := a.eng().Volumes().(engine.HostOwner)
	if !ok {
		return fmt.Errorf("이 엔진으로는 바꿀 수 없습니다. 터미널에서: sudo chown -R %d:%d %s", os.Getuid(), os.Getgid(), dir)
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	if err := o.Chown(ctx, dir, os.Getuid(), os.Getgid()); err != nil {
		return err
	}
	if !writable(dir) {
		return fmt.Errorf("엔진이 다른 컴퓨터에 있어 이 PC의 폴더를 바꾸지 못했습니다. 터미널에서: sudo chown -R %d:%d %s", os.Getuid(), os.Getgid(), dir)
	}
	return nil
}
