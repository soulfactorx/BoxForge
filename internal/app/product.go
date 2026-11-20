package app

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/soulfactorx/boxforge/internal/clirunner"
	"github.com/soulfactorx/boxforge/internal/engine"
	"github.com/soulfactorx/boxforge/internal/update"
	"github.com/soulfactorx/boxforge/internal/version"
)

// Version returns the app's version: "dev" for a build made by hand.
func (a *App) Version() string { return version.Version }

// UpdateInfo is what a check for updates found.
type UpdateInfo struct {
	Current   string `json:"current"`
	Latest    string `json:"latest"`
	Available bool   `json:"available"` // a newer release with a program for this PC
	Installed bool   `json:"installed"` // already put in place: a restart runs it
	Notes     string `json:"notes"`
	Page      string `json:"page"`
}

var (
	updateMu  sync.Mutex
	installed string // the version an update put in place this run
)

// CheckUpdate asks whether a newer version has been released.
func (a *App) CheckUpdate() (UpdateInfo, error) {
	info := UpdateInfo{Current: version.Version}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	rel, err := update.Latest(ctx)
	if err != nil {
		return info, err
	}
	info.Latest, info.Notes, info.Page = rel.Version, rel.Notes, rel.Page
	info.Available = rel.HasProgram() && update.Newer(version.Version, rel.Version)
	updateMu.Lock()
	info.Installed = installed == rel.Version
	updateMu.Unlock()
	return info, nil
}

// UpdateProgress is the payload of an "update" event.
type UpdateProgress struct {
	Done  int64 `json:"done"`
	Total int64 `json:"total"`
}

// ApplyUpdate downloads the newest release and puts it in place of the
// program running; Restart then runs it.
func (a *App) ApplyUpdate() error {
	updateMu.Lock()
	defer updateMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	rel, err := update.Latest(ctx)
	if err != nil {
		return err
	}
	if installed == rel.Version {
		return nil
	}
	if !update.Newer(version.Version, rel.Version) {
		return fmt.Errorf("this is already the newest version")
	}
	if err := update.Apply(ctx, rel, func(done, total int64) {
		a.emit("update", UpdateProgress{Done: done, Total: total})
	}); err != nil {
		return err
	}
	installed = rel.Version
	return nil
}

// quit closes the app; the desktop shell sets it.
var quit func()

// SetQuit gives the app the shell's way to close itself.
func SetQuit(f func()) { quit = f }

// Restart starts the program afresh (the new one, after an update) and
// closes this one.
func (a *App) Restart() error {
	exe, err := update.Program()
	if err != nil {
		return err
	}
	cmd := exec.Command(exe)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	if quit != nil {
		quit()
	}
	return nil
}

// ---- registries

// RegistryLogin signs in to an image registry ("" for Docker Hub) with the
// docker command, which keeps the sign-in where it keeps all of them. The
// password goes to it on its input, never on a command line.
func (a *App) RegistryLogin(server, user, password string) error {
	server, user = strings.TrimSpace(server), strings.TrimSpace(user)
	if user == "" || password == "" {
		return fmt.Errorf("the user name and the password are both needed")
	}
	args := []string{"login", "--username", user, "--password-stdin"}
	if server != "" {
		args = append(args, server)
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	name, full, env := a.docker(args...)
	_, err := clirunner.OutputIn(ctx, env, []byte(password), name, full...)
	return err
}

// RegistryLogout forgets the sign-in to a registry.
func (a *App) RegistryLogout(server string) error {
	args := []string{"logout"}
	if s := strings.TrimSpace(server); s != "" {
		args = append(args, s)
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	name, full, env := a.docker(args...)
	_, err := clirunner.Output(ctx, env, name, full...)
	return err
}

// Registries lists the registries the docker command on this PC is signed
// in to. (Sign-ins kept inside a WSL distribution are not listed.)
func (a *App) Registries() []string {
	out := []string{}
	dir := os.Getenv("DOCKER_CONFIG")
	if dir == "" {
		home, _ := os.UserHomeDir()
		dir = filepath.Join(home, ".docker")
	}
	b, err := os.ReadFile(filepath.Join(dir, "config.json"))
	if err != nil {
		return out
	}
	var cfg struct {
		Auths map[string]json.RawMessage `json:"auths"`
	}
	if json.Unmarshal(b, &cfg) == nil {
		for server := range cfg.Auths {
			out = append(out, server)
		}
	}
	return out
}

// needsLogin reports whether a pull failed for want of a sign-in.
func needsLogin(err error) bool {
	msg := strings.ToLower(err.Error())
	for _, sign := range []string{"unauthorized", "authentication required", "denied", "no basic auth credentials", "access forbidden"} {
		if strings.Contains(msg, sign) {
			return true
		}
	}
	return false
}

// pullWithCLI pulls through the docker command, which knows the sign-ins.
func (a *App) pullWithCLI(ctx context.Context, ref string) error {
	name, full, env := a.docker("pull", ref)
	return clirunner.Run(ctx, "", env, name, full, func(line string) {
		a.emit("pull", PullState{Ref: ref, Status: line, Percent: -1})
	})
}

// ---- what an image expects, and disk space

// ImageDefaults returns the ports and data folders an image declares, for
// filling in the run form.
func (a *App) ImageDefaults(ref string) (engine.ImageDefaults, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	return a.eng().Images().Defaults(ctx, strings.TrimSpace(ref))
}

// DiskUsage measures what images, containers, volumes and the build cache
// take, and how much of each could be freed.
func (a *App) DiskUsage() (engine.Usage, error) {
	ctx, cancel := context.WithTimeout(context.Background(), sizeTimeout)
	defer cancel()
	return a.eng().Usage(ctx)
}

// PruneContainers deletes every stopped container and returns the bytes freed.
func (a *App) PruneContainers() (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	return a.eng().Containers().Prune(ctx)
}

// certPicker asks the user to choose a certificate file; the desktop shell sets it.
var certPicker func() (string, error)

// SetCertPicker gives the app the shell's file dialog for certificates.
func SetCertPicker(f func() (string, error)) { certPicker = f }

// PickCertificate opens a file dialog and returns the chosen path, "" when
// the user cancelled.
func (a *App) PickCertificate() (string, error) {
	if certPicker == nil {
		return "", fmt.Errorf("no file dialog here: type the path")
	}
	return certPicker()
}
