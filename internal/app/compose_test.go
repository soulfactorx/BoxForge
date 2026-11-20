package app

import (
	"reflect"
	"testing"
)

func TestParseDryRun(t *testing.T) {
	got := parseDryRun([]string{
		" Container proj-db-1 Running ",
		" Container proj-admin-1 Running",
		"DRY-RUN MODE -  Container proj-was-1  Recreate",
		" Container proj-ide-1 Stopping",
		" Container proj-ide-1 Stopped",
		" Container proj-ide-1 Removing",
		" Container proj-ide-1 Removed",
		" Container proj-was-1 Recreated",
		" Container proj-was-1 Starting",
		" Container proj-was-1 Started",
		" Network proj_extra Creating",
		" Network proj_extra Created",
		" Container proj-new-1 Creating",
		" Container proj-new-1 Created",
		" Container proj-new-1 Starting",
		" Container proj-idle-1 Starting",
		"some other line of four words",
	})
	want := []Change{
		{"Container", "proj-db-1", "keep"},
		{"Container", "proj-admin-1", "keep"},
		{"Container", "proj-was-1", "recreate"},
		{"Container", "proj-ide-1", "remove"},
		{"Network", "proj_extra", "create"},
		{"Container", "proj-new-1", "create"},
		{"Container", "proj-idle-1", "start"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("got  %v\nwant %v", got, want)
	}
}
