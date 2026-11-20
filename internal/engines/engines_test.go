package engines

import "testing"

func TestWSLPath(t *testing.T) {
	for in, want := range map[string]string{
		`C:\projects\shop\compose.yaml`:        "/mnt/c/projects/shop/compose.yaml",
		`d:/data`:                              "/mnt/d/data",
		`\\wsl$\Ubuntu\home\me\app`:            "/home/me/app",
		`\\wsl.localhost\Ubuntu-24.04\srv\x.y`: "/srv/x.y",
		`\\wsl$\Ubuntu`:                        "/",
		`/already/linux`:                       "/already/linux",
		`relative\path`:                        `relative\path`,
	} {
		if got := WSLPath(in); got != want {
			t.Errorf("WSLPath(%q) = %q, want %q", in, got, want)
		}
	}
}
