package app

import (
	"strings"
	"testing"
)

func TestHideSecrets(t *testing.T) {
	in := `{"apiVersion":"v1","items":[{"kind":"Secret","metadata":{"name":"db","namespace":"default",
"annotations":{"kubectl.kubernetes.io/last-applied-configuration":"{\"stringData\":{\"password\":\"hunter2\"}}"}},
"data":{"password":"aHVudGVyMg=="},"type":"Opaque"}]}`
	out, err := hideSecrets(in)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "aHVudGVyMg") || strings.Contains(out, "hunter2") {
		t.Fatalf("a value is left: %s", out)
	}
	if !strings.Contains(out, `"sizes":{"password":7}`) || !strings.Contains(out, `"name":"db"`) {
		t.Fatalf("keys or names lost: %s", out)
	}
}

func TestKubeCreateDataChecks(t *testing.T) {
	a := &App{}
	for _, c := range []struct {
		kind, name string
		data       map[string]string
	}{
		{"pod", "x", map[string]string{"a": "b"}},
		{"secret", "Bad_Name", map[string]string{"a": "b"}},
		{"secret", "ok", nil},
		{"configmap", "ok", map[string]string{"no spaces": "b"}},
	} {
		if err := a.KubeCreateData(c.kind, "default", c.name, c.data); err == nil {
			t.Errorf("%v accepted", c)
		}
	}
}
