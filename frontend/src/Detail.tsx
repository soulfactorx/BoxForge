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

// What an exit code says about how a container ended.
function reason(code: number, oom: boolean, message: string): { title: string; text: string; logs: boolean } {
  if (oom) return { title: "메모리가 부족해 강제로 종료됐습니다", text: "프로그램이 엔진이 허용한 것보다 많은 메모리를 썼습니다. 메모리 한도를 늘리거나 프로그램의 사용량을 줄여야 합니다.", logs: true };
  if (message) return { title: "시작하지 못했습니다", text: message, logs: false };
  switch (code) {
    case 0:
      return { title: "할 일을 마치고 정상적으로 끝났습니다", text: "오류가 아닙니다. 계속 떠 있어야 하는 프로그램이라면 실행 명령을 확인하세요.", logs: true };
    case 125:
      return { title: "엔진이 컨테이너를 실행하지 못했습니다", text: "실행 설정(포트, 마운트 등)에 문제가 있을 수 있습니다.", logs: false };
    case 126:
      return { title: "실행 명령을 실행할 수 없습니다", text: "명령으로 지정한 파일에 실행 권한이 없거나 실행 파일이 아닙니다.", logs: true };
    case 127:
      return { title: "실행 명령을 찾지 못했습니다", text: "이미지 안에 그 이름의 프로그램이 없습니다. 실행 명령의 철자와 경로를 확인하세요.", logs: true };
    case 130:
      return { title: "사용자가 중단했습니다 (Ctrl+C)", text: "오류가 아닙니다.", logs: false };
    case 137:
      return { title: "강제로 종료됐습니다", text: "중지 요청 뒤 10초 안에 끝나지 않았거나, 강제 종료를 눌렀거나, 메모리가 부족했을 수 있습니다.", logs: true };
    case 139:
      return { title: "프로그램이 비정상 종료됐습니다 (메모리 접근 오류)", text: "프로그램 자체의 결함이거나, 이미지가 이 PC의 프로세서 종류와 맞지 않을 수 있습니다.", logs: true };
    case 143:
      return { title: "중지 요청을 받고 끝났습니다", text: "오류가 아닙니다.", logs: false };
    case 255:
      return { title: "엔진이나 PC가 꺼지면서 함께 멈췄습니다", text: "프로그램의 오류라기보다 바깥 사정일 가능성이 큽니다. 다시 시작하면 됩니다.", logs: true };
  }
  return { title: `프로그램이 오류를 내고 끝났습니다 (종료 코드 ${code})`, text: "무엇이 잘못됐는지는 프로그램이 남긴 마지막 로그에 있습니다. 필수 환경변수(비밀번호 등)가 빠졌을 때 흔히 이렇게 됩니다.", logs: true };
}

function Overview({ c, raw, onLogs }: { c: Container; raw: string; onLogs: () => void }) {
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
  const st = info?.State;
  const why = st && (st.Status === "exited" || st.Status === "dead" || (st.Status === "created" && st.Error)) ? reason(st.ExitCode ?? 0, !!st.OOMKilled, st.Error ?? "") : null;
  return (
    <div className="overview">
      {c.state === "running" && <Charts id={c.id} />}
      {why && (
        <div className={"note-box why" + (c.failed || info?.State?.OOMKilled ? " bad" : "")} data-testid="why">
          <strong>{why.title}</strong>
          <span>{why.text}</span>
          {why.logs && (
            <button className="link" onClick={onLogs}>
              마지막 로그 보기
            </button>
          )}
        </div>
      )}
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
        {tab === "overview" && <Overview c={c} raw={raw} onLogs={() => onTab("logs")} />}
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
