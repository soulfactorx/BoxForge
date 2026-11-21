package provision

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// The WSL 2 virtual machine's resources live in %UserProfile%\.wslconfig,
// under [wsl2]. They are WSL's, not BoxForge's: every distribution shares
// the machine, and a change takes effect only when WSL restarts, which
// stops every distribution. Only the keys BoxForge sets are touched; the
// rest of the file is kept as it is written.

// WSLResources is what the WSL machine may use. 0 means WSL's own default
// (half the memory, all the processors).
type WSLResources struct {
	MemoryGB   int `json:"memoryGB"`
	Processors int `json:"processors"`
	SwapGB     int `json:"swapGB"`
	// Sparse: the distribution's virtual disk gives back what it frees.
	Sparse bool `json:"sparse"`
	// DiskBytes is the size of BoxForge's distribution's virtual disk file.
	DiskBytes int64 `json:"diskBytes"`
	// Pending says the file was changed since WSL last started.
	Pending bool `json:"pending"`
}

// wslconfigFile is %UserProfile%\.wslconfig. BOXFORGE_WSLCONFIG names
// another file for tests.
func wslconfigFile() (string, error) {
	if f := os.Getenv("BOXFORGE_WSLCONFIG"); f != "" {
		return f, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".wslconfig"), nil
}

// sizeGB reads "4GB", "4096MB", "4g" as whole gigabytes.
func sizeGB(v string) int {
	v = strings.ToUpper(strings.TrimSpace(v))
	num := strings.TrimRight(v, "BKMGT")
	n, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0
	}
	switch strings.TrimPrefix(v, num) {
	case "MB", "M":
		n /= 1024
	case "TB", "T":
		n *= 1024
	}
	return int(n + 0.5)
}

// readWSLConfig returns the [wsl2] keys of the file, lower-cased.
func readWSLConfig(text string) map[string]string {
	out := map[string]string{}
	in := false
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if strings.HasPrefix(line, "[") {
			in = strings.EqualFold(strings.Trim(line, "[] \t"), "wsl2")
			continue
		}
		if !in || line == "" || line[0] == '#' || line[0] == ';' {
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok {
			out[strings.ToLower(strings.TrimSpace(k))] = strings.TrimSpace(v)
		}
	}
	return out
}

// setWSLConfig writes keys into the [wsl2] section of text: in place when
// a key is there, at the section's end when not, and away when its value
// is "". A file with no such section gets one.
func setWSLConfig(text string, keys map[string]string) string {
	nl := "\n"
	if strings.Contains(text, "\r\n") {
		nl = "\r\n"
	}
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	done := map[string]bool{}
	var out []string
	in, seen := false, false
	flush := func() {
		for _, k := range []string{"memory", "processors", "swap"} {
			if v, ok := keys[k]; ok && !done[k] && v != "" {
				out = append(out, k+"="+v)
				done[k] = true
			}
		}
	}
	for _, line := range lines {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "[") {
			if in {
				flush()
			}
			in = strings.EqualFold(strings.Trim(t, "[] \t"), "wsl2")
			seen = seen || in
			out = append(out, line)
			continue
		}
		if in {
			if k, _, ok := strings.Cut(t, "="); ok && t[0] != '#' && t[0] != ';' {
				key := strings.ToLower(strings.TrimSpace(k))
				if v, mine := keys[key]; mine {
					if v != "" && !done[key] {
						out = append(out, key+"="+v)
					}
					done[key] = true
					continue
				}
			}
		}
		out = append(out, line)
	}
	if in {
		flush()
	}
	if !seen {
		if len(out) > 0 {
			out = append(out, "")
		}
		out = append(out, "[wsl2]")
		flush()
	}
	return strings.Join(out, nl) + nl
}

// vhdx is the virtual disk file of BoxForge's distribution.
func vhdx() string {
	dir, err := dataDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "ext4.vhdx")
}

// Resources returns the WSL machine's limits and the disk's size.
func Resources() (WSLResources, error) {
	var r WSLResources
	file, err := wslconfigFile()
	if err != nil {
		return r, err
	}
	b, err := os.ReadFile(file)
	if err != nil && !os.IsNotExist(err) {
		return r, err
	}
	keys := readWSLConfig(string(b))
	r.MemoryGB = sizeGB(keys["memory"])
	r.Processors, _ = strconv.Atoi(keys["processors"])
	r.SwapGB = sizeGB(keys["swap"])
	if st, err := os.Stat(vhdx()); err == nil {
		r.DiskBytes = st.Size()
	}
	return r, nil
}

// SetResources writes the limits into .wslconfig. With restart, WSL is
// shut down at once so that they take effect (every distribution stops;
// BoxForge's engine starts again when next used).
func SetResources(ctx context.Context, r WSLResources, restart bool) error {
	if r.MemoryGB < 0 || r.Processors < 0 || r.SwapGB < 0 {
		return errors.New("a limit can't be below zero")
	}
	file, err := wslconfigFile()
	if err != nil {
		return err
	}
	b, err := os.ReadFile(file)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	keys := map[string]string{"memory": "", "processors": "", "swap": ""}
	if r.MemoryGB > 0 {
		keys["memory"] = fmt.Sprintf("%dGB", r.MemoryGB)
	}
	if r.Processors > 0 {
		keys["processors"] = strconv.Itoa(r.Processors)
	}
	if r.SwapGB > 0 {
		keys["swap"] = fmt.Sprintf("%dGB", r.SwapGB)
	}
	text := setWSLConfig(string(b), keys)
	if string(b) != "" {
		// The user's own file: its last state is kept beside it.
		_ = os.WriteFile(file+".boxforge-backup", b, 0o644)
	}
	if err := os.WriteFile(file, []byte(text), 0o644); err != nil {
		return err
	}
	if restart {
		_, err := wsl(ctx, "--shutdown")
		return err
	}
	return nil
}

// SetSparse makes BoxForge's distribution's virtual disk give back the
// space its files no longer use (WSL 2.0 or newer). WSL must be stopped
// for it, so it is shut down first.
func SetSparse(ctx context.Context, on bool) error {
	if !hasDistro() {
		return errors.New("BoxForge's own engine is not installed")
	}
	if _, err := wsl(ctx, "--shutdown"); err != nil {
		return err
	}
	if _, err := wsl(ctx, "--manage", Distro, "--set-sparse", strconv.FormatBool(on)); err != nil {
		return fmt.Errorf("WSL did not take it (WSL 2.0 or newer is needed; \"wsl --update\" updates it): %w", err)
	}
	return nil
}
