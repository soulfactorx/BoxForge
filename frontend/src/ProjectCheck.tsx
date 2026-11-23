// A project moved to Kubernetes, looked into as a whole: how its services
// reach each other (each name found, each port answering, the pods not yet
// ready), and the logs of all its pods in one list, in time order.
import { useEffect, useMemo, useState } from "react";
import { call } from "./bridge";
import { levelOf } from "./Detail";
import { CopyButton, Dialog } from "./ui";

interface Reach {
  service: string;
  found: string[];
  ports: number[];
  targets: { pod: string; ip: string; port: number; open: boolean }[];
  waiting: string[];
}
interface LogLine {
  time: string;
  pod: string;
  container: string;
  text: string;
}

const kubectl = (rest: string) => `docker exec boxforge-k3s kubectl ${rest}`;
// The deployment a pod belongs to: its name less the two generated parts.
const appOf = (pod: string) => pod.split("-").slice(0, -2).join("-") || pod;

export default function ProjectCheck(props: { namespace: string; tab: "reach" | "logs"; showCli: (cmd: string) => void; onClose: () => void }) {
  const [tab, setTab] = useState(props.tab);
  return (
    <Dialog title={`${props.namespace} 점검`} onClose={props.onClose} wide>
      <div className="tabs" role="tablist">
        {(
          [
            ["reach", "연결 점검"],
            ["logs", "로그 모아 보기"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {tab === "reach" ? <ReachCheck namespace={props.namespace} showCli={props.showCli} /> : <ProjectLogs namespace={props.namespace} showCli={props.showCli} />}
      <div className="dialog-actions">
        <button type="button" onClick={props.onClose}>
          닫기
        </button>
      </div>
    </Dialog>
  );
}

function ReachCheck({ namespace, showCli }: { namespace: string; showCli: (cmd: string) => void }) {
  const [rows, setRows] = useState<Reach[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const check = () => {
    setBusy(true);
    setError("");
    showCli(`${kubectl(`get svc,endpoints -n ${namespace}`)}  # 그리고 클러스터 안에서 nslookup 이름 · nc -z 주소 포트`);
    call<Reach[]>("KubeCheck", namespace).then(
      (r) => (setRows(r), setBusy(false)),
      (e) => (setError(e.message), setBusy(false)),
    );
  };
  useEffect(check, [namespace]);

  const bad = rows ? rows.filter((r) => r.found.length === 0 || r.targets.some((t) => !t.open) || r.waiting.length > 0 || (r.ports.length > 0 && r.targets.length === 0)) : [];
  return (
    <div className="reach" data-testid="reach">
      <p className="help">
        서비스마다, 그 이름이 클러스터 안에서 주소로 바뀌는지(다른 서비스가 이름으로 찾을 수 있는지)와, 알려진 포트마다 파드가 실제로 받는지를 클러스터의 네트워크에서 직접 해 봅니다. Compose에서는 되던
        연결이 여기서 안 되면 원인이 이 표에 나옵니다.
      </p>
      <div className="row-actions">
        <button type="button" onClick={check} disabled={busy}>
          {busy ? "점검하는 중…" : "다시 점검"}
        </button>
      </div>
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      {rows && rows.length === 0 && <p className="empty">이 네임스페이스에는 서비스가 없습니다.</p>}
      {rows && rows.length > 0 && (
        <>
          <p className={bad.length ? "warn" : "note"} data-testid="reach-summary">
            {bad.length ? `서비스 ${rows.length}개 중 ${bad.length}개에 문제가 있습니다.` : `서비스 ${rows.length}개 모두 이름으로 찾아지고, 포트가 받습니다.`}
          </p>
          <table className="grid">
            <thead>
              <tr>
                <th>서비스 이름</th>
                <th>이름 → 주소</th>
                <th>포트 (파드별)</th>
                <th>무엇을 보면 되나</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.service} data-testid={`reach-${r.service}`}>
                  <td>
                    <code>{r.service}</code>
                  </td>
                  <td>{r.found.length ? <code>{r.found.join(", ")}</code> : <span className="state kube-bad">찾지 못함</span>}</td>
                  <td>
                    {r.ports.length === 0 && <span className="muted">알려진 포트 없음</span>}
                    {r.targets.map((t) => (
                      <span key={t.ip + t.port} className={"state " + (t.open ? "kube-ok" : "kube-bad")} title={t.pod}>
                        <span className="dot" />
                        {`${t.port} ${t.open ? "받음" : "닫힘"}`}
                      </span>
                    ))}
                  </td>
                  <td className="muted">{hint(r)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

function hint(r: Reach): string {
  if (r.waiting.length > 0 && r.targets.length === 0) return `파드가 아직 준비되지 않았습니다(${r.waiting.join(", ")}). 로그 모아 보기에서 그 파드의 로그를 보세요.`;
  if (r.ports.length > 0 && r.targets.length === 0) return "이 서비스를 받을 파드가 없습니다. 파드가 떠 있는지, 꺼졌다 켜지기를 되풀이하지 않는지 보세요.";
  if (r.targets.some((t) => !t.open)) return "파드는 있는데 그 포트에서 기다리는 프로그램이 없습니다. 앱이 다른 포트를 쓰거나, 127.0.0.1(자기 자신)에서만 기다리거나, 아직 시작 중입니다.";
  if (r.found.length === 0) return "이름이 주소로 바뀌지 않습니다. 클러스터의 이름 서비스(coredns)가 떠 있는지 보세요.";
  if (r.waiting.length > 0) return `준비되지 않은 파드도 있습니다: ${r.waiting.join(", ")}`;
  return "정상";
}

const shortTime = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleTimeString();
};

function ProjectLogs({ namespace, showCli }: { namespace: string; showCli: (cmd: string) => void }) {
  const [lines, setLines] = useState<LogLine[] | null>(null);
  const [error, setError] = useState("");
  const [app, setApp] = useState("");
  const [problems, setProblems] = useState(false);
  const [query, setQuery] = useState("");
  const read = () => {
    setError("");
    showCli(kubectl(`logs -n ${namespace} -l app --all-containers --prefix --timestamps --tail=300`));
    call<LogLine[]>("KubeProjectLogs", namespace, 300).then(setLines, (e) => setError(e.message));
  };
  useEffect(read, [namespace]);
  const apps = useMemo(() => [...new Set((lines ?? []).map((l) => appOf(l.pod)))].sort(), [lines]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (lines ?? [])
      .map((l) => ({ ...l, level: levelOf(l.text) }))
      .filter((l) => (!app || appOf(l.pod) === app) && (!problems || l.level === "error" || l.level === "warn") && (!q || l.text.toLowerCase().includes(q)));
  }, [lines, app, problems, query]);
  return (
    <div className="logs project-logs">
      <div className="logs-bar">
        <select aria-label="서비스" value={app} onChange={(e) => setApp(e.target.value)}>
          <option value="">모든 서비스</option>
          {apps.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <input type="search" placeholder="로그에서 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={problems} onChange={(e) => setProblems(e.target.checked)} />
          오류 · 경고만
        </label>
        <button type="button" onClick={read}>
          다시 읽기
        </button>
        <CopyButton text={shown.map((l) => `${l.time} ${appOf(l.pod)}/${l.container} ${l.text}`).join("\n")} label="보이는 로그 복사" />
      </div>
      <p className="muted">{`서비스마다 마지막 300줄을 시간 순서로 섞어 보여 줍니다. 한 서비스가 다른 서비스를 부르고 실패하는 흐름을 한눈에 따라갈 수 있습니다. 시작 전 준비(set-mac 등)의 로그도 들어 있습니다.`}</p>
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      <pre className="log-box" data-testid="project-logs">
        {!lines ? (
          <span className="muted">읽는 중…</span>
        ) : shown.length === 0 ? (
          <span className="muted">{lines.length ? "찾는 내용이 없습니다." : "아직 출력이 없습니다."}</span>
        ) : (
          shown.map((l, i) => (
            <span key={i} className={"log-line" + (l.level ? " lv-" + l.level : "")}>
              <span className="muted">{shortTime(l.time)} </span>
              <span className="log-src">{`${appOf(l.pod)}${l.container !== appOf(l.pod) ? "/" + l.container : ""}`}</span> {l.text}
              {"\n"}
            </span>
          ))
        )}
      </pre>
    </div>
  );
}
