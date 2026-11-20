// Package update keeps the app current from the project's GitHub releases:
// it finds the newest release, downloads this platform's program, checks it
// against the release's checksum list, and puts it in place of the one
// running. The new one starts at the next launch.
package update

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Where releases are published. BOXFORGE_UPDATE_API names a stand-in for tests.
func api() string {
	if u := os.Getenv("BOXFORGE_UPDATE_API"); u != "" {
		return u
	}
	return "https://api.github.com/repos/soulfactorx/BoxForge/releases/latest"
}

// Release is one published version.
type Release struct {
	Version string `json:"version"` // without the tag's "v"
	Notes   string `json:"notes"`
	Page    string `json:"page"`

	asset string // download address of this platform's program
	sums  string // download address of the checksum list
}

// AssetName is what this platform's program is called in a release.
func AssetName() string {
	switch runtime.GOOS {
	case "windows":
		return "BoxForge-windows-" + runtime.GOARCH + ".exe"
	case "darwin":
		// One program for both Intel and Apple chips: the one inside the app.
		return "BoxForge-darwin-universal"
	}
	return "BoxForge-" + runtime.GOOS + "-" + runtime.GOARCH
}

// Latest asks GitHub for the newest release.
func Latest(ctx context.Context) (Release, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", api(), nil)
	if err != nil {
		return Release{}, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return Release{}, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return Release{}, errors.New("no release has been published yet")
	}
	if res.StatusCode != http.StatusOK {
		return Release{}, fmt.Errorf("the release server answered %s", res.Status)
	}
	var body struct {
		TagName string `json:"tag_name"`
		Body    string `json:"body"`
		HTMLURL string `json:"html_url"`
		Assets  []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
		} `json:"assets"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 4<<20)).Decode(&body); err != nil {
		return Release{}, err
	}
	rel := Release{Version: strings.TrimPrefix(body.TagName, "v"), Notes: body.Body, Page: body.HTMLURL}
	for _, a := range body.Assets {
		switch a.Name {
		case AssetName():
			rel.asset = a.URL
		case "checksums.txt":
			rel.sums = a.URL
		}
	}
	return rel, nil
}

// HasProgram reports whether the release carries a program for this
// platform, with a checksum to check it by.
func (r Release) HasProgram() bool { return r.asset != "" && r.sums != "" }

// parts splits "1.12.3" into numbers; ok is false for anything else.
func parts(v string) ([3]int, bool) {
	var out [3]int
	f := strings.Split(strings.TrimPrefix(v, "v"), ".")
	if len(f) != 3 {
		return out, false
	}
	for i, s := range f {
		n, err := strconv.Atoi(s)
		if err != nil || n < 0 {
			return out, false
		}
		out[i] = n
	}
	return out, true
}

// Newer reports whether latest is a later version than current. A build
// that carries no proper version ("dev") is never updated.
func Newer(current, latest string) bool {
	c, ok1 := parts(current)
	l, ok2 := parts(latest)
	if !ok1 || !ok2 {
		return false
	}
	for i := range c {
		if l[i] != c[i] {
			return l[i] > c[i]
		}
	}
	return false
}

func get(ctx context.Context, url string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return nil, err
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode != http.StatusOK {
		res.Body.Close()
		return nil, fmt.Errorf("the download server answered %s", res.Status)
	}
	return res, nil
}

// wanted reads the checksum list for name's SHA-256.
func wanted(ctx context.Context, url, name string) (string, error) {
	res, err := get(ctx, url)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	sc := bufio.NewScanner(io.LimitReader(res.Body, 1<<20))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name && len(f[0]) == 64 {
			return strings.ToLower(f[0]), nil
		}
	}
	return "", fmt.Errorf("%s is not in the release's checksum list", name)
}

// Apply downloads the release's program and puts it in place of the one
// running, which goes on running until it is closed. progress is told the
// bytes fetched so far and the total (0 while unknown).
func Apply(ctx context.Context, r Release, progress func(done, total int64)) error {
	if !r.HasProgram() {
		return errors.New("this release has no program for this kind of PC")
	}
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return err
	}
	want, err := wanted(ctx, r.sums, AssetName())
	if err != nil {
		return err
	}
	res, err := get(ctx, r.asset)
	if err != nil {
		return err
	}
	defer res.Body.Close()

	// Beside the program, so that moving it into place is one step on the
	// same disk.
	fresh := exe + ".new"
	f, err := os.OpenFile(fresh, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		return fmt.Errorf("the folder the app is in can't be written to (%w); move the app to a folder of your own", err)
	}
	hash := sha256.New()
	var done int64
	var last time.Time
	buf := make([]byte, 256<<10)
	for {
		n, rerr := res.Body.Read(buf)
		if n > 0 {
			if _, err := f.Write(buf[:n]); err != nil {
				f.Close()
				os.Remove(fresh)
				return err
			}
			hash.Write(buf[:n])
			done += int64(n)
			if progress != nil && time.Since(last) > 200*time.Millisecond {
				last = time.Now()
				progress(done, max(res.ContentLength, 0))
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			f.Close()
			os.Remove(fresh)
			return rerr
		}
	}
	if err := f.Close(); err != nil {
		os.Remove(fresh)
		return err
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != want {
		os.Remove(fresh)
		return errors.New("the download does not match the release's checksum; it was not installed")
	}
	// A running program can't be written over, but it can be moved aside:
	// the old one keeps running from its new name and is removed at the
	// next start.
	old := exe + ".old"
	os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		os.Remove(fresh)
		return err
	}
	if err := os.Rename(fresh, exe); err != nil {
		_ = os.Rename(old, exe) // put it back
		os.Remove(fresh)
		return err
	}
	return nil
}

// Cleanup removes what an earlier update left beside the program.
func Cleanup() {
	if exe, err := os.Executable(); err == nil {
		if exe, err = filepath.EvalSymlinks(exe); err == nil {
			os.Remove(exe + ".old")
			os.Remove(exe + ".new")
		}
	}
}
