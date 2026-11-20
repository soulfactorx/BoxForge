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
	"github.com/wailsapp/wails/v2/pkg/runtime"

	"github.com/soulfactorx/boxforge/internal/app"
)

//go:embed all:frontend/dist
var assets embed.FS

func main() {
	a, err := app.New()
	if err != nil {
		log.Fatal(err)
	}
	err = wails.Run(&options.App{
		Title:       "BoxForge",
		Width:       1280,
		Height:      800,
		MinWidth:    900,
		MinHeight:   560,
		AssetServer: &assetserver.Options{Assets: assets},
		OnStartup: func(ctx context.Context) {
			app.Start(a, func(event string, data any) { runtime.EventsEmit(ctx, event, data) })
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
