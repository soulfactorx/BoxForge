package main

import (
	"fmt"
	"sync"

	"github.com/soulfactorx/boxforge/internal/app"
)

// trayUpdate is the tray menu's update entry: one click checks for a new
// version; if there is one it is downloaded and put in place (the window
// needn't be open); a click after that starts the new one. The entry's
// text says where it stands.
type trayUpdate struct {
	check   func() (app.UpdateInfo, error)
	apply   func() error
	restart func() error
	// set shows a text on the entry, and whether it can be clicked.
	set func(title string, enabled bool)

	mu    sync.Mutex
	busy  bool
	ready string // the version put in place, to start on the next click
}

func (u *trayUpdate) idle() { u.set("업데이트 확인", true) }

// click does the entry's next step. It returns when that step is done.
func (u *trayUpdate) click() {
	u.mu.Lock()
	if u.busy {
		u.mu.Unlock()
		return
	}
	ready := u.ready
	u.busy = true
	u.mu.Unlock()
	defer func() {
		u.mu.Lock()
		u.busy = false
		u.mu.Unlock()
	}()

	if ready != "" {
		u.set(fmt.Sprintf("v%s로 다시 시작하는 중…", ready), false)
		if err := u.restart(); err != nil {
			u.set("다시 시작하지 못했습니다 · 다시 누르기", true)
		}
		return
	}
	u.set("업데이트 확인 중…", false)
	info, err := u.check()
	switch {
	case err != nil:
		u.set("업데이트를 확인하지 못했습니다 · 다시 누르기", true)
		return
	case info.Installed:
		u.ready = info.Latest
		u.set(fmt.Sprintf("v%s 설치됨 · 눌러서 다시 시작", info.Latest), true)
		return
	case !info.Available:
		u.set(fmt.Sprintf("최신 버전입니다 (v%s) · 다시 확인", info.Current), true)
		return
	}
	u.set(fmt.Sprintf("v%s 받는 중…", info.Latest), false)
	if err := u.apply(); err != nil {
		u.set("업데이트하지 못했습니다 · 다시 누르기", true)
		return
	}
	u.mu.Lock()
	u.ready = info.Latest
	u.mu.Unlock()
	u.set(fmt.Sprintf("v%s 설치됨 · 눌러서 다시 시작", info.Latest), true)
}

// notice checks quietly (at start): a new version shows on the entry.
func (u *trayUpdate) notice() {
	info, err := u.check()
	if err != nil {
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.busy || u.ready != "" {
		return
	}
	switch {
	case info.Installed:
		u.ready = info.Latest
		u.set(fmt.Sprintf("v%s 설치됨 · 눌러서 다시 시작", info.Latest), true)
	case info.Available:
		u.set(fmt.Sprintf("새 버전 v%s 설치하기", info.Latest), true)
	}
}
