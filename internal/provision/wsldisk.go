package provision

// Shrinking WSL's virtual disks. A distribution's ext4.vhdx grows as files
// are written and never shrinks by itself: what is deleted inside stays
// taken on Windows. Shrinking one is three steps: tell the disk inside which
// blocks are free (fstrim), stop WSL so the file isn't in use, and have
// Windows compact the file (diskpart, which needs administrator rights:
// Windows asks the user).

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/soulfactorx/boxforge/internal/clirunner"
	"github.com/soulfactorx/boxforge/internal/engines"
)

// WSLDisk is one distribution's virtual disk.
type WSLDisk struct {
	Distro string `json:"distro"`
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	Own    bool   `json:"own"` // BoxForge's distribution
}

// WSLDisks lists the WSL distributions and their disks, largest first.
func WSLDisks() []WSLDisk {
	paths := vhdPaths()
	var out []WSLDisk
	for _, d := range engines.Distros() {
		p := paths[d]
		if p == "" && d == Distro {
			p = vhdx()
		}
		if p == "" {
			continue
		}
		st, err := os.Stat(p)
		if err != nil {
			continue
		}
		out = append(out, WSLDisk{Distro: d, Path: p, Bytes: st.Size(), Own: d == Distro})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Bytes > out[j].Bytes })
	return out
}

// vhdPaths is each distribution's disk file, by name: from the registry
// on Windows; BOXFORGE_WSL_DISKS ("name=path;name=path") stands in for it
// in tests.
func vhdPaths() map[string]string {
	if s := os.Getenv("BOXFORGE_WSL_DISKS"); s != "" {
		out := map[string]string{}
		for _, e := range strings.Split(s, ";") {
			if n, p, ok := strings.Cut(e, "="); ok {
				out[n] = p
			}
		}
		return out
	}
	return registryDisks()
}

// diskpartScript compacts one virtual disk, attached read-only.
func diskpartScript(path string) string {
	return strings.Join([]string{
		`select vdisk file="` + path + `"`,
		"attach vdisk readonly",
		"compact vdisk",
		"detach vdisk",
		"exit",
	}, "\r\n") + "\r\n"
}

// CompactDisk shrinks a distribution's disk, telling say each step. It
// stops WSL (every distribution, and the containers in them).
func CompactDisk(ctx context.Context, distro string, say func(string)) (before, after int64, err error) {
	var disk *WSLDisk
	for _, d := range WSLDisks() {
		if d.Distro == distro {
			d := d
			disk = &d
		}
	}
	if disk == nil {
		return 0, 0, fmt.Errorf("no virtual disk was found for %q", distro)
	}
	before = disk.Bytes

	say("안에서 지운 파일의 자리를 비우는 중 (fstrim)")
	if _, err := wsl(ctx, "-d", distro, "-u", "root", "--", "fstrim", "-a"); err != nil {
		// Not every distribution has fstrim; compacting still gives back
		// the blocks never written again.
		say(fmt.Sprintf("fstrim을 하지 못했습니다(%s). 압축은 계속합니다", err))
	}
	say("WSL을 멈추는 중 (wsl --shutdown)")
	if _, err := wsl(ctx, "--shutdown"); err != nil {
		return before, before, err
	}

	dir, err := os.MkdirTemp("", "boxforge-compact-")
	if err != nil {
		return before, before, err
	}
	defer os.RemoveAll(dir)
	log := filepath.Join(dir, "compact.log")
	say("가상 디스크를 압축하는 중 (diskpart: 관리자 권한을 묻는 창이 뜹니다)")
	err = diskpart(ctx, dir, diskpartScript(disk.Path), log)
	said, _ := os.ReadFile(log)
	text := strings.TrimSpace(strings.TrimPrefix(string(said), "\uFEFF"))
	if err != nil {
		if text == "" {
			return before, before, errors.New("관리자 권한을 허락하지 않았거나 diskpart가 실행되지 않아 압축하지 않았습니다")
		}
		return before, before, fmt.Errorf("diskpart가 압축하지 못했습니다:\n%s", text)
	}
	if st, err := os.Stat(disk.Path); err == nil {
		after = st.Size()
	}
	return before, after, nil
}

// diskpart runs a diskpart script as administrator, its output in log
// (UTF-8). It goes through PowerShell, which hands diskpart the script in
// the console's code page: a path with Korean in it (a user folder) reaches
// it intact, as does what diskpart says back. BOXFORGE_DISKPART names a
// stand-in for tests, given the script on its input.
func diskpart(ctx context.Context, dir, script, log string) error {
	if p := os.Getenv("BOXFORGE_DISKPART"); p != "" {
		out, err := os.Create(log)
		if err != nil {
			return err
		}
		defer out.Close()
		cmd := exec.CommandContext(ctx, p)
		cmd.Stdin = strings.NewReader(script)
		cmd.Stdout, cmd.Stderr = out, out
		clirunner.HideWindow(cmd)
		return cmd.Run()
	}
	quote := func(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }
	ps := "$OutputEncoding = [Console]::OutputEncoding\r\n" +
		"$script = " + quote(script) + "\r\n" +
		"$script | diskpart.exe 2>&1 | Out-File -Encoding utf8 -FilePath " + quote(log) + "\r\n" +
		"exit $LASTEXITCODE\r\n"
	file := filepath.Join(dir, "compact.ps1")
	// With a byte order mark: Windows PowerShell reads the file as UTF-8 then.
	if err := os.WriteFile(file, append([]byte("\uFEFF"), ps...), 0o644); err != nil {
		return err
	}
	return elevated(ctx, "powershell.exe", "-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", file)
}
