package app

import (
	"strings"
	"testing"
)

const sampleCompose = `{"name":"demo","services":{
"db":{"image":"postgres:16","environment":{"POSTGRES_PASSWORD":"secret","FROM_HOST":null},"volumes":[{"type":"volume","source":"dbdata","target":"/var/lib/postgresql/data"}],"expose":["5432"]},
"web":{"image":"nginx:alpine","environment":{"MODE":"prod"},"volumes":[{"type":"bind","source":"/tmp/cz/html","target":"/usr/share/nginx/html"}],"depends_on":{"db":{}},"ports":[{"target":80,"published":"8080","protocol":"tcp"}]},
"my_worker":{"build":{"context":"/tmp/cz"},"command":["python","w.py"],"entrypoint":["/bin/sh","-c"],"tty":true,"deploy":{"replicas":2},"privileged":true}},
"volumes":{"dbdata":{"name":"demo_dbdata"}}}`

func TestComposeToKube(t *testing.T) {
	p, err := composeToKube("demo", []byte(sampleCompose))
	if err != nil {
		t.Fatal(err)
	}
	if p.Namespace != "demo" || strings.Join(p.Deployments, ",") != "db,my-worker,web" {
		t.Fatalf("namespace %q, deployments %q", p.Namespace, p.Deployments)
	}
	if strings.Join(p.Built, ",") != "demo-my_worker" {
		t.Fatalf("built %q", p.Built)
	}
	y := p.YAML
	for _, want := range []string{
		"kind: Namespace", "name: demo\n",
		"kind: PersistentVolumeClaim", "claimName: dbdata", "mountPath: /var/lib/postgresql/data", "storage: 1Gi",
		"name: POSTGRES_PASSWORD", "value: secret",
		"containerPort: 5432", "containerPort: 80",
		"image: nginx:alpine", "image: demo-my_worker", "imagePullPolicy: IfNotPresent",
		"command:\n", "- /bin/sh", "args:\n", "- w.py", "tty: true", "stdin: true", "replicas: 2",
		"kind: Service", "port: 80", "targetPort: 5432",
	} {
		if !strings.Contains(y, want) {
			t.Errorf("YAML lacks %q", want)
		}
	}
	if strings.Contains(y, "FROM_HOST") || strings.Contains(y, "/tmp/cz/html") {
		t.Errorf("what can't be moved is in the YAML:\n%s", y)
	}
	if len(p.Volumes) != 1 || p.Volumes[0].Volume != "demo_dbdata" || p.Volumes[0].Claim != "dbdata" || strings.Join(p.Volumes[0].Deployments, ",") != "db" {
		t.Errorf("volumes: %+v", p.Volumes)
	}
	notes := strings.Join(p.Notes, "\n")
	for _, want := range []string{"FROM_HOST", "/tmp/cz/html", "8080→80", "depends_on", "my-worker", "privileged", "demo-my_worker", "새 저장소 dbdata"} {
		if !strings.Contains(notes, want) {
			t.Errorf("notes lack %q:\n%s", want, notes)
		}
	}
}
