package engine

import "testing"

func TestFailedStatus(t *testing.T) {
	for _, c := range []struct {
		state, status string
		want          bool
	}{
		{"running", "Up 3 minutes", false},
		{"exited", "Exited (0) 2 hours ago", false},
		{"exited", "Exited (1) 2 hours ago", true},
		{"exited", "Exited (137) 1 second ago", false},
		{"exited", "Exited (143) 1 second ago", false},
		{"exited", "Exited (127) 1 second ago", true},
		{"created", "Created", false},
		{"dead", "Dead", true},
		{"exited", "", false},
	} {
		if got := FailedStatus(c.state, c.status); got != c.want {
			t.Errorf("FailedStatus(%q, %q) = %v, want %v", c.state, c.status, got, c.want)
		}
	}
}
