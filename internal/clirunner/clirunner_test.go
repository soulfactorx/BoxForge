package clirunner

import (
	"context"
	"reflect"
	"runtime"
	"testing"
)

func TestRunStreamsLinesAndReportsTheLastOnFailure(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("uses sh")
	}
	var got []string
	err := Run(context.Background(), "", nil, "sh", []string{"-c", `printf 'one\ntwo\rthree\n'; echo oops >&2; exit 3`}, func(l string) { got = append(got, l) })
	if want := []string{"one", "two", "three", "oops"}; !reflect.DeepEqual(got, want) {
		t.Errorf("lines = %q, want %q", got, want)
	}
	if err == nil || err.Error() != "oops" {
		t.Errorf("err = %v, want the tool's last line", err)
	}
	if err := Run(context.Background(), "", nil, "sh", []string{"-c", "true"}, nil); err != nil {
		t.Errorf("a clean exit gave %v", err)
	}
}
