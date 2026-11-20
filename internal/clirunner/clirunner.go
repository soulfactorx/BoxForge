// Package clirunner runs command-line tools for the parts of Docker that
// live in the client and have no engine API: Compose first of all.
package clirunner

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os/exec"
	"strings"
)

// Run runs name with args in dir ("" for the app's own), calling line with
// each line the tool prints on stdout or stderr, in the order it came. The
// arguments go to the tool as they are: no shell reads them.
func Run(ctx context.Context, dir, name string, args []string, line func(string)) error {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	hideWindow(cmd)
	pr, pw := io.Pipe()
	cmd.Stdout = pw
	cmd.Stderr = pw
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	var last string
	go func() {
		defer close(done)
		sc := bufio.NewScanner(pr)
		sc.Buffer(make([]byte, 64<<10), 1<<20)
		sc.Split(scanLines)
		for sc.Scan() {
			if text := strings.TrimRight(sc.Text(), " \t"); text != "" {
				last = text
				if line != nil {
					line(text)
				}
			}
		}
		// A line too long to hold ends the scan; keep draining so the
		// tool is not left blocked on a full pipe.
		_, _ = io.Copy(io.Discard, pr)
	}()
	err := cmd.Wait()
	pw.Close()
	<-done
	if err != nil {
		if last != "" {
			// The tool's last words say why better than "exit status 1".
			return fmt.Errorf("%s", last)
		}
		return err
	}
	return nil
}

// Output runs name with args and returns what it printed on stdout, trimmed.
func Output(ctx context.Context, name string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	hideWindow(cmd)
	out, err := cmd.Output()
	return strings.TrimSpace(string(out)), err
}

// scanLines splits at \n and at \r: progress output redraws a line with \r.
func scanLines(data []byte, atEOF bool) (advance int, token []byte, err error) {
	for i, b := range data {
		if b == '\n' || b == '\r' {
			return i + 1, data[:i], nil
		}
	}
	if atEOF && len(data) > 0 {
		return len(data), data, nil
	}
	return 0, nil, nil
}
