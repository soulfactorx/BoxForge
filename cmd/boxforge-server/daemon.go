package main

// Running in the background without a service manager: -daemon starts the
// server detached from the terminal, -stop ends it, -status says whether it
// runs. The started server writes its own process number (a restart after an
// update on Windows is a new process), and its output goes to a log file.

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/soulfactorx/boxforge/internal/update"
)

// daemonEnv marks the server -daemon started: it writes its process number.
const daemonEnv = "BOXFORGE_DAEMON"

func pidFile(dir string) string { return filepath.Join(dir, "server.pid") }
func logFile(dir string) string { return filepath.Join(dir, "server.log") }

// runningPid is the process number of a server -daemon started that still
// runs, 0 when none does.
func runningPid(dir string) int {
	b, err := os.ReadFile(pidFile(dir))
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || pid <= 0 || !alive(pid) {
		return 0
	}
	return pid
}

// notePid is called by the server itself when -daemon started it.
func notePid(dir string) {
	if os.Getenv(daemonEnv) == "" {
		return
	}
	_ = os.MkdirAll(dir, 0o700)
	_ = os.WriteFile(pidFile(dir), []byte(strconv.Itoa(os.Getpid())+"\n"), 0o600)
}

// startDaemon starts this program again in the background with the given
// arguments, its output in the log file, and tells where it can be reached.
func startDaemon(dir string, args []string) error {
	if pid := runningPid(dir); pid != 0 {
		return fmt.Errorf("이미 실행 중입니다 (프로세스 %d). 끄려면 -stop", pid)
	}
	// The path the program was started from: after an update moved it
	// aside, os.Executable names the old file.
	exe, err := update.Program()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	out, err := os.OpenFile(logFile(dir), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer out.Close()
	cmd := exec.Command(exe, args...)
	cmd.Stdout, cmd.Stderr = out, out
	cmd.Env = append(os.Environ(), daemonEnv+"=1")
	detach(cmd)
	if err := cmd.Start(); err != nil {
		return err
	}
	pid := cmd.Process.Pid
	// Written here as well as by the server: one of a version from before
	// it did (just updated to) is still found by -stop.
	_ = os.WriteFile(pidFile(dir), []byte(strconv.Itoa(pid)+"\n"), 0o600)
	noteArgs(dir, args)
	ended := make(chan struct{})
	go func() {
		_ = cmd.Wait()
		close(ended)
	}()

	// A moment for it to start, or to say why it can't.
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ended:
			b, _ := os.ReadFile(logFile(dir))
			return fmt.Errorf("서버가 바로 끝났습니다:\n%s", strings.TrimSpace(string(b)))
		case <-time.After(300 * time.Millisecond):
		}
		if b, _ := os.ReadFile(logFile(dir)); strings.Contains(string(b), "://") {
			time.Sleep(700 * time.Millisecond) // the password and the certificate come just after
			break
		}
	}
	b, _ := os.ReadFile(logFile(dir))
	fmt.Printf("백그라운드에서 실행했습니다 (프로세스 %d).\n\n%s\n\n", pid, strings.TrimSpace(string(b)))
	fmt.Printf("로그: %s\n끄기: %s -stop    상태: %s -status\n", logFile(dir), filepath.Base(exe), filepath.Base(exe))
	return nil
}

// stopDaemon ends the server -daemon started.
func stopDaemon(dir string) error {
	pid := runningPid(dir)
	if pid == 0 {
		_ = os.Remove(pidFile(dir))
		return fmt.Errorf("-daemon 으로 실행한 서버가 없습니다 (서비스로 설치했다면 서비스 관리자로 끄세요)")
	}
	if err := terminate(pid); err != nil {
		return err
	}
	for i := 0; i < 50 && alive(pid); i++ {
		time.Sleep(100 * time.Millisecond)
	}
	if alive(pid) {
		return fmt.Errorf("프로세스 %d가 끝나지 않았습니다", pid)
	}
	_ = os.Remove(pidFile(dir))
	fmt.Printf("서버를 껐습니다 (프로세스 %d).\n", pid)
	return nil
}

// showStatus says whether a server runs in the background or as a service.
func showStatus(dir string) {
	if pid := runningPid(dir); pid != 0 {
		fmt.Printf("실행 중 (-daemon, 프로세스 %d)\n로그: %s\n", pid, logFile(dir))
	} else {
		fmt.Println("-daemon 으로 실행한 서버는 없습니다.")
	}
	if s := serviceStatus(); s != "" {
		fmt.Println(s)
	}
}
