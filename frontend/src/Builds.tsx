import { useEffect, useMemo, useRef, useState } from "react";
import { call, on, type Run } from "./bridge";
import { shq } from "./format";
import { Dialog } from "./ui";

interface Step {
  id: string;
  name: string;
  status: "running" | "done" | "cached" | "error";
  time: string;
  logs: string[];
}

/**
 * Reads BuildKit's plain progress: every line starts "#<n> " and belongs to
 * step n. The first such line names the step; "DONE 0.3s", "CACHED" and
 * "ERROR: …" end it; "0.123 text" is the step's own output.
 */
export function parseSteps(lines: string[]): Step[] {
  const steps = new Map<string, Step>();
  for (const line of lines) {
    const m = /^#(\d+) (.*)$/.exec(line);
    if (!m) continue;
    const [, id, rest] = m;
    // "#0 building with … instance" is the tool announcing itself, not a step.
    if (id === "0") continue;
    let s = steps.get(id);
    if (!s) {
      s = { id, name: rest, status: "running", time: "", logs: [] };
      steps.set(id, s);
      continue;
    }
    const done = /^DONE (\S+)/.exec(rest);
    if (done) {
      s.status = "done";
      s.time = done[1];
    } else if (rest === "CACHED") {
      s.status = "cached";
    } else if (rest.startsWith("ERROR")) {
      s.status = "error";
      s.logs.push(rest);
    } else if (rest !== s.name && rest !== "...") {
      s.logs.push(rest.replace(/^\d+\.\d+ /, ""));
    }
  }
  return [...steps.values()];
}

interface Current {
  key: string;
  tag: string;
  lines: string[];
  state: "running" | "ok" | "failed";
  error: string;
  seconds: number;
}

interface Preset {
  name: string;
  context: string;
  dockerfile: string;
  tag: string;
  args: string;
}

interface Past {
  tag: string;
  context: string;
  ok: boolean;
  seconds: number;
  at: number;
}

const stepLabel: Record<Step["status"], string> = { running: "진행 중", done: "완료", cached: "캐시 사용", error: "실패" };
const saved = (() => {
  try {
    return JSON.parse(localStorage.getItem("boxforge.build") ?? "{}");
  } catch {
    return {};
  }
})();

export default function Builds({ run, onRun }: { run: Run; onRun: (image: string) => void }) {
  const [cli, setCli] = useState<string | null>(null);
  const [missing, setMissing] = useState("");
  const [context, setContext] = useState<string>(saved.context ?? "");
  const [dockerfile, setDockerfile] = useState<string>(saved.dockerfile ?? "");
  const [tag, setTag] = useState<string>(saved.tag ?? "");
  const [args, setArgs] = useState<string>(saved.args ?? "");
  const [noCache, setNoCache] = useState(false);
  const [pull, setPull] = useState(false);
  const [current, setCurrent] = useState<Current | null>(null);
  const [past, setPast] = useState<Past[]>([]);
  const [raw, setRaw] = useState(false);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ text: string; original: string; isNew: boolean } | null>(null);
  const [note, setNote] = useState("");
  const [pruning, setPruning] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [preset, setPreset] = useState("");
  const [naming, setNaming] = useState<string | null>(null);
  const serial = useRef(0);

  useEffect(() => {
    call<string>("DockerCLI").then(setCli, (e) => setMissing(e.message));
    call<string>("Setting", "build.presets").then((raw) => {
      try {
        setPresets(JSON.parse(raw || "[]"));
      } catch {
        // An unreadable list is the same as none.
      }
    }, () => {});
  }, []);

  const keep = (list: Preset[]) => {
    setPresets(list);
    call("SetSetting", "build.presets", JSON.stringify(list)).catch(() => {});
  };

  const fill = (p: { context: string; dockerfile: string; tag: string; args: string }) => {
    setContext(p.context);
    setDockerfile(p.dockerfile);
    setTag(p.tag);
    setArgs(p.args);
    setNoCache(false);
    setPull(false);
  };

  // A clean slate: the form emptied and the last build's output put away.
  const startNew = () => {
    fill({ context: "", dockerfile: "", tag: "", args: "" });
    setPreset("");
    setCurrent(null);
    setNote("");
  };

  const choose = (name: string) => {
    setPreset(name);
    const p = presets.find((x) => x.name === name);
    if (p) {
      fill(p);
      setCurrent(null);
      setNote("");
    }
  };

  const savePreset = () => {
    const name = (naming ?? "").trim();
    setNaming(null);
    if (!name) return;
    keep([...presets.filter((p) => p.name !== name), { name, context, dockerfile, tag, args }].sort((a, b) => a.name.localeCompare(b.name)));
    setPreset(name);
    setNote(`"${name}" 설정을 저장했습니다. 다음에 목록에서 고르면 그대로 채워집니다.`);
  };

  const dropPreset = () => {
    keep(presets.filter((p) => p.name !== preset));
    setNote(`"${preset}" 설정을 지웠습니다. 폴더와 이미지는 그대로입니다.`);
    setPreset("");
  };

  useEffect(() => {
    try {
      localStorage.setItem("boxforge.build", JSON.stringify({ context, dockerfile, tag, args }));
    } catch {
      // Remembering the form is a convenience only.
    }
  }, [context, dockerfile, tag, args]);

  const argList = args.split("\n").map((l) => l.trim()).filter((l) => l.includes("="));
  const command = [
    "docker build",
    tag.trim() && `-t ${shq(tag.trim())}`,
    dockerfile.trim() && `-f ${shq(dockerfile.trim())}`,
    ...argList.map((a) => `--build-arg ${shq(a)}`),
    noCache && "--no-cache",
    pull && "--pull",
    shq(context.trim() || "폴더"),
  ]
    .filter(Boolean)
    .join(" ");

  const steps = useMemo(() => parseSteps(current?.lines ?? []), [current?.lines]);
  const building = current?.state === "running";

  const build = async () => {
    if (!context.trim() || building) return;
    const key = `b${++serial.current}`;
    const started = Date.now();
    const name = tag.trim();
    setNote("");
    setOpenStep(null);
    setCurrent({ key, tag: name, lines: [], state: "running", error: "", seconds: 0 });
    const off = on("build", (l: { key: string; line: string }) => {
      if (l.key === key) setCurrent((c) => (c && c.key === key ? { ...c, lines: c.lines.concat(l.line).slice(-5000) } : c));
    });
    let error = "";
    const ok = await run(command, async () => {
      try {
        await call("Build", { key, context: context.trim(), dockerfile: dockerfile.trim(), tag: name, args: argList, noCache, pull });
      } catch (e: any) {
        error = e.message;
        throw e;
      }
    });
    off();
    const seconds = Math.round((Date.now() - started) / 1000);
    setCurrent((c) => (c && c.key === key ? { ...c, state: ok ? "ok" : "failed", error, seconds } : c));
    setPast((p) => [{ tag: name || "(이름 없음)", context: context.trim(), ok, seconds, at: Date.now() }, ...p].slice(0, 20));
  };

  const browse = async () => {
    try {
      const dir = await call<string>("PickFolder");
      if (dir) setContext(dir);
    } catch {
      // No folder dialog in a browser: the path is typed instead.
    }
  };

  const edit = async () => {
    setNote("");
    try {
      const text = await call<string>("Dockerfile", context, dockerfile);
      setEditor({ text, original: text, isNew: false });
    } catch {
      // None yet: start one, which Save creates.
      const text = "FROM alpine:3\n\n# 이미지에 넣을 파일과 실행할 명령을 적습니다.\nCMD [\"echo\", \"hello\"]\n";
      setEditor({ text, original: "", isNew: true });
    }
  };

  const save = async () => {
    if (!editor) return;
    const text = editor.text;
    setEditor(null);
    if (await run(`# ${dockerfile.trim() || "Dockerfile"} 저장`, () => call("SaveDockerfile", context, dockerfile, text))) {
      setNote("Dockerfile을 저장했습니다.");
    }
  };

  const prune = async () => {
    setPruning(false);
    let summary = "";
    if (await run("docker builder prune -f", async () => (summary = await call<string>("PruneBuildCache")))) {
      setNote(`빌드 캐시를 지웠습니다. ${summary}`);
    }
  };

  return (
    <section>
      <header className="page-head">
        <h1>빌드</h1>
        {cli && <span className="muted">docker {cli}</span>}
        <span className="spacer" />
        <button disabled={!cli || building} onClick={() => setPruning(true)}>
          빌드 캐시 지우기
        </button>
      </header>
      <p className="lead">
        빌드는 내 폴더의 파일과 <code>Dockerfile</code>(만드는 순서를 적은 파일)로 이미지를 만드는 일입니다. 만든 이미지는 이미지 화면에
        나타나고, 바로 컨테이너로 실행할 수 있습니다.
      </p>
      {missing && (
        <div className="banner" role="alert">
          <strong>이 PC에서 docker 명령을 찾지 못했습니다.</strong> 빌드는 docker 명령으로 하므로 지금은 할 수 없습니다.
        </div>
      )}
      {note && <p className="note">{note}</p>}

      <form
        className="run-form build-form"
        onSubmit={(e) => {
          e.preventDefault();
          build();
        }}
      >
        <div className="preset-bar">
          <select aria-label="저장한 빌드 설정" value={preset} onChange={(e) => choose(e.target.value)}>
            <option value="">{presets.length ? "저장한 설정 고르기…" : "저장한 설정이 없습니다"}</option>
            {presets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!context.trim() || building}
            title="지금 적은 폴더 · 이름 · 인자를 이름을 붙여 저장합니다"
            onClick={() => setNaming(preset || tag.trim().split(":")[0] || context.trim().split(/[\\/]/).filter(Boolean).pop() || "")}
          >
            설정 저장
          </button>
          {preset && (
            <button type="button" disabled={building} onClick={dropPreset}>
              저장한 설정 지우기
            </button>
          )}
          <span className="spacer" />
          <button type="button" disabled={building} title="입력한 내용과 아래 결과를 모두 비웁니다" onClick={startNew}>
            새 빌드
          </button>
        </div>
        <label>
          폴더
          <div className="pair">
            <input placeholder="빌드에 쓸 파일이 있는 폴더 (예: C:\projects\myapp)" aria-label="빌드할 폴더" value={context} onChange={(e) => setContext(e.target.value)} />
            <button type="button" onClick={browse}>
              찾아보기
            </button>
          </div>
        </label>
        <div className="two">
          <label>
            이미지 이름
            <input placeholder="예: myapp:1.0" aria-label="이미지 이름" value={tag} onChange={(e) => setTag(e.target.value)} />
            <span className="help">만든 이미지를 부를 이름입니다. 비우면 이름 없는 이미지가 됩니다.</span>
          </label>
          <label>
            Dockerfile
            <div className="pair">
              <input placeholder="비워 두면 폴더 안의 Dockerfile" aria-label="Dockerfile 경로" value={dockerfile} onChange={(e) => setDockerfile(e.target.value)} />
              <button type="button" disabled={!context.trim()} onClick={edit}>
                보기·편집
              </button>
            </div>
          </label>
        </div>
        <details>
          <summary>더 많은 설정</summary>
          <label>
            빌드 인자
            <textarea rows={3} placeholder={"한 줄에 하나씩, 이름=값\n예: VERSION=1.2.3"} aria-label="빌드 인자" value={args} onChange={(e) => setArgs(e.target.value)} />
            <span className="help">Dockerfile의 ARG에 넘기는 값입니다.</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={noCache} onChange={(e) => setNoCache(e.target.checked)} />
            캐시를 쓰지 않고 모든 단계를 다시 실행
          </label>
          <label className="check">
            <input type="checkbox" checked={pull} onChange={(e) => setPull(e.target.checked)} />
            기반 이미지의 새 버전이 있는지 확인
          </label>
        </details>
        <div className="cli-preview">
          <span className="muted">같은 일을 하는 명령</span>
          <code data-testid="build-cli">{command}</code>
        </div>
        <div className="dialog-actions">
          {building && (
            <button type="button" onClick={() => current && call("CancelBuild", current.key)}>
              취소
            </button>
          )}
          <button className="primary" type="submit" disabled={!cli || !context.trim() || building}>
            {building ? "빌드하는 중…" : "빌드"}
          </button>
        </div>
      </form>

      {current && (
        <div className="console" data-testid="build-result">
          <div className="console-head">
            <strong>
              {current.state === "running" && "빌드하는 중…"}
              {current.state === "ok" && `빌드 성공 · ${current.seconds}초`}
              {current.state === "failed" && `빌드 실패 · ${current.seconds}초`}
            </strong>
            <span>
              {current.state === "ok" && current.tag && (
                <button className="link" onClick={() => onRun(current.tag)}>
                  이 이미지로 컨테이너 실행
                </button>
              )}
              <button className="link" onClick={() => setRaw(!raw)}>
                {raw ? "단계로 보기" : "전체 출력 보기"}
              </button>
              {!building && (
                <button className="link" onClick={() => setCurrent(null)}>
                  결과 지우기
                </button>
              )}
            </span>
          </div>
          {current.state === "failed" && (
            <p className="warn" role="alert">
              {current.error}
            </p>
          )}
          {raw || steps.length === 0 ? (
            <pre className="log-box">{current.lines.length ? current.lines.join("\n") : "…"}</pre>
          ) : (
            <ol className="steps">
              {steps.map((s) => (
                <li key={s.id} className={"step " + s.status} data-testid={`step-${s.id}`}>
                  <button className="step-head" aria-expanded={openStep === s.id} disabled={s.logs.length === 0} onClick={() => setOpenStep(openStep === s.id ? null : s.id)}>
                    <span className="dot" />
                    <span className={"step-name" + (s.name.startsWith("[internal]") ? " muted" : "")}>{s.name}</span>
                    <span className="muted step-meta">
                      {stepLabel[s.status]}
                      {s.time && ` · ${s.time}`}
                      {s.logs.length > 0 && ` · 출력 ${s.logs.length}줄`}
                    </span>
                  </button>
                  {(openStep === s.id || s.status === "error") && s.logs.length > 0 && <pre className="log-box">{s.logs.join("\n")}</pre>}
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {past.length > 0 && (
        <>
          <h2 className="section">이번에 한 빌드</h2>
          <table className="grid">
            <tbody>
              {past.map((b) => (
                <tr key={b.at}>
                  <td>
                    <span className={"state " + (b.ok ? "running" : "failed")}>
                      <span className="dot" />
                      {b.ok ? "성공" : "실패"}
                    </span>
                  </td>
                  <td>
                    <strong>{b.tag}</strong>
                    <span className="sub">{b.context}</span>
                  </td>
                  <td className="muted nowrap">{b.seconds}초</td>
                  <td className="muted nowrap">{new Date(b.at).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {editor && (
        <Dialog title={editor.isNew ? "새 Dockerfile" : dockerfile.trim() || "Dockerfile"} onClose={() => setEditor(null)} wide>
          {editor.isNew && <p className="muted">이 폴더에는 아직 Dockerfile이 없습니다. 아래는 시작용 예시이고, 저장하면 파일이 만들어집니다.</p>}
          <textarea className="editor" aria-label="Dockerfile 내용" spellCheck={false} value={editor.text} onChange={(e) => setEditor({ ...editor, text: e.target.value })} />
          <div className="dialog-actions">
            <button onClick={() => setEditor(null)}>닫기</button>
            <button className="primary" disabled={editor.text === editor.original} onClick={save}>
              저장
            </button>
          </div>
        </Dialog>
      )}

      {naming !== null && (
        <Dialog title="빌드 설정 저장" onClose={() => setNaming(null)}>
          <p>지금 적은 폴더, 이미지 이름, Dockerfile, 빌드 인자를 저장합니다. 같은 이름이 있으면 덮어씁니다.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              savePreset();
            }}
          >
            <input autoFocus className="field" aria-label="설정 이름" placeholder="예: myapp" value={naming} onChange={(e) => setNaming(e.target.value)} />
            <div className="dialog-actions">
              <button type="button" onClick={() => setNaming(null)}>
                취소
              </button>
              <button className="primary" type="submit" disabled={!naming.trim()}>
                저장
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {pruning && (
        <Dialog title="빌드 캐시 지우기" onClose={() => setPruning(false)}>
          <p>
            빌드를 빠르게 하려고 저장해 둔 중간 결과를 지웁니다. 디스크 공간이 늘지만, 다음 빌드는 처음부터 다시 하므로 오래 걸립니다. 이미
            만든 이미지는 그대로입니다.
          </p>
          <div className="dialog-actions">
            <button onClick={() => setPruning(false)}>취소</button>
            <button className="danger solid" onClick={prune}>
              지우기
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
