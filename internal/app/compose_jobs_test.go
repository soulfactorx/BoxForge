package app

import (
	"errors"
	"strings"
	"testing"
)

func TestComposeJobs(t *testing.T) {
	a := &App{}
	j, err := startComposeJob(ComposeRequest{Key: "k1", Project: "bfa-x", Action: "upbuild"})
	if err != nil {
		t.Fatal(err)
	}
	j.add("Building agent")
	// The same project again while it runs: refused, not made twice.
	if _, err := startComposeJob(ComposeRequest{Key: "k2", Project: "bfa-x", Action: "upbuild"}); err == nil || !strings.Contains(err.Error(), "진행 중") {
		t.Fatalf("second run: %v", err)
	}
	var found *ComposeJob
	for _, c := range a.ComposeJobs() {
		if c.Key == "k1" {
			found = &c
		}
	}
	if found == nil || !found.Running || strings.Join(found.Lines, "") != "Building agent" {
		t.Fatalf("jobs: %+v", a.ComposeJobs())
	}
	j.end(errors.New("boom"))
	for _, c := range a.ComposeJobs() {
		if c.Key == "k1" && (c.Running || c.Error != "boom") {
			t.Fatalf("ended job: %+v", c)
		}
	}
	// Ended: the project can be worked on again.
	if _, err := startComposeJob(ComposeRequest{Key: "k3", Project: "bfa-x", Action: "stop"}); err != nil {
		t.Fatal(err)
	}
}
