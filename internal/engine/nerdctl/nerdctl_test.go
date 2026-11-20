package nerdctl

import (
	"archive/tar"
	"bytes"
	"context"
	"io"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/soulfactorx/boxforge/internal/engine"
)

func TestSize(t *testing.T) {
	for in, want := range map[string]int64{"9.089MB": 9089000, "8.0 KiB": 8192, "828KiB": 847872, "0B": 0, "": 0} {
		if got := size(in); got != want {
			t.Errorf("size(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestFault(t *testing.T) {
	err := fault([]byte("time=\"x\" level=fatal msg=\"no such container \\\"a\\\"\"\n"), io.EOF)
	if err.Error() != `no such container "a"` {
		t.Error(err)
	}
}

// TestLive runs against a real containerd: BOXFORGE_NERDCTL_IMAGE names an
// image that is there (with a shell and tar).
func TestLive(t *testing.T) {
	img := os.Getenv("BOXFORGE_NERDCTL_IMAGE")
	if img == "" {
		t.Skip("BOXFORGE_NERDCTL_IMAGE is not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	rt, err := Connect(Local)
	if err != nil {
		t.Fatal(err)
	}
	info, _ := rt.Info(ctx)
	t.Logf("info: %+v", info)
	events, _ := rt.Events(ctx)
	cs, vs, ns := rt.Containers(), rt.Volumes(), rt.Networks()
	_ = cs.Remove(ctx, "bf-live", true, true)
	_ = vs.Remove(ctx, "bf-live-data")
	_ = vs.Remove(ctx, "bf-live-copy")
	_ = ns.Remove(ctx, "bf-live-net")

	if err := ns.Create(ctx, "bf-live-net", ""); err != nil {
		t.Fatal(err)
	}
	id, err := cs.Run(ctx, engine.RunSpec{
		Image: img, Name: "bf-live", Network: "bf-live-net", Env: []string{"WHO=box"},
		Mounts: []engine.MountSpec{{Source: "bf-live-data", Target: "/data"}}, Restart: "unless-stopped",
		Command: []string{"sh", "-c", "echo started; echo hello > /data/note.txt; sleep 600"},
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case e := <-events:
		t.Logf("event: %+v", e)
	case <-time.After(5 * time.Second):
		t.Error("no event after a run")
	}
	list, err := cs.List(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var c engine.Container
	for _, x := range list {
		if x.ID == id {
			c = x
		}
	}
	t.Logf("container: %+v", c)
	if c.Name != "bf-live" || c.State != "running" || len(c.Volumes) != 1 || len(c.Networks) != 1 || c.Networks[0].Network != "bf-live-net" || c.Networks[0].IP == "" {
		t.Errorf("the list does not describe the container: %+v", c)
	}
	time.Sleep(time.Second)
	var logs bytes.Buffer
	lctx, stop := context.WithTimeout(ctx, 2*time.Second)
	_ = cs.Logs(lctx, id, 10, &logs)
	stop()
	if !strings.Contains(logs.String(), "started") {
		t.Errorf("logs: %q", logs.String())
	}
	stdout, _, code, err := cs.Output(ctx, id, []string{"sh", "-c", "echo $WHO; exit 4"}, nil)
	if err != nil || code != 4 || strings.TrimSpace(stdout) != "box" {
		t.Errorf("output: %q %d %v", stdout, code, err)
	}
	files, err := cs.Files(ctx, id, "/data")
	if err != nil || len(files) != 1 || files[0].Name != "note.txt" {
		t.Errorf("files: %+v %v", files, err)
	}
	st, err := cs.StatsOnce(ctx, id)
	if err != nil || st.MemUsed == 0 {
		t.Errorf("stats: %+v %v", st, err)
	}
	sizes, err := cs.Sizes(ctx)
	if err != nil || sizes[id].RootFS == 0 {
		t.Errorf("sizes: %+v %v", sizes[id], err)
	}

	// a terminal
	sess, err := cs.Exec(ctx, id, []string{"sh"}, 100, 30)
	if err != nil {
		t.Fatal(err)
	}
	got := make(chan string, 1)
	go func() { b, _ := io.ReadAll(sess); got <- string(b) }()
	time.Sleep(time.Second)
	if err := sess.Resize(ctx, 120, 40); err != nil {
		t.Errorf("resize: %v", err)
	}
	time.Sleep(500 * time.Millisecond)
	_, _ = sess.Write([]byte("echo t-$((20+1)); stty size; exit\n"))
	select {
	case text := <-got:
		if !strings.Contains(text, "t-21") || !strings.Contains(text, "40 120") || strings.Contains(text, "BOXFORGE") {
			t.Errorf("terminal: %q", text)
		}
	case <-time.After(15 * time.Second):
		t.Error("the terminal did not end")
	}
	_ = sess.Close()

	// a pipe
	p, err := cs.Pipe(ctx, id, []string{"cat"})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = p.Write([]byte("through"))
	_ = p.(interface{ CloseWrite() error }).CloseWrite()
	b, _ := io.ReadAll(p)
	_ = p.Close()
	if string(b) != "through" {
		t.Errorf("pipe: %q", b)
	}

	// archives: a file out of the container, a volume to another volume
	rc, err := cs.Archive(ctx, id, "/data/note.txt")
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(rc)
	h, err := tr.Next()
	if err != nil || h.Name != "note.txt" {
		t.Errorf("archive: %+v %v", h, err)
	}
	rc.Close()
	vfiles, err := vs.Files(ctx, "bf-live-data", "/")
	if err != nil || len(vfiles) != 1 {
		t.Errorf("volume files: %+v %v", vfiles, err)
	}
	rc, err = vs.Archive(ctx, "bf-live-data", "/")
	if err != nil {
		t.Fatal(err)
	}
	if err := vs.Restore(ctx, "bf-live-copy", rc); err != nil {
		t.Error(err)
	}
	rc.Close()
	copied, err := vs.Files(ctx, "bf-live-copy", "/")
	if err != nil || len(copied) != 1 || copied[0].Name != "note.txt" {
		t.Errorf("restored volume: %+v %v", copied, err)
	}
	vsizes, err := vs.Sizes(ctx)
	t.Logf("volume sizes: %v %v", vsizes, err)

	nets, err := ns.List(ctx)
	found := false
	for _, n := range nets {
		found = found || (n.Name == "bf-live-net" && n.Subnet != "")
	}
	if err != nil || !found {
		t.Errorf("networks: %+v %v", nets, err)
	}
	ims, err := rt.Images().List(ctx)
	if err != nil || len(ims) == 0 || ims[0].Size == 0 {
		t.Errorf("images: %+v %v", ims, err)
	}
	d, err := rt.Images().Defaults(ctx, img)
	t.Logf("defaults: %+v %v", d, err)
	if err := cs.Commit(ctx, id, "bf-live-image:1"); err != nil {
		t.Error(err)
	}
	raw, _ := cs.Inspect(ctx, id)
	if err := cs.Rename(ctx, id, "bf-live2"); err != nil {
		t.Error(err)
	}
	if err := cs.Pause(ctx, id); err != nil {
		t.Error(err)
	}
	if err := cs.Unpause(ctx, id); err != nil {
		t.Error(err)
	}
	if err := cs.Stop(ctx, id); err != nil {
		t.Error(err)
	}
	list, _ = cs.List(ctx)
	for _, x := range list {
		if x.ID == id {
			t.Logf("stopped: %s %q failed=%v", x.State, x.Status, x.Failed)
			if x.State != "exited" {
				t.Errorf("state after stop: %s", x.State)
			}
		}
	}
	// stopped: files and archives come from the export
	sfiles, err := cs.Files(ctx, id, "/etc")
	ok := false
	for _, f := range sfiles {
		ok = ok || (f.Name == "hostname" && f.Kind == "file")
	}
	if err != nil || !ok {
		t.Errorf("files of a stopped container: %d entries, %v", len(sfiles), err)
	}
	if top, err := cs.Files(ctx, id, "/"); err != nil || len(top) < 5 {
		t.Errorf("top folder of a stopped container: %+v %v", top, err)
	}
	src, err := cs.Archive(ctx, id, "/etc/hostname")
	if err != nil {
		t.Fatal(err)
	}
	if h, err := tar.NewReader(src).Next(); err != nil || h.Name != "hostname" || h.Size == 0 {
		t.Errorf("archive of a stopped container: %+v %v", h, err)
	}
	src.Close()
	if err := cs.Remove(ctx, id, true, false); err != nil {
		t.Error(err)
	}
	nid, notes, err := cs.CreateFrom(ctx, raw, "bf-live-image:1")
	t.Logf("created from: %s %v %v", nid, notes, err)
	if err != nil {
		t.Error(err)
	} else {
		_ = cs.Remove(ctx, nid, true, false)
	}
	u, err := rt.Usage(ctx)
	t.Logf("usage: %+v %v", u, err)
	_ = rt.Images().Remove(ctx, "bf-live-image:1", true)
	_ = vs.Remove(ctx, "bf-live-data")
	_ = vs.Remove(ctx, "bf-live-copy")
	if err := ns.Remove(ctx, "bf-live-net"); err != nil {
		t.Error(err)
	}
}

// TestUnnamed: an image that came without a name can be listed and
// removed (BOXFORGE_NERDCTL_UNNAMED is an archive holding one).
func TestUnnamed(t *testing.T) {
	file := os.Getenv("BOXFORGE_NERDCTL_UNNAMED")
	if file == "" {
		t.Skip("BOXFORGE_NERDCTL_UNNAMED is not set")
	}
	ctx := context.Background()
	rt, err := Connect(Local)
	if err != nil {
		t.Fatal(err)
	}
	f, _ := os.Open(file)
	defer f.Close()
	before, _ := rt.Images().List(ctx)
	if err := rt.Images().Load(ctx, f); err != nil {
		t.Fatal(err)
	}
	after, _ := rt.Images().List(ctx)
	var fresh *engine.Image
	for i, im := range after {
		found := false
		for _, b := range before {
			found = found || b.ID == im.ID
		}
		if !found {
			fresh = &after[i]
		}
	}
	if fresh == nil {
		t.Fatal("the loaded image is not listed")
	}
	if len(fresh.Tags) != 0 {
		t.Errorf("a made-up name is shown as a tag: %v", fresh.Tags)
	}
	if err := rt.Images().Remove(ctx, fresh.ID, false); err != nil {
		t.Errorf("remove: %v", err)
	}
}
