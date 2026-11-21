package provision

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/user"
	"runtime"
	"strings"

	"github.com/soulfactorx/boxforge/internal/clirunner"
)

// Installing an engine where no WSL is involved.
//
// Linux: Docker's own packages, through the distribution's package
// manager, as root. Root comes from being root already (a server), or
// from pkexec, the desktop's own password window.
//
// macOS: there is no engine that runs on macOS itself. Colima (a small
// Linux VM with Docker in it, free) is installed with Homebrew and
// started; it registers itself as a Docker context.

// native reports which of those this machine is, "" for neither (Windows,
// or a test standing in for WSL).
func native() string {
	if os.Getenv("BOXFORGE_WSL") != "" {
		return ""
	}
	switch runtime.GOOS {
	case "linux":
		return "linux"
	case "darwin":
		return "macos"
	}
	return ""
}

var linuxPlan = []Step{
	{ID: "check", Title: "이 PC 확인"},
	{ID: "docker", Title: "Docker Engine 설치"},
	{ID: "start", Title: "엔진 시작과 확인"},
}

var macPlan = []Step{
	{ID: "check", Title: "이 Mac 확인"},
	{ID: "docker", Title: "Colima와 docker 명령 설치"},
	{ID: "start", Title: "엔진 시작과 확인"},
}

// planFor is the steps of this machine's installation.
func planFor() []Step {
	switch native() {
	case "linux":
		return linuxPlan
	case "macos":
		return macPlan
	}
	return plan
}

// tool finds a program; BOXFORGE_NATIVE_PATH names a folder of stand-ins
// for tests, looked in first.
func tool(name string) (string, bool) {
	if dir := os.Getenv("BOXFORGE_NATIVE_PATH"); dir != "" {
		if st, err := os.Stat(dir + "/" + name); err == nil && !st.IsDir() {
			return dir + "/" + name, true
		}
		return "", false
	}
	p, err := exec.LookPath(name)
	return p, err == nil
}

// asRoot is the start of a command that runs as root: nothing when root
// already, pkexec on a desktop. ok is false when there is no way.
func asRoot() (prefix []string, ok bool) {
	if os.Geteuid() == 0 && os.Getenv("BOXFORGE_NATIVE_PATH") == "" {
		return nil, true
	}
	if p, ok := tool("pkexec"); ok {
		return []string{p}, true
	}
	return nil, false
}

// linuxScript installs Docker Engine with the distribution's package
// manager, starts it now and at every boot, and lets the user ($1) use it.
// Debian's and Red Hat's families take Docker's own script, which adds
// Docker's package source; Alpine and Arch have Docker in their own.
const linuxScript = `set -e
who="$1"
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  echo "Docker Engine is already installed and running."
elif command -v apk >/dev/null 2>&1; then
  apk add --no-cache docker docker-cli-compose docker-cli-buildx
elif command -v pacman >/dev/null 2>&1; then
  pacman -Sy --noconfirm --needed docker docker-compose docker-buildx
elif command -v apt-get >/dev/null 2>&1 || command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1 || command -v zypper >/dev/null 2>&1; then
  if command -v curl >/dev/null 2>&1; then curl -fsSL https://get.docker.com -o /tmp/boxforge-get-docker.sh
  elif command -v wget >/dev/null 2>&1; then wget -qO /tmp/boxforge-get-docker.sh https://get.docker.com
  else echo "curl or wget is needed to fetch Docker's installer" >&2; exit 1; fi
  sh /tmp/boxforge-get-docker.sh
  rm -f /tmp/boxforge-get-docker.sh
else
  echo "this distribution's package manager is not one BoxForge knows (apt, dnf, yum, zypper, apk, pacman)" >&2
  exit 1
fi
if [ -d /run/systemd/system ]; then
  systemctl enable --now docker
elif command -v rc-update >/dev/null 2>&1; then
  rc-update add docker default >/dev/null 2>&1 || true
  rc-service docker start || true
else
  service docker start || true
fi
if [ -n "$who" ] && [ "$who" != root ]; then
  getent group docker >/dev/null 2>&1 || groupadd docker 2>/dev/null || addgroup docker 2>/dev/null || true
  usermod -aG docker "$who" 2>/dev/null || addgroup "$who" docker 2>/dev/null || true
fi
i=0
while [ $i -lt 30 ]; do
  docker info >/dev/null 2>&1 && { echo "Docker Engine answers."; exit 0; }
  i=$((i+1)); sleep 1
done
echo "Docker Engine was installed but does not answer yet" >&2
exit 1
`

// nativeSupported says whether the installer can work here, and why not.
func nativeSupported() (bool, string) {
	switch native() {
	case "linux":
		if _, ok := asRoot(); !ok {
			return false, "관리자 권한을 얻을 방법(pkexec)이 없습니다. 아래 안내대로 터미널에서 설치해 주세요."
		}
		return true, ""
	case "macos":
		if _, ok := tool("brew"); !ok {
			return false, "Homebrew가 있어야 자동으로 설치할 수 있습니다. https://brew.sh 의 한 줄로 Homebrew를 설치한 뒤 다시 열어 주세요."
		}
		return true, ""
	}
	return false, "이 운영체제에서의 자동 설치는 아직 만들지 않았습니다."
}

// NativeEngine is the engine target the installation leaves to use.
func NativeEngine() string {
	if native() == "macos" {
		return "context:colima"
	}
	return "default"
}

// runNative does the steps for Linux or macOS and returns the one it
// stopped in.
func (in *Installer) runNative(ctx context.Context, o Options) (string, error) {
	line := func(s string) { in.logf("%s", s) }
	env := []string{}
	if o.Proxy != "" {
		env = append(env, "HTTP_PROXY="+o.Proxy, "HTTPS_PROXY="+o.Proxy, "http_proxy="+o.Proxy, "https_proxy="+o.Proxy)
	}
	in.step("check", "active", "확인하는 중")
	if ok, why := nativeSupported(); !ok {
		return "check", errors.New(why)
	}
	in.step("check", "done", "")

	if native() == "macos" {
		brew, _ := tool("brew")
		in.step("docker", "active", "Homebrew로 설치하는 중입니다. 몇 분 걸릴 수 있습니다.")
		in.logf("brew install colima docker docker-compose docker-buildx")
		if err := clirunner.Run(ctx, "", env, brew, []string{"install", "colima", "docker", "docker-compose", "docker-buildx"}, line); err != nil {
			return "docker", fmt.Errorf("설치하지 못했습니다: %w", err)
		}
		in.step("docker", "done", "")
		in.step("start", "active", "작은 Linux 가상 머신을 만들고 엔진을 켜는 중입니다. 처음에는 몇 분 걸립니다.")
		colima, ok := tool("colima")
		if !ok {
			return "start", errors.New("설치한 colima를 찾지 못했습니다. 터미널을 새로 열어 colima start 를 실행해 보세요.")
		}
		in.logf("colima start")
		if err := clirunner.Run(ctx, "", env, colima, []string{"start"}, line); err != nil {
			return "start", fmt.Errorf("엔진을 켜지 못했습니다: %w", err)
		}
		in.step("start", "done", "")
		return "", nil
	}

	root, _ := asRoot()
	who := ""
	if u, err := user.Current(); err == nil {
		who = u.Username
	}
	f, err := os.CreateTemp("", "boxforge-install-*.sh")
	if err != nil {
		return "docker", err
	}
	defer os.Remove(f.Name())
	if _, err := f.WriteString(linuxScript); err != nil {
		f.Close()
		return "docker", err
	}
	f.Close()
	_ = os.Chmod(f.Name(), 0o755)
	in.step("docker", "active", "Docker Engine을 설치하는 중입니다. 비밀번호를 묻는 창이 뜨면 넣어 주세요.")
	args := append(append([]string{}, root...), "sh", f.Name(), who)
	// pkexec runs with a clean environment: the proxy is handed over by env.
	if o.Proxy != "" && len(root) > 0 {
		args = append(append([]string{}, root...), "env", "HTTP_PROXY="+o.Proxy, "HTTPS_PROXY="+o.Proxy, "http_proxy="+o.Proxy, "https_proxy="+o.Proxy, "sh", f.Name(), who)
	}
	in.logf("%s", strings.Join(args[:len(args)-2], " ")+" <Docker 설치 스크립트>")
	if err := clirunner.Run(ctx, "", env, args[0], args[1:], line); err != nil {
		return "docker", fmt.Errorf("설치하지 못했습니다: %w", err)
	}
	in.step("docker", "done", "")
	in.step("start", "active", "확인하는 중")
	docker, _ := tool("docker")
	if docker == "" {
		docker = "docker"
	}
	if err := clirunner.Run(ctx, "", nil, docker, []string{"info", "--format", "{{.ServerVersion}}"}, line); err != nil {
		// Installed and running, but this session is not in the docker group yet.
		in.step("start", "done", "설치했습니다. 이 계정이 엔진을 쓰려면 한 번 로그아웃했다가 다시 로그인해야 합니다.")
		in.update(func(st *Status) { st.NeedsRelogin = true })
		return "", nil
	}
	in.step("start", "done", "")
	return "", nil
}
