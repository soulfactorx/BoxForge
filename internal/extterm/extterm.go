// Package extterm opens the desktop's own terminal window running a command.
package extterm

import (
	"fmt"
	"os/exec"
	"runtime"
	"strings"
)

// Linux terminals, in the order tried, with the flag after which the
// command to run follows.
var linuxTerminals = [][2]string{
	{"x-terminal-emulator", "-e"},
	{"gnome-terminal", "--"},
	{"konsole", "-e"},
	{"xfce4-terminal", "-x"},
	{"kitty", ""},
	{"alacritty", "-e"},
	{"xterm", "-e"},
}

// shQuote quotes one word for a POSIX shell.
func shQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// Open starts a terminal window running argv. It returns once the window
// is asked for, not when the command ends.
func Open(argv []string) error {
	if len(argv) == 0 {
		return fmt.Errorf("no command to run")
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// A console program started with a console of its own gets a
		// window: Windows Terminal where that is the default, else the
		// classic console.
		cmd = exec.Command(argv[0], argv[1:]...)
		newConsole(cmd)
	case "darwin":
		words := make([]string, len(argv))
		for i, a := range argv {
			words[i] = shQuote(a)
		}
		// The command line goes into AppleScript as a string literal.
		line := strings.NewReplacer(`\`, `\\`, `"`, `\"`).Replace(strings.Join(words, " "))
		cmd = exec.Command("osascript",
			"-e", `tell application "Terminal" to do script "`+line+`"`,
			"-e", `tell application "Terminal" to activate`)
	default:
		for _, t := range linuxTerminals {
			path, err := exec.LookPath(t[0])
			if err != nil {
				continue
			}
			args := []string{}
			if t[1] != "" {
				args = append(args, t[1])
			}
			cmd = exec.Command(path, append(args, argv...)...)
			break
		}
		if cmd == nil {
			return fmt.Errorf("no terminal program was found on this PC")
		}
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }() // so it leaves no zombie behind
	return nil
}
