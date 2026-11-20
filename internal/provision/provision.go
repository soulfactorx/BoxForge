// Package provision installs a Docker Engine for BoxForge on a PC that has
// none: on Windows, WSL 2, a Linux distribution of BoxForge's own beside
// whatever the user already has, and Docker's official packages inside it.
// Everything it installs is free to use; Docker Desktop is not involved.
//
// Each step first looks whether its work is already done, so a run that
// was interrupted (by a failure, a cancel, the restart WSL asks for) is
// simply started again.
package provision

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
	"unicode/utf16"

	"github.com/soulfactorx/boxforge/internal/clirunner"
	"github.com/soulfactorx/boxforge/internal/engines"
)

// Distro is the name of the WSL distribution BoxForge makes for its engine.
const Distro = "BoxForge"

// EngineID is the engine target that distribution becomes.
const EngineID = "wsl:" + Distro

// Step is one stage of the installation.
type Step struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	State  string `json:"state"` // todo, active, done, error
	Detail string `json:"detail"`
}

// Status is the whole installation as the UI shows it.
type Status struct {
	Supported    bool     `json:"supported"`
	Reason       string   `json:"reason"` // why not, when unsupported
	Installed    bool     `json:"installed"`
	Running      bool     `json:"running"`
	NeedsRestart bool     `json:"needsRestart"` // Windows must restart before the next step
	Error        string   `json:"error"`
	Steps        []Step   `json:"steps"`
	Flavors      []Flavor `json:"flavors"`
	Done         int64    `json:"done"`  // bytes downloaded so far
	Total        int64    `json:"total"` // bytes to download; 0 while unknown
	Log          []string `json:"log"`
}

// Flavor is a Linux the engine's distribution can be made from.
type Flavor struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Note  string `json:"note"`
}

// The choices that are always there. "custom" takes a root filesystem the
// user names: a file on this PC or a URL.
var (
	alpineFlavor = Flavor{ID: "alpine", Label: "Alpine Linux (최신 안정판)", Note: "아주 작고 빨리 설치됩니다. 약 4MB를 내려받습니다."}
	customFlavor = Flavor{ID: "custom", Label: "직접 지정", Note: "WSL용 루트 파일시스템(.tar, .tar.gz, .wsl)의 경로나 주소를 적습니다. Ubuntu · Debian · Alpine 계열이어야 Docker를 설치할 수 있습니다."}
	// What is offered when Microsoft's list can't be read.
	fallbackUbuntu = Flavor{ID: "ubuntu", Label: "Ubuntu 24.04 LTS", Note: "가장 널리 쓰여 문제가 적습니다. 약 340MB를 내려받습니다."}
)

// The list `wsl --list --online` shows: every distribution made for WSL,
// with where to download each and its checksum.
func distroListURL() string {
	if u := os.Getenv("BOXFORGE_DISTROS_URL"); u != "" {
		return u
	}
	return "https://raw.githubusercontent.com/microsoft/WSL/master/distributions/DistributionInfo.json"
}

// listed is one distribution of that list.
type listed struct {
	Name         string
	FriendlyName string
	Default      bool
	Amd64Url     *struct{ Url, Sha256 string }
	Arm64Url     *struct{ Url, Sha256 string }
}

func (l listed) download() (url, sum string) {
	d := l.Amd64Url
	if runtime.GOARCH == "arm64" {
		d = l.Arm64Url
	}
	if d == nil {
		return "", ""
	}
	return d.Url, strings.ToLower(strings.TrimPrefix(d.Sha256, "0x"))
}

// The families of that list BoxForge knows how to put Docker into: the
// ones Docker publishes packages for and whose install has been written
// here. The others can run Docker too, but would need steps of their own.
var installable = map[string]string{
	"Ubuntu": "Docker 공식 패키지를 설치합니다.",
	"Debian": "Docker 공식 패키지를 설치합니다.",
}

// parseDistros picks the installable distributions out of Microsoft's list.
func parseDistros(raw string) (map[string]listed, []Flavor) {
	var doc struct {
		ModernDistributions map[string][]listed
	}
	if json.Unmarshal([]byte(raw), &doc) != nil {
		return nil, nil
	}
	byID := map[string]listed{}
	var flavors []Flavor
	for _, family := range []string{"Ubuntu", "Debian"} {
		seen := map[string]bool{}
		first := true
		for _, d := range doc.ModernDistributions[family] {
			url, sum := d.download()
			// The same download under two names ("Ubuntu" and its
			// version) is offered once; one with no checksum, not at all.
			if url == "" || len(sum) != 64 || seen[url] || strings.Contains(d.FriendlyName, "20.04") {
				continue
			}
			seen[url] = true
			label := d.FriendlyName
			if label == family { // "Ubuntu": say which one it is
				label = strings.TrimSuffix(url[strings.LastIndex(url, "/")+1:], ".wsl")
			}
			note := installable[family]
			if first && family == "Ubuntu" {
				note = "최신 버전입니다. " + note
			}
			first = false
			id := "ms:" + d.Name
			byID[id] = d
			flavors = append(flavors, Flavor{ID: id, Label: label, Note: note})
		}
	}
	return byID, flavors
}

// flavors returns the choices, reading Microsoft's list the first time.
func (in *Installer) flavors() []Flavor {
	in.listOnce.Do(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if raw, err := fetch(ctx, distroListURL()); err == nil {
			in.listed, in.choices = parseDistros(raw)
		}
		if len(in.choices) == 0 {
			in.choices = []Flavor{fallbackUbuntu}
		}
		in.choices = append(in.choices, alpineFlavor, customFlavor)
	})
	return in.choices
}

// Options says which Linux to install into.
type Options struct {
	Flavor string `json:"flavor"`
	Source string `json:"source"` // for "custom": a file path or an http(s) URL
}

var plan = []Step{
	{ID: "wsl", Title: "WSL 2 준비"},
	{ID: "download", Title: "Linux 내려받기"},
	{ID: "distro", Title: "BoxForge 전용 Linux 만들기"},
	{ID: "docker", Title: "Docker Engine 설치"},
	{ID: "start", Title: "엔진 시작과 확인"},
}

// source is a root filesystem to import.
type source struct {
	url    string // "" when file is already on this PC
	file   string // where it is, or is to be saved
	sha256 string // "" when its publisher gives none to check against
	keep   bool   // the user's own file: not ours to delete
}

// Where Ubuntu's root filesystem comes from: Ubuntu's own image server,
// which publishes the checksums beside it. BOXFORGE_ROOTFS_URL names
// another base for tests.
func ubuntuBase() string {
	if u := os.Getenv("BOXFORGE_ROOTFS_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	return "https://cloud-images.ubuntu.com/wsl/releases/24.04/current"
}

// Alpine's release folder for this PC's kind of processor.
func alpineBase() string {
	if u := os.Getenv("BOXFORGE_ALPINE_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	arch := "x86_64"
	if runtime.GOARCH == "arm64" {
		arch = "aarch64"
	}
	return "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/" + arch
}

// resolve finds what to download for the chosen flavor.
func (in *Installer) resolve(ctx context.Context, o Options, dir string) (source, error) {
	if d, ok := in.listed[o.Flavor]; ok {
		url, sum := d.download()
		name := url[strings.LastIndex(url, "/")+1:]
		return source{url: url, file: filepath.Join(dir, name), sha256: sum}, nil
	}
	switch o.Flavor {
	case "", "ubuntu":
		arch := "amd64"
		if runtime.GOARCH == "arm64" {
			arch = "arm64"
		}
		name := "ubuntu-noble-wsl-" + arch + "-24.04lts.rootfs.tar.gz"
		list, err := fetch(ctx, ubuntuBase()+"/SHA256SUMS")
		if err != nil {
			return source{}, fmt.Errorf("체크섬 목록을 받지 못했습니다: %w", err)
		}
		sum, err := findSum(strings.NewReader(list), name)
		if err != nil {
			return source{}, err
		}
		return source{url: ubuntuBase() + "/" + name, file: filepath.Join(dir, name), sha256: sum}, nil
	case "alpine":
		index, err := fetch(ctx, alpineBase()+"/latest-releases.yaml")
		if err != nil {
			return source{}, fmt.Errorf("Alpine의 배포 목록을 받지 못했습니다: %w", err)
		}
		name, sum, err := alpineRootfs(index)
		if err != nil {
			return source{}, err
		}
		return source{url: alpineBase() + "/" + name, file: filepath.Join(dir, name), sha256: sum}, nil
	case "custom":
		src := strings.TrimSpace(o.Source)
		if src == "" {
			return source{}, errors.New("루트 파일시스템의 경로나 주소를 적어 주세요.")
		}
		if strings.HasPrefix(src, "https://") || strings.HasPrefix(src, "http://") {
			name := src[strings.LastIndex(src, "/")+1:]
			if i := strings.IndexAny(name, "?#"); i >= 0 {
				name = name[:i]
			}
			if name == "" {
				name = "rootfs.tar.gz"
			}
			return source{url: src, file: filepath.Join(dir, name)}, nil
		}
		if st, err := os.Stat(src); err != nil || st.IsDir() {
			return source{}, fmt.Errorf("%s 파일을 찾을 수 없습니다.", src)
		}
		return source{file: src, keep: true}, nil
	}
	return source{}, fmt.Errorf("unknown flavor %q", o.Flavor)
}

// alpineRootfs reads Alpine's latest-releases.yaml and returns the mini
// root filesystem's file name and SHA-256.
func alpineRootfs(index string) (name, sum string, err error) {
	// The file is a list of blocks, one per download, each starting "-".
	for _, block := range strings.Split("\n"+index, "\n-") {
		if !strings.Contains(block, "flavor: alpine-minirootfs") {
			continue
		}
		for _, line := range strings.Split(block, "\n") {
			k, v, ok := strings.Cut(strings.TrimSpace(line), ":")
			v = strings.Trim(strings.TrimSpace(v), `"'`)
			switch {
			case ok && k == "file":
				name = v
			case ok && k == "sha256":
				sum = strings.ToLower(v)
			}
		}
	}
	if name == "" || len(sum) != 64 {
		return "", "", errors.New("Alpine의 배포 목록에서 루트 파일시스템을 찾지 못했습니다.")
	}
	return name, sum, nil
}

// The script that installs Docker's packages, run as root inside the
// distribution. It looks at which Linux it is in: Docker's own package
// repository for Ubuntu and Debian (the steps of Docker's instructions),
// Alpine's packages for Alpine.
const installScript = `set -e
. /etc/os-release
case "$ID" in
ubuntu|debian)
  export DEBIAN_FRONTEND=noninteractive
  echo "[1/5] 패키지 목록 갱신"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  echo "[2/5] Docker 저장소 등록"
  curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  echo "[3/5] Docker Engine 내려받아 설치"
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  echo "[4/5] 자동 시작 설정"
  if ! grep -q '^systemd *= *true' /etc/wsl.conf 2>/dev/null; then printf '\n[boot]\nsystemd=true\n' >> /etc/wsl.conf; fi
  systemctl enable docker >/dev/null 2>&1 || true
  ;;
alpine)
  echo "[1/5] 패키지 목록 갱신"
  # Docker is in Alpine's community repository, beside main.
  if ! grep -q '/community' /etc/apk/repositories; then sed -n 's#/main$#/community#p' /etc/apk/repositories >> /etc/apk/repositories; fi
  apk update -q
  echo "[2/5] Alpine 저장소 사용"
  echo "[3/5] Docker Engine 내려받아 설치"
  apk add --no-cache docker docker-cli-compose docker-cli-buildx
  echo "[4/5] 자동 시작 설정"
  ;;
*)
  echo "이 배포판($ID)에는 Docker를 자동으로 설치하지 못합니다. Ubuntu, Debian, Alpine 계열을 지원합니다." >&2
  exit 4
  ;;
esac
echo "[5/5] 설치 완료"
`

// The script that starts the engine, run as root inside the distribution
// each time the installer reaches its last step (so a fix to it reaches
// an installation made by an earlier version). With systemd it asks
// systemd. Without (Alpine) it puts a starter where WSL's boot command
// finds it, runs it, and waits for the engine's socket; when the engine
// does not come up it prints the end of the engine's own log, which says why.
const startScript = `mkdir -p /usr/local/bin /var/log
cat > /usr/local/bin/boxforge-start <<'EOS'
#!/bin/sh
# Starts the Docker engine where there is no systemd to do it.
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
pgrep -x dockerd >/dev/null 2>&1 && exit 0
# dockerd wants the cgroup controllers mounted; systemd or OpenRC would have.
if ! mountpoint -q /sys/fs/cgroup; then mount -t cgroup2 none /sys/fs/cgroup 2>/dev/null || mount -t tmpfs -o mode=0755 cgroup /sys/fs/cgroup; fi
if [ ! -e /sys/fs/cgroup/cgroup.controllers ]; then
  for sys in $(awk '!/^#/ { if ($4 == 1) print $1 }' /proc/cgroups); do
    mkdir -p "/sys/fs/cgroup/$sys"
    mountpoint -q "/sys/fs/cgroup/$sys" || mount -n -t cgroup -o "$sys" cgroup "/sys/fs/cgroup/$sys" 2>/dev/null || true
  done
fi
rm -f /var/run/docker.pid
# In a session of its own, so that it outlives the command that started it.
setsid nohup /usr/bin/dockerd >/var/log/dockerd.log 2>&1 </dev/null &
EOS
chmod 755 /usr/local/bin/boxforge-start
if [ -d /run/systemd/system ]; then
  systemctl start docker && exit 0
  journalctl -u docker -n 25 --no-pager 2>/dev/null >&2
  exit 1
fi
if ! grep -q 'boxforge-start' /etc/wsl.conf 2>/dev/null; then printf '\n[boot]\ncommand = /usr/local/bin/boxforge-start\n' >> /etc/wsl.conf; fi
/usr/local/bin/boxforge-start
i=0
while [ $i -lt 40 ]; do
  [ -S /var/run/docker.sock ] && docker info >/dev/null 2>&1 && exit 0
  pgrep -x dockerd >/dev/null 2>&1 || break
  sleep 1
  i=$((i + 1))
done
echo "--- 엔진이 시작되지 않았습니다. 엔진의 로그 끝부분:" >&2
tail -n 25 /var/log/dockerd.log >&2
exit 1
`

// Installer runs the installation, one at a time.
type Installer struct {
	// Notify is called with the new status whenever it changes.
	Notify func(Status)

	mu     sync.Mutex
	st     Status
	cancel context.CancelFunc

	listOnce sync.Once
	listed   map[string]listed // Microsoft's distributions, by flavor ID
	choices  []Flavor
}

func wslExe() string {
	if p := os.Getenv("BOXFORGE_WSL"); p != "" {
		return p
	}
	return "wsl.exe"
}

// supported says whether this PC is one the installer knows.
func supported() (bool, string) {
	if os.Getenv("BOXFORGE_WSL") != "" {
		return true, ""
	}
	switch runtime.GOOS {
	case "windows":
		return true, ""
	case "linux":
		return false, "Linux에서는 터미널에서 두 줄이면 설치됩니다. 아래 안내를 따라 주세요."
	}
	return false, "이 운영체제에서의 자동 설치는 아직 만들지 않았습니다."
}

// dataDir is where the distribution's disk and the download are kept.
func dataDir() (string, error) {
	base, err := os.UserCacheDir() // %LOCALAPPDATA% on Windows
	if err != nil {
		return "", err
	}
	dir := filepath.Join(base, "BoxForge", "wsl")
	return dir, os.MkdirAll(dir, 0o755)
}

// decode turns what wsl.exe printed into text: its own messages are UTF-16.
func decode(raw []byte) string {
	if bytes.IndexByte(raw, 0) < 0 {
		return string(raw)
	}
	u := make([]uint16, 0, len(raw)/2)
	for i := 0; i+1 < len(raw); i += 2 {
		u = append(u, uint16(raw[i])|uint16(raw[i+1])<<8)
	}
	return string(utf16.Decode(u))
}

// wsl runs wsl.exe and returns what it printed.
func wsl(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, wslExe(), args...)
	cmd.Env = append(os.Environ(), "WSL_UTF8=1")
	clirunner.HideWindow(cmd)
	out, err := cmd.CombinedOutput()
	text := strings.TrimSpace(strings.ReplaceAll(decode(out), "\r", ""))
	if err != nil && text != "" {
		lines := strings.Split(text, "\n")
		return text, errors.New(strings.TrimSpace(lines[len(lines)-1]))
	}
	return text, err
}

// inDistro runs a command as root inside BoxForge's distribution.
func inDistro(ctx context.Context, args ...string) (string, error) {
	return wsl(ctx, append([]string{"-d", Distro, "-u", "root", "--"}, args...)...)
}

func hasWSL(ctx context.Context) bool {
	_, err := wsl(ctx, "--status")
	return err == nil
}

func hasDistro() bool {
	for _, d := range engines.Distros() {
		if d == Distro {
			return true
		}
	}
	return false
}

func hasDocker(ctx context.Context) bool {
	_, err := inDistro(ctx, "test", "-x", "/usr/bin/dockerd")
	return err == nil
}

func engineAnswers(ctx context.Context) bool {
	_, err := inDistro(ctx, "docker", "info")
	return err == nil
}

// Status returns where the installation stands, looking at the PC afresh
// when no run is under way.
func (in *Installer) Status() Status {
	flavors := in.flavors()
	in.mu.Lock()
	defer in.mu.Unlock()
	if in.st.Running {
		return in.snapshot()
	}
	ok, why := supported()
	st := Status{Supported: ok, Reason: why, Steps: append([]Step{}, plan...), NeedsRestart: in.st.NeedsRestart, Error: in.st.Error, Log: in.st.Log, Flavors: flavors}
	for i := range st.Steps {
		st.Steps[i].State = "todo"
	}
	if ok {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		// Only what can be seen without starting a stopped distribution.
		if hasWSL(ctx) {
			st.Steps[0].State = "done"
			if hasDistro() {
				st.Steps[1].State, st.Steps[2].State = "done", "done"
				st.Installed = in.st.Installed
			}
		}
	}
	in.st = st
	return in.snapshot()
}

// snapshot copies the status. Callers hold mu.
func (in *Installer) snapshot() Status {
	st := in.st
	st.Steps = append([]Step{}, in.st.Steps...)
	st.Log = append([]string{}, in.st.Log...)
	return st
}

func (in *Installer) update(f func(*Status)) {
	in.mu.Lock()
	f(&in.st)
	st := in.snapshot()
	in.mu.Unlock()
	if in.Notify != nil {
		in.Notify(st)
	}
}

func (in *Installer) step(id, state, detail string) {
	in.update(func(st *Status) {
		for i := range st.Steps {
			if st.Steps[i].ID == id {
				st.Steps[i].State, st.Steps[i].Detail = state, detail
			}
		}
	})
}

func (in *Installer) logf(format string, args ...any) {
	line := fmt.Sprintf(format, args...)
	in.update(func(st *Status) {
		st.Log = append(st.Log, line)
		if len(st.Log) > 300 {
			st.Log = st.Log[len(st.Log)-300:]
		}
	})
}

// Cancel stops a run that is under way.
func (in *Installer) Cancel() {
	in.mu.Lock()
	cancel := in.cancel
	in.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

// Start begins the installation in the background. It returns false when
// one is already running or this PC is not supported.
func (in *Installer) Start(o Options) bool {
	flavors := in.flavors()
	in.mu.Lock()
	if ok, _ := supported(); !ok || in.st.Running {
		in.mu.Unlock()
		return false
	}
	ctx, cancel := context.WithCancel(context.Background())
	in.cancel = cancel
	in.st = Status{Supported: true, Running: true, Steps: append([]Step{}, plan...), Flavors: flavors}
	for i := range in.st.Steps {
		in.st.Steps[i].State = "todo"
	}
	in.mu.Unlock()

	go func() {
		defer cancel()
		active, err := in.run(ctx, o)
		in.update(func(st *Status) {
			st.Running = false
			st.Done, st.Total = 0, 0
			switch {
			case err == nil:
				st.Installed = !st.NeedsRestart
			case ctx.Err() != nil:
				st.Error = "설치를 취소했습니다. 다시 시작하면 끝난 단계는 건너뜁니다."
			default:
				st.Error = err.Error()
			}
			if err != nil {
				for i := range st.Steps {
					if st.Steps[i].ID == active {
						st.Steps[i].State = "error"
					}
				}
			}
		})
	}()
	return true
}

// run does the steps in order and returns the one it stopped in.
func (in *Installer) run(ctx context.Context, o Options) (string, error) {
	// 1. WSL itself.
	in.step("wsl", "active", "확인하는 중")
	if !hasWSL(ctx) {
		in.step("wsl", "active", "Windows에 WSL을 설치합니다. 관리자 권한을 묻는 창이 뜨면 허용해 주세요.")
		in.logf("wsl --install --no-distribution (관리자 권한)")
		if err := elevated(ctx, "wsl.exe", "--install", "--no-distribution"); err != nil {
			return "wsl", fmt.Errorf("WSL을 설치하지 못했습니다: %w", err)
		}
		if !hasWSL(ctx) {
			// Windows enables the feature at its next start.
			in.step("wsl", "done", "설치했습니다. Windows를 다시 시작해야 합니다.")
			in.update(func(st *Status) { st.NeedsRestart = true })
			return "", nil
		}
	}
	in.step("wsl", "done", "")

	dir, err := dataDir()
	if err != nil {
		return "download", err
	}
	if hasDistro() {
		in.step("download", "done", "이미 있습니다")
		in.step("distro", "done", "이미 있습니다")
	} else {
		// 2. The root filesystem, checked against the publisher's checksum.
		in.step("download", "active", "무엇을 받을지 확인하는 중")
		src, err := in.resolve(ctx, o, dir)
		if err != nil {
			return "download", err
		}
		file := src.file
		switch {
		case src.url == "":
			in.step("download", "done", "이 PC의 파일을 씁니다: "+file)
		default:
			in.step("download", "active", filepath.Base(file))
			if err := in.download(ctx, src); err != nil {
				return "download", err
			}
			if src.sha256 != "" {
				in.step("download", "done", "받은 파일이 원본과 같은지 확인했습니다")
			} else {
				in.step("download", "done", "받았습니다. 이 주소는 대조할 체크섬이 없어 확인하지 못했습니다")
			}
		}

		// 3. The distribution, beside and apart from the user's own.
		in.step("distro", "active", "가상 디스크를 만드는 중")
		in.logf("wsl --import %s …", Distro)
		if _, err := wsl(ctx, "--import", Distro, filepath.Join(dir, "disk"), file, "--version", "2"); err != nil {
			return "distro", fmt.Errorf("Linux를 만들지 못했습니다: %w", err)
		}
		if !src.keep {
			_ = os.Remove(file)
		}
		in.step("distro", "done", "")
	}

	// 4. Docker's packages.
	in.step("docker", "active", "")
	if hasDocker(ctx) {
		in.step("docker", "done", "이미 설치되어 있습니다")
	} else {
		script := filepath.Join(dir, "install-docker.sh")
		if err := os.WriteFile(script, []byte(installScript), 0o644); err != nil {
			return "docker", err
		}
		defer os.Remove(script)
		name, args := engines.InWSL(Distro, "sh", engines.WSLPath(script))
		err := clirunner.Run(ctx, "", []string{"WSL_UTF8=1"}, name, args, func(line string) {
			if strings.HasPrefix(line, "[") {
				in.step("docker", "active", line)
			}
			in.logf("%s", line)
		})
		if err != nil {
			return "docker", fmt.Errorf("Docker Engine을 설치하지 못했습니다: %w", err)
		}
		in.step("docker", "done", "")
	}

	// 5. Start it. The distribution is restarted first so that its
	// settings (systemd) are the ones in effect.
	in.step("start", "active", "엔진을 시작하는 중")
	_, _ = wsl(ctx, "--terminate", Distro)
	starter := filepath.Join(dir, "start-docker.sh")
	if err := os.WriteFile(starter, []byte(startScript), 0o644); err != nil {
		return "start", err
	}
	defer os.Remove(starter)
	name, args := engines.InWSL(Distro, "sh", engines.WSLPath(starter))
	var said []string
	err = clirunner.Run(ctx, "", []string{"WSL_UTF8=1"}, name, args, func(line string) {
		said = append(said, line)
		in.logf("%s", line)
	})
	if err != nil {
		if ctx.Err() != nil {
			return "start", ctx.Err()
		}
		why := "엔진을 설치했지만 시작되지 않았습니다."
		if n := len(said); n > 0 {
			// The engine's own last words are the reason.
			why += " 엔진이 남긴 말: " + said[n-1]
		}
		return "start", errors.New(why + " 아래 \"자세한 진행 내용\"에 엔진의 로그가 있습니다.")
	}
	deadline := time.Now().Add(60 * time.Second)
	for !engineAnswers(ctx) {
		if ctx.Err() != nil {
			return "start", ctx.Err()
		}
		if time.Now().After(deadline) {
			return "start", errors.New("엔진이 시작됐지만 응답하지 않습니다. 다시 시도해 주세요.")
		}
		time.Sleep(2 * time.Second)
	}
	in.step("start", "done", "엔진이 응답합니다")
	return "", nil
}

// download fetches the root filesystem and, when its publisher gives a
// SHA-256, checks it.
func (in *Installer) download(ctx context.Context, src source) error {
	file, want := src.file, src.sha256
	// One already here and intact (a run interrupted after it) is kept.
	if want != "" {
		if sum, err := sha256File(file); err == nil && sum == want {
			in.logf("이미 받아 둔 파일을 씁니다")
			return nil
		}
	}
	req, err := http.NewRequestWithContext(ctx, "GET", src.url, nil)
	if err != nil {
		return err
	}
	in.logf("GET %s", req.URL)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return fmt.Errorf("내려받지 못했습니다: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return fmt.Errorf("내려받지 못했습니다: 서버가 %s 로 답했습니다", res.Status)
	}
	in.update(func(st *Status) { st.Done, st.Total = 0, max(res.ContentLength, 0) })
	tmp := file + ".part"
	f, err := os.Create(tmp)
	if err != nil {
		return err
	}
	hash := sha256.New()
	var done int64
	var last time.Time
	buf := make([]byte, 256<<10)
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if _, err := f.Write(buf[:n]); err != nil {
				f.Close()
				os.Remove(tmp)
				return err
			}
			hash.Write(buf[:n])
			done += int64(n)
			if time.Since(last) > 200*time.Millisecond {
				last = time.Now()
				in.update(func(st *Status) { st.Done = done })
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			os.Remove(tmp)
			return fmt.Errorf("내려받다가 끊겼습니다: %w", rerr)
		}
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	in.update(func(st *Status) { st.Done = done })
	if got := hex.EncodeToString(hash.Sum(nil)); want != "" && got != want {
		os.Remove(tmp)
		return errors.New("받은 파일이 원본과 다릅니다(체크섬 불일치). 네트워크가 내용을 바꿨을 수 있습니다. 다시 시도해 주세요.")
	}
	return os.Rename(tmp, file)
}

// fetch returns a small text file from the web.
func fetch(ctx context.Context, url string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return "", fmt.Errorf("the server answered %s", res.Status)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return string(b), err
}

// findSum finds name's line in a SHA256SUMS list: "<hex>  name" or "<hex> *name".
func findSum(r io.Reader, name string) (string, error) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name && len(f[0]) == 64 {
			return strings.ToLower(f[0]), nil
		}
	}
	return "", fmt.Errorf("%s is not in the checksum list", name)
}

func sha256File(file string) (string, error) {
	f, err := os.Open(file)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// Remove deletes BoxForge's distribution, and with it every image,
// container and volume of the engine inside.
func Remove(ctx context.Context) error {
	if !hasDistro() {
		return nil
	}
	_, err := wsl(ctx, "--unregister", Distro)
	return err
}
