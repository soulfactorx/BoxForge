import { useEffect, useMemo, useRef, useState } from "react";
import { call, on, openURL, remote, type Container, type Run } from "./bridge";
import { pick } from "./PathPicker";
import Terminal from "./Terminal";
import { copyText, Dialog, IconButton } from "./ui";

/** An agent a box can have: a recipe (internal/app/agent_recipes.go). */
interface Kind {
  id: string;
  name: string;
  group: "ready" | "hot" | "guide";
  command: string;
  about?: string;
  docs?: string;
  guide?: { title: string; command: string }[];
  keys: string[];
  hosts: string[];
  note: string;
  service?: string;
  port?: number;
  link?: string;
  setup?: string;
  ready?: string;
  gate?: boolean;
  doctor?: string;
  update?: string;
  memory?: number;
  pids?: number;
  network?: Spec["network"];
  source?: string;
}

// The three kinds of agent, as the screen offers them.
const groups: [Kind["group"], string, string][] = [
  ["ready", "바로 쓰기", "가볍고 안정적인 에이전트. 상자를 만들 때 설치합니다."],
  [
    "hot",
    "다용도 · 새로 뜨는 에이전트",
    "늘 켜 두고 웹 화면 · 메신저로도 쓰는 에이전트. 만든 이가 정한 방법으로 상자 사용자의 홈에 설치해서, 플러그인 · 도구를 스스로 더하고 업데이트합니다. 메모리 · 네트워크 · 늘 켜 둘 것이 그에 맞게 정해집니다.",
  ],
  ["guide", "설치 안내만", "CPU 종류나 환경을 많이 타는 에이전트. 빈 상자를 만들고, 상자의 터미널에서 안내대로 직접 설치합니다."],
];

interface Spec {
  name: string;
  agents: string[];
  image?: string;
  command?: string;
  workspace: string;
  readOnly?: string[];
  network: "ai" | "full" | "none";
  allow: string[];
  ports?: number[];
  memory: number;
  cpus: number;
  pids: number;
  readOnlyRoot: boolean;
  service?: string;
  browser?: boolean;
  mark?: number;
}

interface Box {
  spec: Spec;
  project: string;
  file: string;
  dir: string;
  keys: string[];
}

interface Job {
  key: string;
  project: string;
  action: string;
  running: boolean;
  error?: string;
  lines: string[];
}

const jobLabel: Record<string, string> = {
  upbuild: "만들고 시작",
  build: "에이전트 새 버전으로 다시 만들기",
  stop: "멈추기",
  purge: "삭제",
};

interface Snapshot {
  id: string;
  label: string;
  time: number;
}

interface Connection {
  host: string;
  port: number;
  ok: boolean;
  count: number;
  last: number;
}

const networkLabel: Record<Spec["network"], string> = {
  ai: "AI 서비스만",
  full: "인터넷 전체",
  none: "네트워크 끊김",
};

const presetLabel: Record<string, string> = {
  packages: "패키지 받기 (npm · PyPI · Debian)",
  github: "GitHub (git clone · push)",
  messenger: "메신저 (Telegram · Discord · Slack · WhatsApp)",
  "local-ai": "내 PC의 로컬 AI (Ollama · LM Studio)",
};

const stateLabel: Record<string, string> = {
  running: "실행 중",
  exited: "멈춤",
  created: "멈춤",
  restarting: "다시 켜는 중",
  paused: "일시 정지",
  dead: "멈춤",
};

const fmtTime = (t: number) => new Date(t).toLocaleString();

/**
 * Calls fn every ms while on: the next only once the last has answered, and
 * not while the page or this part of it (where) is out of sight (a box's
 * panel is kept, hidden, when another is open). Each call may run something
 * in the box: they must never stack up there.
 */
function usePoll(fn: () => Promise<unknown>, ms: number, on: boolean, deps: unknown[], where?: React.RefObject<HTMLElement | null>) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!on) return;
    let stop = false;
    let t = 0;
    const tick = async () => {
      const seen = !document.hidden && (!where?.current || where.current.offsetParent !== null);
      if (seen) await latest.current().catch(() => {});
      if (!stop) t = window.setTimeout(tick, ms);
    };
    t = window.setTimeout(tick, ms);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [on, ms, ...deps]);
}

interface Props {
  containers: Container[];
  run: Run;
  showCli: (cmd: string) => void;
  onOpen: (id: string) => void;
}

/** AI agents, each in a box of its own: what they can see, reach and use is kept small. */
export default function Agents({ containers, run, showCli, onOpen }: Props) {
  const [kinds, setKinds] = useState<Kind[]>([]);
  const [presets, setPresets] = useState<Record<string, string[]>>({});
  const [recipes, setRecipes] = useState<{ dir: string; problems: string[] }>({
    dir: "",
    problems: [],
  });
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [making, setMaking] = useState<Spec | null>(null);
  const [editing, setEditing] = useState(false);
  const [opened, setOpened] = useState("");
  const [busy, setBusy] = useState("");
  const [output, setOutput] = useState<{
    title: string;
    lines: string[];
  } | null>(null);
  const [visited, setVisited] = useState<string[]>([]);
  const [termCount, setTermCount] = useState<Record<string, number>>({});
  const openBox = (name: string) => {
    setOpened(name);
    setVisited((v) => (v.includes(name) ? v : [...v, name]));
  };
  const serial = useRef(0);

  const load = () =>
    call<Box[]>("AgentBoxes").then(
      (b) => setBoxes(b ?? []),
      () => {},
    );
  useEffect(() => {
    call<{
      kinds: Kind[];
      presets: Record<string, string[]>;
      recipes: string;
      problems: string[];
    }>("AgentCatalog").then((c) => {
      setKinds(c.kinds);
      setPresets(c.presets);
      setRecipes({ dir: c.recipes, problems: c.problems ?? [] });
    });
    load();
    showCli("docker compose ls -a --filter name=bfa-");
  }, []);

  const byName = useMemo(() => new Map(containers.map((c) => [c.name, c])), [containers]);
  const part = (b: Box, p: "agent" | "egress" | "service" | "browser") => byName.get(`${b.project}-${p}`);

  // A job a page started before (the browser closed, another device): found
  // on the server, followed to its end, its output shown as if started here.
  const followed = useRef(new Set<string>());
  useEffect(() => {
    if (busy || boxes.length === 0) return;
    let stop = false;
    let timer = 0;
    (async () => {
      const jobs = await call<Job[]>("ComposeJobs").catch(() => [] as Job[]);
      const j = (jobs ?? []).find((j) => j.running && !followed.current.has(j.key) && boxes.some((b) => b.project === j.project));
      if (!j || stop) return;
      const b = boxes.find((b) => b.project === j.project)!;
      followed.current.add(j.key);
      setBusy(b.spec.name);
      setOutput({
        title: `${b.spec.name} · ${jobLabel[j.action] ?? j.action} (진행 중이던 작업)`,
        lines: j.lines.slice(-800),
      });
      const off = on("compose", (l: { key: string; line: string }) => {
        if (l.key === j.key) setOutput((o) => (o ? { ...o, lines: o.lines.concat(l.line).slice(-800) } : o));
      });
      const watch = async () => {
        const now = ((await call<Job[]>("ComposeJobs").catch(() => [] as Job[])) ?? []).find((x) => x.key === j.key);
        if (now?.running) return void (timer = window.setTimeout(watch, 2000));
        off();
        setBusy("");
        setOutput((o) =>
          o
            ? {
                ...o,
                lines: o.lines.concat(now?.error ? `✖ 실패했습니다: ${now.error}` : "✔ 끝났습니다."),
              }
            : o,
        );
        load();
      };
      timer = window.setTimeout(watch, 2000);
    })();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [boxes.map((b) => b.project).join()]);

  /** Runs one compose command on a box, its output shown as it comes. */
  const compose = async (b: Box, action: "upbuild" | "stop" | "build" | "purge", title: string) => {
    // Unique past this page: a page opened again later follows a job by it.
    const key = `a${Date.now().toString(36)}-${++serial.current}`;
    followed.current.add(key);
    const words: Record<string, string> = {
      upbuild: "up -d --build --remove-orphans",
      stop: "stop",
      build: "build --pull --no-cache",
      purge: "down --volumes --rmi local --remove-orphans",
    };
    // Brought up as this BoxForge writes a box: one made by an older one gets what is new.
    if (action === "upbuild" && !(await run(`# ${b.dir}: compose.yaml · run.sh 다시 쓰기`, () => call("AgentRefresh", b.spec.name)))) return false;
    setBusy(b.spec.name);
    setOutput({ title, lines: [] });
    const off = on("compose", (l: { key: string; line: string }) => {
      if (l.key === key) setOutput((o) => (o ? { ...o, lines: o.lines.concat(l.line).slice(-800) } : o));
    });
    const ok = await run(`docker compose -p ${b.project} -f ${b.file} ${words[action]}`, () =>
      call("ComposeAction", {
        key,
        project: b.project,
        files: [b.file],
        action,
      }),
    );
    off();
    setBusy("");
    setOutput((o) =>
      o
        ? {
            ...o,
            lines: o.lines.concat(ok ? "✔ 끝났습니다." : "✖ 실패했습니다. 아래 상태 표시줄에 이유가 있습니다."),
          }
        : o,
    );
    load(); // its settings as now saved (changed elsewhere too: another tab, another device)
    return ok;
  };

  const fresh = (): Spec => ({
    name: "",
    agents: ["pi"],
    workspace: "",
    readOnly: [],
    network: "ai",
    allow: [],
    ports: [],
    memory: 4,
    cpus: 2,
    pids: 512,
    readOnlyRoot: false,
  });

  const save = async (spec: Spec) => {
    let box: Box | null = null;
    const ok = await run(`# ${spec.name}: compose.yaml · Dockerfile · 프록시 파일 쓰기`, async () => {
      box = await call<Box>("AgentSave", spec, !editing);
    });
    if (!ok || !box) return false;
    setMaking(null);
    await load();
    openBox(spec.name);
    await compose(box, "upbuild", `${spec.name} · ${editing ? "바뀐 설정으로 다시 만들기" : "만들고 시작"}`);
    load();
    return true;
  };

  const box = boxes.find((b) => b.spec.name === opened);

  return (
    <section>
      {/* Every box opened stays: its terminals go on while the list or another box is shown. */}
      {visited.map((name) => {
        const b = boxes.find((x) => x.spec.name === name);
        if (!b) return null;
        return (
          <div key={name} hidden={name !== opened}>
            <Control
              box={b}
              kinds={kinds}
              agent={part(b, "agent")}
              egress={part(b, "egress")}
              service={part(b, "service")}
              browser={part(b, "browser")}
              busy={!!busy}
              run={run}
              showCli={showCli}
              onBack={() => setOpened("")}
              onOpen={onOpen}
              compose={(action, title) => compose(b, action, title)}
              onEdit={() => {
                setEditing(true);
                setMaking({ ...b.spec });
              }}
              onGone={async () => {
                setOpened("");
                setVisited((v) => v.filter((x) => x !== name));
                await load();
              }}
              reload={load}
              output={name === opened ? output : null}
              onCloseOutput={() => setOutput(null)}
              onTerms={(n) => setTermCount((c) => ({ ...c, [name]: n }))}
            />
          </div>
        );
      })}
      {!box && (
        <>
          <header className="page-head">
            <h1>AI 에이전트</h1>
            <span className="spacer" />
            <button
              type="button"
              className="primary"
              onClick={() => {
                setEditing(false);
                setMaking(fresh());
              }}
            >
              새 에이전트 상자
            </button>
          </header>
          <p className="lead">
            AI 에이전트(Pi, Claude Code, OpenClaw 등)를 컨테이너 상자 안에서 돌립니다. 상자 안의 에이전트는 고른 작업 폴더 하나만 보고, 관리자 권한 없이, 정한 CPU · 메모리 안에서, 허락한 주소에만
            연결합니다. 무엇을 바꿨는지 보고, 저장해 둔 때로 되돌릴 수 있습니다.
          </p>
          {output && <Output output={output} busy={!!busy} onClose={() => setOutput(null)} />}
          {boxes.length === 0 ? (
            <div className="empty-state">
              <p>아직 에이전트 상자가 없습니다. "새 에이전트 상자"로 만드세요.</p>
            </div>
          ) : (
            <div className="agent-boxes">
              {boxes.map((b) => {
                const a = part(b, "agent");
                const up = a?.state === "running";
                return (
                  <article key={b.spec.name} className="agent-card" data-testid={`agent-${b.spec.name}`}>
                    <header>
                      <h2>
                        <button type="button" className="link name" onClick={() => openBox(b.spec.name)}>
                          {b.spec.name}
                        </button>
                      </h2>
                      <span className={"state " + (up ? "running" : "")}>
                        <span className="dot" />
                        {busy === b.spec.name ? "작업 중…" : a ? (stateLabel[a.state] ?? a.state) : "만들어지지 않음"}
                      </span>
                    </header>
                    <p className="chips">
                      {b.spec.image ? (
                        <span className="chip">{b.spec.image}</span>
                      ) : (
                        b.spec.agents.map((id) => (
                          <span key={id} className="chip">
                            {kinds.find((k) => k.id === id)?.name ?? id}
                          </span>
                        ))
                      )}
                    </p>
                    <dl className="agent-facts">
                      <div>
                        <dt>네트워크</dt>
                        <dd className={"net-" + b.spec.network}>{networkLabel[b.spec.network]}</dd>
                      </div>
                      <div>
                        <dt>작업 폴더</dt>
                        <dd title={b.spec.workspace}>{b.spec.workspace}</dd>
                      </div>
                      <div>
                        <dt>한도</dt>
                        <dd>
                          {b.spec.cpus ? `CPU ${b.spec.cpus}` : "CPU 제한 없음"} · {b.spec.memory ? `메모리 ${b.spec.memory} GB` : "메모리 제한 없음"}
                        </dd>
                      </div>
                    </dl>
                    <div className="actions">
                      {(termCount[b.spec.name] ?? 0) > 0 && up && <span className="muted">{`터미널 ${termCount[b.spec.name]}개 열림`}</span>}
                      <button type="button" className="primary" onClick={() => openBox(b.spec.name)}>
                        제어판 열기
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </>
      )}
      {making && <MakeDialog kinds={kinds} presets={presets} recipes={recipes} initial={making} editing={editing} onClose={() => setMaking(null)} onSave={save} showCli={showCli} />}
    </section>
  );
}

function Output({ output, busy, onClose }: { output: { title: string; lines: string[] }; busy: boolean; onClose: () => void }) {
  const box = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [output.lines.length]);
  return (
    <div className="console" data-testid="agent-output">
      <div className="console-head">
        <strong>{output.title}</strong>
        {!busy && (
          <button type="button" className="link" onClick={onClose}>
            닫기
          </button>
        )}
      </div>
      <pre ref={box} className="log-box">
        {output.lines.length ? output.lines.join("\n") : "…"}
      </pre>
    </div>
  );
}

/** Making a box, or changing one's settings. */
function MakeDialog(props: {
  kinds: Kind[];
  presets: Record<string, string[]>;
  recipes: { dir: string; problems: string[] };
  initial: Spec;
  editing: boolean;
  onClose: () => void;
  onSave: (s: Spec) => Promise<boolean>;
  showCli: (cmd: string) => void;
}) {
  const { kinds, presets, initial, editing } = props;
  const [spec, setSpec] = useState<Spec>(initial);
  const [own, setOwn] = useState(!!initial.image);
  const [defaults, setDefaults] = useState<string[]>([]);
  const [chosen, setChosen] = useState<string[]>(() => Object.keys(presets).filter((p) => presets[p].every((h) => initial.allow.includes(h)) && initial.allow.length > 0));
  // Lines written by hand: kept whatever agents or groups are chosen.
  const [extra, setExtra] = useState<string[]>([]);
  const [ports, setPorts] = useState((initial.ports ?? []).join(", "));
  const [readOnly, setReadOnly] = useState((initial.readOnly ?? []).join("\n"));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (p: Partial<Spec>) => setSpec((s) => ({ ...s, ...p }));

  useEffect(() => {
    call<string[]>("AgentAllowFor", own ? [] : spec.agents).then((d) => {
      const list = d ?? [];
      setDefaults(list);
      if (editing && extra.length === 0 && spec.allow.length) {
        const known = new Set([...list, ...Object.values(presets).flat()]);
        setExtra(spec.allow.filter((h) => !known.has(h)));
      }
    });
  }, [spec.agents.join(), own]);

  const allow = useMemo(() => {
    const all = [...defaults, ...chosen.flatMap((p) => presets[p] ?? []), ...extra];
    return [...new Set(all)];
  }, [defaults, chosen, extra, presets]);

  const services = kinds.filter((k) => k.service && spec.agents.includes(k.id));
  const [netNote, setNetNote] = useState("");
  const toggleAgent = (id: string, on: boolean) => {
    set({
      agents: on ? [...spec.agents.filter((a) => a !== id), id] : spec.agents.filter((a) => a !== id),
    });
    const k = kinds.find((x) => x.id === id);
    if (!k) return;
    // An agent with a web page of its own (OpenClaw, Hermes): its port, and a browser box to see it in.
    if (on && k.port) {
      if (!portList.includes(k.port)) setPorts((p) => (p.trim() ? `${p}, ${k.port}` : String(k.port)));
      set({ browser: true });
    }
    // Limits it runs well in (the box and what is kept running each have them).
    if (on && k.memory) setSpec((x) => (x.memory && x.memory < k.memory! ? { ...x, memory: k.memory! } : x));
    if (on && k.pids) setSpec((x) => (x.pids && x.pids < k.pids! ? { ...x, pids: k.pids! } : x));
    // The network it needs (a many-sided agent fetches its plugins and tools).
    if (on && k.network && k.network !== spec.network && spec.network === "ai") {
      set({ network: k.network });
      setNetNote(
        k.group === "guide"
          ? `${k.name}은(는) 설치할 때 여러 곳에서 받아 오므로 네트워크를 "${networkLabel[k.network]}"로 바꿨습니다. 아래에서 다시 바꿀 수 있습니다.`
          : `${k.name}은(는) 플러그인 · 도구를 받으러 인터넷에 나가야 해서 네트워크를 "${networkLabel[k.network]}"로 바꿨습니다. 아래에서 다시 바꿀 수 있습니다.`,
      );
    }
    // What it keeps running (its gateway, its page): one that has to be set up first waits for that.
    if (k.service && (k.group === "hot" || k.ready)) {
      if (on && !spec.service) set({ service: k.service });
      if (!on && spec.service === k.service) set({ service: "" });
    }
  };
  const portList = ports
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((p) => +p);
  const badPort = portList.some((p) => !Number.isInteger(p) || p < 1 || p > 65535);

  const final: Spec = {
    ...spec,
    agents: own ? [] : spec.agents,
    image: own ? spec.image : "",
    command: own ? spec.command : "",
    allow: spec.network === "ai" ? allow : [],
    ports: portList,
    readOnly: readOnly
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  };

  useEffect(() => {
    props.showCli(`docker compose -p bfa-${spec.name || "<이름>"} up -d --build   # BoxForge가 쓴 compose.yaml 로`);
  }, [spec.name]);

  const submit = async () => {
    setError("");
    if (badPort) return setError("포트는 1부터 65535 사이의 숫자로, 쉼표로 나눠 적습니다.");
    setSaving(true);
    const ok = await props.onSave(final);
    setSaving(false);
    if (!ok) setError("만들지 못했습니다. 아래 상태 표시줄에 이유가 있습니다.");
  };

  return (
    <Dialog title={editing ? `${spec.name} 설정 바꾸기` : "새 에이전트 상자"} onClose={props.onClose} wide>
      <form
        className="agent-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label>
          상자 이름
          <input value={spec.name} disabled={editing} placeholder="예: pi-work" onChange={(e) => set({ name: e.target.value.toLowerCase() })} />
          <span className="help">작은 영문자 · 숫자 · - 만. 컨테이너 이름이 bfa-이름-agent 가 됩니다.</span>
        </label>

        <fieldset>
          <legend>넣을 에이전트</legend>
          {!own && (
            <div className="agent-kinds">
              {groups.map(([g, title, help]) => {
                const list = kinds.filter((k) => k.group === g);
                if (!list.length) return null;
                return (
                  <div key={g} className="agent-group" data-testid={`agent-group-${g}`}>
                    <h4>{title}</h4>
                    <p className="help">{help}</p>
                    <div className="kind-list">
                      {list.map((k) => (
                        <label key={k.id} className="check">
                          <input type="checkbox" checked={spec.agents.includes(k.id)} onChange={(e) => toggleAgent(k.id, e.target.checked)} />
                          <span>
                            {k.name} <span className="muted">({k.command})</span>
                            {k.source && (
                              <span className="chip mine" title={k.source}>
                                내 레시피
                              </span>
                            )}
                            {k.about && <span className="kind-about">{k.about}</span>}
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {!own && netNote && <p className="note-box">{netNote}</p>}
          {!own && (
            <span className="help">
              {`에이전트 목록은 레시피 파일에서 옵니다. 새로 뜨는 에이전트는 레시피(YAML) 하나를 이 폴더에 넣으면 목록에 나옵니다: ${props.recipes.dir} (형식: docs/AGENT-RECIPES.md)`}
            </span>
          )}
          {!own && props.recipes.problems.map((p) => <p key={p} className="warn">{`읽지 못한 레시피: ${p}`}</p>)}
          <label className="check">
            <input type="checkbox" checked={own} onChange={(e) => setOwn(e.target.checked)} />
            <span>내가 가진 이미지로 (에이전트를 넣지 않음)</span>
          </label>
          {own && (
            <div className="row2">
              <label>
                이미지
                <input value={spec.image ?? ""} placeholder="예: ghcr.io/me/my-agent:latest" onChange={(e) => set({ image: e.target.value })} />
              </label>
              <label>
                에이전트를 시작하는 명령
                <input value={spec.command ?? ""} placeholder="예: my-agent" onChange={(e) => set({ command: e.target.value })} />
              </label>
            </div>
          )}
          {!own && <span className="help">여러 개를 고르면 한 상자에 모두 넣습니다(같은 폴더 · 같은 네트워크). 에이전트를 만들 때 인터넷에서 받아 설치하므로 처음에는 몇 분 걸립니다.</span>}
        </fieldset>

        <label>
          작업 폴더
          <span className="with-button">
            <input aria-label="작업 폴더" value={spec.workspace} placeholder="에이전트가 읽고 고칠 폴더 (예: /home/me/project, C:\work\project)" onChange={(e) => set({ workspace: e.target.value })} />
            <button
              type="button"
              onClick={async () => {
                const d = await pick("folder", "작업 폴더 고르기", "PickFolder");
                if (d) set({ workspace: d });
              }}
            >
              고르기
            </button>
          </span>
          <span className="help">상자 안에서는 /workspace 로 보입니다. 에이전트가 볼 수 있는 내 PC의 폴더는 이것뿐입니다.</span>
        </label>
        <label>
          읽기만 할 폴더 <span className="muted">(선택, 한 줄에 하나)</span>
          <textarea rows={2} value={readOnly} onChange={(e) => setReadOnly(e.target.value)} placeholder="참고할 문서 · 다른 프로젝트. 상자 안 /mnt/read-only/폴더이름 에 읽기 전용으로 보입니다." />
        </label>

        <fieldset>
          <legend>네트워크</legend>
          {(["ai", "full", "none"] as const).map((n) => (
            <label key={n} className="check">
              <input type="radio" name="agent-network" checked={spec.network === n} onChange={() => set({ network: n })} />
              <span>
                {networkLabel[n]}
                <span className="muted">
                  {n === "ai" && " (권장) — 아래 목록의 주소에만 연결합니다. 다른 곳으로의 연결은 막고 기록합니다."}
                  {n === "full" && " — 어디로든 연결합니다. 내 PC의 다른 서비스와 공유기 안의 기기에도 닿을 수 있습니다."}
                  {n === "none" && " — 아무 데도 연결하지 않습니다. 내 PC의 로컬 AI도 쓸 수 없습니다."}
                </span>
              </span>
            </label>
          ))}
          {spec.network === "ai" && (
            <>
              <div className="agent-presets">
                {Object.keys(presets).map((p) => (
                  <label key={p} className="check">
                    <input type="checkbox" checked={chosen.includes(p)} onChange={(e) => setChosen((c) => (e.target.checked ? [...c, p] : c.filter((x) => x !== p)))} />
                    <span>{presetLabel[p] ?? p}</span>
                  </label>
                ))}
              </div>
              <label>
                연결해도 되는 주소
                <textarea
                  aria-label="연결해도 되는 주소"
                  rows={6}
                  className="mono"
                  value={allow.join("\n")}
                  onChange={(e) => {
                    const lines = e.target.value.split("\n").map((l) => l.trim());
                    const auto = new Set([...defaults, ...chosen.flatMap((p) => presets[p] ?? [])]);
                    setExtra(lines.filter((l) => l && !auto.has(l)));
                  }}
                />
                <span className="help">
                  고른 에이전트가 쓰는 주소가 미리 들어 있습니다. *.example.com 은 그 아래 모두, host:port 는 그 포트만 허용합니다. 나중에 "연결 기록"에서 막힌 주소를 눌러 바로 허용할 수도 있습니다.
                </span>
              </label>
            </>
          )}
          <label>
            내 PC에 열 포트 <span className="muted">(선택, 쉼표로)</span>
            <input value={ports} placeholder="예: 18789, 3000" onChange={(e) => setPorts(e.target.value)} />
            <span className="help">
              상자 안 프로그램의 화면(OpenClaw의 18789, 만든 웹앱 등)을 내 PC의 브라우저에서 엽니다. 이 PC에서만(127.0.0.1) 열립니다. 나중에 제어판의 "웹 · 포트"에서 상자를 다시 만들지 않고 바로
              더하거나 뺄 수 있습니다.
            </span>
          </label>
          <label className="check">
            <input type="checkbox" checked={!!spec.browser} onChange={(e) => set({ browser: e.target.checked })} />
            <span>
              브라우저 상자 함께 만들기 <span className="muted">(에이전트의 웹 화면을 내 PC 브라우저 대신 격리된 Firefox로 봄. Firefox 이미지 약 1GB)</span>
            </span>
          </label>
        </fieldset>

        {services.length > 0 && (
          <fieldset>
            <legend>늘 켜 두기 (서비스)</legend>
            <label className="check">
              <input
                type="checkbox"
                checked={!!spec.service}
                onChange={(e) => {
                  const k = services[0];
                  set({ service: e.target.checked ? k.service : "" });
                  if (e.target.checked && k.port && !portList.includes(k.port)) setPorts((p) => (p ? `${p}, ${k.port}` : String(k.port)));
                }}
              />
              <span>메신저 게이트웨이처럼 늘 돌아가야 하는 에이전트를 상자 옆에서 서비스로 켜 둡니다(꺼지면 다시 켬)</span>
            </label>
            {spec.service !== undefined && spec.service !== "" && (
              <label>
                서비스 명령 <span className="muted">(한 줄에 하나, 모두 켜 둠)</span>
                <textarea className="mono" rows={Math.max(2, spec.service.split("\n").length)} value={spec.service} onChange={(e) => set({ service: e.target.value })} />
                <span className="help">
                  {services.some((k) => k.gate)
                    ? "설정(예: openclaw onboard)이 끝날 때까지 기다렸다가 저절로 켜집니다. 상자의 터미널이 설정부터 엽니다."
                    : services.some((k) => k.group === "hot")
                      ? "상자와 함께 켜지고, 하나가 꺼지면 모두 다시 켭니다."
                      : "먼저 상자의 터미널에서 설정을 마친 뒤 켜세요. 설정 전에는 시작하자마자 꺼질 수 있습니다."}
                </span>
              </label>
            )}
          </fieldset>
        )}

        <fieldset>
          <legend>한도와 보호</legend>
          <div className="row3">
            <label>
              메모리 (GB)
              <input type="number" min={0} step={0.5} value={spec.memory} onChange={(e) => set({ memory: +e.target.value })} />
            </label>
            <label>
              CPU (개)
              <input type="number" min={0} step={0.5} value={spec.cpus} onChange={(e) => set({ cpus: +e.target.value })} />
            </label>
            <label>
              프로세스 수
              <input type="number" min={0} step={64} value={spec.pids} onChange={(e) => set({ pids: +e.target.value })} />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={spec.readOnlyRoot} onChange={(e) => set({ readOnlyRoot: e.target.checked })} />
            <span>
              시스템 파일 읽기 전용 <span className="muted">(작업 폴더 · 홈 · /tmp 만 쓸 수 있음. 에이전트가 시스템에 무언가 설치하는 것을 막습니다)</span>
            </span>
          </label>
          <p className="help">
            늘 켜져 있는 보호: 관리자(root)가 아닌 사용자로 실행, 리눅스 특권 모두 빼기(cap_drop ALL), 권한 올리기 막기(no-new-privileges). API 키는 상자 안에서만 읽는 파일로 넣어 컨테이너 설정(docker
            inspect)에 나오지 않습니다. 0은 제한 없음입니다.
          </p>
        </fieldset>

        {error && (
          <p className="warn" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={props.onClose} disabled={saving}>
            취소
          </button>
          <button type="submit" className="primary" disabled={saving || !spec.name || !spec.workspace || (own ? !spec.image || !spec.command : spec.agents.length === 0)}>
            {editing ? "저장하고 다시 만들기" : "만들고 시작"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

type Tab = "terminal" | "web" | "changes" | "network" | "snapshots" | "keys";

/** One box: its terminal, what it changed, where it connected, saved copies and keys. */
function Control(props: {
  box: Box;
  kinds: Kind[];
  agent?: Container;
  egress?: Container;
  service?: Container;
  browser?: Container;
  busy: boolean;
  run: Run;
  showCli: (cmd: string) => void;
  onBack: () => void;
  onOpen: (id: string) => void;
  compose: (action: "upbuild" | "stop" | "build" | "purge", title: string) => Promise<boolean>;
  onEdit: () => void;
  onGone: () => void;
  reload: () => void;
  output: { title: string; lines: string[] } | null;
  onCloseOutput: () => void;
  onTerms: (n: number) => void;
}) {
  const { box, kinds, agent, egress, service, busy, run, showCli } = props;
  const s = box.spec;
  const up = agent?.state === "running";
  const [tab, setTab] = useState<Tab>("terminal");
  const [removing, setRemoving] = useState(false);
  // Its ports, opened on this PC while the box runs (again after BoxForge started anew).
  useEffect(() => {
    if (up) call("AgentPortsEnsure", s.name).catch(() => {});
  }, [up, s.name, (s.ports ?? []).join()]);
  const mine = s.image ? [] : kinds.filter((k) => s.agents.includes(k.id));
  const selfUpdating = mine.filter((k) => k.group !== "ready" && k.update);
  const [ask, setAsk] = useState<{ which: string[]; n: number }>({
    which: [],
    n: 0,
  });
  // What was installed when the box was built ("@latest" then): asked of the agents themselves.
  const [versions, setVersions] = useState<Record<string, string>>({});
  useEffect(() => {
    if (up && !s.image)
      call<Record<string, string>>("AgentVersions", s.name).then(
        (v) => setVersions(v ?? {}),
        () => {},
      );
  }, [up, s.name, (s.agents ?? []).join()]);
  const tabs: [Tab, string][] = [
    ["terminal", "터미널"],
    ["web", "웹 · 포트"],
    ["changes", "바뀐 파일"],
    ...(s.network === "ai" ? ([["network", "연결 기록"]] as [Tab, string][]) : []),
    ["snapshots", "저장 · 되돌리기"],
    ["keys", "API 키"],
  ];

  return (
    <>
      <nav className="crumbs">
        <button type="button" className="link" onClick={props.onBack}>
          AI 에이전트
        </button>
        <span className="muted"> › </span>
        <strong>{s.name}</strong>
      </nav>
      <header className="project-head">
        <span className={"state " + (up ? "running" : "")} data-testid="agent-state">
          <span className="dot" />
          {agent ? (stateLabel[agent.state] ?? agent.state) : "만들어지지 않음"}
        </span>
        <span className={"net-badge net-" + s.network}>{networkLabel[s.network]}</span>
        {service && <span className="muted">{`서비스: ${stateLabel[service.state] ?? service.state}`}</span>}
        <span className="spacer" />
        <IconButton icon="play" label={up ? "설정대로 다시 올리기" : "시작"} tone={up ? undefined : "go"} disabled={busy} onClick={() => props.compose("upbuild", `${s.name} · 시작`)} />
        <IconButton icon="stop" label="멈추기 (상자는 남김)" tone="danger" disabled={busy || !up} onClick={() => props.compose("stop", `${s.name} · 멈추기`)} />
        {!s.image && (
          <button
            type="button"
            disabled={busy}
            title={selfUpdating.length ? "홈에 설치한 에이전트는 그 자신의 업데이트 명령을 터미널에서 실행합니다(상자가 켜져 있어야 함)" : "에이전트를 새 버전으로 받아 상자를 다시 만듭니다"}
            onClick={async () => {
              // Put in when the image is built: built again. Put in the
              // home: updated there by its own command (the home volume
              // keeps it, a new image wouldn't reach it).
              if (mine.some((k) => k.group === "ready")) {
                if (!(await props.compose("build", `${s.name} · 에이전트 새 버전으로 다시 만들기`))) return;
                if (!(await props.compose("upbuild", `${s.name} · 새 버전으로 시작`))) return;
              }
              if (selfUpdating.length) {
                setTab("terminal");
                setAsk((a) => ({
                  which: selfUpdating.map((k) => `update:${k.id}`),
                  n: a.n + 1,
                }));
              }
            }}
          >
            에이전트 업데이트
          </button>
        )}
        <button type="button" disabled={busy} onClick={props.onEdit}>
          설정 바꾸기
        </button>
        {agent && (
          <button type="button" onClick={() => props.onOpen(agent.id)}>
            그래프 · 로그
          </button>
        )}
        <IconButton icon="trash" label="상자 삭제" tone="danger" disabled={busy} onClick={() => setRemoving(true)} />
      </header>
      <dl className="project-meta" data-testid="agent-facts">
        <div>
          <dt>에이전트</dt>
          <dd>{s.image ? `${s.image} (${s.command})` : mine.map((k) => (versions[k.id] ? `${k.name} (${versions[k.id]})` : k.name)).join(", ")}</dd>
        </div>
        <div>
          <dt>작업 폴더</dt>
          <dd>{s.workspace} → /workspace</dd>
        </div>
        <div>
          <dt>한도</dt>
          <dd>{`CPU ${s.cpus || "제한 없음"} · 메모리 ${s.memory ? `${s.memory} GB` : "제한 없음"} · 프로세스 ${s.pids || "제한 없음"}`}</dd>
        </div>
        {(s.ports ?? []).length > 0 && (
          <div>
            <dt>열린 포트</dt>
            <dd>
              {(s.ports ?? []).map((p) => (
                <a key={p} href={`http://localhost:${p}`} target="_blank" rel="noreferrer">
                  localhost:{p}{" "}
                </a>
              ))}
            </dd>
          </div>
        )}
        <div>
          <dt>파일</dt>
          <dd className="muted">{box.file}</dd>
        </div>
      </dl>
      {props.output && <Output output={props.output} busy={busy} onClose={props.onCloseOutput} />}
      {s.network === "ai" && up && egress?.state !== "running" && (
        <p className="warn" role="alert">
          {`연결을 지키는 프록시(${box.project}-egress)가 멈춰 있어 에이전트가 AI 서비스에 닿지 못합니다. 시작을 눌러 다시 올리세요.`}
        </p>
      )}
      <div className="tabs kube-tabs" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      {!up && tab !== "keys" ? (
        <p className="empty">상자가 실행 중이 아닙니다. 시작을 누르세요.</p>
      ) : (
        <>
          {/* Kept open while another tab is looked at: what runs in it goes on, and is there on coming back. */}
          <div hidden={tab !== "terminal"}>
            <TermTab box={box} mine={mine} run={run} showCli={showCli} onCount={props.onTerms} onWeb={() => setTab("web")} ask={ask} />
          </div>
          {tab === "web" && <WebTab box={box} mine={mine} service={service} browser={props.browser} run={run} showCli={showCli} compose={props.compose} reload={props.reload} />}
          {tab === "changes" && <ChangesTab box={box} run={run} showCli={showCli} />}
          {tab === "network" && <NetworkTab box={box} run={run} showCli={showCli} reload={props.reload} />}
          {tab === "snapshots" && <SnapshotsTab box={box} run={run} showCli={showCli} />}
        </>
      )}
      {tab === "keys" && <KeysTab box={box} mine={mine} run={run} showCli={showCli} reload={props.reload} />}
      {removing && (
        <Dialog title={`${s.name} 상자 삭제`} onClose={() => setRemoving(false)}>
          <p>다음이 지워지고 되돌릴 수 없습니다:</p>
          <ul>
            <li>컨테이너 {[box.project + "-agent", s.service ? box.project + "-service" : "", s.network === "ai" ? box.project + "-egress" : ""].filter(Boolean).join(", ")}</li>
            {!s.image && <li>{`에이전트 이미지 boxforge-agent/${s.name}`}</li>}
            {!s.image && <li>상자의 홈 볼륨 (에이전트의 로그인 정보 · 설정 · 대화 기록)</li>}
            {s.browser && <li>브라우저 상자와 그 볼륨 (브라우저에 남은 로그인 · 기록)</li>}
            <li>저장해 둔 작업 폴더 복사본</li>
            <li>{`API 키와 상자 설정 (${box.dir})`}</li>
          </ul>
          <p className="muted">{`작업 폴더(${s.workspace})의 파일은 그대로 남습니다.`}</p>
          <div className="dialog-actions">
            <button type="button" onClick={() => setRemoving(false)}>
              취소
            </button>
            <button
              type="button"
              className="danger"
              onClick={async () => {
                setRemoving(false);
                if (!(await props.compose("purge", `${s.name} · 삭제`))) return;
                if (await run(`# ${box.dir} 와 저장한 복사본 볼륨 지우기`, () => call("AgentForget", s.name))) props.onGone();
              }}
            >
              삭제
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}

interface Term {
  key: number;
  which: string; // "main", an agent kind, or "shell"
  label: string;
  ended: boolean;
}

/** A box's terminals, as an editor's tabs: each one open until it is closed. */
function TermTab({
  box,
  mine,
  run,
  showCli,
  onCount,
  onWeb,
  ask,
}: {
  box: Box;
  mine: Kind[];
  run: Run;
  showCli: (cmd: string) => void;
  onCount: (n: number) => void;
  onWeb: () => void;
  ask?: { which: string[]; n: number }; // terminals asked for from outside (the agents' update)
}) {
  // An agent that is a gateway with a setup (OpenClaw, Hermes) isn't opened by
  // itself: its command starts that setup, every time. A shell, or another
  // agent of the box, is; not one of a guide, which is put in by hand.
  const first = box.spec.image ? "main" : (mine.find((k) => !k.service && k.group !== "guide")?.id ?? "shell");
  const serial = useRef(0);
  // "setup:hermes", "doctor:hermes", "update:hermes", "guide:codex:0": an agent's own command.
  const actionOf = (which: string) => {
    const [action, id, n] = which.split(":");
    const k = id ? mine.find((x) => x.id === id) : undefined;
    if (!k) return undefined;
    const cmd = action === "setup" ? k.setup : action === "doctor" ? k.doctor : action === "update" ? k.update : action === "guide" ? k.guide?.[+n]?.command : "";
    const what = action === "setup" ? "설정" : action === "doctor" ? "진단" : action === "update" ? "업데이트" : (k.guide?.[+n]?.title ?? "설치");
    return { k, action, cmd: cmd ?? "", label: `${k.name} ${what}` };
  };
  const nameOf = (which: string) => {
    const a = actionOf(which);
    if (a) return a.label;
    return which === "shell" ? "셸" : which === "main" ? (box.spec.command ?? "") : (mine.find((k) => k.id === which)?.name ?? which);
  };
  const make = (which: string, list: Term[]): Term => {
    const same = list.filter((t) => t.which === which).length;
    return {
      key: ++serial.current,
      which,
      label: same ? `${nameOf(which)} ${same + 1}` : nameOf(which),
      ended: false,
    };
  };
  // An agent not set up yet (OpenClaw before "openclaw onboard"): its setup
  // opens first, and its gateway waits for it.
  // (A guide's agent: whether it is put in yet.)
  const withSetup = mine.some((k) => k.ready);
  const [terms, setTerms] = useState<Term[]>(() => (withSetup ? [] : [make(first, [])]));
  const [active, setActive] = useState(terms[0]?.key ?? 0);
  const [unset, setUnset] = useState<string[]>([]);
  const [checked, setChecked] = useState(!withSetup);
  const [done, setDone] = useState<string[]>([]); // set up while this was open
  const check = async () => {
    try {
      const need = (await call<string[]>("AgentSetupNeeded", box.spec.name)) ?? [];
      setUnset((was) => {
        const now = was.filter((id) => !need.includes(id));
        if (now.length) setDone((d) => [...new Set([...d, ...now])]);
        return need;
      });
      return need;
    } catch {
      return [];
    }
  };
  // The setup's wizard may go on into the agent itself (OpenClaw's chat)
  // instead of ending: its end is seen in the box, every few seconds.
  const termRef = useRef<HTMLDivElement>(null);
  const kindOf = (id: string) => mine.find((k) => k.id === id);
  const needSetup = unset.filter((id) => kindOf(id)?.group !== "guide" && kindOf(id)?.setup);
  const notIn = unset.filter((id) => kindOf(id)?.group === "guide");
  usePoll(check, 5000, needSetup.length > 0, [], termRef);
  useEffect(() => {
    if (!withSetup) return;
    check().then((need) => {
      const set = need.find((id) => kindOf(id)?.group !== "guide" && kindOf(id)?.setup);
      const t = make(set ? `setup:${set}` : first, []);
      setTerms([t]);
      setActive(t.key);
      setChecked(true);
    });
  }, []);
  useEffect(() => onCount(terms.length), [terms.length]);

  const add = (which: string) => {
    const t = make(which, terms);
    setTerms([...terms, t]);
    setActive(t.key);
  };
  // Asked for from outside (the agents' update): opened here.
  useEffect(() => {
    if (!ask?.which.length) return;
    const more = ask.which.map((w) => make(w, terms));
    setTerms([...terms, ...more]);
    setActive(more[more.length - 1].key);
  }, [ask?.n]);
  const close = (keys: number[]) => {
    const rest = terms.filter((t) => !keys.includes(t.key));
    setTerms(rest);
    if (!rest.some((t) => t.key === active)) {
      // As an editor does: the tab beside the one closed.
      const at = terms.findIndex((t) => t.key === active);
      setActive((rest[Math.min(at, rest.length - 1)] ?? rest[0])?.key ?? 0);
    }
  };
  const cur = terms.find((t) => t.key === active);
  const kind = mine.find((k) => k.id === cur?.which);

  // Its size: dragged by the bar under it (remembered), or the whole window.
  const [height, setHeight] = useState(() => {
    try {
      return Math.max(200, +(localStorage.getItem("bf.agentTermHeight") ?? "") || 440);
    } catch {
      return 440;
    }
  });
  const [big, setBig] = useState(false);
  useEffect(() => {
    if (!big) return;
    const key = (e: KeyboardEvent) => e.key === "Escape" && e.shiftKey && setBig(false);
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [big]);
  const drag = (e: React.PointerEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = height;
    let last = h0;
    const move = (m: PointerEvent) => {
      last = Math.min(window.innerHeight - 120, Math.max(200, h0 + m.clientY - y0));
      setHeight(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem("bf.agentTermHeight", String(Math.round(last)));
      } catch {
        /* kept for this time only */
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const sizeBy = (d: number) => {
    const h = Math.min(window.innerHeight - 120, Math.max(200, height + d));
    setHeight(h);
    try {
      localStorage.setItem("bf.agentTermHeight", String(h));
    } catch {
      /* kept for this time only */
    }
  };
  const cliOf = (which: string) =>
    `docker exec -it ${box.project}-agent sh /opt/boxforge/run ${which === "shell" ? "shell" : which === "main" ? (box.spec.command ?? "") : actionOf(which) ? actionOf(which)!.cmd : (mine.find((k) => k.id === which)?.command ?? "")}`;

  const opener = (which: string) => (
    <>
      {box.spec.image && which === "main" && box.spec.command}
      {which !== "main" && nameOf(which)}
    </>
  );
  return (
    <div ref={termRef} className={"agent-term" + (big ? " big" : "")} style={{ ["--term-h" as string]: `${height}px` }}>
      <div className="graph-bar">
        <span className="muted">새 터미널:</span>
        {(box.spec.image
          ? ["main"]
          : mine.flatMap((k) =>
              // A guide's agent once it is put in; each one's setup and check-up.
              (k.group === "guide" && notIn.includes(k.id) ? [] : [k.id]).concat(k.setup && k.group !== "guide" ? [`setup:${k.id}`] : [], k.doctor ? [`doctor:${k.id}`] : []),
            )
        )
          .concat("shell")
          .map((w) => (
            <button key={w} type="button" className="chip" title={`${nameOf(w)}를 새 탭에서 엽니다`} onClick={() => add(w)}>
              + {opener(w)}
            </button>
          ))}
        <span className="spacer" />
        <button type="button" aria-pressed={big} title={big ? "원래 크기로 (Shift+Esc)" : "창 전체로 크게"} onClick={() => setBig(!big)}>
          {big ? "원래 크기로" : "크게 보기"}
        </button>
        {cur && (
          <button type="button" onClick={() => run(cliOf(cur.which), () => call("AgentOpenTerminal", box.spec.name, cur.which))}>
            외부 터미널로 열기
          </button>
        )}
      </div>
      {terms.length > 0 && (
        <div className="term-tabs" data-testid="term-tabs">
          <div className="term-tab-list" role="tablist" aria-label="열린 터미널">
            {terms.map((t) => (
              <span key={t.key} className={"term-tab" + (t.key === active ? " on" : "") + (t.ended ? " ended" : "")}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={t.key === active}
                  title={t.ended ? "끝난 터미널입니다. 닫거나 새로 여세요." : cliOf(t.which)}
                  onClick={() => setActive(t.key)}
                  onAuxClick={(e) => e.button === 1 && close([t.key])}
                >
                  {t.label}
                  {t.ended && <span className="muted"> (끝남)</span>}
                </button>
                <button type="button" className="term-tab-close" aria-label={`${t.label} 닫기`} title="닫기 (그 안에서 돌던 것도 끕니다)" onClick={() => close([t.key])}>
                  ×
                </button>
              </span>
            ))}
          </div>
          <span className="spacer" />
          <button type="button" className="link" disabled={terms.length < 2} onClick={() => close(terms.filter((t) => t.key !== active).map((t) => t.key))}>
            이 탭 빼고 모두 닫기
          </button>
          {terms.some((t) => t.ended) && (
            <button type="button" className="link" onClick={() => close(terms.filter((t) => t.ended).map((t) => t.key))}>
              끝난 것 닫기
            </button>
          )}
          <button type="button" className="link" onClick={() => close(terms.map((t) => t.key))}>
            모두 닫기
          </button>
        </div>
      )}
      {kind && <p className="help">{kind.note}</p>}
      {needSetup.map((id) => {
        const k = mine.find((x) => x.id === id);
        if (!k) return null;
        const on = cur?.which === `setup:${id}` && !cur.ended;
        return (
          <p key={id} className="note-box" data-testid="setup-needed">
            {k.gate
              ? `${k.name} 설정이 아직 안 됐습니다. 설정(${k.setup})을 마치면 게이트웨이가 저절로 켜집니다.`
              : `${k.name} 설정이 아직 안 됐습니다. 설정(${k.setup})을 마치면 바로 쓸 수 있습니다.`}
            {!on && (
              <span>
                <button type="button" className="primary" onClick={() => add(`setup:${id}`)}>
                  설정 시작
                </button>
              </span>
            )}
          </p>
        );
      })}
      {notIn.map((id) => {
        const k = kindOf(id);
        if (!k) return null;
        return (
          <section key={id} className="guide-card" data-testid="agent-guide">
            <h3>{`${k.name} 설치 안내`}</h3>
            {k.about && <p className="muted">{k.about}</p>}
            <ol>
              {(k.guide ?? []).map((g, i) => (
                <li key={i}>
                  <span>{g.title}</span>
                  <code className="mono">{g.command}</code>
                  <span className="actions">
                    <button type="button" onClick={() => add(`guide:${id}:${i}`)}>
                      터미널에서 실행
                    </button>
                    <button type="button" className="link" onClick={() => copyText(g.command)}>
                      복사
                    </button>
                  </span>
                </li>
              ))}
            </ol>
            <p className="help">
              {`상자 사용자의 홈에 설치되어(상자의 홈 볼륨) 상자를 다시 만들어도 남습니다. 직접 셸을 열어 위 명령을 쳐도 됩니다.${box.spec.network === "ai" ? ' 네트워크가 "AI 서비스만"이라 설치에 필요한 주소(npm 등)는 이 에이전트를 고를 때 허용 목록에 넣었습니다. 막히면 "연결 기록"에서 허용하세요.' : ""}`}
              {k.docs && (
                <>
                  {" "}
                  <a href={k.docs} onClick={(e) => (e.preventDefault(), openURL(k.docs!))}>
                    공식 안내
                  </a>
                </>
              )}
            </p>
          </section>
        );
      })}
      {done.map((id) => {
        const k = mine.find((x) => x.id === id);
        if (!k) return null;
        return (
          <p key={id} className="note-box ok" data-testid="setup-done">
            {k.group === "guide"
              ? `${k.name}이(가) 설치됐습니다. 위의 "새 터미널"에서 "+ ${k.name}"으로 엽니다.`
              : k.gate
                ? `${k.name} 설정이 끝났습니다. 게이트웨이가 저절로 켜지고 있습니다(30초~1분). 이 터미널은 그대로 써도 됩니다.`
                : `${k.name} 설정이 끝났습니다. 이 터미널은 그대로 써도 됩니다.`}
            <span>
              {!!k.port && (
                <button type="button" className="primary" onClick={onWeb}>
                  웹 화면 열러 가기
                </button>
              )}
              <button type="button" className="link" onClick={() => setDone((d) => d.filter((x) => x !== id))}>
                닫기
              </button>
            </span>
          </p>
        );
      })}
      {!checked && <p className="muted">상자를 살펴보는 중…</p>}
      {checked && terms.length === 0 && <p className="empty">열린 터미널이 없습니다. 위의 "새 터미널"에서 여세요.</p>}
      {terms.map((t) => (
        <div key={t.key} hidden={t.key !== active} className="term-pane" data-testid="term-pane">
          <Terminal
            id={box.project + "-agent"}
            name={box.project + "-agent"}
            showCli={showCli}
            run={run}
            command={cliOf(t.which)}
            onEnd={() => {
              setTerms((all) => all.map((x) => (x.key === t.key ? { ...x, ended: true } : x)));
              // Set up, put in, updated: seen at once.
              if (/^(setup|guide|update):/.test(t.which)) check();
            }}
            open={(cols, rows) => call<string>("AgentTermOpen", box.spec.name, t.which, cols, rows)}
          />
        </div>
      ))}
      {terms.length > 0 && !big && (
        <div
          className="term-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="터미널 높이 조절"
          aria-valuenow={Math.round(height)}
          tabIndex={0}
          title="끌어서 터미널 높이를 바꿉니다"
          onPointerDown={drag}
          onKeyDown={(e) => {
            if (e.key === "ArrowUp") (e.preventDefault(), sizeBy(-40));
            if (e.key === "ArrowDown") (e.preventDefault(), sizeBy(40));
          }}
          onDoubleClick={() => sizeBy(440 - height)}
        />
      )}
    </div>
  );
}

// The browser box's own page (its picture), in the box's network.
const browserPort = 5800;

/** Its web pages and ports: opened on this PC by BoxForge, at once, the box running on. */
function WebTab(props: {
  box: Box;
  mine: Kind[];
  service?: Container;
  browser?: Container;
  run: Run;
  showCli: (cmd: string) => void;
  compose: (action: "upbuild" | "stop" | "build" | "purge", title: string) => Promise<boolean>;
  reload: () => void;
}) {
  const { box, mine, run, showCli } = props;
  const s = box.spec;
  const [ports, setPorts] = useState<{ port: number; local: number; shared: number }[]>([]);
  const [adding, setAdding] = useState("");
  const [note, setNote] = useState("");
  const page = mine.find((k) => k.port); // an agent with a web page of its own (OpenClaw)
  // Its setup not done yet: the gateway waits for it, and the page can't open.
  const [unset, setUnset] = useState(false);
  const webRef = useRef<HTMLDivElement>(null);
  const look = () =>
    page?.setup
      ? call<string[]>("AgentSetupNeeded", s.name)
          .then((need) => setUnset((need ?? []).includes(page.id)))
          .catch(() => setUnset(false))
      : Promise.resolve();
  useEffect(() => void look(), [page?.id, props.service?.state]);
  // Set up in the terminal meanwhile: seen here too (asked only until then).
  usePoll(look, 5000, unset, [], webRef);
  const holder = `${box.project}-agent`; // the service shares its network and processes
  const load = () =>
    call<{ port: number; local: number; shared: number }[]>("AgentPortsEnsure", s.name).then(
      (p) => setPorts(p ?? []),
      (e) => setNote(e.message),
    );
  useEffect(() => {
    showCli(`# BoxForge가 이 PC의 127.0.0.1:포트 로 받은 연결을 docker exec ${holder} 로 상자 안의 localhost:포트 에 이어 줍니다`);
    load();
  }, [s.name, s.ports?.join()]);

  const saveSpec = async (next: Spec, title: string) => {
    if (!(await run(`# ${box.dir}: compose.yaml 다시 쓰기`, () => call("AgentSave", next, false)))) return false;
    props.reload();
    return props.compose("upbuild", title);
  };
  const add = async () => {
    const p = +adding;
    if (!Number.isInteger(p) || p < 1 || p > 65535) return setNote("포트는 1부터 65535 사이의 숫자입니다.");
    setNote("");
    if (await run(`# 127.0.0.1:${p} → ${holder} 안의 localhost:${p} (다시 만들지 않음)`, () => call("AgentPortAdd", s.name, p))) {
      setAdding("");
      props.reload();
      load();
    }
  };
  // Where a port of the box is reached from this browser: on this PC (the
  // desktop app), or, through BoxForge's web server, on the server's own
  // address over its HTTPS, for the browsers signed in to it.
  const reach = async (port: number): Promise<string | null> => {
    let at = 0;
    if (remote()) {
      const ok = await run(
        `# https://${location.hostname}:${port} → ${holder} 안의 localhost:${port} (이 BoxForge에 로그인한 브라우저만)`,
        async () => (at = await call<number>("AgentPortShare", s.name, port)),
      );
      load();
      return ok ? `https://${location.hostname}:${at}` : null;
    }
    const ok = await run(`# 127.0.0.1:${port} → ${holder} 안의 localhost:${port}`, async () => (at = await call<number>("AgentPortOpen", s.name, port)));
    load();
    return ok ? `http://127.0.0.1:${at}` : null;
  };
  const openAt = async (port: number) => {
    const base = await reach(port);
    if (base) openURL(base + "/");
  };

  // The agent's own page (OpenClaw), signed in by its one-time link.
  // Getting its link takes a few seconds: once at a time, and said so.
  const [opening, setOpening] = useState<"" | "pc" | "browser">("");
  const openPage = async (where: "pc" | "browser") => {
    if (opening) return;
    setOpening(where);
    try {
      await openPageNow(where);
    } finally {
      setOpening("");
    }
  };
  const openPageNow = async (where: "pc" | "browser") => {
    // OpenClaw's page opens signed in, by its one-time link; another's (Hermes) is its address.
    let link = `http://127.0.0.1:${page!.port}/`;
    if (page!.link === "openclaw" && !(await run(`docker exec ${holder} sh /opt/boxforge/run openclaw dashboard --json`, async () => (link = await call<string>("AgentWebLink", s.name))))) return;
    if (where === "pc") {
      const base = await reach(page!.port!);
      if (!base) return;
      // The link names the gateway as the box sees it (127.0.0.1:18789, and
      // gatewayUrl=ws://127.0.0.1:18789 in it): moved to where this browser reaches it.
      const b = new URL(base);
      const u = new URL(link);
      u.protocol = b.protocol;
      u.hostname = b.hostname;
      u.port = b.port;
      const was = `ws://127.0.0.1:${page!.port}`;
      const now = `${b.protocol === "https:" ? "wss" : "ws"}://${b.host}`;
      u.hash = u.hash.split(encodeURIComponent(was)).join(encodeURIComponent(now)).split(was).join(now);
      openURL(u.toString());
    } else {
      if (!(await run(`# 브라우저 상자에서 ${link.split("#")[0]} 열기`, () => call<number>("AgentBrowserOpen", s.name, link)))) return;
      // The browser starts again with the page: a moment before its picture shows it.
      setTimeout(() => openAt(browserPort), 2500);
    }
  };
  const openBrowser = async () => {
    if (await run(`# ${box.project}-browser 의 화면`, () => call<number>("AgentBrowserOpen", s.name, ""))) openAt(browserPort);
  };
  const browserUp = props.browser?.state === "running";

  return (
    <div ref={webRef} className="agent-web">
      {remote() && (
        <p className="note-box">
          웹 서버로 접속 중입니다: 상자의 화면과 포트는 BoxForge 서버의 같은 번호 포트(HTTPS)로 열리고, 이 BoxForge에 로그인한 브라우저에서만 열립니다. 서버에 방화벽이나 포트 포워딩이 있으면 그
          번호(예: 18789)를 열어 두세요.
        </p>
      )}
      {s.service && (
        <section className="web-card">
          <h3>늘 켜 둔 서비스</h3>
          <Gateway box={box} mine={mine} service={props.service} run={run} />
        </section>
      )}
      {page && (
        <section className="web-card" data-testid="agent-page">
          <h3>{`${page.name} 화면`}</h3>
          <p className="muted">
            {`${page.name}의 웹 화면을 ${page.link === "openclaw" ? "로그인된 상태로 " : ""}엽니다(상자 안의 127.0.0.1:${page.port}). 브라우저 상자는 격리된 Firefox라서, 그 화면의 코드가 내 PC의 브라우저에서 돌지 않습니다(내 PC에는 그림만 보입니다).`}
          </p>
          {unset && page.gate && (
            <p className="note-box" data-testid="page-setup-needed">
              {`${page.name} 설정이 아직 안 됐습니다. "터미널" 탭의 "설정 시작"(${page.setup})으로 설정을 마치면 게이트웨이가 저절로 켜지고, 그 뒤에 화면이 열립니다.`}
            </p>
          )}
          {!s.service && (
            <p className="note-box">
              {page.gate
                ? `게이트웨이가 켜져 있어야 화면이 열립니다. 상자의 터미널에서 설정(${page.setup})을 마쳤다면 "늘 켜 두기"로 게이트웨이를 켜세요.`
                : `화면을 내는 프로그램이 켜져 있어야 화면이 열립니다. "늘 켜 두기"로 켜세요.`}
              <span>
                <button
                  type="button"
                  onClick={() =>
                    saveSpec(
                      {
                        ...s,
                        service: page.service ?? "",
                        ports: [...new Set([...(s.ports ?? []), page.port!])],
                      },
                      `${s.name} · 게이트웨이 늘 켜 두기`,
                    )
                  }
                >
                  {page.gate ? "게이트웨이 늘 켜 두기" : "늘 켜 두기"}
                </button>
              </span>
            </p>
          )}

          <div className="actions">
            <button type="button" className="primary" disabled={!!opening} aria-busy={opening === "pc"} onClick={() => openPage("pc")}>
              {opening === "pc" ? "여는 중… (몇 초 걸립니다)" : remote() ? "이 기기 브라우저로 열기" : "내 PC 브라우저로 열기"}
            </button>
            {s.browser ? (
              <button
                type="button"
                disabled={!browserUp || !!opening}
                aria-busy={opening === "browser"}
                title={browserUp ? "" : "브라우저 상자가 아직 켜지지 않았습니다"}
                onClick={() => openPage("browser")}
              >
                {opening === "browser" ? "여는 중… (몇 초 걸립니다)" : "브라우저 상자로 열기"}
              </button>
            ) : null}
          </div>
        </section>
      )}

      <section className="web-card" data-testid="agent-browser">
        <h3>브라우저 상자</h3>
        {s.browser ? (
          <>
            <p className="muted">
              {`상자 옆에서 도는 격리된 Firefox입니다. 에이전트와 같은 네트워크 안에 있어서 상자 안의 화면을 localhost로 열고, 그 밖의 곳에는 닿지 않습니다. 내 PC에서는 그 화면을 그림으로만 봅니다. 상태: ${props.browser ? (stateLabel[props.browser.state] ?? props.browser.state) : "아직 만들어지지 않음"}`}
            </p>
            <div className="actions">
              <button type="button" disabled={!browserUp} onClick={openBrowser}>
                브라우저 상자 화면 열기
              </button>
            </div>
          </>
        ) : (
          <>
            <p className="muted">에이전트의 웹 화면을 내 PC 브라우저 대신 격리된 Firefox에서 봅니다. 처음 만들 때 Firefox 이미지(약 1GB)를 받습니다.</p>
            <div className="actions">
              <button type="button" onClick={() => saveSpec({ ...s, browser: true }, `${s.name} · 브라우저 상자 만들기`)}>
                브라우저 상자 만들기
              </button>
            </div>
          </>
        )}
      </section>

      <section className="web-card" data-testid="agent-ports">
        <h3>포트</h3>
        <p className="muted">
          상자 안 프로그램의 포트를 내 PC의 같은 번호(쓰이고 있으면 다음 빈 번호)로 엽니다. 이 PC에서만(127.0.0.1) 열리고, 상자를 다시 만들지 않고 바로 열리고 닫힙니다. BoxForge가 켜져 있는 동안 열려
          있습니다.
        </p>
        {ports.length > 0 && (
          <table className="grid">
            <thead>
              <tr>
                <th>상자 안</th>
                <th>{remote() ? "열린 곳" : "내 PC"}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {ports.map((p) => (
                <tr key={p.port}>
                  <td className="mono">localhost:{p.port}</td>
                  <td className="mono">{remote() ? (p.shared ? `https://${location.hostname}:${p.shared}` : "아직 안 엶") : p.local ? `127.0.0.1:${p.local}` : "닫힘"}</td>
                  <td className="row-actions">
                    {(p.local > 0 || remote()) && (
                      <button type="button" className="link" onClick={() => openAt(p.port)}>
                        {remote() ? "이 기기에서 열기" : "내 PC 브라우저로"}
                      </button>
                    )}
                    {s.browser && (
                      <button
                        type="button"
                        className="link"
                        disabled={!browserUp}
                        onClick={async () => {
                          if (await run(`# 브라우저 상자에서 http://127.0.0.1:${p.port}/ 열기`, () => call<number>("AgentBrowserOpen", s.name, `http://127.0.0.1:${p.port}/`)))
                            setTimeout(() => openAt(browserPort), 2500);
                        }}
                      >
                        브라우저 상자로
                      </button>
                    )}
                    <button
                      type="button"
                      className="link"
                      onClick={async () => {
                        if (await run(`# 127.0.0.1:${p.local || p.port} 닫기`, () => call("AgentPortRemove", s.name, p.port))) {
                          props.reload();
                          load();
                        }
                      }}
                    >
                      빼기
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form
          className="graph-bar"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <input aria-label="열 포트" inputMode="numeric" value={adding} placeholder="예: 3000" onChange={(e) => setAdding(e.target.value.trim())} />
          <button type="submit" disabled={!adding}>
            포트 열기
          </button>
        </form>
        {note && <p className="warn">{note}</p>}
      </section>
    </div>
  );
}

/** The gateway kept running: whether it runs, what it last said, and starting it again. */
interface GatewayCheck {
  agent: string;
  setup: boolean;
  port: number;
  listening: boolean;
}

function Gateway({ box, mine, service, run }: { box: Box; mine: Kind[]; service?: Container; run: Run }) {
  const [log, setLog] = useState("");
  const [shown, setShown] = useState(false);
  const [check, setCheck] = useState<GatewayCheck | null>(null);
  const up = service?.state === "running";
  const here = useRef<HTMLDivElement>(null);
  const read = () =>
    Promise.all([
      call<string>("AgentServiceLog", box.spec.name).then(
        (l) => setLog(l ?? ""),
        () => setLog(""),
      ),
      // Its container running isn't it ready: how far it is, seen in the box.
      up ? call<GatewayCheck>("AgentGatewayCheck", box.spec.name).then(setCheck, () => setCheck(null)) : (setCheck(null), undefined),
    ]);
  useEffect(() => void read(), [box.spec.name, service?.state]);
  // Often while it is on its way, seldom once it is ready.
  const settled = up && !!check && !check.setup && (!check.port || check.listening);
  usePoll(read, settled ? 20000 : 5000, true, [box.spec.name, service?.state], here);
  const who = mine.find((k) => k.id === check?.agent);
  // What "running" means, in words: waiting for its setup, starting, or ready.
  const [stage, tone, more] = !service
    ? ["아직 만들어지지 않음", "", ""]
    : !up
      ? [stateLabel[service.state] ?? service.state, "", service.state === "restarting" ? "켜지자마자 꺼지고 있습니다. 아래 기록에서 이유를 보세요." : ""]
      : !check
        ? ["실행 중", "running", ""]
        : check.setup
          ? ["설정을 기다리는 중", "waiting", `${who?.name ?? "에이전트"} 설정이 끝나면 저절로 켜집니다. "터미널" 탭의 "${who?.name ?? ""} 설정"으로 마치세요.`]
          : check.port && !check.listening
            ? ["켜는 중…", "waiting", `프로그램은 돌고 있고, 아직 포트 ${check.port}에서 답하지 않습니다. 처음 켤 때는 30초~1분쯤 걸립니다.`]
            : check.port
              ? ["준비됨", "running", `포트 ${check.port}에서 답하고 있습니다. 아래에서 화면을 열 수 있습니다.`]
              : ["실행 중", "running", ""];
  const locked = /recover-lock|cannot verify Gateway ownership/.test(log);
  const lines = log.trimEnd().split("\n");
  const restart = () =>
    run(`docker compose -p ${box.project} restart service`, () =>
      call("ComposeAction", {
        key: `gw-${Date.now()}`,
        project: box.project,
        files: [box.file],
        action: "restart",
        services: ["service"],
      }),
    ).then(read);
  return (
    <div ref={here} className="gateway" data-testid="agent-gateway">
      <p>
        <span className={"state " + tone} data-testid="gateway-stage">
          <span className="dot" />
          {`게이트웨이: ${stage}`}
        </span>{" "}
        <span className="muted">{service?.status}</span>
      </p>
      {more && <p className="help">{more}</p>}
      {locked && (
        <p className="warn">
          게이트웨이의 잠금이 전에 끝난 게이트웨이에게 남아 있습니다. 셸에서 openclaw gateway recover-lock 을 실행하고, 그것이 알려 주는 확인 명령(--confirm …)을 실행한 뒤 "게이트웨이 다시 켜기"를
          누르세요.
        </p>
      )}
      <div className="actions">
        <button type="button" onClick={restart}>
          게이트웨이 다시 켜기
        </button>
        <button type="button" className="link" onClick={() => setShown(!shown)}>
          {shown ? "기록 접기" : "게이트웨이 기록 보기"}
        </button>
      </div>
      {shown && <p className="help">게이트웨이가 쓴 글 그대로입니다(최근 40줄). OpenClaw는 준비되면 "[gateway] ready"라고 씁니다.</p>}
      {shown && <pre className="log-box gateway-log">{lines.slice(-40).join("\n") || "기록이 없습니다."}</pre>}
    </div>
  );
}

function ChangesTab({ box, run, showCli }: { box: Box; run: Run; showCli: (cmd: string) => void }) {
  const [data, setData] = useState<{
    git: boolean;
    since: number;
    files: { status: string; path: string }[];
  } | null>(null);
  const [error, setError] = useState("");
  const [shown, setShown] = useState<{ path: string; text: string } | null>(null);
  const read = () => {
    showCli(`docker exec ${box.project}-agent git -C /workspace status --porcelain`);
    call<typeof data>("AgentChanges", box.spec.name).then(
      (d) => (setData(d), setError("")),
      (e) => setError(e.message),
    );
  };
  useEffect(read, [box.spec.name]);
  const label: Record<string, string> = {
    M: "고침",
    A: "더함",
    D: "지움",
    R: "이름 바꿈",
    "??": "새 파일",
    changed: "바뀜",
  };
  return (
    <div className="agent-changes">
      <div className="graph-bar">
        <span className="muted">
          {data?.git
            ? "작업 폴더가 git 저장소라서, 마지막 커밋과 비교한 것입니다."
            : data
              ? `git 저장소가 아니라서, ${fmtTime(data.since * 1000)} (상자를 만들거나 마지막으로 저장한 때) 이후 바뀐 파일입니다.`
              : ""}
        </span>
        <span className="spacer" />
        <button type="button" onClick={read}>
          새로 읽기
        </button>
      </div>
      {error && <p className="warn">{error}</p>}
      {data && data.files.length === 0 && <p className="empty">바뀐 파일이 없습니다.</p>}
      <ul className="change-list" data-testid="agent-changes">
        {data?.files.map((f) => (
          <li key={f.path}>
            <span className={"change-" + (f.status === "??" ? "new" : f.status.toLowerCase())}>{label[f.status] ?? f.status}</span>
            <button
              type="button"
              className="link"
              onClick={() =>
                run(`docker exec ${box.project}-agent git -C /workspace diff -- ${f.path}`, async () =>
                  setShown({
                    path: f.path,
                    text: await call<string>("AgentDiff", box.spec.name, f.path),
                  }),
                )
              }
            >
              {f.path}
            </button>
          </li>
        ))}
      </ul>
      {shown && (
        <div className="console">
          <div className="console-head">
            <strong>{shown.path}</strong>
            <button type="button" className="link" onClick={() => setShown(null)}>
              닫기
            </button>
          </div>
          <pre className="log-box diff">
            {shown.text.split("\n").map((l, i) => (
              <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "add" : l.startsWith("-") && !l.startsWith("---") ? "del" : ""}>
                {l + "\n"}
              </span>
            ))}
          </pre>
        </div>
      )}
    </div>
  );
}

function NetworkTab({ box, run, showCli, reload }: { box: Box; run: Run; showCli: (cmd: string) => void; reload: () => void }) {
  const [list, setList] = useState<Connection[] | null>(null);
  const [allowed, setAllowed] = useState<string[]>(box.spec.allow);
  useEffect(() => {
    showCli(`docker logs --tail 5000 ${box.project}-egress`);
    let stop = false;
    let timer = 0;
    const tick = async () => {
      const c = await call<Connection[]>("AgentConnections", box.spec.name).catch(() => null);
      if (stop) return;
      if (c) setList(c);
      timer = window.setTimeout(tick, 3000);
    };
    tick();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [box.spec.name]);
  const allow = async (c: Connection) => {
    const entry = c.port === 443 || c.port === 80 ? c.host : `${c.host}:${c.port}`;
    if (await run(`echo ${entry} >> ${box.dir}/egress/allow.txt   # 프록시가 바로 다시 읽음`, () => call("AgentAllow", box.spec.name, entry))) {
      setAllowed((a) => [...a, entry]);
      reload();
    }
  };
  const blocked = (list ?? []).filter((c) => !c.ok).length;
  return (
    <div className="agent-network">
      <p className="muted">
        에이전트가 연결하려 한 주소입니다(3초마다 새로 읽음). 막힌 주소가 꼭 필요한 것이면 "허용"을 누르면 바로 열립니다. 모르는 주소는 열지 마세요.
        {blocked > 0 && ` 막힌 주소 ${blocked}곳.`}
      </p>
      {list && list.length === 0 && <p className="empty">아직 연결한 곳이 없습니다.</p>}
      {list && list.length > 0 && (
        <table className="grid" data-testid="agent-connections">
          <thead>
            <tr>
              <th>주소</th>
              <th>결과</th>
              <th>횟수</th>
              <th>마지막</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((c) => (
              <tr key={`${c.host}:${c.port}:${c.ok}`} className={c.ok ? "" : "blocked"}>
                <td className="mono">
                  {c.host}:{c.port}
                </td>
                <td>{c.ok ? "허용" : "막힘"}</td>
                <td>{c.count}</td>
                <td>{fmtTime(c.last)}</td>
                <td>
                  {!c.ok &&
                    (allowed.includes(c.host) || allowed.includes(`${c.host}:${c.port}`) ? (
                      <span className="muted">허용함</span>
                    ) : (
                      <button type="button" onClick={() => allow(c)}>
                        허용
                      </button>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SnapshotsTab({ box, run, showCli }: { box: Box; run: Run; showCli: (cmd: string) => void }) {
  const [list, setList] = useState<Snapshot[]>([]);
  const [label, setLabel] = useState("");
  const [asking, setAsking] = useState<{
    snap: Snapshot;
    what: "restore" | "remove";
  } | null>(null);
  const [working, setWorking] = useState(false);
  const load = () =>
    call<Snapshot[]>("AgentSnapshots", box.spec.name).then(
      (l) => setList(l ?? []),
      () => {},
    );
  useEffect(() => {
    showCli(`docker volume ls --filter name=${box.project}-snap-`);
    load();
  }, [box.spec.name]);
  const vol = (id: string) => `${box.project}-snap-${id}`;
  const take = async () => {
    setWorking(true);
    const ok = await run(
      `docker volume create ${box.project}-snap-<시각> && docker cp ${box.project}-agent:/workspace - | docker run --rm -i -v ${box.project}-snap-<시각>:/s alpine tar -x -C /s --strip-components=1`,
      () => call("AgentSnapshotTake", box.spec.name, label),
    );
    setWorking(false);
    if (ok) {
      setLabel("");
      load();
    }
  };
  return (
    <div className="agent-snapshots">
      <p className="muted">
        작업 폴더를 지금 상태 그대로 저장해 둡니다. 에이전트에게 큰 일을 맡기기 전에 저장하면, 결과가 마음에 들지 않을 때 그때로 되돌릴 수 있습니다. 복사본은 상자 밖(볼륨)에 있어 에이전트가 건드릴 수
        없습니다.
      </p>
      <div className="graph-bar">
        <input aria-label="저장 이름" value={label} placeholder="이름 (선택, 예: 리팩터링 전)" onChange={(e) => setLabel(e.target.value)} />
        <button type="button" className="primary" disabled={working} onClick={take}>
          {working ? "저장하는 중…" : "지금 상태 저장"}
        </button>
      </div>
      {list.length === 0 ? (
        <p className="empty">저장한 것이 없습니다.</p>
      ) : (
        <ul className="snapshot-list" data-testid="agent-snapshots">
          {list.map((s) => (
            <li key={s.id}>
              <strong>{s.label || "이름 없음"}</strong> <span className="muted">{fmtTime(s.time * 1000)}</span>
              <span className="spacer" />
              <button type="button" disabled={working} onClick={() => setAsking({ snap: s, what: "restore" })}>
                되돌리기
              </button>
              <IconButton icon="trash" label="저장한 것 지우기" tone="danger" disabled={working} onClick={() => setAsking({ snap: s, what: "remove" })} />
            </li>
          ))}
        </ul>
      )}
      {asking && (
        <Dialog title={asking.what === "restore" ? "저장한 때로 되돌리기" : "저장한 것 지우기"} onClose={() => setAsking(null)}>
          {asking.what === "restore" ? (
            <p>{`작업 폴더(${box.spec.workspace})의 지금 내용이 모두 지워지고, ${fmtTime(asking.snap.time * 1000)}${asking.snap.label ? ` "${asking.snap.label}"` : ""}에 저장한 내용으로 바뀝니다. 그 뒤에 바뀐 것은 되돌릴 수 없습니다. 지금 상태도 남기고 싶으면 먼저 "지금 상태 저장"을 하세요.`}</p>
          ) : (
            <p>{`${fmtTime(asking.snap.time * 1000)}${asking.snap.label ? ` "${asking.snap.label}"` : ""}에 저장한 복사본(볼륨 ${vol(asking.snap.id)})이 지워집니다. 작업 폴더는 그대로입니다.`}</p>
          )}
          <div className="dialog-actions">
            <button type="button" onClick={() => setAsking(null)}>
              취소
            </button>
            <button
              type="button"
              className="danger"
              onClick={async () => {
                const { snap, what } = asking;
                setAsking(null);
                setWorking(true);
                if (what === "restore")
                  await run(
                    `docker exec ${box.project}-agent find /workspace -mindepth 1 -delete && docker run --rm -v ${vol(snap.id)}:/s alpine tar -c -C /s . | docker cp - ${box.project}-agent:/workspace`,
                    () => call("AgentSnapshotRestore", box.spec.name, snap.id),
                  );
                else await run(`docker volume rm ${vol(snap.id)}`, () => call("AgentSnapshotRemove", box.spec.name, snap.id));
                setWorking(false);
                load();
              }}
            >
              {asking.what === "restore" ? "되돌리기" : "지우기"}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function KeysTab({ box, mine, run, showCli, reload }: { box: Box; mine: Kind[]; run: Run; showCli: (cmd: string) => void; reload: () => void }) {
  const suggested = [...new Set(mine.flatMap((k) => k.keys))];
  const [name, setName] = useState(suggested.find((k) => !box.keys.includes(k)) ?? "");
  const [value, setValue] = useState("");
  useEffect(() => showCli(`# ${box.dir}/secrets.env (상자 안 /run/secrets/agent_env, 값은 보이지 않음)`), [box.dir]);
  const put = async (key: string, v: string) => {
    if (await run(`# ${box.dir}/secrets.env 의 ${key} ${v ? "넣기" : "지우기"}`, () => call("AgentSetKey", box.spec.name, key, v))) {
      setValue("");
      reload();
    }
  };
  return (
    <div className="agent-keys">
      <p className="muted">
        API 키는 이 PC의 상자 설정 폴더에 나만 읽을 수 있는 파일로 두고, 상자 안에는 /run/secrets/agent_env 로만 넣습니다. 컨테이너 설정(docker inspect)과 내보내기 파일에는 들어가지 않습니다. 넣은
        키는 다시 보여 주지 않습니다. 에이전트를 다시 열면 적용됩니다. 구독 로그인을 쓰는 에이전트는 키 없이 터미널에서 로그인해도 됩니다.
      </p>
      <ul className="key-list" data-testid="agent-keys">
        {box.keys.map((k) => (
          <li key={k}>
            <span className="mono">{k}</span> <span className="muted">설정됨</span>
            <span className="spacer" />
            <IconButton icon="trash" label={`${k} 지우기`} tone="danger" onClick={() => put(k, "")} />
          </li>
        ))}
      </ul>
      <form
        className="graph-bar"
        onSubmit={(e) => {
          e.preventDefault();
          if (name && value) put(name, value);
        }}
      >
        <input aria-label="키 이름" list="agent-key-names" value={name} placeholder="예: ANTHROPIC_API_KEY" onChange={(e) => setName(e.target.value.trim())} />
        <datalist id="agent-key-names">
          {suggested.map((k) => (
            <option key={k} value={k} />
          ))}
        </datalist>
        <input aria-label="키 값" type="password" autoComplete="off" value={value} placeholder="값" onChange={(e) => setValue(e.target.value)} />
        <button type="submit" className="primary" disabled={!name || !value}>
          저장
        </button>
      </form>
    </div>
  );
}
