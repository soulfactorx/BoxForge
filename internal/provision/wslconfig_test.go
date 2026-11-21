package provision

import (
	"strings"
	"testing"
)

func TestSetWSLConfig(t *testing.T) {
	in := "# mine\r\n[wsl2]\r\nmemory=8GB\r\nkernelCommandLine = quiet\r\n\r\n[experimental]\r\nsparseVhd=true\r\n"
	out := setWSLConfig(in, map[string]string{"memory": "4GB", "processors": "2", "swap": ""})
	want := "# mine\r\n[wsl2]\r\nmemory=4GB\r\nkernelCommandLine = quiet\r\n\r\nprocessors=2\r\n[experimental]\r\nsparseVhd=true\r\n"
	if out != want {
		t.Errorf("got\n%q\nwant\n%q", out, want)
	}
	if k := readWSLConfig(out); k["memory"] != "4GB" || k["processors"] != "2" || k["kernelcommandline"] != "quiet" {
		t.Errorf("read back: %v", k)
	}
	// a file with no [wsl2]: one is added; an empty value takes the key away
	out = setWSLConfig("[experimental]\nautoMemoryReclaim=gradual\n", map[string]string{"memory": "6GB"})
	if !strings.HasSuffix(out, "[wsl2]\nmemory=6GB\n") || !strings.Contains(out, "autoMemoryReclaim") {
		t.Errorf("added section: %q", out)
	}
	out = setWSLConfig(out, map[string]string{"memory": ""})
	if strings.Contains(out, "memory=") {
		t.Errorf("an emptied key stayed: %q", out)
	}
	if sizeGB("4096MB") != 4 || sizeGB("6gb") != 6 || sizeGB("1.5GB") != 2 {
		t.Error("sizes")
	}
}
