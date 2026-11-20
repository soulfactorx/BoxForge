// BoxForge: the desktop app. The window is a web view showing frontend/dist;
// the page calls the methods of internal/app.App.
package main

import (
	"context"
	"embed"
	"log"

	"github.com/wailsapp/wails/v2"
	"github.com/wailsapp/wails/v2/pkg/options"
	"github.com/wailsapp/wails/v2/pkg/options/assetserver"
	"github.com/wailsapp/wails/v2/pkg/options/linux"
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/soulfactorx/boxforge/internal/app"
	"github.com/soulfactorx/boxforge/internal/desktop"
)

//go:embed all:frontend/dist
var assets embed.FS

//go:embed build/appicon.png
var icon []byte

func main() {
	a, err := app.New()
	if err != nil {
		log.Fatal(err)
	}
	// Linux: the menu entry the desktop takes the window's icon from.
	if err := desktop.Register(icon); err != nil {
		log.Printf("desktop entry: %v", err)
	}
	err = wails.Run(&options.App{
		Linux:       &linux.Options{Icon: icon, ProgramName: desktop.Name},
		Title:       "BoxForge",
		Width:       1280,
		Height:      800,
		MinWidth:    900,
		MinHeight:   560,
		AssetServer: &assetserver.Options{Assets: assets},
		OnStartup: func(ctx context.Context) {
			app.Start(a, func(event string, data any) { runtime.EventsEmit(ctx, event, data) })
			app.SetQuit(func() { runtime.Quit(ctx) })
			app.SetCertPicker(func() (string, error) {
				return runtime.OpenFileDialog(ctx, runtime.OpenDialogOptions{
					Title:   "인증서 파일 선택",
					Filters: []runtime.FileFilter{{DisplayName: "인증서 (*.crt, *.pem, *.cer)", Pattern: "*.crt;*.pem;*.cer"}},
				})
			})
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
