package desktop

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAutostart(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", dir)
	if Autostart() {
		t.Fatal("on before it was set")
	}
	if err := SetAutostart(true); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "autostart", "boxforge.desktop"))
	if err != nil || !strings.Contains(string(b), " --hidden") || !Autostart() {
		t.Fatalf("entry: %q %v", b, err)
	}
	if err := SetAutostart(false); err != nil || Autostart() {
		t.Fatalf("still on: %v", err)
	}
	if err := SetAutostart(false); err != nil {
		t.Errorf("turning off twice: %v", err)
	}
}
