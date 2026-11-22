// Kubernetes, the parts beyond the plain lists: the deploy helper, making
// settings (ConfigMap · Secret) and storage (PVC), why a pod is stuck, and
// the picture of how a request reaches the pods.
import { useEffect, useMemo, useState } from "react";
import { type Pair } from "./recipes";
import { Pairs } from "./RunDialog";
import { call } from "./bridge";
import { Dialog } from "./ui";

export interface Meta {
  name: string;
  namespace: string;
  creationTimestamp: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
}
export interface Item {
  kind: string;
  metadata: Meta;
  spec: any;
  status: any;
  [key: string]: any;
}

/** Whether every label the selector asks for is on the object. */
export const selects = (selector: Record<string, string> | undefined, labels: Record<string, string> | undefined) =>
  !!selector && Object.keys(selector).length > 0 && Object.entries(selector).every(([k, v]) => labels?.[k] === v);

/** The pods a workload runs: same namespace, its selector's labels. */
export const podsOf = (w: Item, pods: Item[]) => pods.filter((p) => p.metadata.namespace === w.metadata.namespace && selects(w.spec?.selector?.matchLabels, p.metadata.labels));

/** The services that send to a workload's pods. */
export const servicesOf = (w: Item, services: Item[]) =>
  services.filter((s) => s.metadata.namespace === w.metadata.namespace && selects(s.spec?.selector, w.spec?.template?.metadata?.labels));

/** Where an ingress sends: [host, path, service, port] for each rule. */
export function routes(ing: Item): { host: string; path: string; service: string; port: string }[] {
  const out: { host: string; path: string; service: string; port: string }[] = [];
  const back = (b: any) => ({ service: b?.service?.name ?? "", port: String(b?.service?.port?.number ?? b?.service?.port?.name ?? "") });
  if (ing.spec?.defaultBackend) out.push({ host: "", path: "/", ...back(ing.spec.defaultBackend) });
  for (const r of ing.spec?.rules ?? []) {
    for (const p of r.http?.paths ?? []) out.push({ host: r.host ?? "", path: p.path ?? "/", ...back(p.backend) });
  }
  return out;
}

// What the cluster's own reasons mean, for the ones people meet first.
const eventMeaning: Record<string, string> = {
  FailedScheduling: "파드를 놓을 자리를 찾지 못했습니다(메모리 · CPU가 모자라거나, 쓸 저장소가 아직 없음)",
  FailedMount: "저장소나 설정값(ConfigMap · Secret)을 붙이지 못했습니다. 이름이 맞는지 확인하세요",
  FailedAttachVolume: "저장소를 붙이지 못했습니다",
  Unhealthy: "상태 검사(probe)에 실패했습니다",
  BackOff: "실패해서 잠시 기다렸다가 다시 해 봅니다",
  Failed: "실패했습니다",
  FailedCreatePodSandBox: "파드가 들어갈 자리(sandbox)를 만들지 못했습니다",
  ProvisioningFailed: "저장 공간을 만들지 못했습니다",
};

/**
 * Why a pod is not running as it should: the container's own message, or
 * else the latest warning the cluster wrote about it, in plain words.
 */
export function whyPod(p: Item, events: Item[]): string {
  for (const c of [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])]) {
    const w = c.state?.waiting;
    const last = c.lastState?.terminated;
    // Ended by itself, with nothing wrong: an image with nothing to do (a
    // bare shell, as alpine and ubuntu run) is restarted over and over.
    if (w?.reason === "CrashLoopBackOff" && last?.exitCode === 0) {
      return "할 일 없이 바로 끝나는 이미지입니다(alpine · ubuntu 같은 기본 이미지는 셸만 있어서, 터미널이 없으면 곧바로 끝납니다). Kubernetes는 끝난 컨테이너를 계속 다시 켭니다. 다시 배포할 때 '실행할 명령'을 주거나 '터미널을 연 채로 두기'를 켜세요.";
    }
    if (w?.message && w.reason !== "ContainerCreating" && w.reason !== "PodInitializing") return w.message;
    const t = c.lastState?.terminated ?? c.state?.terminated;
    if (t && t.reason !== "Completed" && (c.restartCount ?? 0) > 0) return `마지막으로 끝난 이유: ${t.reason}${t.exitCode != null ? ` (종료 코드 ${t.exitCode})` : ""}`;
  }
  const mine = events
    .filter((e) => e.type === "Warning" && e.involvedObject?.kind === "Pod" && e.involvedObject?.name === p.metadata.name && e.metadata.namespace === p.metadata.namespace)
    .sort((a, b) => Date.parse(b.lastTimestamp ?? b.metadata.creationTimestamp) - Date.parse(a.lastTimestamp ?? a.metadata.creationTimestamp));
  const e = mine[0];
  if (e) return eventMeaning[e.reason] ? `${eventMeaning[e.reason]} — ${e.message}` : e.message;
  for (const c of p.status?.conditions ?? []) {
    if (c.status === "False" && c.message) return c.message;
  }
  return "";
}

/** Text a name may be: what Kubernetes allows, from what was typed. */
export const kubeName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63);
const validName = (s: string) => /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(s);

const q = (s: string) => JSON.stringify(s); // a YAML string that is always read as text

export interface Deploy {
  name: string;
  image: string;
  replicas: string;
  port: string;
  env: Pair[];
  from: string; // "configmap:<name>" or "secret:<name>"; "" for none
  reach: "none" | "inside" | "address";
  host: string;
  disk: string; // GB of storage to keep; "" for none
  mount: string;
  command: string; // run in place of the image's own ("" for its own), through sh -c
  keepOpen: boolean; // a terminal and input kept open: what a bare shell needs to stay up
}

export const emptyDeploy: Deploy = { name: "", image: "", replicas: "1", port: "", env: [], from: "", reach: "inside", host: "", disk: "", mount: "/data", command: "", keepOpen: false };

// Base images whose own command is only a shell, when the engine can't say.
const shellImage = /^(?:docker\.io\/)?(?:library\/)?(alpine|ubuntu|debian|busybox|fedora|centos|rockylinux|almalinux|archlinux|amazonlinux|oraclelinux|opensuse\/\w+)(?::[^/]*)?$/;
export const looksBareShell = (image: string) => shellImage.test(image.trim().replace(/^mirror\.gcr\.io\//, ""));

/** The YAML the deploy helper applies. */
export function deployYaml(d: Deploy): string {
  const name = d.name;
  const port = +d.port || 0;
  const env = d.env.filter((r) => r.a.trim());
  const [fromKind, fromName] = d.from.split(":");
  const lines = [
    "apiVersion: apps/v1",
    "kind: Deployment",
    "metadata:",
    `  name: ${name}`,
    "spec:",
    `  replicas: ${Math.max(0, +d.replicas || 0)}`,
    "  selector:",
    `    matchLabels: { app: ${name} }`,
    "  template:",
    "    metadata:",
    `      labels: { app: ${name} }`,
    "    spec:",
    "      containers:",
    `        - name: ${name}`,
    `          image: ${q(d.image.trim())}`,
  ];
  if (d.command.trim()) lines.push(`          command: ["sh", "-c", ${q(d.command.trim())}]`);
  else if (d.keepOpen) lines.push("          stdin: true", "          tty: true");
  if (port) lines.push("          ports:", `            - containerPort: ${port}`);
  if (env.length) {
    lines.push("          env:");
    for (const r of env) lines.push(`            - name: ${q(r.a.trim())}`, `              value: ${q(r.b)}`);
  }
  if (fromName) lines.push("          envFrom:", `            - ${fromKind === "secret" ? "secretRef" : "configMapRef"}: { name: ${fromName} }`);
  if (+d.disk > 0) {
    lines.push("          volumeMounts:", `            - name: data`, `              mountPath: ${q(d.mount || "/data")}`);
    lines.push("      volumes:", "        - name: data", `          persistentVolumeClaim: { claimName: ${name}-data }`);
  }
  if (+d.disk > 0) lines.push("---", ...pvcLines(`${name}-data`, d.disk));
  if (port && d.reach !== "none") {
    lines.push("---", "apiVersion: v1", "kind: Service", "metadata:", `  name: ${name}`, "spec:", `  selector: { app: ${name} }`, "  ports:", `    - port: ${port}`, `      targetPort: ${port}`);
  }
  if (port && d.reach === "address") {
    lines.push(
      "---",
      "apiVersion: networking.k8s.io/v1",
      "kind: Ingress",
      "metadata:",
      `  name: ${name}`,
      "spec:",
      "  rules:",
      `    - host: ${q(d.host || `${name}.localhost`)}`,
      "      http:",
      "        paths:",
      "          - path: /",
      "            pathType: Prefix",
      "            backend:",
      `              service: { name: ${name}, port: { number: ${port} } }`,
    );
  }
  return lines.join("\n") + "\n";
}

function pvcLines(name: string, gb: string) {
  return [
    "apiVersion: v1",
    "kind: PersistentVolumeClaim",
    "metadata:",
    `  name: ${name}`,
    "spec:",
    "  accessModes: [ReadWriteOnce]",
    "  resources:",
    `    requests: { storage: ${Math.max(1, Math.round(+gb || 1))}Gi }`,
  ];
}
export const pvcYaml = (name: string, gb: string) => pvcLines(name, gb).join("\n") + "\n";

/** The deploy helper: a form for the usual case, and the YAML it makes. */
export function DeployDialog(props: { data: Item[]; onApply: (yaml: string, d: Deploy) => void; onYaml: (yaml: string) => void; onClose: () => void; busy: boolean; busyText?: string }) {
  const [d, setD] = useState<Deploy>(emptyDeploy);
  const [show, setShow] = useState(false);
  const set = (patch: Partial<Deploy>) => setD((old) => ({ ...old, ...patch }));
  const yaml = useMemo(() => deployYaml(d), [d]);
  // An image that only runs a shell ends at once without a terminal: found
  // out (from the engine's copy, else by its name) and kept open.
  const [bare, setBare] = useState(false);
  useEffect(() => {
    const image = d.image.trim();
    if (!image) return setBare(false);
    let stale = false;
    const t = setTimeout(() => {
      call<{ shell: boolean }>("ImageDefaults", image).then(
        (x) => !stale && found(!!x?.shell || looksBareShell(image)),
        () => !stale && found(looksBareShell(image)),
      );
    }, 400);
    const found = (yes: boolean) => {
      setBare(yes);
      if (yes) set({ keepOpen: true });
    };
    return () => {
      stale = true;
      clearTimeout(t);
    };
  }, [d.image]);
  const portOk = !d.port || (+d.port > 0 && +d.port < 65536);
  const ok = validName(d.name) && d.image.trim() !== "" && !/\s/.test(d.image.trim()) && portOk;
  const sources = props.data.filter((i) => i.metadata.namespace === "default");
  return (
    <Dialog title="앱 배포" onClose={props.onClose} wide>
      <p className="muted">이미지 하나를 클러스터에 띄웁니다. 필요한 것(Deployment, Service, Ingress, 저장소)을 YAML로 만들어 적용합니다.</p>
      <form
        className="run-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) props.onApply(yaml, d);
        }}
      >
        <label>
          이미지
          <input autoFocus aria-label="이미지" placeholder="예: nginx:alpine" value={d.image} onChange={(e) => set({ image: e.target.value, name: d.name || kubeName(e.target.value.split("/").pop()!.split(":")[0]) })} />
          <span className="help">이름만 적으면 Docker Hub의 공식 이미지입니다(alpine = docker.io/library/alpine:latest). 버전을 고정하려면 alpine:3.20처럼 :태그를, 다른 곳의 이미지는 ghcr.io/사용자/이름처럼 주소째 적습니다.</span>
        </label>
        <label>
          이름
          <input aria-label="이름" placeholder="영어 소문자, 숫자, -" value={d.name} onChange={(e) => set({ name: kubeName(e.target.value) })} />
          <span className="help">파드 · 서비스 · 주소가 모두 이 이름을 씁니다.</span>
        </label>
        <div className="two-up">
          <label>
            파드 개수
            <input aria-label="파드 개수" inputMode="numeric" value={d.replicas} onChange={(e) => set({ replicas: e.target.value.replace(/\D/g, "").slice(0, 2) })} />
            <span className="help">같은 컨테이너를 몇 개 띄울지. 하나가 죽어도 나머지가 일합니다.</span>
          </label>
          <label>
            컨테이너 포트
            <input aria-label="컨테이너 포트" inputMode="numeric" placeholder="예: 80" value={d.port} onChange={(e) => set({ port: e.target.value.replace(/\D/g, "").slice(0, 5) })} />
            <span className="help">앱이 기다리는 포트. 웹이 아니면 비워 둡니다.</span>
          </label>
        </div>
        <label>
          실행할 명령
          <input aria-label="실행할 명령" placeholder="비워 두면 이미지에 정해진 것" value={d.command} onChange={(e) => set({ command: e.target.value })} />
          <span className="help">예: sleep infinity, python app.py. sh -c 로 실행합니다.</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={d.keepOpen && !d.command.trim()} disabled={!!d.command.trim()} onChange={(e) => set({ keepOpen: e.target.checked })} />
          터미널을 연 채로 두기
        </label>
        {bare && (
          <p className="note" data-testid="bare-shell">
            이 이미지는 셸만 실행합니다. 터미널이 없으면 바로 끝나서 Kubernetes가 계속 다시 켜기만 하므로, "터미널을 연 채로 두기"를 켜 두었습니다. 파드의 터미널로 들어가 쓸 수 있습니다.
          </p>
        )}
        {d.port && (
          <fieldset>
            <legend>접속 방법</legend>
            <label className="check">
              <input type="radio" name="reach" checked={d.reach === "none"} onChange={() => set({ reach: "none" })} />
              접속하지 않음
            </label>
            <label className="check">
              <input type="radio" name="reach" checked={d.reach === "inside"} onChange={() => set({ reach: "inside" })} />
              <span>
                클러스터 안에서 이름으로 (Service) — 다른 앱이 <code>{d.name || "이름"}:{d.port}</code> 로 접속
              </span>
            </label>
            <label className="check">
              <input type="radio" name="reach" checked={d.reach === "address"} onChange={() => set({ reach: "address" })} />
              <span>
                주소로 (Ingress) — 브라우저에서 <code>{d.host || `${d.name || "이름"}.localhost`}</code> 로 접속
              </span>
            </label>
            {d.reach === "address" && (
              <label>
                주소
                <input aria-label="주소" placeholder={`${d.name || "이름"}.localhost`} value={d.host} onChange={(e) => set({ host: e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, "") })} />
                <span className="help">.localhost 로 끝나는 주소는 따로 설정하지 않아도 이 PC를 가리킵니다. "주소" 탭에서 내 PC로 연결하면 열립니다.</span>
              </label>
            )}
          </fieldset>
        )}
        <Pairs label="환경변수" help="앱에 줄 설정. 비밀번호는 아래의 Secret으로 주세요." rows={d.env} onChange={(env) => set({ env })} a="이름" b="값" sep="=" />
        <label>
          설정값 모두 넣기
          <select aria-label="설정값 모두 넣기" value={d.from} onChange={(e) => set({ from: e.target.value })}>
            <option value="">넣지 않음</option>
            {sources.map((s) => (
              <option key={s.kind + s.metadata.name} value={`${s.kind === "Secret" ? "secret" : "configmap"}:${s.metadata.name}`}>
                {s.kind} {s.metadata.name}
              </option>
            ))}
          </select>
          <span className="help">ConfigMap이나 Secret의 키들이 환경변수로 들어갑니다. "설정값" 탭에서 만듭니다.</span>
        </label>
        <div className="two-up">
          <label>
            저장소 (GB)
            <input aria-label="저장소 (GB)" inputMode="numeric" placeholder="비워 두면 없음" value={d.disk} onChange={(e) => set({ disk: e.target.value.replace(/\D/g, "").slice(0, 4) })} />
            <span className="help">파드를 지우거나 바꿔도 남는 공간. 파드 개수는 1개일 때 씁니다.</span>
          </label>
          {+d.disk > 0 && (
            <label>
              붙일 경로
              <input aria-label="붙일 경로" value={d.mount} onChange={(e) => set({ mount: e.target.value })} />
            </label>
          )}
        </div>
        <button type="button" className="link" onClick={() => setShow(!show)}>
          {show ? "YAML 숨기기" : "만들어질 YAML 보기"}
        </button>
        {show && (
          <pre className="log-box yaml" data-testid="deploy-yaml">
            {yaml}
          </pre>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={props.onClose}>
            취소
          </button>
          <button type="button" disabled={!ok} onClick={() => props.onYaml(yaml)}>
            YAML로 고치기
          </button>
          <button className="primary" type="submit" disabled={!ok || props.busy}>
            {props.busy ? "배포하는 중…" : "배포"}
          </button>
        </div>
        {props.busy && props.busyText && (
          <p className="muted" role="status" data-testid="deploy-sending">
            <span className="spinner" /> {props.busyText}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** Making a ConfigMap or a Secret from keys and values. */
export function DataDialog(props: { onCreate: (kind: "configmap" | "secret", name: string, data: Record<string, string>) => void; onClose: () => void; busy: boolean }) {
  const [kind, setKind] = useState<"configmap" | "secret">("configmap");
  const [name, setName] = useState("");
  const [rows, setRows] = useState<Pair[]>([{ a: "", b: "" }]);
  const keys = rows.filter((r) => r.a.trim());
  const badKey = keys.find((r) => !/^[-._a-zA-Z0-9]+$/.test(r.a.trim()));
  const ok = validName(name) && keys.length > 0 && !badKey;
  return (
    <Dialog title="설정값 만들기" onClose={props.onClose}>
      <form
        className="run-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) props.onCreate(kind, name, Object.fromEntries(keys.map((r) => [r.a.trim(), r.b])));
        }}
      >
        <fieldset>
          <legend>종류</legend>
          <label className="check">
            <input type="radio" name="kind" checked={kind === "configmap"} onChange={() => setKind("configmap")} />
            ConfigMap — 보통 설정 (주소, 모드 같은 것)
          </label>
          <label className="check">
            <input type="radio" name="kind" checked={kind === "secret"} onChange={() => setKind("secret")} />
            Secret — 비밀번호 · 키. 만든 뒤에는 화면에 값을 보여주지 않습니다
          </label>
        </fieldset>
        <label>
          이름
          <input autoFocus aria-label="이름" placeholder="영어 소문자, 숫자, -" value={name} onChange={(e) => setName(kubeName(e.target.value))} />
        </label>
        <Pairs label="값" help="키는 영어 · 숫자 · - _ . 만 씁니다. 앱에는 보통 환경변수로 들어갑니다." rows={rows} onChange={setRows} a="키" b="값" sep="=" />
        {badKey && <p className="error">키 "{badKey.a}"에 쓸 수 없는 글자가 있습니다.</p>}
        <div className="dialog-actions">
          <button type="button" onClick={props.onClose}>
            취소
          </button>
          <button className="primary" type="submit" disabled={!ok || props.busy}>
            만들기
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** Making storage (a PersistentVolumeClaim). */
export function PvcDialog(props: { onCreate: (yaml: string, name: string) => void; onClose: () => void; busy: boolean }) {
  const [name, setName] = useState("");
  const [gb, setGb] = useState("1");
  const ok = validName(name) && +gb > 0;
  return (
    <Dialog title="저장소 만들기" onClose={props.onClose}>
      <p className="muted">파드가 지워져도 남는 저장 공간입니다. 클러스터 컨테이너의 볼륨(boxforge-k3s) 안에 만들어집니다.</p>
      <form
        className="run-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) props.onCreate(pvcYaml(name, gb), name);
        }}
      >
        <label>
          이름
          <input autoFocus aria-label="이름" value={name} onChange={(e) => setName(kubeName(e.target.value))} />
        </label>
        <label>
          크기 (GB)
          <input aria-label="크기 (GB)" inputMode="numeric" value={gb} onChange={(e) => setGb(e.target.value.replace(/\D/g, "").slice(0, 4))} />
          <span className="help">파드가 이 저장소를 처음 쓸 때 실제로 만들어집니다. 그 전에는 "Pending"으로 보입니다.</span>
        </label>
        <div className="dialog-actions">
          <button type="button" onClick={props.onClose}>
            취소
          </button>
          <button className="primary" type="submit" disabled={!ok || props.busy}>
            만들기
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * The picture: for each app, the address → service → workload → pods a
 * request goes through, with what is wrong where.
 */
export function Flow(props: { workloads: Item[]; services: Item[]; ingresses: Item[]; pods: Item[]; events: Item[]; podTone: (p: Item) => "ok" | "wait" | "bad" | "done" }) {
  const used = new Set<string>();
  const rows = props.workloads.map((w) => {
    const svcs = servicesOf(w, props.services);
    svcs.forEach((s) => used.add(s.metadata.namespace + "/" + s.metadata.name));
    const names = new Set(svcs.map((s) => s.metadata.name));
    const ings = props.ingresses.filter((i) => i.metadata.namespace === w.metadata.namespace && routes(i).some((r) => names.has(r.service)));
    return { w, svcs, ings, pods: podsOf(w, props.pods) };
  });
  // Services that reach no workload: a wrong selector is a common mistake.
  const lone = props.services.filter((s) => !used.has(s.metadata.namespace + "/" + s.metadata.name) && !(s.metadata.namespace === "default" && s.metadata.name === "kubernetes"));
  if (rows.length === 0 && lone.length === 0) return <p className="empty">배포한 앱이 없습니다. "앱 배포"로 시작해 보세요.</p>;
  return (
    <div className="flow" data-testid="kube-flow">
      <p className="muted">요청이 들어오는 길: 주소(Ingress) → 서비스 → 워크로드 → 파드. 빨간 곳이 막힌 곳입니다.</p>
      {rows.map(({ w, svcs, ings, pods }) => {
        const want = w.kind === "DaemonSet" ? w.status?.desiredNumberScheduled ?? 0 : w.spec?.replicas ?? 0;
        const have = (w.kind === "DaemonSet" ? w.status?.numberReady : w.status?.readyReplicas) ?? 0;
        const bad = pods.find((p) => props.podTone(p) === "bad" || props.podTone(p) === "wait");
        const why = have < want && bad ? whyPod(bad, props.events) : "";
        return (
          <div className="flow-row" key={w.kind + w.metadata.namespace + w.metadata.name} data-testid={`flow-${w.metadata.name}`}>
            <div className={"flow-node" + (ings.length ? "" : " none")}>
              <span className="flow-kind">주소</span>
              {ings.length ? ings.flatMap((i) => routes(i).map((r) => <code key={i.metadata.name + r.host + r.path}>{(r.host || "*") + r.path}</code>)) : <span className="muted">없음</span>}
            </div>
            <span className="flow-arrow" aria-hidden="true">→</span>
            <div className={"flow-node" + (svcs.length ? "" : " none")}>
              <span className="flow-kind">서비스</span>
              {svcs.length ? (
                svcs.map((s) => (
                  <span key={s.metadata.name}>
                    {s.metadata.name}
                    <span className="sub">{(s.spec?.ports ?? []).map((p: any) => p.port).join(", ")}</span>
                  </span>
                ))
              ) : (
                <span className="muted">없음 (밖에서 닿지 않음)</span>
              )}
            </div>
            <span className="flow-arrow" aria-hidden="true">→</span>
            <div className={"flow-node" + (have < want ? " bad" : "")}>
              <span className="flow-kind">{w.kind}</span>
              <span>{w.metadata.name}</span>
              <span className="sub">
                준비 {have} / {want}
              </span>
            </div>
            <span className="flow-arrow" aria-hidden="true">→</span>
            <div className="flow-node">
              <span className="flow-kind">파드</span>
              <span className="flow-pods">
                {pods.length === 0 ? (
                  <span className="muted">없음</span>
                ) : (
                  pods.map((p) => <span key={p.metadata.name} className={"flow-pod kube-" + props.podTone(p)} title={p.metadata.name} />)
                )}
              </span>
            </div>
            {why && <p className="flow-why">원인: {why}</p>}
          </div>
        );
      })}
      {lone.map((s) => (
        <div className="flow-row" key={"svc" + s.metadata.namespace + s.metadata.name}>
          <div className="flow-node bad">
            <span className="flow-kind">서비스</span>
            <span>{s.metadata.name}</span>
          </div>
          <p className="flow-why">이 서비스가 보낼 파드가 없습니다. selector({Object.entries(s.spec?.selector ?? {}).map(([k, v]) => `${k}=${v}`).join(", ") || "없음"})가 워크로드의 라벨과 맞는지 확인하세요.</p>
        </div>
      ))}
    </div>
  );
}

// What the cluster's ordinary events mean, as a deployment comes up.
const stepMeaning: Record<string, string> = {
  ScalingReplicaSet: "파드를 몇 개 둘지 정함",
  SuccessfulCreate: "파드를 만듦",
  Scheduled: "파드를 놓을 자리를 정함",
  Pulling: "이미지를 받는 중",
  Pulled: "이미지를 받음",
  Created: "컨테이너를 만듦",
  Started: "컨테이너를 시작함",
  Killing: "옛 컨테이너를 끝내는 중",
  BackOff: "실패해서 잠시 기다렸다가 다시 해 봄",
  Failed: "실패함",
  FailedScheduling: "파드를 놓을 자리를 찾지 못함",
  FailedMount: "저장소나 설정값을 붙이지 못함",
  ProvisioningSucceeded: "저장 공간을 만듦",
  WaitForFirstConsumer: "파드가 쓰기 시작하면 저장 공간을 만듦",
  ExternalProvisioning: "저장 공간을 만드는 중",
  Provisioning: "저장 공간을 만드는 중",
};

const when = (e: Item) => Date.parse(e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp) || 0;

/** The deployments named in `kubectl apply`'s answer ("deployment.apps/web created"). */
export const appliedDeployments = (out: string) => [...out.matchAll(/^deployment\.apps\/(\S+) (?:created|configured)/gm)].map((m) => m[1]);

/** Seconds since a moment, ticking: for "sending (12 s)". */
export function useElapsed(since: number | null) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.floor((Date.now() - since) / 1000);
}

/**
 * How a deployment just applied is coming up: each of its pods, and the
 * cluster's own steps (pod made, image being fetched, started) in plain words.
 */
export function DeployProgress(props: { names: string[]; workloads: Item[]; pods: Item[]; events: Item[]; podTone: (p: Item) => "ok" | "wait" | "bad" | "done"; podText: (p: Item) => string; onClose: () => void }) {
  const rows = props.names.map((name) => {
    const w = props.workloads.find((x) => x.kind === "Deployment" && x.metadata.name === name && x.metadata.namespace === "default");
    const pods = w ? podsOf(w, props.pods) : [];
    const want = w?.spec?.replicas ?? 0;
    const have = w?.status?.readyReplicas ?? 0;
    const mine = (e: Item) => {
      const o = e.involvedObject ?? {};
      return e.metadata.namespace === "default" && ((o.kind === "Deployment" && o.name === name) || ((o.kind === "ReplicaSet" || o.kind === "Pod") && String(o.name).startsWith(name + "-")) || (o.kind === "PersistentVolumeClaim" && o.name === name + "-data"));
    };
    // The same step again and again (a container restarted over and over) once, with how often.
    const steps: (Item & { times: number })[] = [];
    for (const e of props.events.filter(mine).sort((a, b) => when(a) - when(b))) {
      const prev = steps[steps.length - 1];
      if (prev && prev.reason === e.reason) prev.times += e.count ?? 1;
      else steps.push({ ...e, times: e.count ?? 1 });
    }
    steps.splice(0, Math.max(0, steps.length - 10));
    const done = !!w && want > 0 && have >= want;
    const stuck = pods.find((p) => props.podTone(p) === "bad");
    return { name, w, pods, want, have, steps, done, stuck };
  });
  const allDone = rows.every((r) => r.done || (r.w && r.want === 0));
  return (
    <div className={"note-box deploy-progress" + (allDone ? " done" : "")} data-testid="deploy-progress" role="status">
      {rows.map((r) => (
        <div key={r.name} className="deploy-app">
          <strong>
            {r.name}{" "}
            {r.done ? "배포가 끝났습니다" : !r.w ? "워크로드를 만드는 중…" : r.stuck ? "문제가 있습니다" : `배포하는 중… 파드 ${r.have} / ${r.want} 준비`}
          </strong>
          {r.pods.map((p) => (
            <span key={p.metadata.name} className="block">
              <span className={"state kube-" + props.podTone(p)}>
                <span className="dot" />
                {p.metadata.name}
              </span>{" "}
              <span className="muted">{props.podText(p)}</span>
            </span>
          ))}
          {r.stuck && <span className="sub why">원인: {whyPod(r.stuck, props.events)}</span>}
          {r.steps.length > 0 && (
            <ol className="deploy-steps">
              {r.steps.map((e) => (
                <li key={e.metadata.name} className={e.type === "Warning" ? "warn" : ""}>
                  <span>{stepMeaning[e.reason] ?? e.reason}</span>
                  {e.times > 1 && <span>{` (${e.times}번)`}</span>}
                  <span className="muted"> · {e.involvedObject?.kind} {e.message}</span>
                </li>
              ))}
            </ol>
          )}
        </div>
      ))}
      <div>
        <button type="button" onClick={props.onClose}>
          {allDone ? "닫기" : "그만 보기 (배포는 계속됨)"}
        </button>
      </div>
    </div>
  );
}
