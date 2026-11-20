package desktop

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRegister(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("XDG_DATA_HOME", dir)
	exe, _ := os.Executable()
	if strings.Contains(exe, "go-build") {
		t.Skip("a test binary under go-build is not registered")
	}
	if err := Register([]byte("png")); err != nil {
		t.Fatal(err)
	}
	entry, err := os.ReadFile(filepath.Join(dir, "applications", "boxforge.desktop"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{"StartupWMClass=boxforge", "Exec=\"", "Icon=" + dir} {
		if !strings.Contains(string(entry), want) {
			t.Errorf("entry lacks %q:\n%s", want, entry)
		}
	}
}

func TestQuote(t *testing.T) {
	if got := quote(`/a b/50%"x`); got != `"/a b/50%%\\"x"` {
		t.Error(got)
	}
}
