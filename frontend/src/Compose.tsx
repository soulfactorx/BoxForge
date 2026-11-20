import { useEffect, useMemo, useRef, useState } from "react";
import { call, on, openURL, type Container, type Run } from "./bridge";
import { published } from "./Containers";
import { isUp, stateLabel } from "./format";
import { Dialog, IconButton } from "./ui";

interface Project {
  name: string;
  workDir: string;
  files: string[];
  members: Container[];
}

interface Props {
  containers: Container[];
  run: Run;
  onOpen: (containerId: string) => void;
}

type Action = "up" | "down" | "stop" | "start" | "restart" | "pull";
const doing: Record<Action, string> = {
  up: "올리는 중", down: "내리는 중", stop: "중지하는 중", start: "시작하는 중", restart: "재시작하는 중", pull: "이미지 받는 중",
};

const naming: Record<Action, string> = { up: "올리기", down: "내리기", stop: "중지", start: "시작", restart: "재시작", pull: "이미지 받기" };

const dirname = (file: string) => file.replace(/[\\/][^\\/]*$/, "");

export default function Compose({ containers, run, onOpen }: Props) {
  const [version, setVersion] = useState<string | null>(null);
  const [missing, setMissing] = useState("");
  const [busy, setBusy] = useState<{ key: string; text: string } | null>(null);
  const [output, setOutput] = useState<{ title: string; lines: string[] } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
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
  const compose = async (title: string, command: string, req: { project: string; workDir: string; files: string[]; action: Action }) => {
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

  const act = (p: Project, action: Action) =>
    compose(`${p.name} · ${naming[action]}`, `docker compose -p ${p.name} ${action === "up" ? "up -d" : action}`, {
      project: p.name, workDir: p.workDir, files: p.files, action,
    });

  const openFile = async () => {
    const file = (opening ?? "").trim();
    setOpening(null);
    if (!file) return;
    await compose(`${file} · 올리기`, `docker compose -f ${file} up -d`, { project: "", workDir: dirname(file), files: [file], action: "up" });
  };

  const browse = async () => {
    try {
      const file = await call<string>("PickComposeFile");
      if (file) setOpening(file);
    } catch {
      // No file dialog in a browser: the path is typed instead.
    }
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
          <pre ref={box} className="log-box">
            {output.lines.length ? output.lines.join("\n") : "…"}
          </pre>
        </div>
      )}

      {projects.length === 0 ? (
        <p className="empty">Compose 프로젝트가 없습니다. "Compose 파일 열기"로 compose.yaml을 골라 올려 보세요.</p>
      ) : (
        projects.map((p) => {
          const up = p.members.filter(isUp).length;
          const mine = busy?.key === p.name;
          return (
            <article key={p.name} className="project" data-testid={`project-${p.name}`}>
              <header>
                <div className="project-title">
                  <h2>{p.name}</h2>
                  <span className={"state " + (up === p.members.length ? "running" : up > 0 ? "paused" : "")}>
                    <span className="dot" />
                    {mine ? busy.text + "…" : `${p.members.length}개 중 ${up}개 실행`}
                  </span>
                </div>
                <div className="actions">
                  <IconButton icon="play" label="올리기 (파일대로 만들고 시작)" tone="go" disabled={off || !!busy} onClick={() => act(p, "up")} />
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
