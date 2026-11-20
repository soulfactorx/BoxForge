package provision

import (
	"context"
	"os/exec"
	"strings"

	"github.com/soulfactorx/boxforge/internal/clirunner"
)

// elevated runs a program as administrator and waits for it. Windows asks
// the user first; a refusal comes back as an error.
func elevated(ctx context.Context, exe string, args ...string) error {
	quoted := make([]string, len(args))
	for i, a := range args {
		quoted[i] = "'" + strings.ReplaceAll(a, "'", "''") + "'"
	}
	ps := "$p = Start-Process -FilePath '" + exe + "' -ArgumentList " + strings.Join(quoted, ",") + " -Verb RunAs -Wait -PassThru; exit $p.ExitCode"
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", ps)
	clirunner.HideWindow(cmd)
	return cmd.Run()
}
