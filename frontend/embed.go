// Package frontend holds the built UI (frontend/dist, made by `npm run
// build`), for the programs that serve it: the desktop app's window and
// the web server.
package frontend

import "embed"

// Dist is the built UI, under "dist".
//
//go:embed all:dist
var Dist embed.FS
