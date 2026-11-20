import { useEffect, useMemo, useRef, useState } from "react";
import { call, on, type PullState, type Run } from "./bridge";
import { ago } from "./format";
import Terminal from "./Terminal";
import { Dialog, IconButton, Menu, Progress } from "./ui";

interface KubeState {
  exists: boolean;
  running: boolean;
  ready: boolean;
  version: string;
  image: string;
}

interface Meta {
  name: string;
  namespace: string;
  creationTimestamp: string;
  deletionTimestamp?: string;
}
interface Item {
  kind: string;
  metadata: Meta;
  spec: any;
  status: any;
  [key: string]: any;
}

type Tab = "pods" | "workloads" | "services" | "events";

interface Forward {
  id: string;
  namespace: string;
  service: string;
  port: number;
  local: number;
}

const tcpPorts = (s: any): number[] => (s.spec?.ports ?? []).filter((p: any) => (p.protocol ?? "TCP") === "TCP").map((p: any) => p.port);

// What `kubectl get pods` would say in its STATUS column, and why.
function podStatus(p: Item): { text: string; tone: "ok" | "wait" | "bad" | "done" } {
  const all = [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])];
  if (p.metadata.deletionTimestamp) return { text: "Terminating", tone: "wait" };
  for (const c of all) {
    const w = c.state?.waiting?.reason;
    if (w && w !== "PodInitializing") return { text: w, tone: w === "ContainerCreating" ? "wait" : "bad" };
    const t = c.state?.terminated;
    if (t && t.reason && t.reason !== "Completed") return { text: t.reason, tone: "bad" };
  }
  const phase: string = p.status?.phase ?? "Unknown";
  if (phase === "Running") {
    const ready = (p.status?.containerStatuses ?? []).every((c: any) => c.ready);
    return ready ? { text: "Running", tone: "ok" } : { text: "NotReady", tone: "wait" };
  }
  if (phase === "Succeeded") return { text: "Completed", tone: "done" };
  if (phase === "Pending") return { text: "Pending", tone: "wait" };
  return { text: phase, tone: "bad" };
}

const meaning: Record<string, string> = {
  Running: "실행 중",
  NotReady: "실행 중이지만 아직 준비 안 됨",
  Completed: "할 일을 마치고 끝남",
  Pending: "실행할 자리를 기다리는 중",
  ContainerCreating: "컨테이너를 만드는 중",
  Terminating: "끝나는 중",
  ImagePullBackOff: "이미지를 내려받지 못함. 이름이나 인터넷 연결을 확인하세요",
  ErrImagePull: "이미지를 내려받지 못함. 이름이나 인터넷 연결을 확인하세요",
  InvalidImageName: "이미지 이름이 잘못됨",
  CrashLoopBackOff: "시작하자마자 계속 죽음. 로그를 확인하세요",
  Error: "오류로 끝남. 로그를 확인하세요",
  OOMKilled: "메모리가 부족해 강제 종료됨",
  CreateContainerConfigError: "설정(ConfigMap · Secret)을 찾지 못함",
};

const system = (ns: string) => ns === "kube-system" || ns === "kube-public" || ns === "kube-node-lease";
const since = (iso: string) => ago(Date.parse(iso) / 1000);
const kubectl = (rest: string) => `docker exec boxforge-k3s kubectl ${rest}`;

const sample = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: hello
spec:
  replicas: 2
  selector:
    matchLabels: { app: hello }
  template:
    metadata:
      labels: { app: hello }
    spec:
      containers:
        - name: web
          image: nginx:alpine
          ports:
            - containerPort: 80
---
apiVersion: v1
kind: Service
metadata:
  name: hello
spec:
  selector: { app: hello }
  ports:
    - port: 80
`;

export default function Kubernetes({ run, showCli }: { run: Run; showCli: (cmd: string) => void }) {
  const [state, setState] = useState<KubeState | null>(null);
  const [starting, setStarting] = useState<string | null>(null); // what the start is doing
  const [pull, setPull] = useState<PullState | null>(null);
  const [tab, setTab] = useState<Tab>("pods");
  const [showSystem, setShowSystem] = useState(false);
  const [pods, setPods] = useState<Item[]>([]);
  const [workloads, setWorkloads] = useState<Item[]>([]);
  const [services, setServices] = useState<Item[]>([]);
  const [events, setEvents] = useState<Item[]>([]);
  const [text, setText] = useState<{ title: string; body: string; reload?: () => Promise<string> } | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [shell, setShell] = useState<{ namespace: string; name: string } | null>(null);
  const [forwards, setForwards] = useState<Forward[]>([]);
  const [fwd, setFwd] = useState<{ namespace: string; name: string; ports: number[]; port: number; local: string } | null>(null);
  const [fwdBusy, setFwdBusy] = useState(false);
  const loadForwards = () => call<Forward[]>("KubeForwards").then(setForwards, () => {});

  const forward = async () => {
    if (!fwd) return;
    const local = +fwd.local || 0;
    setFwdBusy(true);
    const ok = await run(kubectl(`port-forward svc/${fwd.name} ${local || ""}:${fwd.port} -n ${fwd.namespace}`), () => call("KubeForward", fwd.namespace, fwd.name, fwd.port, local));
    setFwdBusy(false);
    if (ok) {
      setFwd(null);
      loadForwards();
    }
  };
  const unforward = async (f: Forward) => {
    await run(`# localhost:${f.local} → ${f.service}:${f.port} 연결 끊기 (kubectl port-forward 를 Ctrl+C 로 끝내는 것과 같음)`, () => call("KubeForwardStop", f.id));
    loadForwards();
  };
  const [applied, setApplied] = useState("");
  const [removing, setRemoving] = useState(false);
  const [note, setNote] = useState("");
  const busy = useRef(false);

  const refresh = async () => {
    const st = await call<KubeState>("KubeStatus").catch(() => null);
    if (st) setState(st);
    if (!st?.ready || busy.current) return;
    busy.current = true;
    const list = async (kind: string, set: (items: Item[]) => void) => {
      try {
        set(JSON.parse(await call<string>("KubeGet", kind)).items ?? []);
      } catch {
        // The next round asks again.
      }
    };
    loadForwards();
    await Promise.all([list("pods", setPods), list("workloads", setWorkloads), list("services", setServices), list("events", setEvents)]);
    busy.current = false;
  };

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 3000);
    const off = [on("kube", (t: string) => setStarting(t)), on("pull", (p: PullState) => setPull(p.done ? null : p))];
    return () => {
      clearInterval(timer);
      off.forEach((f) => f());
    };
  }, []);

  const start = async () => {
    setStarting("준비하는 중");
    setNote("");
    await run("docker run -d --name boxforge-k3s --privileged -p 6443:6443 -v boxforge-k3s:/var/lib/rancher/k3s rancher/k3s server", () => call("KubeStart"));
    setStarting(null);
    setPull(null);
    refresh();
  };

  const stop = async () => {
    await run("docker stop boxforge-k3s", () => call("KubeStop"));
    refresh();
  };

  const remove = async () => {
    setRemoving(false);
    if (await run("docker rm -f -v boxforge-k3s && docker volume rm boxforge-k3s", () => call("KubeRemove"))) {
      setPods([]);
      setWorkloads([]);
      setServices([]);
      setEvents([]);
    }
    refresh();
  };

  const act = async (command: string, method: string, ...args: unknown[]) => {
    await run(kubectl(command), () => call(method, ...args));
    refresh();
  };

  const open = async (title: string, command: string, load: () => Promise<string>) => {
    showCli(kubectl(command));
    setText({ title, body: "읽는 중…", reload: load });
    try {
      setText({ title, body: (await load()) || "(내용 없음)", reload: load });
    } catch (e: any) {
      setText({ title, body: e.message, reload: load });
    }
  };

  const apply = async () => {
    const yaml = applying ?? "";
    let out = "";
    if (await run(kubectl("apply -f app.yaml"), async () => (out = await call<string>("KubeApply", yaml)))) {
      setApplying(null);
      setApplied(out.trim());
      refresh();
    }
  };

  const saveConfig = async () => {
    let file = "";
    if (await run(kubectl("config view --raw > ~/.kube/boxforge.yaml"), async () => (file = await call<string>("KubeConfig")))) {
      setNote(`kubeconfig를 ${file} 에 저장했습니다. 내 PC의 kubectl로 쓰려면: kubectl --kubeconfig ${file} get pods`);
    }
  };

  const mine = <T extends Item>(items: T[]) => items.filter((i) => showSystem || !system(i.metadata.namespace));
  const shownPods = useMemo(() => mine(pods).sort((a, b) => a.metadata.namespace.localeCompare(b.metadata.namespace) || a.metadata.name.localeCompare(b.metadata.name)), [pods, showSystem]);
  const shownWork = useMemo(() => mine(workloads).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)), [workloads, showSystem]);
  const shownSvc = useMemo(() => mine(services).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)), [services, showSystem]);
  const warnings = useMemo(
    () =>
      mine(events)
        .filter((e) => e.type === "Warning")
        .sort((a, b) => Date.parse(b.lastTimestamp ?? b.metadata.creationTimestamp) - Date.parse(a.lastTimestamp ?? a.metadata.creationTimestamp))
        .slice(0, 100),
    [events, showSystem],
  );

  const ready = state?.ready;
  const tabs: [Tab, string, number][] = [
    ["pods", "파드", shownPods.length],
    ["workloads", "워크로드", shownWork.length],
    ["services", "서비스", shownSvc.length],
    ["events", "경고", warnings.length],
  ];

  return (
    <section>
      <header className="page-head">
        <h1>Kubernetes</h1>
        {state && (
          <span className={"state " + (ready ? "running" : state.running ? "paused" : "")} data-testid="kube-state">
            <span className="dot" />
            {ready ? `준비됨 · ${state.version}` : starting ? "켜는 중" : state.running ? "시작하는 중" : state.exists ? "꺼짐" : "없음"}
          </span>
        )}
        <span className="spacer" />
        {ready && (
          <>
            <label className="check">
              <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
              시스템 항목도 보기
            </label>
            <button onClick={saveConfig}>kubeconfig 저장</button>
            <button className="primary" onClick={() => setApplying(sample)}>
              YAML 적용
            </button>
          </>
        )}
        {state?.running && !starting && <button onClick={stop}>끄기</button>}
        {state?.exists && !starting && (
          <button className="danger" onClick={() => setRemoving(true)}>
            삭제
          </button>
        )}
      </header>
      <p className="lead">
        Kubernetes는 컨테이너 여러 개를 알아서 띄우고, 죽으면 다시 살리고, 개수를 늘리고 줄여 주는 시스템입니다. 여기서는 연습과 개발에 쓰는
        작은 클러스터(k3s)를 컨테이너 하나로 돌립니다.
      </p>
      {note && <p className="note">{note}</p>}

      {state && !ready && (
        <div className="kube-off">
          {starting ? (
            <>
              <p role="status">
                <span className="spinner" /> {starting}…
              </p>
              {pull && (
                <div className="pull-progress">
                  <span>
                    {pull.ref} 받는 중{pull.percent >= 0 ? ` · ${pull.percent}%` : ""}
                  </span>
                  <Progress percent={pull.percent} />
                </div>
              )}
              <p className="muted">처음에는 이미지를 받느라 몇 분 걸릴 수 있습니다. 그다음부터는 수십 초면 켜집니다.</p>
            </>
          ) : (
            <>
              <p>
                {state.exists ? "클러스터가 꺼져 있습니다. 안에 배포해 둔 것은 그대로 있습니다." : "아직 클러스터가 없습니다."}
              </p>
              <button className="primary" onClick={start} data-testid="kube-start">
                Kubernetes 켜기
              </button>
              {!state.exists && (
                <p className="muted">
                  <code>{state.image}</code> 이미지(약 300MB)로 <code>boxforge-k3s</code> 컨테이너를 만듭니다. 그 안에서 다시 컨테이너를 돌려야 해서
                  모든 권한(privileged)으로 실행하며, PC의 6443번 포트를 씁니다.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {ready && (
        <>
          {applied && (
            <pre className="note-box applied" data-testid="applied">
              {applied}
            </pre>
          )}
          <div className="tabs kube-tabs" role="tablist">
            {tabs.map(([id, label, n]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                {label} <span className="count">{n}</span>
              </button>
            ))}
          </div>

          {tab === "pods" &&
            (shownPods.length === 0 ? (
              <p className="empty">파드가 없습니다. "YAML 적용"으로 앱을 배포해 보세요.</p>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>이름</th>
                    <th>상태</th>
                    <th className="num">재시작</th>
                    <th>만든 때</th>
                    <th className="actions">작업</th>
                  </tr>
                </thead>
                <tbody>
                  {shownPods.map((p) => {
                    const s = podStatus(p);
                    const { name, namespace } = p.metadata;
                    const restarts = (p.status?.containerStatuses ?? []).reduce((n: number, c: any) => n + (c.restartCount ?? 0), 0);
                    return (
                      <tr key={namespace + "/" + name} data-testid={`pod-${name}`}>
                        <td>
                          <span className="name">{name}</span>
                          <span className="sub">{namespace}</span>
                        </td>
                        <td>
                          <span className={"state kube-" + s.tone}>
                            <span className="dot" />
                            {s.text}
                          </span>
                          <span className="sub">{meaning[s.text] ?? ""}</span>
                        </td>
                        <td className="num">{restarts}</td>
                        <td className="muted nowrap">{since(p.metadata.creationTimestamp)}</td>
                        <td className="actions">
                          <button onClick={() => open(`${name} 로그`, `logs ${name} -n ${namespace} --tail=500`, () => call<string>("KubeLogs", namespace, name))}>로그</button>
                          <Menu
                            items={[
                              ...(s.text === "Running" || s.text === "NotReady" ? [{ label: "터미널", onClick: () => setShell({ namespace, name }) }] : []),
                              { label: "자세히 (describe)", onClick: () => open(name, `describe pod ${name} -n ${namespace}`, () => call<string>("KubeDescribe", "pod", namespace, name)) },
                              { label: "삭제 (워크로드가 새로 만듦)", onClick: () => act(`delete pod ${name} -n ${namespace}`, "KubeDelete", "pod", namespace, name), danger: true },
                            ]}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ))}

          {tab === "workloads" &&
            (shownWork.length === 0 ? (
              <p className="empty">워크로드(Deployment 등)가 없습니다.</p>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>이름</th>
                    <th>종류</th>
                    <th>준비된 파드</th>
                    <th>만든 때</th>
                    <th className="actions">작업</th>
                  </tr>
                </thead>
                <tbody>
                  {shownWork.map((w) => {
                    const { name, namespace } = w.metadata;
                    const kind = w.kind.toLowerCase();
                    const want = w.kind === "DaemonSet" ? w.status?.desiredNumberScheduled ?? 0 : w.spec?.replicas ?? 0;
                    const have = (w.kind === "DaemonSet" ? w.status?.numberReady : w.status?.readyReplicas) ?? 0;
                    return (
                      <tr key={w.kind + namespace + name} data-testid={`workload-${name}`}>
                        <td>
                          <span className="name">{name}</span>
                          <span className="sub">{namespace}</span>
                        </td>
                        <td>{w.kind}</td>
                        <td>
                          <span className={"state " + (have >= want && want > 0 ? "running" : want === 0 ? "" : "paused")}>
                            <span className="dot" />
                            {have} / {want}
                          </span>
                        </td>
                        <td className="muted nowrap">{since(w.metadata.creationTimestamp)}</td>
                        <td className="actions">
                          {w.kind !== "DaemonSet" && (
                            <>
                              <IconButton icon="minus" label="파드 하나 줄이기" disabled={want <= 0} onClick={() => act(`scale ${kind} ${name} -n ${namespace} --replicas=${want - 1}`, "KubeScale", kind, namespace, name, want - 1)} />
                              <IconButton icon="plus" label="파드 하나 늘리기" onClick={() => act(`scale ${kind} ${name} -n ${namespace} --replicas=${want + 1}`, "KubeScale", kind, namespace, name, want + 1)} />
                            </>
                          )}
                          <IconButton icon="restart" label="파드를 새로 바꾸기 (rollout restart)" onClick={() => act(`rollout restart ${kind} ${name} -n ${namespace}`, "KubeRestart", kind, namespace, name)} />
                          <IconButton icon="trash" label="삭제 (파드도 함께 사라짐)" tone="danger" onClick={() => act(`delete ${kind} ${name} -n ${namespace}`, "KubeDelete", kind, namespace, name)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ))}

          {tab === "services" && forwards.length > 0 && (
            <div className="note-box forwards" data-testid="forwards">
              <strong>내 PC로 연결된 포트</strong>
              {forwards.map((f) => (
                <div className="forward" key={f.id}>
                  <code>localhost:{f.local}</code>
                  <span className="muted">→</span>
                  <span>
                    {f.service}:{f.port} <span className="muted">({f.namespace})</span>
                  </span>
                  <span className="spacer" />
                  <a className="link" href={`http://localhost:${f.local}`} target="_blank" rel="noreferrer">
                    브라우저로 열기
                  </a>
                  <button onClick={() => unforward(f)}>끊기</button>
                </div>
              ))}
              <span className="sub">BoxForge가 켜져 있는 동안만 이어집니다.</span>
            </div>
          )}
          {tab === "services" &&
            (shownSvc.length === 0 ? (
              <p className="empty">서비스가 없습니다.</p>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>이름</th>
                    <th>종류</th>
                    <th>클러스터 안 주소</th>
                    <th>포트</th>
                    <th className="actions">작업</th>
                  </tr>
                </thead>
                <tbody>
                  {shownSvc.map((s) => {
                    const { name, namespace } = s.metadata;
                    return (
                      <tr key={namespace + name} data-testid={`service-${name}`}>
                        <td>
                          <span className="name">{name}</span>
                          <span className="sub">{namespace}</span>
                        </td>
                        <td>{s.spec?.type}</td>
                        <td>
                          <code>{s.spec?.clusterIP}</code>
                          <span className="sub">
                            {name}.{namespace}
                          </span>
                        </td>
                        <td>{(s.spec?.ports ?? []).map((p: any) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol}`).join(", ") || "—"}</td>
                        <td className="actions">
                          {tcpPorts(s).length > 0 && s.spec?.clusterIP && s.spec.clusterIP !== "None" && (
                            <button
                              onClick={() => {
                                const ports = tcpPorts(s);
                                setFwd({ namespace, name, ports, port: ports[0], local: String(ports[0] < 1024 ? ports[0] + 8000 : ports[0]) });
                              }}
                            >
                              내 PC로 연결
                            </button>
                          )}
                          {!(namespace === "default" && name === "kubernetes") && (
                            <IconButton icon="trash" label="삭제" tone="danger" onClick={() => act(`delete service ${name} -n ${namespace}`, "KubeDelete", "service", namespace, name)} />
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ))}

          {tab === "events" &&
            (warnings.length === 0 ? (
              <p className="empty">경고가 없습니다.</p>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>대상</th>
                    <th>이유</th>
                    <th>내용</th>
                    <th>때</th>
                  </tr>
                </thead>
                <tbody>
                  {warnings.map((e) => (
                    <tr key={e.metadata.namespace + e.metadata.name}>
                      <td className="nowrap">
                        {e.involvedObject?.kind}/{e.involvedObject?.name}
                        <span className="sub">{e.metadata.namespace}</span>
                      </td>
                      <td>{e.reason}</td>
                      <td>{e.message}</td>
                      <td className="muted nowrap">{since(e.lastTimestamp ?? e.metadata.creationTimestamp)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
        </>
      )}

      {text && (
        <Dialog title={text.title} onClose={() => setText(null)} wide>
          <pre className="log-box yaml" data-testid="kube-text">
            {text.body}
          </pre>
          <div className="dialog-actions">
            {text.reload && (
              <button
                onClick={async () => {
                  const { title, reload } = text;
                  try {
                    setText({ title, reload, body: (await reload!()) || "(내용 없음)" });
                  } catch (e: any) {
                    setText({ title, reload, body: e.message });
                  }
                }}
              >
                새로 고침
              </button>
            )}
            <button onClick={() => setText(null)}>닫기</button>
          </div>
        </Dialog>
      )}

      {fwd && (
        <Dialog title={`${fwd.name} 서비스를 내 PC로 연결`} onClose={() => setFwd(null)}>
          <p>클러스터 안의 서비스는 밖에서 바로 접속할 수 없습니다. 내 PC의 포트 하나를 이 서비스로 이어 주면 브라우저나 다른 프로그램에서 localhost로 접속할 수 있습니다.</p>
          <form
            className="run-form"
            onSubmit={(e) => {
              e.preventDefault();
              forward();
            }}
          >
            {fwd.ports.length > 1 && (
              <label>
                서비스 포트
                <select value={fwd.port} onChange={(e) => setFwd({ ...fwd, port: +e.target.value })}>
                  {fwd.ports.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              내 PC 포트
              <input autoFocus inputMode="numeric" aria-label="내 PC 포트" placeholder="비워 두면 빈 포트를 고릅니다" value={fwd.local} onChange={(e) => setFwd({ ...fwd, local: e.target.value.replace(/\D/g, "") })} />
              <span className="help">
                localhost:{fwd.local || "(자동)"} → {fwd.name}:{fwd.port}
              </span>
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setFwd(null)}>
                취소
              </button>
              <button className="primary" type="submit" disabled={fwdBusy || +fwd.local > 65535}>
                {fwdBusy ? "연결하는 중…" : "연결"}
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {shell && (
        <Dialog title={`${shell.name} 터미널`} onClose={() => setShell(null)} wide>
          <div className="pod-term" data-testid="pod-term">
            <Terminal
              id={shell.namespace + "/" + shell.name}
              name={shell.name}
              run={run}
              showCli={showCli}
              command={kubectl(`exec -it ${shell.name} -n ${shell.namespace} -- sh`)}
              open={(cols, rows) => call<string>("KubeTermOpen", shell.namespace, shell.name, cols, rows)}
            />
          </div>
          <div className="dialog-actions">
            <button onClick={() => setShell(null)}>닫기</button>
          </div>
        </Dialog>
      )}

      {applying !== null && (
        <Dialog title="YAML 적용" onClose={() => setApplying(null)} wide>
          <p className="muted">
            만들거나 바꿀 것을 YAML로 적습니다. 아래는 nginx 두 개를 띄우고 이름을 붙이는 예시입니다. 같은 이름이 이미 있으면 내용이 바뀝니다.
          </p>
          <textarea className="editor" aria-label="적용할 YAML" spellCheck={false} value={applying} onChange={(e) => setApplying(e.target.value)} />
          <div className="dialog-actions">
            <button onClick={() => setApplying(null)}>취소</button>
            <button className="primary" disabled={!applying.trim()} onClick={apply}>
              적용
            </button>
          </div>
        </Dialog>
      )}

      {removing && (
        <Dialog title="클러스터 삭제" onClose={() => setRemoving(false)}>
          <p>
            Kubernetes 클러스터와 그 안에 배포한 <strong>모든 것</strong>(파드, 서비스, 저장된 데이터)을 삭제합니다. 되돌릴 수 없습니다.
          </p>
          <p className="muted">잠시 쉬게만 하려면 "끄기"를 쓰세요. 끄면 배포해 둔 것은 남습니다.</p>
          <div className="dialog-actions">
            <button onClick={() => setRemoving(false)}>취소</button>
            <button className="danger solid" onClick={remove}>
              전부 삭제
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
