// devserver serves the UI and the app's bindings over HTTP, for working on
// the UI in an ordinary browser and for browser tests, on machines where
// the desktop shell can't be built. Development only: it asks for no
// password, so it listens on 127.0.0.1 and nowhere else. The server for
// real use is cmd/boxforge-server.
//
//	go run ./cmd/devserver                      # real Docker
//	BOXFORGE_ENGINE=fake go run ./cmd/devserver # in-memory engine
package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/soulfactorx/boxforge/internal/app"
	"github.com/soulfactorx/boxforge/internal/webserver"
)

func main() {
	port := flag.Int("port", 34116, "port on 127.0.0.1")
	dist := flag.String("dist", "frontend/dist", "built UI to serve")
	flag.Parse()

	a, err := app.New()
	if err != nil {
		log.Fatal(err)
	}
	srv := webserver.New(a, webserver.Options{UI: os.DirFS(*dist), Open: true})
	app.Start(a, srv.Emit)
	defer app.Stop(a)

	addr := fmt.Sprintf("127.0.0.1:%d", *port)
	log.Printf("BoxForge dev server on http://%s", addr)
	log.Fatal(http.ListenAndServe(addr, srv.Handler()))
}
