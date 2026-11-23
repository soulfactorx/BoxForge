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
	"time"

	"github.com/soulfactorx/boxforge/internal/clirunner"
	"github.com/soulfactorx/boxforge/internal/engines"
)

// WSLDisk is one distribution's virtual disk.
type WSLDisk struct {
	Distro string `json:"distro"`
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"` // what it takes on the drive
	Sparse bool   `json:"sparse"`
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
		if _, err := os.Stat(p); err != nil {
			continue
		}
		size, sparse := onDisk(p)
		out = append(out, WSLDisk{Distro: d, Path: p, Bytes: size, Sparse: sparse, Own: d == Distro})
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

// Compacted is what shrinking a disk did. Sizes are what the file takes
// on the drive: for a sparse file (WSL's "auto shrink", which Kiri may set)
// that is less than its length, and it is what gives space back.
type Compacted struct {
	Before  int64  `json:"before"`
	After   int64  `json:"after"`
	Sparse  bool   `json:"sparse"` // the file is sparse: diskpart can't compact it, fstrim did the work
	Trim    string `json:"trim"`   // what fstrim said
	Trimmed bool   `json:"trimmed"`
	Log     string `json:"log"` // what diskpart said
}

// CompactDisk shrinks a distribution's disk, telling say each step. It
// stops WSL (every distribution, and the containers in them).
func CompactDisk(ctx context.Context, distro string, say func(string)) (Compacted, error) {
	var res Compacted
	var disk *WSLDisk
	for _, d := range WSLDisks() {
		if d.Distro == distro {
			d := d
			disk = &d
		}
	}
	if disk == nil {
		return res, fmt.Errorf("no virtual disk was found for %q", distro)
	}
	res.Before, res.Sparse = onDisk(disk.Path)
	res.After = res.Before

	// Without this, Windows can't tell which blocks ext4 freed: compacting
	// then gives back nothing.
	say("안에서 지운 파일의 자리를 비우는 중 (fstrim)")
	out, err := wsl(ctx, "-d", distro, "-u", "root", "--", "fstrim", "-av")
	if err != nil {
		// A distribution without fstrim of its own may have busybox's.
		if o2, err2 := wsl(ctx, "-d", distro, "-u", "root", "--", "busybox", "fstrim", "-v", "/"); err2 == nil {
			out, err = o2, nil
		}
	}
	res.Trim, res.Trimmed = strings.TrimSpace(out), err == nil
	if err != nil {
		res.Trim = err.Error()
		say(fmt.Sprintf("fstrim을 하지 못했습니다(%s). 압축은 계속합니다", err))
	}

	say("WSL을 멈추는 중 (wsl --shutdown)")
	if _, err := wsl(ctx, "--shutdown"); err != nil {
		return res, err
	}
	// Its disk is free only once the distribution has stopped: what starts
	// it again (its own app) is waited out for a while.
	for i := 0; i < 15; i++ {
		running, _ := wsl(ctx, "-l", "--running", "-q")
		if !hasLine(running, distro) {
			break
		}
		if i == 14 {
			return res, fmt.Errorf("%s 배포판이 자꾸 다시 켜져서 디스크를 압축할 수 없습니다. 그 배포판을 쓰는 프로그램(Kiri 등)을 완전히 끄고 다시 해 보세요", distro)
		}
		time.Sleep(2 * time.Second)
		_, _ = wsl(ctx, "--terminate", distro)
	}

	if res.Sparse {
		// A sparse disk gives back what fstrim freed by itself, and
		// diskpart refuses to compact one.
		say("자동 줄이기(sparse)가 켜진 디스크라 fstrim으로 이미 돌려주었습니다")
	} else {
		dir, err := os.MkdirTemp("", "boxforge-compact-")
		if err != nil {
			return res, err
		}
		defer os.RemoveAll(dir)
		log := filepath.Join(dir, "compact.log")
		say("가상 디스크를 압축하는 중 (diskpart: 관리자 권한을 묻는 창이 뜹니다)")
		err = diskpart(ctx, dir, diskpartScript(disk.Path), log)
		said, _ := os.ReadFile(log)
		res.Log = strings.TrimSpace(strings.TrimPrefix(string(said), "\uFEFF"))
		if err != nil {
			if res.Log == "" {
				return res, errors.New("관리자 권한을 허락하지 않았거나 diskpart가 실행되지 않아 압축하지 않았습니다")
			}
			return res, fmt.Errorf("diskpart가 압축하지 못했습니다:\n%s", res.Log)
		}
	}
	res.After, _ = onDisk(disk.Path)
	return res, nil
}

// hasLine reports whether one line of wsl's output is name.
func hasLine(out, name string) bool {
	for _, l := range strings.Split(out, "\n") {
		if strings.TrimSpace(l) == name {
			return true
		}
	}
	return false
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
