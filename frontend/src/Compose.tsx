import type { KubeMove } from "./Kubernetes";
import { lang, translate } from "./i18n";
import { pick } from "./PathPicker";
import { useEffect, useMemo, useRef, useState } from "react";
import { call, on, openURL, type Container, type Run } from "./bridge";
import { published } from "./Containers";
import { isUp, stateLabel } from "./format";
import ComposeProject, { type Project } from "./ComposeProject";
import { Dialog, IconButton, Progress } from "./ui";

interface Props {
  containers: Container[];
  run: Run;
  showCli: (cmd: string) => void;
  onOpen: (containerId: string) => void;
  onKube?: (m: KubeMove) => void;
}

type Action = "up" | "down" | "stop" | "start" | "restart" | "pull";
const doing: Record<Action, string> = {
  up: "올리는 중", down: "내리는 중", stop: "중지하는 중", start: "시작하는 중", restart: "재시작하는 중", pull: "이미지 받는 중",
};

const naming: Record<Action, string> = { up: "올리기", down: "내리기", stop: "중지", start: "시작", restart: "재시작", pull: "이미지 받기" };

const dirname = (file: string) => file.replace(/[\\/][^\\/]*$/, "");

// What Compose says of each thing it makes, and which words mean that
// thing is done.
const stepLine = /^\s*(Container|Network|Volume|Image)?\s*(\S+)\s+(Pulling|Pulled|Creating|Created|Starting|Started|Running|Recreate|Recreated|Stopping|Stopped|Removing|Removed|Waiting|Healthy|Built|Building|Error)\b/;
const finished = new Set(["Pulled", "Created", "Started", "Running", "Recreated", "Stopped", "Removed", "Healthy", "Built"]);
const doingNow: Record<string, string> = {
  Pulling: "이미지를 내려받는 중",
  Creating: "만드는 중",
  Starting: "시작하는 중",
  Recreate: "다시 만드는 중",
  Stopping: "멈추는 중",
  Removing: "지우는 중",
  Waiting: "준비되기를 기다리는 중",
  Building: "빌드하는 중",
};

/** Where a compose command stands: how many of its things are done, what it is on, how long it has taken. */
function Progressing({ lines, busy }: { lines: string[]; busy: boolean }) {
  const [started] = useState(() => Date.now());
  const [now, setNow] = useState(Date.now());
  const [ended, setEnded] = useState(0);
  useEffect(() => {
    if (!busy) return setEnded(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [busy]);
  const state = new Map<string, string>();
  for (const l of lines) {
    const m = stepLine.exec(l);
    if (m) state.set((m[1] ?? "") + " " + m[2], m[3]);
  }
  const total = state.size;
  const done = [...state.values()].filter((s) => finished.has(s)).length;
  const current = [...state.entries()].reverse().find(([, s]) => !finished.has(s) && s !== "Error");
  const failed = !busy && lines.some((l) => l.startsWith("✖"));
  const seconds = Math.max(0, Math.round(((busy ? now : ended || now) - started) / 1000));
  return (
    <div className={"compose-progress" + (failed ? " failed" : !busy ? " ok" : "")} data-testid="compose-progress">
      <span className="compose-progress-text">
        {busy ? <span className="spinner" /> : <span className="setup-mark">{failed ? "✖" : "✔"}</span>}
        <strong>{busy ? (current ? `${current[0].trim().split(" ").pop()} ${doingNow[current[1]] ?? current[1]}` : "준비하는 중") : failed ? "실패했습니다" : "끝났습니다"}</strong>
        {total > 0 && (
          <span className="muted">
            {total}개 중 {done}개 완료
          </span>
        )}
        <span className="muted">{seconds}초</span>
      </span>
      <Progress percent={!busy && !failed ? 100 : total > 0 ? Math.round((done * 100) / total) : -1} />
      {busy && current?.[1] === "Pulling" && <span className="sub">이미지를 처음 받을 때는 크기에 따라 몇 분 걸릴 수 있습니다.</span>}
    </div>
  );
}

// A note in a compose file ("# …", which Compose skips), in the language
// of the screens: the file is the user's to keep.
const c = (note: string) => "# " + (lang() === "en" ? translate(note) : note);

// Starting points for a new project.
const starters: { id: string; title: string; about: string; text: string }[] = [
  {
    id: "web",
    title: "웹 서버 하나",
    about: "nginx 하나를 띄웁니다. 올린 뒤 브라우저에서 localhost:8080 으로 엽니다.",
    text: `services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"          ${c("내 PC의 8080 → 컨테이너의 80")}
    restart: unless-stopped
`,
  },
  {
    id: "web-db",
    title: "웹 + 데이터베이스",
    about: "웹 서버와 PostgreSQL. 데이터베이스의 내용은 볼륨에 남고, 웹은 데이터베이스가 켜진 뒤에 시작합니다. 비밀번호는 꼭 바꾸세요.",
    text: `services:
  web:
    image: nginx:alpine
    ports:
      - "8080:80"
    depends_on:
      - db                 ${c("db가 먼저 켜집니다")}
    restart: unless-stopped
  db:
    image: postgres:17
    environment:
      - POSTGRES_PASSWORD=change-me   ${c("꼭 바꾸세요")}
    volumes:
      - dbdata:/var/lib/postgresql/data   ${c("컨테이너를 지워도 남는 데이터")}
    restart: unless-stopped

volumes:
  dbdata:
`,
  },
  {
    id: "wordpress",
    title: "WordPress",
    about: "WordPress와 MariaDB. 올린 뒤 localhost:8080 에서 설치 화면이 열립니다. 비밀번호 두 곳은 같은 값으로 바꾸세요.",
    text: `services:
  wordpress:
    image: wordpress:latest
    ports:
      - "8080:80"
    environment:
      - WORDPRESS_DB_HOST=db
      - WORDPRESS_DB_USER=wordpress
      - WORDPRESS_DB_PASSWORD=change-me   ${c("아래 MARIADB_PASSWORD 와 같게")}
      - WORDPRESS_DB_NAME=wordpress
    volumes:
      - site:/var/www/html
    depends_on:
      - db
    restart: unless-stopped
  db:
    image: mariadb:11
    environment:
      - MARIADB_DATABASE=wordpress
      - MARIADB_USER=wordpress
      - MARIADB_PASSWORD=change-me
      - MARIADB_RANDOM_ROOT_PASSWORD=1
    volumes:
      - dbdata:/var/lib/mysql
    restart: unless-stopped

volumes:
  site:
  dbdata:
`,
  },
  {
    id: "blank",
    title: "거의 빈 파일",
    about: "서비스 하나만 적힌 파일입니다. 이미지 이름을 바꾸고, 올린 뒤 구조 그림에서 서비스를 더하세요.",
    text: `services:
  app:
    image: nginx:alpine    ${c("실행할 이미지로 바꾸세요")}
`,
  },
];

export default function Compose({ containers, run, showCli, onOpen, onKube }: Props) {
  const [opened, setOpened] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);
  const [missing, setMissing] = useState("");
  const [busy, setBusy] = useState<{ key: string; text: string } | null>(null);
  const [output, setOutput] = useState<{ title: string; lines: string[] } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  // A new project being written: its folder, and the file's text.
  const [making, setMaking] = useState<{ dir: string; kind: string; text: string; error: string } | null>(null);

  const pickFolder = async () => {
    const dir = await pick("folder", "프로젝트 폴더 고르기", "PickFolder");
    if (dir) setMaking((m) => m && { ...m, dir, error: "" });
  };

  // The ports the new file would take on this PC, and which are taken.
  const wanted = useMemo(() => [...new Set([...(making?.text ?? "").matchAll(/^\s*-\s*["']?(?:[\d.]+:)?(\d+):\d+/gm)].map((m) => +m[1]))], [making?.text]);
  const [taken, setTaken] = useState<number[]>([]);
  useEffect(() => {
    if (wanted.length === 0) return setTaken([]);
    let stale = false;
    call<number[]>("PortsInUse", wanted).then((t) => !stale && setTaken(t ?? []), () => {});
    return () => {
      stale = true;
    };
  }, [wanted.join()]);
  // Moves each taken port to the next free one above it.
  const freePorts = async () => {
    if (!making) return;
    let text = making.text;
    for (const p of taken) {
      const tries = Array.from({ length: 20 }, (_, i) => p + 1 + i).filter((n) => !wanted.includes(n));
      const busyPorts = await call<number[]>("PortsInUse", tries).catch(() => [] as number[]);
      const free = tries.find((n) => !busyPorts.includes(n));
      if (free) text = text.replace(new RegExp(`(^\\s*-\\s*["']?(?:[\\d.]+:)?)${p}(:\\d+)`, "gm"), `$1${free}$2`);
    }
    setMaking({ ...making, text });
  };

  const create = async () => {
    if (!making) return;
    let file = "";
    try {
      file = await call<string>("ComposeCreate", making.dir, making.text);
    } catch (e: any) {
      setMaking({ ...making, error: e.message });
      return;
    }
    setMaking(null);
    await compose(`${file} · 올리기`, `docker compose -f ${file} up -d`, { project: "", workDir: dirname(file), files: [file], action: "up" });
  };
  const [downing, setDowning] = useState<Project | null>(null);
  const [viewing, setViewing] = useState<{ file: string; text: string } | null>(null);
  const [fileError, setFileError] = useState("");
  const serial = useRef(0);
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    call<string>("ComposeVersion").then(setVersion, (e) => setMissing(e.message));
  }, []);

  const projects = useMemo(() => {
    const map = new Map<string, Project>();
    for (const c of containers) {
      if (!c.project) continue;
      let p = map.get(c.project);
      if (!p) {
        p = {
          name: c.project,
          workDir: c.labels?.["com.docker.compose.project.working_dir"] ?? "",
          files: (c.labels?.["com.docker.compose.project.config_files"] ?? "").split(",").filter(Boolean),
          members: [],
        };
        map.set(c.project, p);
      }
      p.members.push(c);
    }
    const list = [...map.values()];
    list.forEach((p) => p.members.sort((a, b) => a.service.localeCompare(b.service) || a.name.localeCompare(b.name)));
    return list.sort((a, b) => a.name.localeCompare(b.name));
  }, [containers]);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [output]);

  // Runs one compose command, its output shown as it comes.
  const compose = async (title: string, command: string, req: { project: string; workDir: string; files: string[]; action: Action; services?: string[] }) => {
    if (busy) return;
    const key = `c${++serial.current}`;
    setBusy({ key: req.project || req.files[0], text: doing[req.action] });
    setOutput({ title, lines: [] });
    const off = on("compose", (l: { key: string; line: string }) => {
      if (l.key === key) setOutput((o) => (o ? { ...o, lines: o.lines.concat(l.line).slice(-500) } : o));
    });
    const ok = await run(command, () => call("ComposeAction", { key, ...req }));
    off();
    setBusy(null);
    setOutput((o) => (o ? { ...o, lines: o.lines.concat(ok ? "✔ 끝났습니다." : "✖ 실패했습니다. 아래 상태 표시줄에 이유가 있습니다.") } : o));
  };

  const act = (p: Project, action: Action, services: string[] = []) =>
    compose(
      `${p.name}${services.length ? " / " + services.join(", ") : ""} · ${naming[action]}`,
      `docker compose -p ${p.name} ${action === "up" ? "up -d" : action}${services.length ? " " + services.join(" ") : ""}`,
      { project: p.name, workDir: p.workDir, files: p.files, action, services },
    );

  const openFile = async () => {
    const file = (opening ?? "").trim();
    setOpening(null);
    if (!file) return;
    await compose(`${file} · 올리기`, `docker compose -f ${file} up -d`, { project: "", workDir: dirname(file), files: [file], action: "up" });
  };

  const browse = async () => {
    const file = await pick("file", "Compose 파일 고르기", "PickComposeFile", [".yml", ".yaml"]);
    if (file) setOpening(file);
  };

  const view = async (file: string) => {
    setFileError("");
    try {
      setViewing({ file, text: await call<string>("ComposeFile", file) });
    } catch (e: any) {
      setFileError(`${file}: ${e.message}`);
    }
  };

  const off = !version;
  return (
    <section>
      <header className="page-head">
        <h1>Compose</h1>
        {version && <span className="muted">Compose {version}</span>}
        <span className="spacer" />
        <button disabled={off || !!busy} onClick={() => setMaking({ dir: "", kind: starters[0].id, text: starters[0].text, error: "" })}>
          새로 만들기
        </button>
        <button className="primary" disabled={off || !!busy} onClick={() => setOpening("")}>
          Compose 파일 열기
        </button>
      </header>
      <p className="lead">
        Compose는 여러 컨테이너를 파일 하나(<code>compose.yaml</code>)에 적어 두고 한 번에 올리고 내리는 방법입니다. 한 묶음을
        프로젝트라고 부릅니다.
      </p>
      {missing && (
        <div className="banner" role="alert">
          <strong>이 PC에서 docker compose 명령을 찾지 못했습니다.</strong> 프로젝트를 보는 것은 되지만 올리기·내리기는 할 수 없습니다.
          컨테이너 화면에서 개별 컨테이너를 시작·중지할 수는 있습니다.
        </div>
      )}
      {fileError && (
        <p className="warn" role="alert">
          {fileError}
        </p>
      )}

      {output && (
        <div className="console" data-testid="compose-output">
          <div className="console-head">
            <strong>{output.title}</strong>
            {!busy && (
              <button className="link" onClick={() => setOutput(null)}>
                닫기
              </button>
            )}
          </div>
          <Progressing key={output.title} lines={output.lines} busy={!!busy} />
          <pre ref={box} className="log-box">
            {output.lines.length ? output.lines.join("\n") : "…"}
          </pre>
        </div>
      )}

      {opened && projects.find((p) => p.name === opened) ? (
        <ComposeProject
          project={projects.find((p) => p.name === opened)!}
          run={run}
          showCli={showCli}
          busy={off || !!busy}
          act={act}
          onDown={() => setDowning(projects.find((p) => p.name === opened)!)}
          onOpen={onOpen}
          onBack={() => setOpened(null)}
          onKube={onKube}
        />
      ) : projects.length === 0 ? (
        <p className="empty">Compose 프로젝트가 없습니다. "Compose 파일 열기"로 compose.yaml을 골라 올려 보세요.</p>
      ) : (
        projects.map((p) => {
          const up = p.members.filter(isUp).length;
          const mine = busy?.key === p.name;
          return (
            <article key={p.name} className="project" data-testid={`project-${p.name}`}>
              <header>
                <div className="project-title">
                  <h2>
                    <button className="link name" title="구조 · 서비스 · 파일 · 로그 보기" onClick={() => setOpened(p.name)}>
                      {p.name}
                    </button>
                  </h2>
                  <span className={"state " + (up === p.members.length ? "running" : up > 0 ? "paused" : "")}>
                    <span className="dot" />
                    {mine ? busy.text + "…" : `${p.members.length}개 중 ${up}개 실행`}
                  </span>
                </div>
                <div className="actions">
                  <button onClick={() => setOpened(p.name)}>
                    자세히
                  </button>
                  <IconButton
                    icon="play"
                    label={up === p.members.length ? "모두 실행 중입니다 (파일을 고쳤다면 자세히 → 올리기로 적용)" : "올리기 (파일대로 만들고 시작)"}
                    tone="go"
                    disabled={off || !!busy || up === p.members.length}
                    onClick={() => act(p, "up")}
                  />
                  <IconButton icon="restart" label="재시작" disabled={off || !!busy || up === 0} onClick={() => act(p, "restart")} />
                  <IconButton icon="stop" label="중지 (컨테이너는 남김)" tone="danger" disabled={off || !!busy || up === 0} onClick={() => act(p, "stop")} />
                  <IconButton icon="download" label="이미지 새로 받기" disabled={off || !!busy} onClick={() => act(p, "pull")} />
                  <IconButton icon="trash" label="내리기 (컨테이너와 네트워크 삭제)" tone="danger" disabled={off || !!busy} onClick={() => setDowning(p)} />
                </div>
              </header>
              <p className="project-files muted">
                {p.files.length === 0
                  ? "compose 파일 위치를 알 수 없습니다"
                  : p.files.map((f) => (
                      <button key={f} className="link" title="파일 내용 보기" onClick={() => view(f)}>
                        {f}
                      </button>
                    ))}
              </p>
              <table className="grid">
                <tbody>
                  {p.members.map((c) => (
                    <tr key={c.id} data-testid={`service-${c.service}`}>
                      <td>
                        <strong>{c.service}</strong>
                        <span className="sub">{c.image}</span>
                      </td>
                      <td>
                        <span className={"state " + (c.failed ? "failed" : c.state)}>
                          <span className="dot" />
                          {c.failed ? "실패" : stateLabel[c.state] ?? c.state}
                        </span>
                      </td>
                      <td className="ports">
                        {published(c).length === 0
                          ? "—"
                          : published(c).map((port) => (
                              <button key={port.public} className="link port" onClick={() => openURL(`http://localhost:${port.public}`)}>
                                {port.public}→{port.private}
                              </button>
                            ))}
                      </td>
                      <td className="actions">
                        <button className="link" onClick={() => onOpen(c.id)}>
                          {c.name}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
          );
        })
      )}

      {making && (
        <Dialog title="새 Compose 프로젝트" onClose={() => setMaking(null)} wide>
          <p>
            폴더 하나에 <code>compose.yaml</code>을 만들고 올립니다. 폴더 이름이 프로젝트 이름이 됩니다. 아래의 글은 시작용이니 그대로 써도 되고, 올린 뒤에 구조 그림이나
            "파일" 탭에서 고칠 수 있습니다.
          </p>
          <form
            className="run-form"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <label>
              폴더
              <div className="pair">
                <input autoFocus className="field" aria-label="프로젝트 폴더" placeholder="예: C:\projects\shop 또는 /home/me/shop" value={making.dir} onChange={(e) => setMaking({ ...making, dir: e.target.value, error: "" })} />
                <button type="button" onClick={pickFolder}>
                  찾아보기
                </button>
              </div>
              <span className="help">없는 폴더면 새로 만듭니다. 이미 compose 파일이 있는 폴더에는 만들지 않습니다.</span>
            </label>
            <fieldset className="plain">
              <legend>무엇으로 시작할까요?</legend>
              <div className="recipe-chips">
                {starters.map((s) => (
                  <button key={s.id} type="button" className={"chip" + (making.kind === s.id ? " on" : "")} onClick={() => setMaking({ ...making, kind: s.id, text: s.text })}>
                    {s.title}
                  </button>
                ))}
              </div>
              <span className="help">{starters.find((s) => s.id === making.kind)?.about}</span>
            </fieldset>
            <label>
              compose.yaml
              <textarea className="editor starter" aria-label="새 compose 파일 내용" spellCheck={false} rows={14} value={making.text} onChange={(e) => setMaking({ ...making, text: e.target.value })} />
            </label>
            {taken.length > 0 && (
              <p className="warn" data-testid="ports-taken">
                내 PC의 {taken.join(", ")}번 포트는 이미 다른 프로그램이나 컨테이너가 쓰고 있어서, 이대로 올리면 실패합니다.{" "}
                <button type="button" className="link" onClick={freePorts}>
                  비어 있는 포트로 바꾸기
                </button>
              </p>
            )}
            {making.error && (
              <p className="warn" role="alert">
                {making.error}
              </p>
            )}
            <div className="dialog-actions">
              <button type="button" onClick={() => setMaking(null)}>
                취소
              </button>
              <button className="primary" type="submit" disabled={!making.dir.trim() || !making.text.trim()}>
                만들고 올리기
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {opening !== null && (
        <Dialog title="Compose 파일 열기" onClose={() => setOpening(null)}>
          <p>compose 파일을 고르면 그 안에 적힌 컨테이너들을 만들고 시작합니다. 필요한 이미지는 먼저 내려받습니다.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              openFile();
            }}
          >
            <div className="pair">
              <input autoFocus className="field" aria-label="compose 파일 경로" placeholder="예: C:\projects\shop\compose.yaml" value={opening} onChange={(e) => setOpening(e.target.value)} />
              <button type="button" onClick={browse}>
                찾아보기
              </button>
            </div>
            <div className="dialog-actions">
              <button type="button" onClick={() => setOpening(null)}>
                취소
              </button>
              <button className="primary" type="submit" disabled={!opening.trim()}>
                올리기
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {downing && (
        <Dialog title="프로젝트 내리기" onClose={() => setDowning(null)}>
          <p>
            <strong>{downing.name}</strong> 프로젝트의 컨테이너 {downing.members.length}개와 프로젝트가 만든 네트워크를 삭제합니다. 컨테이너
            안에서 바뀐 파일은 사라집니다.
          </p>
          <p className="note-plain">볼륨은 지우지 않습니다. 데이터베이스 같은 볼륨의 데이터는 남고, 다시 올리면 이어서 씁니다.</p>
          <div className="dialog-actions">
            <button onClick={() => setDowning(null)}>취소</button>
            <button
              className="danger solid"
              onClick={() => {
                const p = downing;
                setDowning(null);
                act(p, "down");
              }}
            >
              내리기
            </button>
          </div>
        </Dialog>
      )}

      {viewing && (
        <Dialog title={viewing.file} onClose={() => setViewing(null)} wide>
          <pre className="log-box yaml" data-testid="compose-file">
            {viewing.text}
          </pre>
          <div className="dialog-actions">
            <button onClick={() => setViewing(null)}>닫기</button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
