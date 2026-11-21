// BoxForge: the desktop app. The window is a web view showing frontend/dist;
// the page calls the methods of internal/app.App.
package main

import (
	"context"
	_ "embed"
	"log"
	"os"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/soulfactorx/boxforge/frontend"
	"github.com/soulfactorx/boxforge/internal/app"
	"github.com/soulfactorx/boxforge/internal/desktop"
)

//go:embed build/appicon.png
var icon []byte

func main() {
	if os.Getenv("BOXFORGE_RESTARTED") != "" {
		// Started by the version this one replaces, which is on its way
		// out: give it a moment, or it would be taken for a second copy.
		time.Sleep(1500 * time.Millisecond)
	}
	a, err := app.New()
	if err != nil {
		log.Fatal(err)
	}
	// Linux: the menu entry the desktop takes the window's icon from.
	if err := desktop.Register(icon); err != nil {
		log.Printf("desktop entry: %v", err)
	}
	// ctx is the window, once there is one. quitting is set when the app is
	// to end for real, not go to the tray.
	var ctx atomic.Value
	var quitting atomic.Bool
	show := func() {
		if c, ok := ctx.Load().(context.Context); ok {
			runtime.WindowShow(c)
			runtime.WindowUnminimise(c)
		}
	}
	quit := func() {
		quitting.Store(true)
		if c, ok := ctx.Load().(context.Context); ok {
			runtime.Quit(c)
		}
	}
	app.SetQuit(quit)
	app.SetTray(startTray(show, quit), func() {
		if c, ok := ctx.Load().(context.Context); ok {
			runtime.WindowHide(c)
		}
	})
	err = wails.Run(&options.App{
		// Opening BoxForge while it is running (in the tray, perhaps)
		// brings its window back instead of starting another.
		SingleInstanceLock: &options.SingleInstanceLock{
			UniqueId:               "boxforge-6f1c2a54-7d0e-4b57-9d0b-2f3a1c9e8b11",
			OnSecondInstanceLaunch: func(options.SecondInstanceData) { show() },
		},
		// Closing the window keeps BoxForge in the tray, when there is one
		// and the user has not chosen otherwise.
		OnBeforeClose: func(context.Context) bool {
			return !quitting.Load() && a.Closing()
		},
		Linux:       &linux.Options{Icon: icon, ProgramName: desktop.Name},
		Title:       "BoxForge",
		Width:       1280,
		Height:      800,
		MinWidth:    900,
		MinHeight:   560,
		AssetServer: &assetserver.Options{Assets: frontend.Dist},
		OnStartup: func(c context.Context) {
			ctx.Store(c)
			ctx := c
			app.Start(a, func(event string, data any) { runtime.EventsEmit(ctx, event, data) })
			app.SetCertPicker(func() (string, error) {
				return runtime.OpenFileDialog(ctx, runtime.OpenDialogOptions{
					Title:   "인증서 파일 선택",
					Filters: []runtime.FileFilter{{DisplayName: "인증서 (*.crt, *.pem, *.cer)", Pattern: "*.crt;*.pem;*.cer"}},
				})
			})
			app.SetAnyFilePicker(func() (string, error) {
				return runtime.OpenFileDialog(ctx, runtime.OpenDialogOptions{Title: "올릴 파일"})
			})
			bundles := []runtime.FileFilter{{DisplayName: "BoxForge 묶음 (*.boxforge)", Pattern: "*.boxforge"}}
			app.SetBundlePickers(
				func(name string) (string, error) {
					return runtime.SaveFileDialog(ctx, runtime.SaveDialogOptions{Title: "내보낼 파일", DefaultFilename: name, Filters: bundles})
				},
				func() (string, error) {
					return runtime.OpenFileDialog(ctx, runtime.OpenDialogOptions{Title: "가져올 파일", Filters: bundles})
				},
			)
			app.SetFolderPicker(func() (string, error) {
				return runtime.OpenDirectoryDialog(ctx, runtime.OpenDialogOptions{Title: "빌드할 폴더 선택"})
			})
			app.SetFilePicker(func() (string, error) {
				return runtime.OpenFileDialog(ctx, runtime.OpenDialogOptions{
					Title:   "Compose 파일 열기",
					Filters: []runtime.FileFilter{{DisplayName: "Compose (*.yml, *.yaml)", Pattern: "*.yml;*.yaml"}},
				})
			})
		},
		OnShutdown: func(context.Context) { app.Stop(a) },
		Bind:       []any{a},
	})
	if err != nil {
		log.Fatal(err)
	}
}
