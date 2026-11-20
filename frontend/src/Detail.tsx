import { useEffect, useMemo, useRef, useState } from "react";
import { call, on, openURL, type Container, type LogChunk, type Run } from "./bridge";
import Charts from "./Charts";
import { published } from "./Containers";
import Terminal from "./Terminal";
import { ago, shortId, stateLabel, statusText } from "./format";
import { IconButton } from "./ui";

export type Tab = "overview" | "logs" | "terminal" | "inspect";

// The most lines a log view keeps; older ones are dropped.
const maxLines = 5000;
// Terminal colour and cursor sequences, which a plain text view can't show.
const ansi = /\u001b\[[0-9;?]*[A-Za-z]/g;
// Environment variable names whose values are hidden until asked for.
const secret = /pass|secret|token|key|credential/i;

function Logs({ c, showCli }: { c: Container; showCli: (cmd: string) => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [ended, setEnded] = useState("");
  const [query, setQuery] = useState("");
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLPreElement>(null);
  const partial = useRef("");

  useEffect(() => {
    setLines([]);
    setEnded("");
    partial.current = "";
    const off = on("logs", (chunk: LogChunk) => {
      if (chunk.id !== c.id) return;
      if (chunk.text) {
        const parts = (partial.current + chunk.text.replace(ansi, "")).split("\n");
        partial.current = parts.pop() ?? "";
        if (parts.length) setLines((old) => old.concat(parts).slice(-maxLines));
      }
      if (chunk.end) setEnded(chunk.error || "로그가 끝났습니다. 컨테이너가 멈췄습니다.");
    });
    call("StartLogs", c.id).catch((e) => setEnded(e.message));
    showCli(`docker logs -f --tail 1000 ${c.name}`);
    return () => {
      off();
      call("StopLogs", c.id).catch(() => {});
    };
    // The stream restarts when the container starts again: its state is in the key.
  }, [c.id, c.state === "running"]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? lines.filter((l) => l.toLowerCase().includes(q)) : lines;
  }, [lines, query]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown, follow]);

  return (
    <div className="logs">
      <div className="logs-bar">
        <input type="search" placeholder="로그에서 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          새 줄 따라가기
        </label>
        <button onClick={() => setLines([])}>화면 지우기</button>
      </div>
      <pre ref={box} className="log-box" data-testid="logs">
        {shown.length === 0 ? <span className="muted">{query ? "찾는 내용이 없습니다." : "아직 출력이 없습니다."}</span> : shown.join("\n")}
      </pre>
      {ended && <p className="muted">{ended}</p>}
    </div>
  );
}

function Overview({ c, raw }: { c: Container; raw: string }) {
  const [reveal, setReveal] = useState(false);
  const info = useMemo(() => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }, [raw]);
  const env: string[] = info?.Config?.Env ?? [];
  const mounts: any[] = info?.Mounts ?? [];
  const networks = Object.entries<any>(info?.NetworkSettings?.Networks ?? {});
  const command = [info?.Path, ...(info?.Args ?? [])].filter(Boolean).join(" ");
  const restart = info?.HostConfig?.RestartPolicy?.Name;
  return (
    <div className="overview">
      {c.state === "running" && <Charts id={c.id} />}
      <dl className="facts">
        <dt>상태</dt>
        <dd>
          {c.failed ? "실패" : stateLabel[c.state] ?? c.state} · {statusText(c)}
        </dd>
        <dt>이미지</dt>
        <dd>{c.image}</dd>
        <dt>ID</dt>
        <dd>
          <code>{shortId(c.id)}</code>
        </dd>
        <dt>만든 때</dt>
        <dd>{ago(c.created)}</dd>
        {c.project && (
          <>
            <dt>Compose</dt>
            <dd>
              {c.project} / {c.service}
            </dd>
          </>
        )}
        {command && (
          <>
            <dt>실행 명령</dt>
            <dd>
              <code>{command}</code>
            </dd>
          </>
        )}
        {restart && restart !== "no" && (
          <>
            <dt>재시작 정책</dt>
            <dd>{restart}</dd>
          </>
        )}
      </dl>

      <h3>포트</h3>
      {published(c).length === 0 ? (
        <p className="muted">밖으로 연 포트가 없습니다.</p>
      ) : (
        <ul className="plain">
          {published(c).map((p) => (
            <li key={p.public}>
              <button className="link" onClick={() => openURL(`http://localhost:${p.public}`)}>
                localhost:{p.public}
              </button>{" "}
              → 컨테이너의 {p.private}/{p.proto}
            </li>
          ))}
        </ul>
      )}

      <h3>저장 공간</h3>
      {mounts.length === 0 ? (
        <p className="muted">연결된 볼륨이나 폴더가 없습니다. 컨테이너를 삭제하면 안의 데이터도 사라집니다.</p>
      ) : (
        <ul className="plain">
          {mounts.map((m) => (
            <li key={m.Destination}>
              <code>{m.Type === "volume" ? m.Name : m.Source}</code> → <code>{m.Destination}</code>{" "}
              <span className="muted">{m.Type === "volume" ? "볼륨" : "폴더"}</span>
            </li>
          ))}
        </ul>
      )}

      <h3>네트워크</h3>
      {networks.length === 0 ? (
        <p className="muted">—</p>
      ) : (
        <ul className="plain">
          {networks.map(([name, n]) => (
            <li key={name}>
              {name} {n.IPAddress && <code className="muted">{n.IPAddress}</code>}
            </li>
          ))}
        </ul>
      )}

      <h3>
        환경변수{" "}
        {env.some((e) => secret.test(e.split("=")[0])) && (
          <button className="link" onClick={() => setReveal(!reveal)}>
            {reveal ? "비밀값 가리기" : "비밀값 보기"}
          </button>
        )}
      </h3>
      {env.length === 0 ? (
        <p className="muted">—</p>
      ) : (
        <ul className="plain env">
          {env.map((e) => {
            const i = e.indexOf("=");
            const key = i < 0 ? e : e.slice(0, i);
            const value = i < 0 ? "" : e.slice(i + 1);
            return (
              <li key={key}>
                <code>{key}</code> = <code>{secret.test(key) && !reveal ? "••••••••" : value}</code>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

interface Props {
  c: Container;
  tab: Tab;
  onTab: (t: Tab) => void;
  onClose: () => void;
  showCli: (cmd: string) => void;
  run: Run;
}

export default function Detail({ c, tab, onTab, onClose, showCli, run }: Props) {
  const [raw, setRaw] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    call<string>("InspectContainer", c.id).then(setRaw, (e) => setError(e.message));
    // Reloaded when the state changes: ports, addresses and times change with it.
  }, [c.id, c.state, c.name]);

  useEffect(() => {
    if (tab === "inspect") showCli(`docker inspect ${c.name}`);
    if (tab === "overview") {
      showCli(`docker inspect ${c.name}`);
      if (c.state === "running") showCli(`docker stats ${c.name}`);
    }
  }, [tab, c.name]);

  const tabs: [Tab, string][] = [
    ["overview", "개요"],
    ["logs", "로그"],
    ["terminal", "터미널"],
    ["inspect", "원본"],
  ];
  return (
    <aside className="drawer" data-testid="detail">
      <header>
        <h2>{c.name}</h2>
        <IconButton icon="close" label="닫기" onClick={onClose} />
      </header>
      <div className="tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => onTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="drawer-body">
        {error && <p className="warn">{error}</p>}
        {tab === "overview" && <Overview c={c} raw={raw} />}
        {tab === "logs" && <Logs c={c} showCli={showCli} />}
        {tab === "terminal" &&
          (c.state === "running" ? (
            <Terminal id={c.id} name={c.name} showCli={showCli} run={run} />
          ) : (
            <p className="muted">터미널은 실행 중인 컨테이너에서만 열 수 있습니다. 먼저 컨테이너를 시작하세요.</p>
          ))}
        {tab === "inspect" && (
          <>
            <p className="muted">엔진이 이 컨테이너에 대해 알고 있는 전부입니다.</p>
            <pre className="log-box json">{raw}</pre>
          </>
        )}
      </div>
    </aside>
  );
}
