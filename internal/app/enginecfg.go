package app

import (
	"context"
	"fmt"
	"os"
	"runtime"
	"time"

	"github.com/soulfactorx/boxforge/internal/desktop"
	"github.com/soulfactorx/boxforge/internal/engines"
	"github.com/soulfactorx/boxforge/internal/provision"
)

// EngineResources is what the settings page shows of the WSL machine's
// limits, when the engine in use runs in WSL.
type EngineResources struct {
	Available bool `json:"available"` // the engine in use is in WSL
	Own       bool `json:"own"`       // it is BoxForge's own distribution
	provision.WSLResources
	CPUs int `json:"cpus"` // this PC's processors
}

// EngineResources returns the WSL machine's limits and its disk.
func (a *App) EngineResources() (EngineResources, error) {
	out := EngineResources{CPUs: runtime.NumCPU()}
	if a.wslTarget() == "" {
		return out, nil
	}
	r, err := provision.Resources()
	if err != nil {
		return out, err
	}
	out.Available, out.Own = true, a.wslTarget() == provision.Distro
	out.WSLResources = r
	out.Pending = engines.Setting("wsl.pending") == "on"
	out.Sparse = engines.Setting("wsl.sparse") == "on"
	return out, nil
}

// SetEngineResources writes the WSL machine's limits. With restart, WSL
// is shut down so that they take effect now: every WSL distribution
// stops, and the engine starts again as BoxForge connects.
func (a *App) SetEngineResources(r provision.WSLResources, restart bool) error {
	if a.wslTarget() == "" {
		return fmt.Errorf("the engine in use is not in WSL")
	}
	if r.Processors > runtime.NumCPU() {
		return fmt.Errorf("this PC has %d processors", runtime.NumCPU())
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if restart {
		a.hangUp()
	}
	if err := provision.SetResources(ctx, r, restart); err != nil {
		return err
	}
	pending := "on"
	if restart {
		pending = ""
	}
	return engines.SetSetting("wsl.pending", pending)
}

// SetEngineSparse makes BoxForge's distribution's disk give back the space
// its files free. WSL is shut down for it.
func (a *App) SetEngineSparse(on bool) error {
	if a.wslTarget() != provision.Distro {
		return fmt.Errorf("this is for BoxForge's own engine")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	a.hangUp()
	if err := provision.SetSparse(ctx, on); err != nil {
		return err
	}
	v := ""
	if on {
		v = "on"
	}
	_ = engines.SetSetting("wsl.pending", "")
	return engines.SetSetting("wsl.sparse", v)
}

// StartAtSignIn is the "start BoxForge when I sign in" setting.
type StartAtSignIn struct {
	Supported bool `json:"supported"`
	On        bool `json:"on"`
}

// SignIn returns whether BoxForge starts at sign-in.
func (a *App) SignIn() StartAtSignIn {
	// Only the desktop app: a server is started by the system's services.
	if outbox != "" || os.Getenv("BOXFORGE_ENGINE") == "fake" {
		return StartAtSignIn{}
	}
	return StartAtSignIn{Supported: desktop.AutostartSupported(), On: desktop.Autostart()}
}

// SetSignIn turns starting at sign-in on or off.
func (a *App) SetSignIn(on bool) error {
	if outbox != "" {
		return fmt.Errorf("the web server is started by the system's services, not at sign-in")
	}
	return desktop.SetAutostart(on)
}

// WSLDisks lists the WSL distributions' virtual disks (Windows), BoxForge's
// and others' (Kiri's, Docker's, a Linux one).
func (a *App) WSLDisks() []provision.WSLDisk {
	disks := provision.WSLDisks()
	if disks == nil {
		disks = []provision.WSLDisk{}
	}
	return disks
}

// CompactWSLDisk shrinks a WSL distribution's virtual disk. WSL is stopped
// for it (every distribution and its containers); the engine connects again
// when next used. Each step is sent as a "disk-compact" event.
func (a *App) CompactWSLDisk(distro string) (provision.Compacted, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	if a.wslTarget() != "" {
		a.hangUp()
	}
	return provision.CompactDisk(ctx, distro, func(text string) { a.emit("disk-compact", text) })
}
