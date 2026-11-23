import { useEffect, useMemo, useRef, useState } from "react";
import { call, on, type PullState, type Run } from "./bridge";
import { ago } from "./format";
import Terminal from "./Terminal";
import { appliedDeployments, DataDialog, type Deploy, DeployDialog, DeployProgress, Flow, type Item, PvcDialog, podsOf, routes, useElapsed, whyPod } from "./KubeExtras";
import ProjectCheck from "./ProjectCheck";
import { Dialog, IconButton, Menu, Note, Progress } from "./ui";

interface KubeState {
  exists: boolean;
  running: boolean;
  ready: boolean;
  version: string;
  image: string;
  port: number;
  others: { name: string; maker: string; running: boolean; port: number }[];
}

type Tab = "flow" | "pods" | "workloads" | "services" | "ingresses" | "config" | "storage" | "events";

// What a delete takes away, said before it is done.
interface Confirm {
  title: string;
  body: string;
  command: string;
  go: () => Promise<unknown>;
}

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

// Ports that by custom speak HTTPS: opened in the browser as https.
const secure = (port: number) => port === 443 || port === 8443 || port === 6443;
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

/** The cluster's log while it starts, kept scrolled to its end. */
function BootLog({ lines, open, onToggle }: { lines: string[]; open: boolean; onToggle: () => void }) {
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, open]);
  return (
    <div className="boot-log">
      <button type="button" className="link" onClick={onToggle}>
        {open ? "진행 로그 숨기기" : "진행 로그 보기"} ({lines.length}줄)
      </button>
      {open && (
        <pre ref={box} className="log-box" data-testid="kube-boot-log">
          {lines.length ? lines.join("\n") : "클러스터 컨테이너의 로그를 기다리는 중…"}
        </pre>
      )}
    </div>
  );
}

// What the screen knows, kept while it is not shown: leaving the page and
// coming back finds the lists already read, a deployment still being sent,
// and the one being followed. A cluster on a slow machine takes seconds to
// list again, and a send that is under way goes on without the screen.
const kept: Record<string, unknown> = {};
const keptChanged = new EventTarget();

/** useState, its value kept in `kept` across the page being left. */
function useKept<T>(key: string, initial: T): [T, (v: T | ((old: T) => T)) => void] {
  const [value, set] = useState<T>(() => (key in kept ? (kept[key] as T) : initial));
  useEffect(() => {
    const on = () => set(kept[key] as T);
    keptChanged.addEventListener(key, on);
    return () => keptChanged.removeEventListener(key, on);
  }, [key]);
  const put = (v: T | ((old: T) => T)) => {
    const next = typeof v === "function" ? (v as (old: T) => T)((key in kept ? kept[key] : initial) as T) : v;
    kept[key] = next;
    keptChanged.dispatchEvent(new Event(key));
  };
  return [value, put];
}

/** A Compose project made into Kubernetes objects, to be applied. */
export interface KubeMove {
  namespace: string;
  yaml: string;
  load: string[]; // the engine's images to put into the cluster first
  deployments: string[];
  // Engine volumes whose data goes into the claims made from them, after.
  copy: { volume: string; claim: string; deployments: string[] }[];
}

export default function Kubernetes({
  run,
  showCli,
  deployFrom,
  onDeployFromTaken,
}: {
  run: Run;
  showCli: (cmd: string) => void;
  deployFrom?: Partial<Deploy> | KubeMove | null;
  onDeployFromTaken?: () => void;
}) {
  const [state, setState] = useState<KubeState | null>(null);
  const [starting, setStarting] = useState<string | null>(null); // what the start is doing
  const [bootLog, setBootLog] = useState<string[]>([]); // the cluster's own words while it starts
  const [showLog, setShowLog] = useState(true);
  const [pull, setPull] = useState<PullState | null>(null);
  const [tab, setTab] = useState<Tab>("flow");
  const [showSystem, setShowSystem] = useState(false);
  const [pods, setPods] = useKept<Item[]>("pods", []);
  const [workloads, setWorkloads] = useKept<Item[]>("workloads", []);
  const [services, setServices] = useKept<Item[]>("services", []);
  const [events, setEvents] = useKept<Item[]>("events", []);
  const [ingresses, setIngresses] = useKept<Item[]>("ingresses", []);
  const [configs, setConfigs] = useKept<Item[]>("configs", []);
  const [secrets, setSecrets] = useKept<Item[]>("secrets", []);
  const [pvcs, setPvcs] = useKept<Item[]>("pvcs", []);
  const [namespaces, setNamespaces] = useKept<Item[]>("namespaces", []);
  // Whether the lists have been read once: until then "none" would be a guess.
  const [loaded, setLoaded] = useKept("loaded", false);
  const [deploying, setDeploying] = useState(false);
  // The deploy form's list of settings to pass in: read while it is open,
  // whatever tab is behind it (a slow cluster may not answer the first time).
  useEffect(() => {
    if (!deploying) return;
    const read = () => {
      for (const [kind, set] of [["configmaps", setConfigs], ["secrets", setSecrets]] as const) call<string>("KubeGet", kind).then((j) => set(JSON.parse(j).items ?? []), () => {});
    };
    read();
    const t = setInterval(read, 5000);
    return () => clearInterval(t);
  }, [deploying]);
  const [making, setMaking] = useState<"data" | "pvc" | null>(null);
  const [working, setWorking] = useState(false);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const tabRef = useRef<Tab>("flow");
  tabRef.current = tab;
  const [text, setText] = useState<{ title: string; body: string; reload?: () => Promise<string> } | null>(null);
  const [applying, setApplyingText] = useState<string | null>(null);
  // Whose YAML is in the dialog to be changed ("" for new).
  const [editing, setEditing] = useState("");
  const setApplying = (text: string | null) => {
    if (text === null) setEditing("");
    setApplyingText(text);
  };
  // Changing what is deployed: its YAML as it is now, to change and apply.
  const edit = async (kind: string, namespace: string, name: string) => {
    let yaml = "";
    if (await run(kubectl(`get ${kind} ${name} -n ${namespace} -o yaml`), async () => (yaml = await call<string>("KubeYAML", kind, namespace, name)))) {
      setEditing(name);
      setApplyingText(yaml);
    }
  };
  const [shell, setShell] = useState<{ namespace: string; name: string } | null>(null);
  const [forwards, setForwards] = useState<Forward[]>([]);
  const [fwd, setFwd] = useState<{ namespace: string; name: string; ports: number[]; port: number; local: string } | null>(null);
  const [fwdBusy, setFwdBusy] = useState(false);
  const loadForwards = () => call<Forward[]>("KubeForwards").then(setForwards, () => {});

  const forward = async () => {
    if (!fwd) return;
    const local = +fwd.local || 0;
    setFwdBusy(true);
    let got: Forward | null = null;
    const ok = await run(kubectl(`port-forward svc/${fwd.name} ${local || ""}:${fwd.port} -n ${fwd.namespace}`), async () => (got = await call<Forward>("KubeForward", fwd.namespace, fwd.name, fwd.port, local)));
    setFwdBusy(false);
    const made = got as Forward | null;
    if (ok && made && local && made.local !== local) setNote(`이 PC의 ${local}번 포트는 다른 프로그램이 쓰고 있어서 ${made.local}번 포트로 이었습니다.`);
    if (ok) {
      setFwd(null);
      loadForwards();
    }
  };
  const unforward = async (f: Forward) => {
    await run(`# localhost:${f.local} → ${f.service}:${f.port} 연결 끊기 (kubectl port-forward 를 Ctrl+C 로 끝내는 것과 같음)`, () => call("KubeForwardStop", f.id));
    loadForwards();
  };
  const [applied, setApplied] = useKept("applied", "");
  const [removing, setRemoving] = useState(false);
  const [note, setNote] = useState("");
  // The other clusters' notice, once closed, stays closed while the app runs.
  const [othersSeen, setOthersSeen] = useKept("othersSeen", false);
  // A moved project being looked into.
  const [inspect, setInspect] = useState<{ namespace: string; tab: "reach" | "logs" } | null>(null);
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
    // The rest only while their tab is open: each is a command in the cluster.
    const t = tabRef.current;
    let got = 0;
    const count = (set: (items: Item[]) => void) => (items: Item[]) => {
      got++;
      set(items);
    };
    await Promise.all([
      list("pods", count(setPods)),
      list("workloads", setWorkloads),
      list("services", setServices),
      list("events", setEvents),
      list("ingresses", setIngresses),
      list("namespaces", setNamespaces),
      ...(t === "config" ? [list("configmaps", setConfigs), list("secrets", setSecrets)] : []),
      ...(t === "storage" ? [list("persistentvolumeclaims", setPvcs)] : []),
    ]);
    if (got > 0) setLoaded(true);
    busy.current = false;
  };

  useEffect(() => {
    refresh();
    // Each round is several kubectl commands in the cluster: not too often.
    const timer = setInterval(refresh, 5000);
    const off = [
      on("kube", (t: string) => setStarting(t)),
      on("pull", (p: PullState) => setPull(p.done ? null : p)),
      on("kube-log", (lines: string[]) => setBootLog((l) => [...l, ...lines].slice(-300))),
    ];
    return () => {
      clearInterval(timer);
      off.forEach((f) => f());
    };
  }, []);

  // Up but not ready, with no start of ours following it (the screen was
  // left, or the start gave up waiting): the log is read every few seconds.
  const booting = !!state?.running && !state.ready && !starting;
  useEffect(() => {
    if (!booting) return;
    const read = () => call<string[]>("KubeLogTail", 100).then(setBootLog, () => {});
    read();
    const t = setInterval(read, 3000);
    return () => clearInterval(t);
  }, [booting]);

  // Stopped (by hand, or it ended while starting): its last words, read once.
  const stopped = !!state?.exists && !state.running && !starting;
  useEffect(() => {
    if (stopped) call<string[]>("KubeLogTail", 100).then(setBootLog, () => {});
  }, [stopped]);

  const start = async () => {
    setStarting("준비하는 중");
    setBootLog([]);
    setShowLog(true);
    setNote("");
    await run("docker run -d --name boxforge-k3s --privileged -p 127.0.0.1:6443:6443 -v boxforge-k3s:/var/lib/rancher/k3s rancher/k3s server", () => call("KubeStart"));
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
      setIngresses([]);
      setConfigs([]);
      setSecrets([]);
      setPvcs([]);
      setLoaded(false);
      setTracking([]);
    }
    refresh();
  };

  const act = async (command: string, method: string, ...args: unknown[]) => {
    await run(kubectl(command), () => call(method, ...args));
    refresh();
  };

  // Deleting asks first, saying what goes with it.
  const del = (kind: string, namespace: string, name: string, body: string) =>
    setConfirm({ title: `${name} 삭제`, body, command: kubectl(`delete ${kind} ${name} -n ${namespace}`), go: () => call("KubeDelete", kind, namespace, name) });

  // A container to deploy, from the containers page: the form opens filled.
  const [deployInit, setDeployInit] = useState<Partial<Deploy> | undefined>(undefined);
  useEffect(() => {
    if (!deployFrom || !state?.ready) return;
    if ("yaml" in deployFrom) {
      // A whole project: applied at once, its deployments followed.
      const m = deployFrom as KubeMove;
      (async () => {
        if (!(await deploy(m.yaml, m.load, m.deployments.map((d) => `${m.namespace}/${d}`)))) return;
        // Then the data, one volume at a time: its users stop meanwhile.
        for (const v of m.copy) {
          setCopying(v.volume);
          await run(
            `docker run --rm -v ${v.volume}:/from alpine tar -c -C /from . | ${kubectl(`exec -i -n ${m.namespace} … tar -x`)}  # 그동안 ${v.deployments.join(", ")} 은 0개로`,
            () => call("KubeMoveVolume", m.namespace, v.claim, v.volume, v.deployments),
          );
        }
        setCopying("");
        refresh();
      })();
    } else {
      setDeployInit(deployFrom);
      setDeploying(true);
    }
    onDeployFromTaken?.();
  }, [deployFrom, state?.ready]);

  // Sending to the cluster: since when, for the seconds shown meanwhile.
  const [sendingSince, setSendingSince] = useKept<number | null>("sendingSince", null);
  const sent = useElapsed(sendingSince);
  // Deployments just applied, followed until their pods are ready.
  const [tracking, setTracking] = useKept<string[]>("tracking", []);
  const [trackSince, setTrackSince] = useKept("trackSince", 0);
  // An engine volume whose data is being copied into the cluster.
  const [copying, setCopying] = useKept("copying", "");
  useEffect(() => {
    if (tracking.length === 0) return;
    const t = setInterval(refresh, 2500);
    return () => clearInterval(t);
  }, [tracking.length]);

  const deploy = async (yaml: string, images: string[] = [], follow?: string[]) => {
    let out = "";
    setWorking(true);
    const sentAt = Date.now();
    setSendingSince(sentAt);
    // The engine's copies first, when asked: the cluster won't find them elsewhere.
    let loaded = true;
    for (const image of images) {
      loaded = loaded && (await run(`docker save ${image} | docker exec -i boxforge-k3s ctr -n k8s.io images import -`, () => call("KubeLoadImage", image)));
    }
    const ok = loaded && (await run(kubectl("apply -f app.yaml"), async () => (out = await call<string>("KubeApply", yaml))));
    setWorking(false);
    setSendingSince(null);
    if (ok) {
      setDeploying(false);
      setMaking(null);
      setApplied(out.trim());
      setTracking(follow ?? appliedDeployments(out));
      setTrackSince(sentAt);
      setTab("flow");
      refresh();
    }
    return ok;
  };

  const makeData = async (kind: "configmap" | "secret", name: string, data: Record<string, string>) => {
    const lits = Object.keys(data)
      .map((k) => `--from-literal=${k}=${kind === "secret" ? "****" : JSON.stringify(data[k])}`)
      .join(" ");
    setWorking(true);
    const ok = await run(kubectl(`create ${kind === "secret" ? "secret generic" : "configmap"} ${name} ${lits}`), () => call("KubeCreateData", kind, "default", name, data));
    setWorking(false);
    if (ok) {
      setMaking(null);
      refresh();
    }
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
    const sentAt = Date.now();
    setSendingSince(sentAt);
    const ok = await run(kubectl("apply -f app.yaml"), async () => (out = await call<string>("KubeApply", yaml)));
    setSendingSince(null);
    if (ok) {
      setApplying(null);
      setApplied(out.trim());
      setTracking(appliedDeployments(out));
      setTrackSince(sentAt);
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
  const shownIng = useMemo(() => mine(ingresses).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)), [ingresses, showSystem]);
  const shownData = useMemo(() => mine([...configs, ...secrets]).filter((c) => c.metadata.name !== "kube-root-ca.crt").sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)), [configs, secrets, showSystem]);
  // Namespaces a Compose project was moved into.
  const moved = namespaces.filter((n) => n.metadata.labels?.["boxforge.compose/project"] && !n.metadata.deletionTimestamp);
  const shownPvc = useMemo(() => mine(pvcs).sort((a, b) => a.metadata.name.localeCompare(b.metadata.name)), [pvcs, showSystem]);
  const traefik = forwards.find((f) => f.namespace === "kube-system" && f.service === "traefik" && f.port === 80);
  // k3s installs its way in a minute or two after it first starts.
  // Ready when its service is there and one of its pods answers.
  const gate =
    services.some((s) => s.metadata.namespace === "kube-system" && s.metadata.name === "traefik") &&
    pods.some((p) => p.metadata.namespace === "kube-system" && p.metadata.labels?.["app.kubernetes.io/name"] === "traefik" && podStatus(p).text === "Running");
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
  const tabs: [Tab, string, number | null][] = [
    ["flow", "흐름 그림", null],
    ["pods", "파드", shownPods.length],
    ["workloads", "워크로드", shownWork.length],
    ["services", "서비스", shownSvc.length],
    ["ingresses", "주소", shownIng.length],
    ["config", "설정값", tab === "config" ? shownData.length : null],
    ["storage", "저장소", tab === "storage" ? shownPvc.length : null],
    ["events", "경고", warnings.length],
  ];
  const openAddress = async () => {
    if (await run(kubectl("port-forward svc/traefik 8080:80 -n kube-system"), () => call("KubeForward", "kube-system", "traefik", 80, 8080))) loadForwards();
  };

  // Until the lists have been read once, nothing is said to be missing.
  const view: Tab | "loading" = loaded ? tab : "loading";
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
            <button onClick={() => setApplying(sample)}>YAML 적용</button>
            <button
              className="primary"
              onClick={() => {
                setDeployInit(undefined);
                setDeploying(true);
              }}
            >
              앱 배포
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
      {note && <Note onClose={() => setNote("")}>{note}</Note>}
      {deployFrom && state && !state.ready && (
        <p className="note" role="status" data-testid="kube-pending">
          {"yaml" in deployFrom
            ? `Kubernetes가 준비되면 ${(deployFrom as KubeMove).namespace} 프로젝트를 배포합니다. 아래에서 켜 주세요.`
            : "Kubernetes가 준비되면 앱 배포 창이 열립니다. 아래에서 켜 주세요."}
        </p>
      )}
      {state && state.others.length > 0 && !othersSeen && (
        <div className="note-box" data-testid="kube-others">
          <span className="box-close">
            <IconButton icon="close" label="닫기" onClick={() => setOthersSeen(true)} />
          </span>
          <strong>이 엔진에는 BoxForge 것이 아닌 Kubernetes 클러스터도 있습니다</strong>
          {state.others.map((o) => (
            <span key={o.name} className="block">
              <code>{o.name}</code> {o.maker ? `(${o.maker}가 만든 것)` : ""} · {o.running ? "실행 중" : "꺼짐"}
              {o.port ? ` · 포트 ${o.port}` : ""}
            </span>
          ))}
          <span className="sub">
            여기서 보이는 클러스터(boxforge-k3s)와는 따로 도는 별개의 클러스터입니다. 둘 다 켜 두면 메모리와 CPU를 두 배로 쓰고, 6443번 포트를 먼저 잡은 쪽이 가지며 나중에 켠 쪽은 다음 빈 포트를 씁니다. 하나만 쓴다면 다른 쪽은 그 프로그램에서 꺼 두세요.
          </span>
        </div>
      )}

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
              <BootLog lines={bootLog} open={showLog} onToggle={() => setShowLog(!showLog)} />
            </>
          ) : state.running ? (
            <>
              <p role="status">
                <span className="spinner" /> 클러스터가 아직 시작하는 중입니다…
              </p>
              <p className="muted">느린 PC나 작은 가상 머신에서는 10분 넘게 걸리기도 합니다. 다 되면 이 화면이 저절로 바뀝니다.</p>
              <BootLog lines={bootLog} open={showLog} onToggle={() => setShowLog(!showLog)} />
            </>
          ) : (
            <>
              <p>
                {state.exists ? "클러스터가 꺼져 있습니다. 안에 배포해 둔 것은 그대로 있습니다." : "아직 클러스터가 없습니다."}
              </p>
              <button className="primary" onClick={start} data-testid="kube-start">
                Kubernetes 켜기
              </button>
              {bootLog.length > 0 && (
                <>
                  <p className="muted">아래는 클러스터 컨테이너가 꺼지기 전에 남긴 로그입니다. 켜는 중에 꺼졌다면 끝부분에 이유가 있습니다.</p>
                  <BootLog lines={bootLog} open={showLog} onToggle={() => setShowLog(!showLog)} />
                </>
              )}
              {!state.exists && (
                <p className="muted">
                  <code>{state.image}</code> 이미지(약 300MB)로 <code>boxforge-k3s</code> 컨테이너를 만듭니다. 그 안에서 다시 컨테이너를 돌려야 해서
                  모든 권한(privileged)으로 실행하며, 이 PC에서만 닿는 6443번 포트를 씁니다(쓰이고 있으면 다음 빈 포트).
                </p>
              )}
            </>
          )}
        </div>
      )}

      {ready && (
        <>
          {tracking.length > 0 && (
            <DeployProgress
              since={trackSince}
              onLoad={async (namespace, name) => {
                const at = Date.now();
                if (await run(`docker save IMAGE | docker exec -i boxforge-k3s ctr -n k8s.io images import - && ${kubectl(`rollout restart deployment ${name} -n ${namespace}`)}`, () => call("KubeLoadFor", namespace, name))) {
                  setTrackSince(at);
                  refresh();
                }
              }}
              names={tracking}
              workloads={workloads}
              pods={pods}
              events={events}
              podTone={(p) => podStatus(p).tone}
              podText={(p) => { const t = podStatus(p).text; return meaning[t] ? `${t} · ${meaning[t]}` : t; }}
              onClose={() => setTracking([])}
            />
          )}
          {applied && (
            <Note className="applied" testid="applied" pre onClose={() => setApplied("")}>
              {applied}
            </Note>
          )}
          {copying && (
            <p className="note" role="status" data-testid="volume-copying">
              <span className="spinner" /> {`볼륨 ${copying}의 데이터를 클러스터의 저장소로 옮기는 중입니다. 그동안 이 저장소를 쓰는 앱은 잠깐 멈춥니다.`}
            </p>
          )}
          {sendingSince !== null && !deploying && applying === null && (
            <p className="note" role="status" data-testid="deploy-sending">
              <span className="spinner" /> {`배포할 내용을 클러스터에 보내는 중입니다 (${sent}초). 끝나면 아래에 진행 상황이 나옵니다.`}
            </p>
          )}
          <div className="tabs kube-tabs" role="tablist">
            {tabs.map(([id, label, n]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
                {label} {n !== null && <span className="count">{n}</span>}
              </button>
            ))}
          </div>

          {view === "pods" &&
            (shownPods.length === 0 ? (
              <p className="empty">파드가 없습니다. "앱 배포"로 앱을 띄워 보세요.</p>
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
                    const why = s.tone === "bad" || s.tone === "wait" ? whyPod(p, events) : "";
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
                          {why && (
                            <span className="sub why" data-testid="pod-why">
                              원인: {why}
                            </span>
                          )}
                        </td>
                        <td className="num">{restarts}</td>
                        <td className="muted nowrap">{since(p.metadata.creationTimestamp)}</td>
                        <td className="actions">
                          <button onClick={() => open(`${name} 로그`, `logs ${name} -n ${namespace} --tail=500`, () => call<string>("KubeLogs", namespace, name))}>로그</button>
                          <Menu
                            items={[
                              ...(s.text === "Running" || s.text === "NotReady" ? [{ label: "터미널", onClick: () => setShell({ namespace, name }) }] : []),
                              { label: "자세히 (describe)", onClick: () => open(name, `describe pod ${name} -n ${namespace}`, () => call<string>("KubeDescribe", "pod", namespace, name)) },
                              { label: "삭제 (워크로드가 새로 만듦)", onClick: () => del("pod", namespace, name, "이 파드를 지웁니다. 워크로드가 관리하는 파드라면 새 파드가 곧 다시 만들어집니다. 파드 안에만 있던 파일은 사라집니다."), danger: true },
                            ]}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ))}

          {view === "workloads" &&
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
                    const stuck = have < want ? podsOf(w, pods).find((p) => podStatus(p).tone !== "ok") : undefined;
                    const why = stuck ? whyPod(stuck, events) : "";
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
                          {why && <span className="sub why">원인: {why}</span>}
                        </td>
                        <td className="muted nowrap">{since(w.metadata.creationTimestamp)}</td>
                        <td className="actions">
                          {w.kind !== "DaemonSet" && (
                            <>
                              <IconButton icon="minus" label="파드 하나 줄이기" disabled={want <= 0} onClick={() => act(`scale ${kind} ${name} -n ${namespace} --replicas=${want - 1}`, "KubeScale", kind, namespace, name, want - 1)} />
                              <IconButton icon="plus" label="파드 하나 늘리기" onClick={() => act(`scale ${kind} ${name} -n ${namespace} --replicas=${want + 1}`, "KubeScale", kind, namespace, name, want + 1)} />
                            </>
                          )}
                          <IconButton icon="edit" label="고치기 (YAML)" onClick={() => edit(kind, namespace, name)} />
                          <IconButton icon="restart" label="파드를 새로 바꾸기 (rollout restart)" onClick={() => act(`rollout restart ${kind} ${name} -n ${namespace}`, "KubeRestart", kind, namespace, name)} />
                          <IconButton icon="trash" label="삭제 (파드도 함께 사라짐)" tone="danger" onClick={() => del(kind, namespace, name, `${w.kind} ${name}와 그 파드 ${have}개를 지웁니다. 서비스 · 주소 · 저장소는 남습니다.`)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ))}

          {view === "services" && forwards.length > 0 && (
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
                  <a className="link" href={`${secure(f.port) ? "https" : "http"}://localhost:${f.local}`} target="_blank" rel="noreferrer">
                    브라우저로 열기
                  </a>
                  <button onClick={() => unforward(f)}>끊기</button>
                  {f.namespace === "default" && f.service === "kubernetes" && (
                    <span className="sub" data-testid="api-forward-note">
                      이것은 앱이 아니라 Kubernetes 자신의 관리 창구(API)입니다. 웹 페이지가 없고, 열면 인증서 경고 뒤에 "권한 없음"(Unauthorized) 응답만 나옵니다. 내 앱은 그 앱의 서비스를 연결하세요.
                    </span>
                  )}
                </div>
              ))}
              <span className="sub">BoxForge가 켜져 있는 동안만 이어집니다.</span>
            </div>
          )}
          {view === "services" &&
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
                          {s.spec?.clusterIP === "None" ? <span className="muted" title="주소 없이 이름이 파드의 주소를 가리킵니다(모든 포트). Compose에서 옮긴 서비스가 이렇게 됩니다.">이름으로 찾기</span> : <code>{s.spec?.clusterIP}</code>}
                          <span className="sub">
                            {name}.{namespace}
                          </span>
                        </td>
                        <td>{(s.spec?.ports ?? []).map((p: any) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol}`).join(", ") || "—"}</td>
                        <td className="actions">
                          {tcpPorts(s).length > 0 && s.spec?.clusterIP && (
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
                            <>
                            <IconButton icon="edit" label="고치기 (YAML)" onClick={() => edit("service", namespace, name)} />
                            <IconButton icon="trash" label="삭제" tone="danger" onClick={() => del("service", namespace, name, `서비스 ${name}를 지웁니다. 파드는 그대로 돌지만, 이 이름으로 접속하던 곳은 더 닿지 않습니다.`)} />
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ))}

          {view === "loading" && (
            <p className="muted" role="status" data-testid="kube-loading">
              <span className="spinner" /> 클러스터에서 목록을 읽는 중… 느린 기계에서는 시간이 걸립니다.
            </p>
          )}
          {view === "flow" && moved.length > 0 && (
            <div className="kube-bar moved-projects" data-testid="moved-projects">
              <span className="muted">Compose에서 옮긴 프로젝트</span>
              {moved.map((ns) => {
                const name = ns.metadata.name;
                const apps = workloads.filter((w) => w.metadata.namespace === name).length;
                return (
                  <span key={name} className="chip">
                    {name}
                    <button type="button" className="link" onClick={() => setInspect({ namespace: name, tab: "reach" })}>
                      연결 점검
                    </button>
                    <button type="button" className="link" onClick={() => setInspect({ namespace: name, tab: "logs" })}>
                      로그 모아 보기
                    </button>
                    <button
                      type="button"
                      className="link"
                      onClick={() =>
                        setConfirm({
                          title: `${name} 프로젝트 지우기`,
                          body: `네임스페이스 ${name}와 그 안의 모든 것(워크로드 ${apps}개, 서비스, 저장소와 그 데이터)을 지웁니다. 되돌릴 수 없습니다. Compose로 띄운 컨테이너와 볼륨은 그대로입니다.`,
                          command: kubectl(`delete namespace ${name}`),
                          go: () => call("KubeDelete", "namespace", "", name),
                        })
                      }
                    >
                      통째로 지우기
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          {view === "flow" && <Flow workloads={shownWork} services={shownSvc} ingresses={shownIng} pods={shownPods} events={events} podTone={(p) => podStatus(p).tone} />}

          {view === "ingresses" && (
            <div className="note-box forwards" data-testid="address-box">
              {traefik ? (
                <>
                  <strong>주소가 내 PC의 {traefik.local}번 포트로 열려 있습니다</strong>
                  <span className="sub">아래 주소를 누르면 브라우저로 열립니다. BoxForge가 켜져 있는 동안만 이어집니다.</span>
                </>
              ) : (
                <>
                  <strong>주소로 접속하려면 내 PC로 연결하세요</strong>
                  <span className="sub">
                    클러스터의 입구(Traefik, 80번)를 이 PC의 8080번 포트로 잇습니다. 그다음 <code>이름.localhost:8080</code> 으로 접속합니다.
                  </span>
                  <span>
                    <button onClick={openAddress} disabled={!gate}>
                      내 PC로 연결 (8080)
                    </button>
                  </span>
                  {!gate && <span className="sub">클러스터의 입구를 아직 준비하는 중입니다. 처음 켠 뒤 1~2분 걸립니다.</span>}
                </>
              )}
            </div>
          )}
          {view === "ingresses" &&
            (shownIng.length === 0 ? (
              <p className="empty">주소(Ingress)가 없습니다. "앱 배포"에서 접속 방법을 "주소로"로 고르면 만들어집니다.</p>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>이름</th>
                    <th>주소</th>
                    <th>보내는 곳</th>
                    <th className="actions">작업</th>
                  </tr>
                </thead>
                <tbody>
                  {shownIng.map((i) => {
                    const { name, namespace } = i.metadata;
                    return (
                      <tr key={namespace + name} data-testid={`ingress-${name}`}>
                        <td>
                          <span className="name">{name}</span>
                          <span className="sub">{namespace}</span>
                        </td>
                        <td>
                          {routes(i).map((r) => {
                            const url = `http://${r.host || "localhost"}${traefik ? `:${traefik.local}` : ""}${r.path}`;
                            return (
                              <span key={r.host + r.path} className="block">
                                {traefik ? (
                                  <a className="link" href={url} target="_blank" rel="noreferrer">
                                    {url}
                                  </a>
                                ) : (
                                  <code>{(r.host || "*") + r.path}</code>
                                )}
                                {r.host && !r.host.endsWith(".localhost") && r.host !== "localhost" && <span className="sub">이 이름이 이 PC를 가리키게 hosts 파일에 적어야 열립니다.</span>}
                              </span>
                            );
                          })}
                        </td>
                        <td>
                          {routes(i).map((r) => (
                            <span key={r.host + r.path + "b"} className="block">
                              {r.service}:{r.port}
                            </span>
                          ))}
                        </td>
                        <td className="actions">
                          <IconButton icon="edit" label="고치기 (YAML)" onClick={() => edit("ingress", namespace, name)} />
                          <IconButton icon="trash" label="삭제" tone="danger" onClick={() => del("ingress", namespace, name, `주소 ${name}을 지웁니다. 앱은 그대로 돌지만 이 주소로는 더 열리지 않습니다.`)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ))}

          {view === "config" && (
            <div className="kube-bar">
              <p className="muted">앱에 줄 설정을 모아 둡니다. ConfigMap은 보통 설정, Secret은 비밀번호 · 키입니다.</p>
              <span className="spacer" />
              <button className="primary" onClick={() => setMaking("data")}>
                설정값 만들기
              </button>
            </div>
          )}
          {view === "config" &&
            (shownData.length === 0 ? (
              <p className="empty">설정값이 없습니다.</p>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>이름</th>
                    <th>종류</th>
                    <th>키</th>
                    <th>만든 때</th>
                    <th className="actions">작업</th>
                  </tr>
                </thead>
                <tbody>
                  {shownData.map((c) => {
                    const { name, namespace } = c.metadata;
                    const secret = c.kind === "Secret";
                    const kind = secret ? "secret" : "configmap";
                    const keys: string[] = Object.keys((secret ? c.sizes : c.data) ?? {});
                    return (
                      <tr key={c.kind + namespace + name} data-testid={`${kind}-${name}`}>
                        <td>
                          <span className="name">{name}</span>
                          <span className="sub">{namespace}</span>
                        </td>
                        <td>
                          {c.kind}
                          {secret && c.type !== "Opaque" && <span className="sub">{c.type}</span>}
                        </td>
                        <td>
                          {keys.length === 0 ? (
                            <span className="muted">없음</span>
                          ) : (
                            keys.map((k) => (
                              <span key={k} className="block">
                                <code>{k}</code>
                                {secret ? <span className="muted"> · {c.sizes[k]}바이트 (값은 보이지 않음)</span> : <span className="muted"> = {String(c.data[k]).slice(0, 60)}</span>}
                              </span>
                            ))
                          )}
                        </td>
                        <td className="muted nowrap">{since(c.metadata.creationTimestamp)}</td>
                        <td className="actions">
                          <button onClick={() => open(name, `describe ${kind} ${name} -n ${namespace}`, () => call<string>("KubeDescribe", kind, namespace, name))}>자세히</button>
                          {!secret && <IconButton icon="edit" label="고치기 (YAML)" onClick={() => edit(kind, namespace, name)} />}
                          <IconButton icon="trash" label="삭제" tone="danger" onClick={() => del(kind, namespace, name, `${c.kind} ${name}의 값 ${keys.length}개를 지웁니다. 이것을 쓰는 앱은 다시 시작할 때 설정을 찾지 못합니다.`)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ))}

          {view === "storage" && (
            <div className="kube-bar">
              <p className="muted">파드가 지워져도 남는 저장 공간(PersistentVolumeClaim)입니다.</p>
              <span className="spacer" />
              <button className="primary" onClick={() => setMaking("pvc")}>
                저장소 만들기
              </button>
            </div>
          )}
          {view === "storage" &&
            (shownPvc.length === 0 ? (
              <p className="empty">저장소가 없습니다.</p>
            ) : (
              <table className="grid">
                <thead>
                  <tr>
                    <th>이름</th>
                    <th>상태</th>
                    <th>크기</th>
                    <th>쓰는 파드</th>
                    <th className="actions">작업</th>
                  </tr>
                </thead>
                <tbody>
                  {shownPvc.map((v) => {
                    const { name, namespace } = v.metadata;
                    const users = pods.filter((p) => p.metadata.namespace === namespace && (p.spec?.volumes ?? []).some((x: any) => x.persistentVolumeClaim?.claimName === name));
                    const phase: string = v.status?.phase ?? "Pending";
                    return (
                      <tr key={namespace + name} data-testid={`pvc-${name}`}>
                        <td>
                          <span className="name">{name}</span>
                          <span className="sub">{namespace}</span>
                        </td>
                        <td>
                          <span className={"state " + (phase === "Bound" ? "running" : "paused")}>
                            <span className="dot" />
                            {phase}
                          </span>
                          <span className="sub">{phase === "Bound" ? "자리가 잡혀 쓰는 중" : phase === "Pending" ? "파드가 처음 쓸 때 만들어짐" : ""}</span>
                        </td>
                        <td>{v.status?.capacity?.storage ?? v.spec?.resources?.requests?.storage}</td>
                        <td>{users.length ? users.map((p) => <span key={p.metadata.name} className="block">{p.metadata.name}</span>) : <span className="muted">없음</span>}</td>
                        <td className="actions">
                          <IconButton
                            icon="trash"
                            label="삭제"
                            tone="danger"
                            onClick={() => del("persistentvolumeclaim", namespace, name, `저장소 ${name}와 그 안의 데이터를 모두 지웁니다. 되돌릴 수 없습니다.${users.length ? ` 지금 쓰는 파드(${users.map((p) => p.metadata.name).join(", ")})가 끝날 때까지 지워지지 않고 기다립니다.` : ""}`)}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ))}

          {view === "events" &&
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
        <Dialog title={editing ? `${editing} 고치기` : "YAML 적용"} onClose={() => setApplying(null)} wide>
          <p className="muted">
            {editing
              ? "지금 클러스터에 있는 그대로입니다. 고친 뒤 적용하면 지우지 않고 바뀝니다. 파드의 설정(이미지 · 환경변수 · 명령 등)을 바꾸면 새 파드로 하나씩 바뀝니다."
              : "만들거나 바꿀 것을 YAML로 적습니다. 아래는 nginx 두 개를 띄우고 이름을 붙이는 예시입니다. 같은 이름이 이미 있으면 내용이 바뀝니다."}
          </p>
          <textarea className="editor" aria-label="적용할 YAML" spellCheck={false} value={applying} onChange={(e) => setApplying(e.target.value)} />
          <div className="dialog-actions">
            <button onClick={() => setApplying(null)}>취소</button>
            <button className="primary" disabled={!applying.trim() || sendingSince !== null} onClick={apply}>
              {sendingSince !== null ? "적용하는 중…" : "적용"}
            </button>
          </div>
          {sendingSince !== null && (
            <p className="muted" role="status">
              <span className="spinner" /> {`클러스터에 보내는 중입니다 (${sent}초). 느린 기계에서는 1분 넘게 걸리기도 합니다.`}
            </p>
          )}
        </Dialog>
      )}

      {deploying && <DeployDialog data={[...configs, ...secrets]} init={deployInit} busy={working} busyText={`클러스터에 보내는 중입니다 (${sent}초). 느린 기계에서는 1분 넘게 걸리기도 합니다.`} onApply={(y, d) => deploy(y, d.fromEngine ? [d.image.trim()] : [])} onYaml={(y) => (setDeploying(false), setApplying(y))} onClose={() => setDeploying(false)} />}
      {making === "data" && <DataDialog busy={working} onCreate={makeData} onClose={() => setMaking(null)} />}
      {making === "pvc" && <PvcDialog busy={working} onCreate={(y) => deploy(y)} onClose={() => setMaking(null)} />}
      {inspect && <ProjectCheck namespace={inspect.namespace} tab={inspect.tab} showCli={showCli} onClose={() => setInspect(null)} />}
      {confirm && (
        <Dialog title={confirm.title} onClose={() => setConfirm(null)}>
          <p>{confirm.body}</p>
          <div className="cli-preview">
            <span className="muted">같은 일을 하는 명령</span>
            <code>{confirm.command}</code>
          </div>
          <div className="dialog-actions">
            <button onClick={() => setConfirm(null)}>취소</button>
            <button
              className="danger solid"
              onClick={async () => {
                const c = confirm;
                setConfirm(null);
                await run(c.command, c.go);
                refresh();
              }}
            >
              삭제
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
