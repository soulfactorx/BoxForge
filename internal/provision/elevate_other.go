//go:build !windows

package provision

import (
	"context"
	"errors"
)

func elevated(context.Context, string, ...string) error {
	return errors.New("administrator rights are asked for on Windows only")
}
