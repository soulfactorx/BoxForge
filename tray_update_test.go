package main

import (
	"errors"
	"testing"

	"github.com/soulfactorx/boxforge/internal/app"
)

func TestTrayUpdate(t *testing.T) {
	var titles []string
	applied, restarted := 0, 0
	info := app.UpdateInfo{Current: "0.34.3", Latest: "0.35.0", Available: true}
	u := &trayUpdate{
		check:   func() (app.UpdateInfo, error) { return info, nil },
		apply:   func() error { applied++; return nil },
		restart: func() error { restarted++; return nil },
		set:     func(title string, _ bool) { titles = append(titles, title) },
	}
	u.idle()
	u.notice()
	if titles[len(titles)-1] != "새 버전 v0.35.0 설치하기" {
		t.Fatalf("after notice: %q", titles)
	}
	u.click() // checks, downloads, puts in place
	if applied != 1 || restarted != 0 || titles[len(titles)-1] != "v0.35.0 설치됨 · 눌러서 다시 시작" {
		t.Fatalf("after first click: applied %d restarted %d %q", applied, restarted, titles)
	}
	u.click() // starts the new one
	if restarted != 1 || applied != 1 {
		t.Fatalf("after second click: applied %d restarted %d", applied, restarted)
	}

	// Newest already; then a failure to check says so and can be tried again.
	titles = nil
	u = &trayUpdate{
		check:   func() (app.UpdateInfo, error) { return app.UpdateInfo{Current: "0.35.0", Latest: "0.35.0"}, nil },
		apply:   func() error { t.Fatal("nothing to apply"); return nil },
		restart: func() error { t.Fatal("nothing to restart"); return nil },
		set:     func(title string, _ bool) { titles = append(titles, title) },
	}
	u.click()
	if titles[len(titles)-1] != "최신 버전입니다 (v0.35.0) · 다시 확인" {
		t.Fatalf("%q", titles)
	}
	u.check = func() (app.UpdateInfo, error) { return app.UpdateInfo{}, errors.New("offline") }
	u.click()
	if titles[len(titles)-1] != "업데이트를 확인하지 못했습니다 · 다시 누르기" {
		t.Fatalf("%q", titles)
	}
}
