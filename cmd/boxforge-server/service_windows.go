package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
)

// detach starts the command with no console of its own: closing the
// window it was started from does not end it.
func detach(cmd *exec.Cmd) {
	const detachedProcess, newGroup = 0x00000008, 0x00000200
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: detachedProcess | newGroup}
	cmd.Stdin = nil
}

func alive(pid int) bool {
	const queryLimited, stillActive = 0x1000, 259
	h, err := syscall.OpenProcess(queryLimited, false, uint32(pid))
	if err != nil {
		return false
	}
	defer syscall.CloseHandle(h)
	var code uint32
	if err := syscall.GetExitCodeProcess(h, &code); err != nil {
		return false
	}
	return code == stillActive
}

func terminate(pid int) error {
	p, err := os.FindProcess(pid)
	if err != nil {
		return err
	}
	return p.Kill()
}

func install(string, map[string]string) error {
	return fmt.Errorf("Windows에서는 아직 서비스 설치를 지원하지 않습니다. -daemon 으로 백그라운드에서 실행하거나, 작업 스케줄러에 '로그온할 때' 실행으로 등록하세요")
}

func uninstall() error { return install("", nil) }

func serviceStatus() string { return "" }
