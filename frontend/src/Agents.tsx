import { useEffect, useMemo, useRef, useState } from "react";
import { call, on, type Container, type Run } from "./bridge";
import { pick } from "./PathPicker";
import Terminal from "./Terminal";
import { Dialog, IconButton } from "./ui";

interface Kind {
  id: string;
  name: string;
  command: string;
  keys: string[];
  hosts: string[];
  note: string;
  service?: string;
  port?: number;
}

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
  mark?: number;
}

interface Box {
  spec: Spec;
  project: string;
  file: string;
  dir: string;
  keys: string[];
}

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
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [making, setMaking] = useState<Spec | null>(null);
  const [editing, setEditing] = useState(false);
  const [opened, setOpened] = useState("");
  const [busy, setBusy] = useState("");
  const [output, setOutput] = useState<{ title: string; lines: string[] } | null>(null);
  const [visited, setVisited] = useState<string[]>([]);
  const [termCount, setTermCount] = useState<Record<string, number>>({});
  const openBox = (name: string) => {
    setOpened(name);
    setVisited((v) => (v.includes(name) ? v : [...v, name]));
  };
  const serial = useRef(0);

  const load = () => call<Box[]>("AgentBoxes").then((b) => setBoxes(b ?? []), () => {});
  useEffect(() => {
    call<{ kinds: Kind[]; presets: Record<string, string[]> }>("AgentCatalog").then((c) => {
      setKinds(c.kinds);
      setPresets(c.presets);
    });
    load();
    showCli("docker compose ls -a --filter name=bfa-");
  }, []);

  const byName = useMemo(() => new Map(containers.map((c) => [c.name, c])), [containers]);
  const part = (b: Box, p: "agent" | "egress" | "service") => byName.get(`${b.project}-${p}`);

  /** Runs one compose command on a box, its output shown as it comes. */
  const compose = async (b: Box, action: "upbuild" | "stop" | "build" | "purge", title: string) => {
    const key = `a${++serial.current}`;
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
      call("ComposeAction", { key, project: b.project, files: [b.file], action }),
    );
    off();
    setBusy("");
    setOutput((o) => (o ? { ...o, lines: o.lines.concat(ok ? "✔ 끝났습니다." : "✖ 실패했습니다. 아래 상태 표시줄에 이유가 있습니다.") } : o));
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
            AI 에이전트(Pi, Claude Code, OpenClaw 등)를 컨테이너 상자 안에서 돌립니다. 상자 안의 에이전트는 고른 작업 폴더 하나만 보고, 관리자 권한 없이,
            정한 CPU · 메모리 안에서, 허락한 주소에만 연결합니다. 무엇을 바꿨는지 보고, 저장해 둔 때로 되돌릴 수 있습니다.
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
      {making && (
        <MakeDialog
          kinds={kinds}
          presets={presets}
          initial={making}
          editing={editing}
          onClose={() => setMaking(null)}
          onSave={save}
          showCli={showCli}
        />
      )}
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
  const toggleAgent = (id: string, on: boolean) => set({ agents: on ? [...spec.agents.filter((a) => a !== id), id] : spec.agents.filter((a) => a !== id) });
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
    ports: spec.network === "none" ? [] : portList,
    readOnly: readOnly.split("\n").map((l) => l.trim()).filter(Boolean),
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
              {kinds.map((k) => (
                <label key={k.id} className="check">
                  <input type="checkbox" checked={spec.agents.includes(k.id)} onChange={(e) => toggleAgent(k.id, e.target.checked)} />
                  <span>
                    {k.name} <span className="muted">({k.command})</span>
                  </span>
                </label>
              ))}
            </div>
          )}
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
                <span className="help">고른 에이전트가 쓰는 주소가 미리 들어 있습니다. *.example.com 은 그 아래 모두, host:port 는 그 포트만 허용합니다. 나중에 "연결 기록"에서 막힌 주소를 눌러 바로 허용할 수도 있습니다.</span>
              </label>
            </>
          )}
          {spec.network !== "none" && (
            <label>
              내 PC에 열 포트 <span className="muted">(선택, 쉼표로)</span>
              <input value={ports} placeholder="예: 18789, 3000" onChange={(e) => setPorts(e.target.value)} />
              <span className="help">상자 안 프로그램의 화면(OpenClaw의 18789, 만든 웹앱 등)을 내 PC의 브라우저에서 엽니다. 이 PC에서만(127.0.0.1) 열리고 다른 기기에서는 닿지 않습니다.</span>
            </label>
          )}
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
                서비스 명령
                <input value={spec.service} onChange={(e) => set({ service: e.target.value })} />
                <span className="help">먼저 상자의 터미널에서 설정(예: openclaw onboard)을 마친 뒤 켜세요. 설정 전에는 시작하자마자 꺼질 수 있습니다.</span>
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
            늘 켜져 있는 보호: 관리자(root)가 아닌 사용자로 실행, 리눅스 특권 모두 빼기(cap_drop ALL), 권한 올리기 막기(no-new-privileges). API 키는 상자 안에서만 읽는
            파일로 넣어 컨테이너 설정(docker inspect)에 나오지 않습니다. 0은 제한 없음입니다.
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
          <button
            type="submit"
            className="primary"
            disabled={saving || !spec.name || !spec.workspace || (own ? !spec.image || !spec.command : spec.agents.length === 0)}
          >
            {editing ? "저장하고 다시 만들기" : "만들고 시작"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

type Tab = "terminal" | "changes" | "network" | "snapshots" | "keys";

/** One box: its terminal, what it changed, where it connected, saved copies and keys. */
function Control(props: {
  box: Box;
  kinds: Kind[];
  agent?: Container;
  egress?: Container;
  service?: Container;
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
  const mine = s.image ? [] : kinds.filter((k) => s.agents.includes(k.id));
  const tabs: [Tab, string][] = [
    ["terminal", "터미널"],
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
            onClick={async () => {
              if (await props.compose("build", `${s.name} · 에이전트 새 버전으로 다시 만들기`)) await props.compose("upbuild", `${s.name} · 새 버전으로 시작`);
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
      <dl className="project-meta">
        <div>
          <dt>에이전트</dt>
          <dd>{s.image ? `${s.image} (${s.command})` : mine.map((k) => k.name).join(", ")}</dd>
        </div>
        <div>
          <dt>작업 폴더</dt>
          <dd>{s.workspace} → /workspace</dd>
        </div>
        <div>
          <dt>한도</dt>
          <dd>
            {`CPU ${s.cpus || "제한 없음"} · 메모리 ${s.memory ? `${s.memory} GB` : "제한 없음"} · 프로세스 ${s.pids || "제한 없음"}`}
          </dd>
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
            <TermTab box={box} mine={mine} run={run} showCli={showCli} onCount={props.onTerms} />
          </div>
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
function TermTab({ box, mine, run, showCli, onCount }: { box: Box; mine: Kind[]; run: Run; showCli: (cmd: string) => void; onCount: (n: number) => void }) {
  const first = box.spec.image ? "main" : (mine[0]?.id ?? "shell");
  const serial = useRef(0);
  const nameOf = (which: string) => (which === "shell" ? "셸" : which === "main" ? (box.spec.command ?? "") : (mine.find((k) => k.id === which)?.name ?? which));
  const make = (which: string, list: Term[]): Term => {
    const same = list.filter((t) => t.which === which).length;
    return { key: ++serial.current, which, label: same ? `${nameOf(which)} ${same + 1}` : nameOf(which), ended: false };
  };
  const [terms, setTerms] = useState<Term[]>(() => [make(first, [])]);
  const [active, setActive] = useState(terms[0]?.key ?? 0);
  useEffect(() => onCount(terms.length), [terms.length]);

  const add = (which: string) => {
    const t = make(which, terms);
    setTerms([...terms, t]);
    setActive(t.key);
  };
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
  const cliOf = (which: string) => `docker exec -it ${box.project}-agent sh /opt/boxforge/run ${which === "shell" ? "shell" : which === "main" ? (box.spec.command ?? "") : (mine.find((k) => k.id === which)?.command ?? "")}`;

  // Programs from terminals closed outside the app (a window shut, an older
  // BoxForge): the same agent opened again beside one may fail.
  const [left, setLeft] = useState<string[]>([]);
  const look = () => call<string[]>("AgentLeftovers", box.spec.name).then((l) => setLeft(l ?? []), () => setLeft([]));
  const stopLeft = async () => {
    if (await run(`docker exec ${box.project}-agent kill <이전 터미널의 프로그램>`, () => call("AgentStopLeftovers", box.spec.name))) look();
  };

  const opener = (which: string) => (
    <>
      {box.spec.image && which === "main" && box.spec.command}
      {which !== "main" && nameOf(which)}
    </>
  );
  return (
    <div className={"agent-term" + (big ? " big" : "")} style={{ ["--term-h" as string]: `${height}px` }}>
      <div className="graph-bar">
        <span className="muted">새 터미널:</span>
        {(box.spec.image ? ["main"] : mine.map((k) => k.id)).concat("shell").map((w) => (
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
      {left.length > 0 && (
        <div className="note-box" role="alert" data-testid="agent-leftovers">
          <strong>{`닫은 터미널에서 시작한 프로그램이 아직 상자 안에서 돌고 있습니다 (${left.length}개).`}</strong>
          <span className="sub">같은 에이전트를 하나 더 열면 실패할 수 있습니다(OpenClaw의 "The CLI command failed" 등). 쓰지 않는 것이면 끄세요. 여기 탭에 열린 터미널은 그대로 둡니다.</span>
          <code className="leftover-list">{left.join("\n")}</code>
          <span>
            <button type="button" className="primary" onClick={stopLeft}>
              모두 끄기
            </button>
          </span>
        </div>
      )}
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
      {terms.length === 0 && <p className="empty">열린 터미널이 없습니다. 위의 "새 터미널"에서 여세요.</p>}
      {terms.map((t) => (
        <div key={t.key} hidden={t.key !== active} className="term-pane" data-testid="term-pane">
          <Terminal
            id={box.project + "-agent"}
            name={box.project + "-agent"}
            showCli={showCli}
            run={run}
            command={cliOf(t.which)}
            onEnd={() => setTerms((all) => all.map((x) => (x.key === t.key ? { ...x, ended: true } : x)))}
            open={async (cols, rows) => {
              const session = await call<string>("AgentTermOpen", box.spec.name, t.which, cols, rows);
              look();
              return session;
            }}
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

function ChangesTab({ box, run, showCli }: { box: Box; run: Run; showCli: (cmd: string) => void }) {
  const [data, setData] = useState<{ git: boolean; since: number; files: { status: string; path: string }[] } | null>(null);
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
  const label: Record<string, string> = { M: "고침", A: "더함", D: "지움", R: "이름 바꿈", "??": "새 파일", changed: "바뀜" };
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
              onClick={() => run(`docker exec ${box.project}-agent git -C /workspace diff -- ${f.path}`, async () => setShown({ path: f.path, text: await call<string>("AgentDiff", box.spec.name, f.path) }))}
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
  const [asking, setAsking] = useState<{ snap: Snapshot; what: "restore" | "remove" } | null>(null);
  const [working, setWorking] = useState(false);
  const load = () => call<Snapshot[]>("AgentSnapshots", box.spec.name).then((l) => setList(l ?? []), () => {});
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
        작업 폴더를 지금 상태 그대로 저장해 둡니다. 에이전트에게 큰 일을 맡기기 전에 저장하면, 결과가 마음에 들지 않을 때 그때로 되돌릴 수 있습니다. 복사본은 상자 밖(볼륨)에 있어
        에이전트가 건드릴 수 없습니다.
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
        API 키는 이 PC의 상자 설정 폴더에 나만 읽을 수 있는 파일로 두고, 상자 안에는 /run/secrets/agent_env 로만 넣습니다. 컨테이너 설정(docker inspect)과 내보내기 파일에는 들어가지
        않습니다. 넣은 키는 다시 보여 주지 않습니다. 에이전트를 다시 열면 적용됩니다. 구독 로그인을 쓰는 에이전트는 키 없이 터미널에서 로그인해도 됩니다.
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
