package update

import "testing"

func TestNewer(t *testing.T) {
	for _, c := range []struct {
		current, latest string
		want            bool
	}{
		{"0.9.0", "0.9.1", true},
		{"0.9.9", "0.10.0", true},
		{"1.0.0", "0.99.99", false},
		{"1.2.3", "1.2.3", false},
		{"1.2.3", "v1.3.0", true},
		{"dev", "9.9.9", false},  // a hand-made build is left alone
		{"1.0.0", "next", false}, // a tag that is not a version
		{"1.0", "1.0.1", false},
	} {
		if got := Newer(c.current, c.latest); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.current, c.latest, got, c.want)
		}
	}
}
