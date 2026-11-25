package app

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/soulfactorx/boxforge/internal/engine"
	"github.com/soulfactorx/boxforge/internal/extterm"
)

// AgentBox is a box as the screen shows it.
type AgentBox struct {
	Spec    AgentSpec `json:"spec"`
	Project string    `json:"project"`
	File    string    `json:"file"` // its compose.yaml
	Dir     string    `json:"dir"`
	// State of its parts: "" when not made yet; else the engine's state.
	Agent   string   `json:"agent"`
	Service string   `json:"service"`
	Egress  string   `json:"egress"`
	AgentID string   `json:"agentId"`
	Keys    []string `json:"keys"` // the names of the keys it has (never their values)
}

func agentDir(name string) (string, error) {
	if !agentName.MatchString(name) {
		return "", fmt.Errorf("%q is not a box's name", name)
	}
	root := agentsDir()
	if root == "" {
		return "", fmt.Errorf("there is no settings folder for boxes on this PC")
	}
	return filepath.Join(root, name), nil
}

func readAgent(name string) (AgentSpec, string, error) {
	dir, err := agentDir(name)
	if err != nil {
		return AgentSpec{}, "", err
	}
	b, err := os.ReadFile(filepath.Join(dir, "spec.json"))
	if err != nil {
		return AgentSpec{}, "", fmt.Errorf("there is no box named %s", name)
	}
	var s AgentSpec
	if err := json.Unmarshal(b, &s); err != nil {
		return AgentSpec{}, "", err
	}
	return s, dir, nil
}

func writeAgentSpec(dir string, s AgentSpec) error {
	b, _ := json.MarshalIndent(s, "", "  ")
	return os.WriteFile(filepath.Join(dir, "spec.json"), b, 0o600)
}

// AgentBoxes lists the boxes, with the state of their containers.
func (a *App) AgentBoxes() ([]AgentBox, error) {
	out := []AgentBox{}
	root := agentsDir()
	entries, _ := os.ReadDir(root)
	state := map[string]engine.Container{}
	if list, err := a.eng().Containers().List(context.Background()); err == nil {
		for _, c := range list {
			state[c.Name] = c
		}
	}
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		s, dir, err := readAgent(e.Name())
		if err != nil {
			continue
		}
		p := agentProject(s.Name)
		box := AgentBox{Spec: s, Project: p, File: filepath.Join(dir, "compose.yaml"), Dir: dir, Keys: keyNames(dir)}
		if c, ok := state[p+"-agent"]; ok {
			box.Agent, box.AgentID = c.State, c.ID
		}
		box.Service = state[p+"-service"].State
		box.Egress = state[p+"-egress"].State
		out = append(out, box)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Spec.Name < out[j].Spec.Name })
	return out, nil
}

// AgentAllowFor is the address list a box of these agents starts with.
func (a *App) AgentAllowFor(ids []string) []string { return agentAllowFor(ids) }

// AgentSave writes a box's files: a new one (fresh is true; a box of that
// name is refused), or an existing one's changed settings. Bringing it up
// is the Compose "up" of the file it returns.
func (a *App) AgentSave(s AgentSpec, fresh bool) (AgentBox, error) {
	if err := s.check(); err != nil {
		return AgentBox{}, err
	}
	dir, err := agentDir(s.Name)
	if err != nil {
		return AgentBox{}, err
	}
	if _, err := os.Stat(filepath.Join(dir, "spec.json")); err == nil && fresh {
		return AgentBox{}, fmt.Errorf("there is a box named %s already", s.Name)
	} else if err != nil && !fresh {
		return AgentBox{}, fmt.Errorf("there is no box named %s", s.Name)
	}
	if old, _, err := readAgent(s.Name); err == nil {
		s.Mark = old.Mark
	}
	if s.Mark == 0 {
		s.Mark = time.Now().Unix()
	}
	if err := os.MkdirAll(filepath.Join(dir, "egress"), 0o755); err != nil {
		return AgentBox{}, err
	}
	for name, text := range agentFiles(s, a.hostPath) {
		if err := os.WriteFile(filepath.Join(dir, filepath.FromSlash(name)), []byte(text), 0o644); err != nil {
			return AgentBox{}, err
		}
	}
	keys := filepath.Join(dir, "secrets.env")
	if _, err := os.Stat(keys); err != nil {
		if err := os.WriteFile(keys, []byte("# This box's API keys, written by BoxForge.\n"), 0o600); err != nil {
			return AgentBox{}, err
		}
	}
	giveKeys(keys)
	if err := writeAgentSpec(dir, s); err != nil {
		return AgentBox{}, err
	}
	return AgentBox{Spec: s, Project: agentProject(s.Name), File: filepath.Join(dir, "compose.yaml"), Dir: dir, Keys: keyNames(dir)}, nil
}

// AgentRefresh writes a box's files again from its saved settings, as
// this version of BoxForge writes them: done before it is brought up, so
// a box made by an older one gets what is new.
func (a *App) AgentRefresh(name string) error {
	s, _, err := readAgent(name)
	if err != nil {
		return err
	}
	_, err = a.AgentSave(s, false)
	return err
}

// giveKeys lets the box's user read the keys file: when BoxForge runs as
// root on Linux, the box runs as 1000, not as the file's owner.
func giveKeys(file string) {
	if os.Getuid() == 0 {
		uid, gid := agentIDs()
		_ = os.Chown(file, uid, gid)
	}
}

// AgentForget removes what is left of a box once Compose has taken it
// away: its saved copies and its folder (keys and all).
func (a *App) AgentForget(name string) error {
	dir, err := agentDir(name)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	for _, s := range readSnapshots(dir) {
		if err := a.eng().Volumes().Remove(ctx, snapshotVolume(name, s.ID)); err != nil && !strings.Contains(strings.ToLower(err.Error()), "no such volume") {
			return err
		}
	}
	closeBoxPorts(name)
	return os.RemoveAll(dir)
}

// keyNames reads which keys a box has, from its keys file.
func keyNames(dir string) []string {
	out := []string{}
	b, err := os.ReadFile(filepath.Join(dir, "secrets.env"))
	if err != nil {
		return out
	}
	for _, l := range strings.Split(string(b), "\n") {
		if k, _, ok := strings.Cut(l, "="); ok && keyName.MatchString(k) {
			out = append(out, k)
		}
	}
	return out
}

// AgentSetKey puts a key in a box's keys file, or takes it out (value "").
// The box reads it the next time an agent starts in it; its value is never
// shown again.
func (a *App) AgentSetKey(name, key, value string) error {
	_, dir, err := readAgent(name)
	if err != nil {
		return err
	}
	if !keyName.MatchString(key) {
		return fmt.Errorf("%q is not a setting's name (letters, digits and _, like OPENAI_API_KEY)", key)
	}
	value = strings.TrimSpace(value)
	if strings.ContainsAny(value, "\n\r\x00") {
		return fmt.Errorf("a key is one line")
	}
	file := filepath.Join(dir, "secrets.env")
	b, _ := os.ReadFile(file)
	var lines []string
	for _, l := range strings.Split(strings.TrimRight(string(b), "\n"), "\n") {
		if k, _, ok := strings.Cut(l, "="); ok && k == key {
			continue
		}
		lines = append(lines, l)
	}
	if value != "" {
		lines = append(lines, key+"='"+strings.ReplaceAll(value, "'", `'\''`)+"'")
	}
	if err := os.WriteFile(file, []byte(strings.Join(lines, "\n")+"\n"), 0o600); err != nil {
		return err
	}
	giveKeys(file)
	return nil
}

// agentCommand is what runs in the box for one of its agents, or its shell:
// plain words through agentRun where the box has it (made by 0.37.1 or
// later), else agentWrap on the command line.
func agentCommand(s AgentSpec, which string, run bool) ([]string, error) {
	var words []string
	switch which {
	case "shell":
		words = []string{"shell"}
	case "main":
		words = strings.Fields(s.Command)
		if s.Image == "" && len(s.Agents) > 0 {
			k, _ := agentKind(s.Agents[0])
			words = strings.Fields(k.Command)
		}
	default:
		ok := false
		for _, id := range s.Agents {
			if id == which {
				ok = true
			}
		}
		k, known := agentKind(which)
		if !ok || !known {
			return nil, fmt.Errorf("the box has no agent %q", which)
		}
		words = strings.Fields(k.Command)
	}
	if len(words) == 0 {
		return nil, fmt.Errorf("the box has no command to start")
	}
	if run {
		return append([]string{"sh", agentRunPath}, words...), nil
	}
	inner := strings.Join(words, " ")
	if which == "shell" {
		inner = "command -v bash >/dev/null && exec bash || exec sh"
	}
	return []string{"sh", "-c", agentWrap, "boxforge", "sh", "-c", inner}, nil
}

// hasRun reports whether a box has agentRun in it.
func (a *App) hasRun(ctx context.Context, box string) bool {
	_, _, code, err := a.eng().Containers().Output(ctx, box, []string{"test", "-r", agentRunPath}, nil)
	return err == nil && code == 0
}

// AgentTermOpen opens, in the screen's terminal, one of a box's agents
// ("main" for its first, or its kind) or a shell ("shell").
func (a *App) AgentTermOpen(name, which string, cols, rows int) (string, error) {
	s, _, err := readAgent(name)
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	box := agentProject(name) + "-agent"
	run := a.hasRun(ctx, box)
	cmd, err := agentCommand(s, which, run)
	if err != nil {
		return "", err
	}
	id := ""
	if run {
		id = fmt.Sprintf("term-%d", time.Now().UnixNano())
		cmd = append(cmd[:2:2], append([]string{"--term", id}, cmd[2:]...)...)
	}
	sess, err := a.eng().Containers().Exec(ctx, box, cmd, uint(max(cols, 1)), uint(max(rows, 1)))
	if err != nil {
		return "", err
	}
	session := a.attach(sess)
	if id != "" {
		a.mu.Lock()
		if a.boxTerms == nil {
			a.boxTerms = map[string]boxTerm{}
		}
		a.boxTerms[session] = boxTerm{box: box, id: id}
		a.mu.Unlock()
	}
	return session, nil
}

// boxTerm is a terminal open in a box: the box, and the name run.sh wrote
// the started program's process (its session's leader) under.
type boxTerm struct{ box, id string }

// endBoxTerm stops what a closed terminal started: asked to end as a closed
// terminal asks (HUP), then told (TERM), then made to (KILL).
func (a *App) endBoxTerm(t boxTerm) {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	script := `f=/tmp/.boxforge/$1; [ -r "$f" ] || exit 0; p=$(cat "$f"); rm -f "$f"; [ -n "$p" ] || exit 0
kill -HUP -"$p" 2>/dev/null || kill -HUP "$p" 2>/dev/null
( sleep 2; kill -TERM -"$p" 2>/dev/null || kill -TERM "$p" 2>/dev/null; sleep 3; kill -KILL -"$p" 2>/dev/null || kill -KILL "$p" 2>/dev/null ) >/dev/null 2>&1 &`
	_, _, _, _ = a.eng().Containers().Output(ctx, t.box, []string{"sh", "-c", script, "boxforge", t.id}, nil)
}

// AgentOpenTerminal does the same in the desktop's own terminal window.
func (a *App) AgentOpenTerminal(name, which string) error {
	s, _, err := readAgent(name)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	if !a.hasRun(ctx, agentProject(name)+"-agent") {
		return fmt.Errorf("이 상자는 이전 버전의 BoxForge가 만들어서 아직 외부 터미널로 열 수 없습니다. 위의 ▶(설정대로 다시 올리기)를 한 번 누른 뒤 다시 해 주세요")
	}
	cmd, err := agentCommand(s, which, true)
	if err != nil {
		return err
	}
	bin, args, env := a.docker(append([]string{"exec", "-it", agentProject(name) + "-agent"}, cmd...)...)
	for _, kv := range env {
		if k, v, ok := strings.Cut(kv, "="); ok {
			os.Setenv(k, v)
			defer os.Unsetenv(k)
		}
	}
	return extterm.Open(append([]string{bin}, args...))
}

// AgentChange is one file the agent changed.
type AgentChange struct {
	Status string `json:"status"` // git's two letters (M, A, D, ??), or "changed"
	Path   string `json:"path"`
}

// AgentChanges lists what changed in the work folder: as git sees it when
// the folder is a git repository, else the files written since the box was
// made or its files were last saved.
func (a *App) AgentChanges(name string) (map[string]any, error) {
	s, _, err := readAgent(name)
	if err != nil {
		return nil, err
	}
	script := fmt.Sprintf(`cd /workspace || exit 1
if command -v git >/dev/null && git -c safe.directory='*' rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo GIT; git -c safe.directory='*' status --porcelain=v1 -uall | head -n 2000
else
  echo FILES
  # -newermt is GNU find's; busybox's (alpine) knows only minutes.
  { find . \( -name .git -o -name node_modules \) -prune -o -type f -newermt @%d -print 2>/dev/null ||
    find . \( -name .git -o -name node_modules \) -prune -o -type f -mmin -%d -print; } | head -n 2000
fi`, s.Mark, (time.Now().Unix()-s.Mark)/60+1)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, errOut, code, err := a.eng().Containers().Output(ctx, agentProject(name)+"-agent", []string{"sh", "-c", script}, nil)
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, fmt.Errorf("the changes can't be read: %s", strings.TrimSpace(errOut))
	}
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	git := len(lines) > 0 && lines[0] == "GIT"
	files := []AgentChange{}
	for _, l := range lines[1:] {
		switch {
		case l == "":
		case git && len(l) > 3:
			files = append(files, AgentChange{Status: strings.TrimSpace(l[:2]), Path: strings.Trim(l[3:], `"`)})
		case !git:
			files = append(files, AgentChange{Status: "changed", Path: strings.TrimPrefix(l, "./")})
		}
	}
	return map[string]any{"git": git, "since": s.Mark, "files": files}, nil
}

// AgentDiff shows how a changed file differs (git), or its start (no git).
func (a *App) AgentDiff(name, file string) (string, error) {
	if _, _, err := readAgent(name); err != nil {
		return "", err
	}
	clean := path.Clean("/" + file)
	if file == "" || clean == "/" {
		return "", fmt.Errorf("name a file")
	}
	script := `cd /workspace || exit 1
f=".$1"
if command -v git >/dev/null && git -c safe.directory='*' rev-parse --is-inside-work-tree >/dev/null 2>&1 && git -c safe.directory='*' ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then
  git -c safe.directory='*' diff --no-color HEAD -- "$f" | head -c 200000
elif [ -f "$f" ]; then
  head -c 20000 -- "$f"
else
  echo "(deleted)"
fi`
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	out, errOut, code, err := a.eng().Containers().Output(ctx, agentProject(name)+"-agent", []string{"sh", "-c", script, "boxforge", clean}, nil)
	if err != nil {
		return "", err
	}
	if code != 0 {
		return "", fmt.Errorf("%s", strings.TrimSpace(errOut))
	}
	return out, nil
}

// AgentConnection is the addresses a box tried, as its proxy wrote them.
type AgentConnection struct {
	Host  string `json:"host"`
	Port  int    `json:"port"`
	OK    bool   `json:"ok"`
	Count int    `json:"count"`
	Last  int64  `json:"last"` // milliseconds
}

// AgentConnections reads the proxy's record: each address tried, let
// through or stopped, how often and when last. The newest first.
func (a *App) AgentConnections(name string) ([]AgentConnection, error) {
	s, _, err := readAgent(name)
	if err != nil {
		return nil, err
	}
	out := []AgentConnection{}
	if s.Network != "ai" {
		return out, nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var buf bytes.Buffer
	err = a.eng().Containers().Logs(ctx, agentProject(name)+"-egress", 5000, &buf)
	if err != nil && !errors.Is(err, context.DeadlineExceeded) && buf.Len() == 0 {
		return nil, err
	}
	return parseConnections(buf.String()), nil
}

func parseConnections(log string) []AgentConnection {
	type key struct {
		host string
		port int
		ok   bool
	}
	seen := map[key]*AgentConnection{}
	for _, l := range strings.Split(log, "\n") {
		var e struct {
			T    int64  `json:"t"`
			Host string `json:"host"`
			Port int    `json:"port"`
			OK   bool   `json:"ok"`
		}
		if i := strings.IndexByte(l, '{'); i < 0 || json.Unmarshal([]byte(l[i:]), &e) != nil || e.Host == "" {
			continue
		}
		k := key{e.Host, e.Port, e.OK}
		c := seen[k]
		if c == nil {
			c = &AgentConnection{Host: e.Host, Port: e.Port, OK: e.OK}
			seen[k] = c
		}
		c.Count++
		c.Last = max(c.Last, e.T)
	}
	out := []AgentConnection{}
	for _, c := range seen {
		out = append(out, *c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Last > out[j].Last })
	return out
}

// AgentAllow lets a box reach one more address, at once: the proxy reads
// its list again when it changes.
func (a *App) AgentAllow(name, host string) error {
	s, dir, err := readAgent(name)
	if err != nil {
		return err
	}
	for _, h := range s.Allow {
		if h == host {
			return nil
		}
	}
	s.Allow = append(s.Allow, host)
	if err := s.check(); err != nil {
		return err
	}
	files := agentFiles(s, a.hostPath)
	if err := os.WriteFile(filepath.Join(dir, "egress", "allow.txt"), []byte(files["egress/allow.txt"]), 0o644); err != nil {
		return err
	}
	return writeAgentSpec(dir, s)
}

// Snapshots: copies of a box's work folder, each kept in a volume of its
// own that the box itself never sees, to go back to.

func snapshotVolume(name, id string) string { return agentProject(name) + "-snap-" + id }

// below drops the first part of a tar name (the folder it was taken from).
func below(n string) string {
	_, rest, _ := strings.Cut(strings.TrimPrefix(n, "./"), "/")
	return rest
}

// AgentSnapshot is one saved copy.
type AgentSnapshot struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Time  int64  `json:"time"`
}

func readSnapshots(dir string) []AgentSnapshot {
	out := []AgentSnapshot{}
	b, err := os.ReadFile(filepath.Join(dir, "snapshots.json"))
	if err == nil {
		_ = json.Unmarshal(b, &out)
	}
	return out
}

func writeSnapshots(dir string, list []AgentSnapshot) error {
	b, _ := json.MarshalIndent(list, "", "  ")
	return os.WriteFile(filepath.Join(dir, "snapshots.json"), b, 0o600)
}

// AgentSnapshots lists a box's saved copies, newest first.
func (a *App) AgentSnapshots(name string) ([]AgentSnapshot, error) {
	_, dir, err := readAgent(name)
	if err != nil {
		return nil, err
	}
	list := readSnapshots(dir)
	sort.Slice(list, func(i, j int) bool { return list[i].Time > list[j].Time })
	return list, nil
}

// retar passes a tar stream on with each name changed by rename; a name
// it turns to "" is left out.
func retar(r io.Reader, rename func(string) string) io.ReadCloser {
	pr, pw := io.Pipe()
	go func() {
		tr := tar.NewReader(r)
		tw := tar.NewWriter(pw)
		for {
			h, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				pw.CloseWithError(err)
				return
			}
			name := rename(h.Name)
			if name == "" {
				continue
			}
			h.Name = name
			if err := tw.WriteHeader(h); err != nil {
				pw.CloseWithError(err)
				return
			}
			if _, err := io.Copy(tw, tr); err != nil {
				pw.CloseWithError(err)
				return
			}
		}
		pw.CloseWithError(tw.Close())
	}()
	return pr
}

// AgentSnapshotTake saves the box's work folder as it is now, and starts
// "changed files" over from here.
func (a *App) AgentSnapshotTake(name, label string) (AgentSnapshot, error) {
	s, dir, err := readAgent(name)
	if err != nil {
		return AgentSnapshot{}, err
	}
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	now := time.Now()
	snap := AgentSnapshot{ID: now.Format("20060102-150405"), Label: strings.TrimSpace(label), Time: now.Unix()}
	src, err := a.eng().Containers().Archive(ctx, agentProject(name)+"-agent", "/workspace")
	if err != nil {
		return AgentSnapshot{}, err
	}
	defer src.Close()
	vol := snapshotVolume(name, snap.ID)
	if err := a.eng().Volumes().Create(ctx, vol); err != nil {
		return AgentSnapshot{}, err
	}
	r := retar(src, below) // workspace/x → x
	defer r.Close()
	if err := a.eng().Volumes().Put(ctx, vol, "/", r); err != nil {
		return AgentSnapshot{}, err
	}
	list := append(readSnapshots(dir), snap)
	if err := writeSnapshots(dir, list); err != nil {
		return AgentSnapshot{}, err
	}
	s.Mark = snap.Time
	return snap, writeAgentSpec(dir, s)
}

// AgentSnapshotRestore puts the work folder back as it was saved: what is
// in it now is deleted first. The box must be running.
func (a *App) AgentSnapshotRestore(name, id string) error {
	_, dir, err := readAgent(name)
	if err != nil {
		return err
	}
	found := false
	for _, s := range readSnapshots(dir) {
		found = found || s.ID == id
	}
	if !found {
		return fmt.Errorf("there is no saved copy %s", id)
	}
	ctx, cancel := context.WithTimeout(context.Background(), pullTimeout)
	defer cancel()
	src, err := a.eng().Volumes().Archive(ctx, snapshotVolume(name, id), "/")
	if err != nil {
		return err
	}
	defer src.Close()
	box := agentProject(name) + "-agent"
	// Emptied by the box's own user: what the agent made is its own.
	if _, errOut, code, err := a.eng().Containers().Output(ctx, box, []string{"sh", "-c", "find /workspace -mindepth 1 -delete"}, nil); err != nil {
		return err
	} else if code != 0 {
		return fmt.Errorf("the work folder couldn't be emptied: %s", strings.TrimSpace(errOut))
	}
	r := retar(src, below) // the folder itself is there already
	defer r.Close()
	return a.eng().Containers().Put(ctx, box, "/workspace", r)
}

// AgentSnapshotRemove deletes a saved copy.
func (a *App) AgentSnapshotRemove(name, id string) error {
	_, dir, err := readAgent(name)
	if err != nil {
		return err
	}
	list := readSnapshots(dir)
	var kept []AgentSnapshot
	for _, s := range list {
		if s.ID != id {
			kept = append(kept, s)
		}
	}
	if len(kept) == len(list) {
		return fmt.Errorf("there is no saved copy %s", id)
	}
	ctx, cancel := context.WithTimeout(context.Background(), actionTimeout)
	defer cancel()
	if err := a.eng().Volumes().Remove(ctx, snapshotVolume(name, id)); err != nil && !strings.Contains(strings.ToLower(err.Error()), "no such volume") {
		return err
	}
	return writeSnapshots(dir, kept)
}
