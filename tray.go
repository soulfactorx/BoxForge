//go:build windows || linux

package main

import (
	_ "embed"
	"runtime"

	"fyne.io/systray"
)

//go:embed build/trayicon.png
var trayPNG []byte

//go:embed build/trayicon.ico
var trayICO []byte

func init() {
	// The tray's window (Windows) belongs to the thread that makes it, and
	// that thread has to be the one the app's own message loop runs on.
	runtime.LockOSThread()
}

// startTray puts BoxForge's icon in the taskbar's tray, with a menu to
// bring the window back and to quit. It reports whether there is a tray
// to be in: without one, a closed window could not be got back.
func startTray(show, quit func()) bool {
	if !trayHost() {
		return false
	}
	start, _ := systray.RunWithExternalLoop(func() {
		if runtime.GOOS == "windows" {
			systray.SetIcon(trayICO)
		} else {
			systray.SetIcon(trayPNG)
		}
		systray.SetTitle("BoxForge")
		systray.SetTooltip("BoxForge")
		systray.SetOnTapped(show)
		open := systray.AddMenuItem("BoxForge 열기", "창을 다시 엽니다")
		systray.AddSeparator()
		end := systray.AddMenuItem("종료", "BoxForge를 완전히 끕니다")
		go func() {
			for {
				select {
				case <-open.ClickedCh:
					show()
				case <-end.ClickedCh:
					quit()
				}
			}
		}()
	}, nil)
	// On Windows the app's own loop serves the tray's window; elsewhere
	// the tray is a service of its own to start.
	if runtime.GOOS != "windows" {
		start()
	}
	return true
}
