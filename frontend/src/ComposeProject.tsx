import { useEffect, useMemo, useRef, useState } from "react";
import ServiceForm from "./ComposeEdit";
import ComposeKube from "./ComposeKube";
import type { KubeMove } from "./Kubernetes";
import { call, openURL, type Container, type Run } from "./bridge";
import { published } from "./Containers";
import { ago, isUp, stateLabel, statusText } from "./format";
import { IconButton } from "./ui";

export interface Project {
  name: string;
  workDir: string;
  files: string[];
  members: Container[];
}

type Action = "up" | "down" | "stop" | "start" | "restart" | "pull";
type Tab = "graph" | "services" | "file" | "logs";

interface Service {
  name: string;
  image: string;
  ports: string[];
  volumes: string[];
  deps: string[];
  container?: Container;
}

interface Change {
  kind: string;
  name: string;
  action: "keep" | "create" | "recreate" | "start" | "remove";
}

interface Props {
  project: Project;
  run: Run;
  showCli: (cmd: string) => void;
  busy: boolean;
  act: (p: Project, action: Action, services?: string[]) => Promise<unknown>;
  onDown: () => void;
  onOpen: (containerId: string) => void;
  onBack: () => void;
  /** Moves the project to Kubernetes (opens that page, applies it there). */
  onKube?: (m: KubeMove) => void;
}

const changeText: Record<Change["action"], string> = {
  keep: "그대로 둠",
  create: "새로 만듦",
  recreate: "다시 만듦 (잠깐 멈췄다 켜짐)",
  start: "시작함",
  remove: "삭제함",
};

// ---- the graph: who needs whom

const BOX = { w: 250, h: 86, gapX: 90, gapY: 22 };
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** Whether "from" already waits, through any chain, for "to". */
export function needs(services: { name: string; deps: string[] }[], from: string, to: string): boolean {
  const by = new Map(services.map((s) => [s.name, s.deps]));
  const seen = new Set<string>();
  const walk = (n: string): boolean => {
    if (n === to) return true;
    if (seen.has(n)) return false;
    seen.add(n);
    return (by.get(n) ?? []).some(walk);
  };
  return walk(from);
}

function Graph({ services, onOpen, onEdit, onLink, onUnlink }: { services: Service[]; onOpen: (id: string) => void; onEdit?: (name: string) => void; onLink?: (from: string, to: string) => void; onUnlink?: (from: string, to: string) => void }) {
  const [focus, setFocus] = useState<string | null>(null);
  // Joining two services: from which, and where the pointer is while dragging.
  const [from, setFrom] = useState<string | null>(null);
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const at = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    const box = svg.current!.viewBox.baseVal;
    return { x: ((e.clientX - r.left) / r.width) * box.width, y: ((e.clientY - r.top) / r.height) * box.height };
  };
  const nodeAt = (e: { clientX: number; clientY: number }) => (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest("[data-node]")?.getAttribute("data-node") ?? null;
  const finish = (to: string | null) => {
    if (from && to && to !== from) onLink?.(from, to);
    setFrom(null);
    setTip(null);
  };
  const layout = useMemo(() => {
    const by = new Map(services.map((s) => [s.name, s]));
    // A service's depth is how long a chain of needs hangs below it.
    const depth = new Map<string, number>();
    const walk = (name: string, seen: Set<string>): number => {
      if (depth.has(name)) return depth.get(name)!;
      if (seen.has(name)) return 0; // a loop in the file: don't follow it round
      seen.add(name);
      const deps = (by.get(name)?.deps ?? []).filter((d) => by.has(d));
      const d = deps.length ? 1 + Math.max(...deps.map((x) => walk(x, seen))) : 0;
      depth.set(name, d);
      return d;
    };
    services.forEach((s) => walk(s.name, new Set()));
    const max = Math.max(0, ...depth.values());
    // Those that need the most stand at the left; what everything rests on, at the right.
    const cols: Service[][] = Array.from({ length: max + 1 }, () => []);
    services.forEach((s) => cols[max - depth.get(s.name)!].push(s));
    cols.forEach((c) => c.sort((a, b) => a.name.localeCompare(b.name)));
    const tallest = Math.max(...cols.map((c) => c.length));
    const height = tallest * BOX.h + (tallest - 1) * BOX.gapY + 16;
    const pos = new Map<string, { x: number; y: number }>();
    cols.forEach((col, i) => {
      const used = col.length * BOX.h + (col.length - 1) * BOX.gapY;
      col.forEach((s, j) => pos.set(s.name, { x: 8 + i * (BOX.w + BOX.gapX), y: (height - used) / 2 + j * (BOX.h + BOX.gapY) }));
    });
    const edges = services.flatMap((s) => s.deps.filter((d) => by.has(d)).map((d) => ({ from: s.name, to: d })));
    return { pos, edges, width: 28 + cols.length * BOX.w + (cols.length - 1) * BOX.gapX, height }; // room on the right for the join handles
  }, [services]);

  const lit = useMemo(() => {
    if (!focus) return null;
    const set = new Set([focus]);
    layout.edges.forEach((e) => {
      if (e.from === focus) set.add(e.to);
      if (e.to === focus) set.add(e.from);
    });
    return set;
  }, [focus, layout.edges]);

  return (
    <div className="map-wrap">
      {from && (
        <p className="map-hint" role="status">
          <strong>{from}</strong>가 기다릴(먼저 시작할) 서비스를 누르세요. <button type="button" className="link" onClick={() => finish(null)}>그만두기</button>
        </p>
      )}
      <svg
        ref={svg}
        onPointerMove={(e) => from && tip && setTip(at(e))}
        onPointerUp={(e) => {
          if (!from || !tip) return;
          const to = nodeAt(e);
          // Let go on nothing: keep the start, and a click on a box finishes.
          if (to && to !== from) finish(to);
          else setTip(null);
        }}
        onKeyDown={(e) => e.key === "Escape" && finish(null)}
        className={"map" + (from ? " linking" : "")} viewBox={`0 0 ${layout.width} ${layout.height}`} width={layout.width} height={layout.height} role="group" aria-label={`서비스 ${services.length}개의 의존 관계`} data-testid="compose-graph">
        <defs>
          <marker id="needs" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0,1 L9,5 L0,9 z" className="arrow-head" />
          </marker>
        </defs>
        {layout.edges.map((e) => {
          const a = layout.pos.get(e.from)!;
          const b = layout.pos.get(e.to)!;
          const x1 = a.x + BOX.w;
          const y1 = a.y + BOX.h / 2;
          const x2 = b.x - 3;
          const y2 = b.y + BOX.h / 2;
          const bend = (x2 - x1) / 2;
          const off = lit && !(e.from === focus || e.to === focus);
          const d = `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
          return (
            <g key={e.from + ">" + e.to}>
              <path className={"map-edge needs" + (off ? " off" : "")} markerEnd="url(#needs)" d={d} data-testid="edge-needs" />
              {onUnlink && (
                <path
                  className="map-edge-hit"
                  d={d}
                  role="button"
                  tabIndex={0}
                  aria-label={`${e.from} → ${e.to} 연결 끊기`}
                  data-testid={`edge-${e.from}-${e.to}`}
                  onClick={() => onUnlink(e.from, e.to)}
                  onKeyDown={(k) => (k.key === "Enter" || k.key === " ") && (k.preventDefault(), onUnlink(e.from, e.to))}
                >
                  <title>
                    {e.from} → {e.to} 연결 끊기
                  </title>
                </path>
              )}
            </g>
          );
        })}
        {from && tip && (() => {
          const a = layout.pos.get(from)!;
          return <path className="map-edge needs drawing" markerEnd="url(#needs)" d={`M${a.x + BOX.w},${a.y + BOX.h / 2} L${tip.x},${tip.y}`} />;
        })()}
        {services.map((s) => {
          const p = layout.pos.get(s.name)!;
          const c = s.container;
          const state = !c ? "none" : c.failed ? "failed" : c.state;
          const hint = `${s.name} · ${!c ? "아직 만들어지지 않음" : c.failed ? "실패" : stateLabel[c.state] ?? c.state}${c ? " · 눌러서 상세 보기" : ""}`;
          return (
            <g
              key={s.name}
              className={"map-node container" + (c && isUp(c) ? "" : " dim") + (lit && !lit.has(s.name) ? " off" : "")}
              transform={`translate(${p.x},${p.y})`}
              role="button"
              tabIndex={0}
              aria-label={hint}
              data-testid={`svc-node-${s.name}`}
              data-node={s.name}
              onMouseEnter={() => setFocus(s.name)}
              onMouseLeave={() => setFocus(null)}
              onFocus={() => setFocus(s.name)}
              onBlur={() => setFocus(null)}
              onClick={() => (from ? finish(s.name) : c && onOpen(c.id))}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), from ? finish(s.name) : c && onOpen(c.id))}
            >
              <title>{hint}</title>
              <rect width={BOX.w} height={BOX.h} rx="9" />
              <circle className={"map-dot " + state} cx="15" cy="20" r="4.5" />
              <text className="map-title" x="28" y="24.5">
                {clip(s.name, 26)}
              </text>
              <text className="map-sub" x="14" y="43">
                {clip(s.image || "이미지 없음", 38)}
              </text>
              <text className="map-sub" x="14" y="60">
                {s.ports.length ? clip("포트 " + s.ports.join(" "), 38) : "포트 없음"}
              </text>
              <text className="map-sub" x="14" y="76">
                {s.volumes.length ? clip("볼륨 " + s.volumes.join(", "), 38) : ""}
              </text>
              {onEdit && (
                <g
                  className="map-edit"
                  role="button"
                  tabIndex={0}
                  aria-label={`${s.name} 설정 고치기`}
                  data-testid={`svc-edit-${s.name}`}
                  transform={`translate(${BOX.w - 34},6)`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onEdit(s.name);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      onEdit(s.name);
                    }
                  }}
                >
                  <title>{s.name} 설정 고치기</title>
                  <rect width="28" height="24" rx="6" />
                  <path d="M9 16.5l1-3.5 6.5-6.5 2.5 2.5-6.5 6.5z M15 8l2.5 2.5" fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </g>
              )}
              {onLink && (
                <g
                  className={"map-link" + (from === s.name ? " on" : "")}
                  role="button"
                  tabIndex={0}
                  aria-label={`${s.name}에서 선 잇기`}
                  data-testid={`svc-link-${s.name}`}
                  transform={`translate(${BOX.w},${BOX.h / 2})`}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.target as Element).releasePointerCapture?.(e.pointerId);
                    setFrom(s.name);
                    setTip(at(e));
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      setFrom(s.name);
                    }
                  }}
                >
                  <title>끌어서 {s.name}가 기다릴 서비스에 놓기</title>
                  <circle r="11" className="map-link-hit" />
                  <circle r="6" />
                </g>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ---- the file: edit, see what applying would do, apply

/** The services a compose file names, with the line each starts on. */
export function serviceLines(text: string) {
  const out: { name: string; line: number }[] = [];
  const lines = text.split("\n");
  let inside = false;
  let indent = -1;
  lines.forEach((raw, i) => {
    if (/^services:\s*(#.*)?$/.test(raw)) {
      inside = true;
      indent = -1;
      return;
    }
    if (!inside || !raw.trim() || raw.trim().startsWith("#")) return;
    const lead = raw.length - raw.trimStart().length;
    if (lead === 0) {
      inside = false; // the next top-level key
      return;
    }
    if (indent < 0) indent = lead;
    const m = lead === indent && /^([A-Za-z0-9._-]+):\s*(#.*)?$/.exec(raw.trim());
    if (m) out.push({ name: m[1], line: i + 1 });
  });
  return out;
}

interface Draft {
  file: string;
  text: string;
  what: string;
}

function FileTab({ project, run, busy, act, onApplied, draft }: { project: Project; run: Run; busy: boolean; act: Props["act"]; onApplied: () => void; draft: Draft | null }) {
  const [file, setFile] = useState(draft?.file ?? project.files[0] ?? "");
  const [saved, setSaved] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [changes, setChanges] = useState<Change[] | null>(null);
  const [problem, setProblem] = useState("");
  const [checking, setChecking] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  // A file put back by an import is the engine's (root's): offered to the
  // user as soon as it is opened, before anything fails on it.
  const [notMine, setNotMine] = useState("");
  useEffect(() => {
    if (!file) return;
    setSaved(null);
    setError("");
    call<string>("ComposeNotMine", file).then(setNotMine, () => setNotMine(""));
    call<string>("ComposeFile", file).then(
      (t) => {
        setSaved(t);
        // A change made in the picture's form arrives as text not saved yet.
        setText(draft && draft.file === file ? draft.text : t);
      },
      (e) => setError(e.message),
    );
  }, [file]);

  // What applying would do, asked a moment after the typing stops.
  const members = project.members.map((c) => c.id + c.state).join();
  useEffect(() => {
    if (saved === null) return;
    let stale = false;
    setChecking(true);
    const timer = setTimeout(() => {
      call<Change[]>("ComposePreview", project.name, project.files, file, text).then(
        (c) => {
          if (stale) return;
          setChanges(c ?? []);
          setProblem("");
          setChecking(false);
        },
        (e) => {
          if (stale) return;
          setChanges(null);
          setProblem(e.message);
          setChecking(false);
        },
      );
    }, 700);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [text, saved, file, members]);

  const index = useMemo(() => serviceLines(text), [text]);
  const dirty = saved !== null && text !== saved;
  // Changed text is saved only once compose has read it and found nothing
  // wrong: an empty or broken file never replaces a working one.
  const unsure = dirty && (checking || !text.trim());
  const news = (changes ?? []).filter((c) => c.action !== "keep");

  const jump = (line: number) => {
    const el = box.current;
    if (!el) return;
    const at = text.split("\n").slice(0, line - 1).join("\n").length + (line > 1 ? 1 : 0);
    el.focus();
    el.setSelectionRange(at, at + (text.split("\n")[line - 1]?.length ?? 0));
    el.scrollTop = Math.max(0, (line - 3) * parseFloat(getComputedStyle(el).lineHeight));
  };

  const save = async () => {
    const ok = await run(`# ${file} 저장`, () => call("ComposeSave", file, text));
    if (ok) setSaved(text);
    else setNotMine(await call<string>("ComposeNotMine", file).catch(() => ""));
    return ok;
  };
  const makeMine = async () => {
    if (await run(`sudo chown -R $(id -u):$(id -g) ${notMine}  # 엔진이 root로 대신함`, () => call("ComposeMakeMine", file))) {
      setNotMine("");
      if (dirty) await save();
    }
  };

  const apply = async () => {
    if (dirty && !(await save())) return;
    await act(project, "up");
    onApplied();
  };

  if (!file) return <p className="empty">이 프로젝트의 compose 파일 위치를 알 수 없습니다.</p>;
  if (error)
    return (
      <p className="warn" role="alert">
        {file}: {error}. 파일이 이 PC에서 보이지 않으면(다른 PC나 WSL 안에서 올린 프로젝트) 여기서 고칠 수 없습니다.
      </p>
    );
  return (
    <div className="compose-file">
      {notMine && (
        <div className="note-box" role="alert" data-testid="not-mine">
          <strong>{`이 폴더(${notMine})는 다른 사용자(root)의 것이라 고친 것을 저장할 수 없습니다.`}</strong>
          <span className="sub">가져오기로 되살린 폴더는 엔진이 root 권한으로 만들어서 그렇습니다. 이 프로젝트 폴더와 그 안의 파일을 지금 사용자의 것으로 바꾸면 고칠 수 있습니다.</span>
          <span>
            <button type="button" className="primary" onClick={makeMine}>
              {dirty ? "내 것으로 바꾸고 저장" : "내 것으로 바꾸기"}
            </button>
          </span>
        </div>
      )}
      <aside className="svc-index">
        <strong>서비스 {index.length}개</strong>
        {index.map((s) => (
          <button key={s.name} className="link" onClick={() => jump(s.line)}>
            <span>{s.name}</span>
            <span className="muted">{s.line}번째 줄</span>
          </button>
        ))}
      </aside>
      <div className="file-edit">
        <div className="file-bar">
          {project.files.length > 1 ? (
            <select aria-label="compose 파일" value={file} onChange={(e) => setFile(e.target.value)}>
              {project.files.map((f) => (
                <option key={f}>{f}</option>
              ))}
            </select>
          ) : (
            <code className="muted file-path">{file}</code>
          )}
          <span className={dirty ? "warn" : "muted"} data-testid="file-state">
            {saved === null ? "읽는 중…" : dirty ? "바뀜 · 아직 저장 안 함" : "저장됨"}
          </span>
        </div>
        {draft && draft.file === file && text === draft.text && (
          <p className="note-box" data-testid="draft-note">
            그림에서 고친 내용({draft.what})을 파일의 글에 반영했습니다. 아직 저장하지 않았습니다. 아래에서 적용하면 일어날 일을 확인하고 저장하세요.
          </p>
        )}
        <textarea ref={box} className="editor" aria-label="compose 파일 내용" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} />
        <div className="dialog-actions">
          <button disabled={!dirty} onClick={() => setText(saved ?? "")}>
            되돌리기
          </button>
          <button disabled={!dirty || !!problem || unsure} onClick={save}>
            저장만
          </button>
          <button className="primary" disabled={busy || !!problem || saved === null || unsure} onClick={apply}>
            {dirty ? "저장하고 적용" : "적용"}
          </button>
        </div>
      </div>
      <aside className="apply-plan" data-testid="apply-plan">
        <strong>적용하면 생기는 일</strong>
        {problem ? (
          <p className="warn" role="alert">
            이대로는 적용할 수 없습니다: {problem}
          </p>
        ) : changes === null ? (
          <p className="muted">확인하는 중…</p>
        ) : news.length === 0 ? (
          <p className="muted">{dirty ? "바뀐 내용이 실행 중인 것과 같아, 아무것도 다시 만들지 않습니다." : "없습니다. 파일이 실행 중인 내용과 같습니다."}</p>
        ) : (
          <ul className="plan">
            {news.map((c) => (
              <li key={c.kind + c.name} className={c.action}>
                <span className="dot" />
                <span>
                  <strong>{c.name}</strong>
                  <span className="sub">
                    {c.kind === "Container" ? "" : c.kind === "Network" ? "네트워크 · " : "볼륨 · "}
                    {changeText[c.action]}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {checking && changes !== null && <p className="muted">다시 확인하는 중…</p>}
        <p className="muted plan-foot">
          "적용"은 파일을 저장한 다음 <code>docker compose up -d</code>를 실행합니다. 바뀌지 않은 서비스는 계속 돕니다.
        </p>
      </aside>
    </div>
  );
}

// ---- the logs of every service together

interface Line {
  time: string;
  stamp: string;
  service: string;
  text: string;
}

/** Splits `docker compose logs --timestamps` into lines in the order they were written. */
export function parseLogs(raw: string): Line[] {
  const out: Line[] = [];
  for (const row of raw.split("\n")) {
    const m = /^(\S+?)(?:-\d+)?\s+\| (\d{4}-\d\d-\d\dT[\d:.]+Z?) ?(.*)$/.exec(row);
    if (!m) {
      // A line with no time of its own continues the one before it.
      if (out.length && row.includes("|")) out[out.length - 1].text += "\n" + row.slice(row.indexOf("|") + 2);
      continue;
    }
    const at = new Date(m[2].replace(/(\.\d{3})\d+/, "$1"));
    out.push({ service: m[1], stamp: m[2], time: isNaN(at.getTime()) ? "" : at.toLocaleTimeString(), text: m[3] });
  }
  // Compose prints one container after another; by time they read as they happened.
  return out.sort((a, b) => (a.stamp < b.stamp ? -1 : a.stamp > b.stamp ? 1 : 0));
}

function LogsTab({ project, showCli }: { project: Project; showCli: (cmd: string) => void }) {
  const [lines, setLines] = useState<Line[] | null>(null);
  const [error, setError] = useState("");
  const [auto, setAuto] = useState(false);
  const [only, setOnly] = useState("");
  const [query, setQuery] = useState("");
  const box = useRef<HTMLDivElement>(null);

  const load = () =>
    call<string>("ComposeLogs", project.name, 300).then(
      (raw) => {
        setLines(parseLogs(raw));
        setError("");
      },
      (e) => setError(e.message),
    );

  useEffect(() => {
    showCli(`docker compose -p ${project.name} logs --timestamps --tail 300`);
    load();
  }, [project.name]);

  useEffect(() => {
    if (!auto) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [auto, project.name]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (lines ?? []).filter((l) => (!only || l.service === only) && (!q || l.text.toLowerCase().includes(q)));
  }, [lines, only, query]);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [shown]);

  const names = [...new Set((lines ?? []).map((l) => l.service))].sort();
  return (
    <div className="compose-logs">
      <div className="logs-bar">
        <select aria-label="서비스 고르기" value={only} onChange={(e) => setOnly(e.target.value)}>
          <option value="">모든 서비스</option>
          {names.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
        <input type="search" placeholder="로그에서 찾기" value={query} onChange={(e) => setQuery(e.target.value)} />
        <label className="check">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
          3초마다 새로 고침
        </label>
        <button onClick={load}>새로 고침</button>
      </div>
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      <div ref={box} className="log-box log-rows" data-testid="compose-logs">
        {lines === null && !error ? (
          <span className="muted">읽는 중…</span>
        ) : shown.length === 0 ? (
          <span className="muted">{lines?.length ? "찾는 내용이 없습니다." : "아직 출력이 없습니다."}</span>
        ) : (
          shown.map((l, i) => (
            <div key={i} className="log-row">
              <span className="muted">{l.time}</span>
              <span className="log-svc">{l.service}</span>
              <span className="log-text">{l.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ---- the page

export default function ComposeProject({ project, run, showCli, busy, act, onDown, onOpen, onBack, onKube }: Props) {
  const [moving, setMoving] = useState(false);
  const [tab, setTab] = useState<Tab>("graph");
  // A service being changed in the picture ("" for a new one), and what the form made of the file.
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [config, setConfig] = useState<any>(null);
  const [round, setRound] = useState(0);

  const [linkNote, setLinkNote] = useState("");
  // Joining or parting two services is a change to the file: made as a
  // draft, shown on the file tab, applied from there.
  const relink = async (name: string, change: (deps: string[]) => string[], what: string) => {
    setLinkNote("");
    try {
      const file = project.files[0];
      const text = await call<string>("ComposeFile", file);
      const e = await call<any>("ComposeService", text, name);
      if (e.locked.includes("depends_on")) {
        setLinkNote(`${name}의 depends_on은 그림에서 바꿀 수 없는 형태로 적혀 있습니다. "Compose 파일" 탭에서 직접 고치세요.`);
        return;
      }
      showCli(`# ${file} 의 services.${name}.depends_on 고치기 (파일을 고친 뒤 docker compose up -d)`);
      setDraft({ file, text: await call<string>("ComposeEdit", text, { ...e, dependsOn: change(e.dependsOn ?? []) }), what });
      setTab("file");
    } catch (err: any) {
      setLinkNote(err.message);
    }
  };
  const link = (from: string, to: string) => {
    if (needs(services, from, to)) return setLinkNote(`${from}는 이미 ${to}를 기다립니다.`);
    if (needs(services, to, from)) return setLinkNote(`${to}가 이미 ${from}를 기다리고 있어서, 서로 기다리게 되면 둘 다 시작하지 못합니다.`);
    relink(from, (d) => [...d, to], `${from}가 ${to}를 기다리게 잇기`);
  };
  const unlink = (from: string, to: string) => relink(from, (d) => d.filter((x) => x !== to), `${from} → ${to} 연결 끊기`);

  const files = project.files.join("|");
  useEffect(() => {
    call<string>("ComposeConfig", project.name, project.files).then(
      (raw) => setConfig(JSON.parse(raw)),
      () => setConfig(null), // no file to read here: what the containers say will do
    );
  }, [project.name, files, round]);

  useEffect(() => {
    if (tab === "graph" || tab === "services") showCli(`docker compose -p ${project.name} ps -a`);
    if (tab === "file") showCli(`docker compose -p ${project.name} config`);
  }, [tab, project.name]);

  const services = useMemo(() => {
    const by = new Map<string, Service>();
    for (const [name, s] of Object.entries<any>(config?.services ?? {})) {
      by.set(name, {
        name,
        image: s.image ?? (s.build ? "(이 폴더에서 빌드)" : ""),
        ports: (s.ports ?? []).map((p: any) => (p.published ? `${p.published}→${p.target}` : `${p.target}`)),
        volumes: (s.volumes ?? []).map((v: any) => (v.type === "volume" ? v.source : v.source?.split(/[\\/]/).pop()) ?? "").filter(Boolean),
        deps: Object.keys(s.depends_on ?? {}),
      });
    }
    for (const c of project.members) {
      const have = by.get(c.service);
      if (have) {
        have.container = have.container ?? c;
        continue;
      }
      // Not in the file (or no file): what the container's labels tell.
      by.set(c.service, {
        name: c.service,
        image: c.image,
        ports: published(c).map((p) => `${p.public}→${p.private}`),
        volumes: c.volumes,
        deps: (c.labels?.["com.docker.compose.depends_on"] ?? "").split(",").map((d) => d.split(":")[0]).filter(Boolean),
        container: c,
      });
    }
    return [...by.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [config, project.members]);

  const up = project.members.filter(isUp).length;
  const oldest = Math.min(...project.members.map((c) => c.created));
  const nets = Object.values<any>(config?.networks ?? {}).map((n) => n.name).filter(Boolean);
  const netNames = nets.length ? nets : [...new Set(project.members.flatMap((c) => c.networks.map((n) => n.network)))];
  const tabs: [Tab, string][] = [
    ["graph", "구조"],
    ["services", "서비스"],
    ["file", "Compose 파일"],
    ["logs", "로그"],
  ];

  return (
    <div data-testid="compose-project">
      <nav className="crumbs big">
        <button className="link" onClick={onBack}>
          Compose
        </button>
        <span className="muted"> › </span>
        <strong>{project.name}</strong>
      </nav>
      <header className="project-head">
        <span className={"state " + (up === project.members.length && up > 0 ? "running" : up > 0 ? "paused" : "")}>
          <span className="dot" />
          {project.members.length}개 중 {up}개 실행
        </span>
        <span className="spacer" />
        <IconButton
          icon="play"
          label={up === project.members.length && up > 0 ? "파일대로 다시 올리기 (바뀐 것만 다시 만듦, 모두 실행 중)" : "올리기 (파일대로 만들고 시작)"}
          tone={up === project.members.length && up > 0 ? undefined : "go"}
          disabled={busy}
          onClick={() => act(project, "up")}
        />
        <IconButton icon="restart" label="모두 재시작" disabled={busy || up === 0} onClick={() => act(project, "restart")} />
        <IconButton icon="stop" label="모두 중지 (컨테이너는 남김)" tone="danger" disabled={busy || up === 0} onClick={() => act(project, "stop")} />
        <IconButton icon="trash" label="내리기 (컨테이너와 네트워크 삭제)" tone="danger" disabled={busy} onClick={onDown} />
        {onKube && project.files.length > 0 && (
          <button type="button" onClick={() => setMoving(true)}>
            Kubernetes로 옮기기
          </button>
        )}
      </header>
      {moving && onKube && (
        <ComposeKube
          project={project.name}
          files={project.files}
          showCli={showCli}
          onClose={() => setMoving(false)}
          onMove={(m) => {
            setMoving(false);
            onKube(m);
          }}
        />
      )}
      <dl className="project-meta">
        <div>
          <dt>파일</dt>
          <dd>{project.files.join(", ") || "알 수 없음"}</dd>
        </div>
        <div>
          <dt>서비스</dt>
          <dd>{services.length}</dd>
        </div>
        <div>
          <dt>네트워크</dt>
          <dd>{netNames.join(", ") || "—"}</dd>
        </div>
        <div>
          <dt>만든 때</dt>
          <dd>{project.members.length ? ago(oldest) : "—"}</dd>
        </div>
      </dl>
      <div className="tabs kube-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>

      {tab === "graph" && (
        <>
          {project.files.length > 0 && (
            <div className="graph-bar">
              <button onClick={() => setEditing("")}>서비스 추가</button>
              <span className="muted">상자의 연필을 누르면 그 서비스의 설정(이미지 · 포트 · 환경변수 · 저장 공간)을 고칩니다. 상자 오른쪽의 점을 다른 상자로 끌면 "먼저 시작할 서비스"로 잇고, 선을 누르면 끊습니다.</span>
            </div>
          )}
          {linkNote && (
            <p className="note" role="alert">
              {linkNote}
            </p>
          )}
          <Graph services={services} onOpen={onOpen} onEdit={project.files.length > 0 ? setEditing : undefined} onLink={project.files.length > 0 ? link : undefined} onUnlink={project.files.length > 0 ? unlink : undefined} />
          <p className="muted footnote">
            화살표는 서비스가 필요로 하는 대상을 가리킵니다. Compose는 화살표가 가리키는 쪽을 먼저 시작합니다.
            {services.every((s) => s.deps.length === 0) && " 이 프로젝트에는 서로 기다리는 관계(depends_on)가 없습니다."}
          </p>
        </>
      )}

      {tab === "services" && (
        <table className="grid">
          <thead>
            <tr>
              <th>서비스</th>
              <th>상태</th>
              <th>포트</th>
              <th>만든 때</th>
              <th className="actions">작업</th>
            </tr>
          </thead>
          <tbody>
            {services.map((s) => {
              const c = s.container;
              return (
                <tr key={s.name} data-testid={`svc-${s.name}`}>
                  <td>
                    {c ? (
                      <button className="link name" onClick={() => onOpen(c.id)}>
                        {s.name}
                      </button>
                    ) : (
                      <span className="name">{s.name}</span>
                    )}
                    <span className="sub">{s.image}</span>
                  </td>
                  <td>
                    {c ? (
                      <>
                        <span className={"state " + (c.failed ? "failed" : c.state)}>
                          <span className="dot" />
                          {c.failed ? "실패" : stateLabel[c.state] ?? c.state}
                        </span>
                        <span className="sub">{statusText(c)}</span>
                      </>
                    ) : (
                      <span className="muted">아직 만들어지지 않음</span>
                    )}
                  </td>
                  <td className="ports">
                    {c && published(c).length
                      ? published(c).map((p) => (
                          <button key={p.public} className="link port" onClick={() => openURL(`http://localhost:${p.public}`)}>
                            {p.public}→{p.private}
                          </button>
                        ))
                      : "—"}
                  </td>
                  <td className="muted nowrap">{c ? ago(c.created) : "—"}</td>
                  <td className="actions">
                    {c && isUp(c) ? (
                      <>
                        <IconButton icon="restart" label={`${s.name} 재시작`} disabled={busy} onClick={() => act(project, "restart", [s.name])} />
                        <IconButton icon="stop" label={`${s.name} 중지`} tone="danger" disabled={busy} onClick={() => act(project, "stop", [s.name])} />
                      </>
                    ) : (
                      <IconButton icon="play" label={`${s.name} 올리기`} tone="go" disabled={busy} onClick={() => act(project, "up", [s.name])} />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {tab === "file" && (
        <FileTab
          project={project}
          run={run}
          busy={busy}
          act={act}
          draft={draft}
          onApplied={() => {
            setDraft(null);
            setRound((n) => n + 1);
          }}
        />
      )}
      {editing !== null && (
        <ServiceForm
          file={project.files[0]}
          name={editing}
          others={services.map((s) => s.name).filter((n) => n !== editing)}
          showCli={showCli}
          onClose={() => setEditing(null)}
          onDraft={(text, what) => {
            setDraft({ file: project.files[0], text, what });
            setEditing(null);
            setTab("file");
          }}
        />
      )}
      {tab === "logs" && <LogsTab project={project} showCli={showCli} />}
    </div>
  );
}
