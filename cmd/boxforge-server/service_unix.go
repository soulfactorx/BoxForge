//go:build !windows

package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/soulfactorx/boxforge/internal/webserver"
)

// detach starts the command in a session of its own: closing the terminal
// does not end it.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	cmd.Stdin = nil
}

func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func terminate(pid int) error { return syscall.Kill(pid, syscall.SIGTERM) }

// The service manager on this machine: "systemd", "openrc", or "".
func manager() string {
	if fi, err := os.Stat("/run/systemd/system"); err == nil && fi.IsDir() {
		return "systemd"
	}
	for _, p := range []string{"/sbin/openrc-run", "/usr/sbin/openrc-run", "/run/openrc"} {
		if _, err := os.Stat(p); err == nil {
			return "openrc"
		}
	}
	return ""
}

func serviceFile(m string) string {
	if m == "systemd" {
		return "/etc/systemd/system/" + serviceName + ".service"
	}
	return "/etc/init.d/" + serviceName
}

// sh runs a command, showing it first; quiet ones may fail.
func sh(quiet bool, name string, args ...string) error {
	fmt.Printf("  $ %s %s\n", name, strings.Join(args, " "))
	out, err := exec.Command(name, args...).CombinedOutput()
	if err != nil && !quiet {
		return fmt.Errorf("%s %s: %v\n%s", name, strings.Join(args, " "), err, strings.TrimSpace(string(out)))
	}
	return nil
}

// install puts the server in place and makes it a service that starts
// with the machine, then starts it.
func install(who string, set map[string]string) error {
	if os.Geteuid() != 0 {
		exe, _ := os.Executable()
		return fmt.Errorf("관리자 권한이 필요합니다: sudo %s -install", exe)
	}
	m := manager()
	if m == "" {
		return fmt.Errorf("이 시스템의 서비스 관리자(systemd, OpenRC)를 찾지 못했습니다. -daemon 으로 백그라운드에서 실행하거나 docs/SERVER.md를 보고 직접 등록하세요")
	}
	if who == "" {
		who = os.Getenv("SUDO_USER")
	}
	if who == "" {
		who = os.Getenv("DOAS_USER")
	}
	if who == "" {
		who = "root"
	}
	u, err := user.Lookup(who)
	if err != nil {
		return fmt.Errorf("사용자 %q: %v", who, err)
	}
	uid, _ := strconv.Atoi(u.Uid)
	gid, _ := strconv.Atoi(u.Gid)
	fmt.Printf("BoxForge 서버를 %s 서비스로 설치합니다 (사용자 %s).\n\n", m, who)

	// The program, where its user can replace it with an update.
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	exe, _ = filepath.EvalSymlinks(exe)
	target := filepath.Join(installDir, "boxforge-server")
	if exe != target {
		if err := os.MkdirAll(installDir, 0o755); err != nil {
			return err
		}
		if err := copyFile(exe, target); err != nil {
			return err
		}
		fmt.Printf("  프로그램: %s\n", target)
	}
	_ = os.Chown(installDir, uid, gid)
	_ = os.Chown(target, uid, gid)

	// The engine, for that user.
	if who != "root" {
		if _, err := user.LookupGroup("docker"); err == nil && !inGroup(u, "docker") {
			// usermod where there is one (most systems), else BusyBox's addgroup (Alpine).
			if _, err := exec.LookPath("usermod"); err == nil {
				_ = sh(true, "usermod", "-aG", "docker", who)
			} else {
				_ = sh(true, "addgroup", who, "docker")
			}
			if !inGroup(u, "docker") {
				fmt.Printf("  ! %s를 docker 그룹에 넣지 못했습니다. 직접 넣어 주세요: usermod -aG docker %s (Alpine: addgroup %s docker)\n", who, who, who)
			}
		}
	}

	// A password, and the certificate, made now so that they can be shown here.
	dir := filepath.Join(u.HomeDir, ".config", "BoxForge")
	fresh := ""
	passwords := webserver.PasswordsIn(dir)
	if !passwords.Exists() {
		if fresh, err = passwords.Generate(); err != nil {
			return err
		}
	}
	args := serviceArgs(set)
	print := ""
	if strings.Contains(strings.Join(args, " "), "-tls") && set["cert"] == "" {
		if _, print, err = webserver.Certificate(dir); err != nil {
			return err
		}
	}
	chownTree(filepath.Join(u.HomeDir, ".config"), uid, gid)

	// One started with -daemon would hold the port.
	if pid := runningPid(dir); pid != 0 {
		fmt.Printf("  -daemon 으로 실행 중인 서버(프로세스 %d)를 끕니다\n", pid)
		_ = terminate(pid)
		time.Sleep(time.Second)
		_ = os.Remove(pidFile(dir))
	}

	s := service{Exe: target, Args: args, User: who, Home: u.HomeDir}
	file := serviceFile(m)
	fmt.Printf("  서비스 파일: %s\n", file)
	if m == "systemd" {
		if err := os.WriteFile(file, []byte(s.systemdUnit()), 0o644); err != nil {
			return err
		}
		for _, c := range [][]string{{"daemon-reload"}, {"enable", serviceName}, {"restart", serviceName}} {
			if err := sh(false, "systemctl", c...); err != nil {
				return err
			}
		}
	} else {
		if err := os.WriteFile(file, []byte(s.openrcScript()), 0o755); err != nil {
			return err
		}
		if _, err := os.Stat("/etc/init.d/docker"); err == nil {
			_ = sh(true, "rc-update", "add", "docker", "default")
			_ = sh(true, "rc-service", "docker", "start")
		}
		if err := sh(false, "rc-update", "add", serviceName, "default"); err != nil {
			return err
		}
		_ = sh(true, "rc-service", serviceName, "stop")
		if err := sh(false, "rc-service", serviceName, "start"); err != nil {
			return err
		}
	}

	fmt.Println("\n설치했습니다. 컴퓨터를 다시 켜도 저절로 시작합니다.")
	listen := ":8088"
	for i := 0; i+1 < len(args); i++ {
		if args[i] == "-listen" {
			listen = args[i+1]
		}
	}
	host, _, _ := net.SplitHostPort(listen)
	scheme := "http"
	if strings.Contains(strings.Join(args, " "), "-tls") || set["cert"] != "" {
		scheme = "https"
	}
	for _, a := range addresses(host, listen) {
		fmt.Printf("  %s://%s\n", scheme, a)
	}
	if fresh != "" {
		fmt.Printf("\n비밀번호: %s\n(처음 한 번만 보여 줍니다. 바꾸려면 sudo -u %s %s -set-password)\n", fresh, who, target)
	}
	if print != "" {
		fmt.Printf("\n브라우저가 인증서 경고를 보여 주면, SHA-256 지문이 아래와 같은지 확인하고 계속하세요.\n  %s\n", print)
	}
	if m == "systemd" {
		fmt.Printf("\n상태: systemctl status %s    로그: journalctl -u %s -f\n", serviceName, serviceName)
	} else {
		fmt.Printf("\n상태: rc-service %s status    로그: tail -f /var/log/boxforge.log\n", serviceName)
	}
	fmt.Printf("지우기: sudo %s -uninstall\n", target)
	return nil
}

// uninstall stops the service and removes it. The program and the
// settings (password, certificate) stay.
func uninstall() error {
	if os.Geteuid() != 0 {
		exe, _ := os.Executable()
		return fmt.Errorf("관리자 권한이 필요합니다: sudo %s -uninstall", exe)
	}
	m := manager()
	file := serviceFile(m)
	if m == "" {
		return fmt.Errorf("이 시스템의 서비스 관리자를 찾지 못했습니다")
	}
	if _, err := os.Stat(file); err != nil {
		return fmt.Errorf("설치된 서비스가 없습니다 (%s)", file)
	}
	if m == "systemd" {
		_ = sh(true, "systemctl", "disable", "--now", serviceName)
	} else {
		_ = sh(true, "rc-service", serviceName, "stop")
		_ = sh(true, "rc-update", "del", serviceName, "default")
	}
	if err := os.Remove(file); err != nil {
		return err
	}
	if m == "systemd" {
		_ = sh(true, "systemctl", "daemon-reload")
	}
	fmt.Printf("\n서비스를 지웠습니다. 프로그램(%s)과 비밀번호 · 설정(~/.config/BoxForge)은 남아 있습니다.\n", installDir)
	return nil
}

// serviceStatus is a line on the installed service, "" when there is none.
func serviceStatus() string {
	m := manager()
	if m == "" {
		return ""
	}
	if _, err := os.Stat(serviceFile(m)); err != nil {
		return "서비스로는 설치되어 있지 않습니다 (설치: sudo boxforge-server -install)."
	}
	var out []byte
	if m == "systemd" {
		out, _ = exec.Command("systemctl", "is-active", serviceName).CombinedOutput()
	} else {
		out, _ = exec.Command("rc-service", serviceName, "status").CombinedOutput()
	}
	return fmt.Sprintf("서비스(%s): %s", m, strings.TrimSpace(string(out)))
}

func copyFile(from, to string) error {
	in, err := os.Open(from)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := to + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, to)
}

func inGroup(u *user.User, name string) bool {
	g, err := user.LookupGroup(name)
	if err != nil {
		return false
	}
	ids, _ := u.GroupIds()
	for _, id := range ids {
		if id == g.Gid {
			return true
		}
	}
	return false
}

// chownTree gives a folder and what is in it to the user.
func chownTree(root string, uid, gid int) {
	_ = filepath.Walk(root, func(p string, _ os.FileInfo, err error) error {
		if err == nil {
			_ = os.Lchown(p, uid, gid)
		}
		return nil
	})
}
