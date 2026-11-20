package engines

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/soulfactorx/boxforge/internal/clirunner"
)

// cmdConn is a connection whose two directions are a process's stdin and
// stdout. `docker system dial-stdio`, run next to an engine, joins them to
// the engine's socket: that is how an engine inside WSL is reached with no
// network port opened.
type cmdConn struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser

	mu     sync.Mutex
	stderr bytes.Buffer
	once   sync.Once
}

type lockedWriter struct{ c *cmdConn }

func (w lockedWriter) Write(p []byte) (int, error) {
	w.c.mu.Lock()
	defer w.c.mu.Unlock()
	return w.c.stderr.Write(p)
}

// dialCommand starts the command and returns the connection to it.
func dialCommand(ctx context.Context, name string, args ...string) (net.Conn, error) {
	// Not CommandContext: the connection outlives the dial's context, and
	// Close ends the process.
	cmd := exec.Command(name, args...)
	clirunner.HideWindow(cmd)
	c := &cmdConn{cmd: cmd}
	var err error
	if c.stdin, err = cmd.StdinPipe(); err != nil {
		return nil, err
	}
	if c.stdout, err = cmd.StdoutPipe(); err != nil {
		return nil, err
	}
	cmd.Stderr = lockedWriter{c}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return c, nil
}

func (c *cmdConn) Read(p []byte) (int, error) {
	n, err := c.stdout.Read(p)
	if err == io.EOF && n == 0 {
		// The helper ended. If it said why (no docker there, permission
		// denied), that is the error worth showing.
		c.mu.Lock()
		why := strings.TrimSpace(c.stderr.String())
		c.mu.Unlock()
		if why != "" {
			return 0, errors.New(lastLine(why))
		}
	}
	return n, err
}

func (c *cmdConn) Write(p []byte) (int, error) { return c.stdin.Write(p) }

// CloseWrite ends our side of the conversation while still reading the
// answer: an attached container's stdin is closed this way.
func (c *cmdConn) CloseWrite() error { return c.stdin.Close() }

func (c *cmdConn) Close() error {
	c.once.Do(func() {
		_ = c.stdin.Close()
		done := make(chan struct{})
		go func() { _ = c.cmd.Wait(); close(done) }()
		// With its stdin closed the helper ends by itself; one that
		// doesn't is ended.
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			_ = c.cmd.Process.Kill()
			<-done
		}
	})
	return nil
}

type cmdAddr string

func (a cmdAddr) Network() string { return "command" }
func (a cmdAddr) String() string  { return string(a) }

func (c *cmdConn) LocalAddr() net.Addr              { return cmdAddr("local") }
func (c *cmdConn) RemoteAddr() net.Addr             { return cmdAddr(fmt.Sprint(c.cmd.Args)) }
func (c *cmdConn) SetDeadline(time.Time) error      { return nil }
func (c *cmdConn) SetReadDeadline(time.Time) error  { return nil }
func (c *cmdConn) SetWriteDeadline(time.Time) error { return nil }

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}
