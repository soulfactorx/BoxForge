package extterm

import (
	"os/exec"
	"strings"
	"syscall"
)

// winQuote quotes one word for cmd.exe when it holds a space.
func winQuote(s string) string {
	if strings.ContainsAny(s, " \t") {
		return `"` + s + `"`
	}
	return s
}

// openWindows opens a console window running argv.
//
// The program is not started directly: a child Go starts gets no keyboard
// (its input is the null device), and `docker exec -it` then gives up at
// once and the window closes. `start` gives the program a console of its
// own, keyboard and all. Should the command fail, `pause` keeps the window
// open so that the reason can be read.
func openWindows(argv []string) *exec.Cmd {
	words := make([]string, len(argv))
	for i, a := range argv {
		words[i] = winQuote(a)
	}
	cmd := exec.Command("cmd.exe")
	const createNoWindow = 0x08000000 // none for the cmd.exe that only runs `start`
	cmd.SysProcAttr = &syscall.SysProcAttr{
		CmdLine:       `cmd.exe /c start "BoxForge" cmd.exe /c "` + strings.Join(words, " ") + ` || pause"`,
		CreationFlags: createNoWindow,
	}
	return cmd
}
