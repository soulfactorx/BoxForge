package app

import (
	"strings"
	"testing"
	"time"
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

func TestShortLog(t *testing.T) {
	for in, want := range map[string]string{
		`time="2026-11-21T12:00:00Z" level=info msg="Starting k3s v1.33.5+k3s1 (\"abc\")"`: `info: Starting k3s v1.33.5+k3s1 ("abc")`,
		`I1121 12:00:00.123456      42 server.go:12] Started kubelet`:                      `info: Started kubelet`,
		`E1121 12:00:01.000000 7 pod.go:1] "Error syncing pod"`:                            `error: "Error syncing pod"`,
		"  \r":       "",
		"plain text": "plain text",
	} {
		if got := shortLog(in); got != want {
			t.Errorf("shortLog(%q) = %q, want %q", in, got, want)
		}
	}
	b := &lineBatch{}
	b.Write([]byte("level=info msg=\"one\"\nlevel=warning msg=\"tw"))
	b.Write([]byte("o\"\n"))
	if got := b.take(); len(got) != 2 || got[1] != "warning: two" {
		t.Fatalf("lines: %q", got)
	}
}

func TestWaitedText(t *testing.T) {
	for d, want := range map[time.Duration]string{45 * time.Second: "45초", 200 * time.Second: "3분 20초"} {
		if got := waitedText(d); got != want {
			t.Errorf("%v: %q, want %q", d, got, want)
		}
	}
}
