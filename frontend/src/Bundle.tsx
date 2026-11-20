import { useEffect, useRef, useState } from "react";
import { call, download, on, remote, upload, type Container, type Run } from "./bridge";
import { explain } from "./EngineCopy";
import { Dialog } from "./ui";

interface Info {
  app: string;
  created: number;
  runtime: string;
  containers: { name: string; image: string; volumes: string[] }[];
  volumes: string[];
}

let serial = 0;

/** The lines of a transfer in progress, fed by "transfer" events. */
function useSteps(key: string) {
  const [steps, setSteps] = useState<string[]>([]);
  useEffect(
    () =>
      on("transfer", (t: { key: string; text: string }) => {
        if (t.key !== key) return;
        // A line that only counts up replaces the one before it.
        setSteps((s) => (s.length && s[s.length - 1].split(" · ")[0] === t.text.split(" · ")[0] ? [...s.slice(0, -1), t.text] : [...s, t.text]));
      }),
    [key],
  );
  return [steps, setSteps] as const;
}

function Steps({ steps, busy }: { steps: string[]; busy: boolean }) {
  if (steps.length === 0) return null;
  return (
    <ol className="transfer" data-testid="transfer">
      {steps.map((s, i) => (
        <li key={i} className={busy && i === steps.length - 1 ? "now" : ""}>
          {busy && i === steps.length - 1 ? <span className="spinner" /> : <span className="setup-mark">✔</span>}
          {s}
        </li>
      ))}
    </ol>
  );
}

/** Notes of an import, as sentences. */
export function importNotes(notes: string[]) {
  return explain(notes).map((n) => {
    if (n.startsWith("volume-kept:")) return `볼륨 "${n.slice(12)}"은(는) 이미 있어서 그대로 두었습니다. 파일의 데이터로 바꾸려면 그 볼륨을 지운 뒤 다시 가져오세요.`;
    if (n.startsWith("container-kept:")) return `컨테이너 "${n.slice(15)}"은(는) 같은 이름이 이미 있어서 만들지 않았습니다.`;
    return n;
  });
}

interface ExportProps {
  containers: Container[];
  picked: string[];
  run: Run;
  onClose: () => void;
  onDone: (file: string) => void;
}

/** Chooses containers and writes them, with their images and data, to one file. */
export function ExportDialog({ containers, picked, run, onClose, onDone }: ExportProps) {
  const [ids, setIds] = useState<string[]>(picked);
  const [changes, setChanges] = useState(true);
  const [volumes, setVolumes] = useState(true);
  const [file, setFile] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(`b${++serial}`).current;
  const [steps, setSteps] = useSteps(key);
  const chosen = containers.filter((c) => ids.includes(c.id));
  const base = chosen.length === 1 ? chosen[0].name : chosen[0]?.project || "boxforge";

  // Where to write: proposed at once, changed with the dialog.
  useEffect(() => {
    if (!file) call<string>("PickExportFileDefault", base).then(setFile, () => {});
  }, []);
  const browse = async () => {
    try {
      const f = await call<string>("PickExportFile", base);
      if (f) setFile(f);
    } catch (e: any) {
      setError(e.message);
    }
  };

  const go = async () => {
    setBusy(true);
    setError("");
    setSteps([]);
    let failed = "";
    const names = chosen.map((c) => c.name).join(" ");
    // From a browser elsewhere the file is made on the server, named after
    // what was chosen, and fetched from there.
    const target = remote() ? await call<string>("PickExportFileDefault", base) : file;
    const ok = await run(`# ${names} 를 파일 하나로: docker commit → docker save, 볼륨은 tar 로 → ${remote() ? base + ".boxforge" : file}`, async () => {
      try {
        await call("ExportBundle", key, ids, target, { changes, volumes });
      } catch (e: any) {
        failed = e.message;
        throw e;
      }
    });
    setBusy(false);
    const made = target.endsWith(".boxforge") ? target : target + ".boxforge";
    if (ok) onDone(remote() ? download(made) : made);
    else setError(failed);
  };

  const projects = [...new Set(containers.map((c) => c.project).filter(Boolean))];
  return (
    <Dialog title="파일로 내보내기" onClose={busy ? () => {} : onClose} wide>
      <p>고른 컨테이너를 이미지 · 데이터와 함께 파일 하나(.boxforge)에 담습니다. 다른 PC의 BoxForge에서 "가져오기"로 열면 같은 컨테이너가 만들어집니다.</p>
      <fieldset className="plain" disabled={busy}>
        <legend>내보낼 컨테이너</legend>
        {projects.length > 0 && (
          <div className="recipe-chips">
            <span className="muted">프로젝트 통째로</span>
            {projects.map((p) => (
              <button key={p} type="button" className="chip" onClick={() => setIds(containers.filter((c) => c.project === p).map((c) => c.id))}>
                {p}
              </button>
            ))}
          </div>
        )}
        <div className="pick-list" data-testid="export-list">
          {containers.map((c) => (
            <label key={c.id} className="check">
              <input type="checkbox" checked={ids.includes(c.id)} onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))} />
              <span>
                {c.name} <span className="muted">{c.image}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="check option">
        <input type="checkbox" checked={changes} disabled={busy} onChange={(e) => setChanges(e.target.checked)} />
        <span>
          컨테이너 안에서 바뀐 파일 포함
          <span className="sub">끄면 원래 이미지만 담습니다. 받는 쪽은 처음 만든 상태로 시작합니다.</span>
        </span>
      </label>
      <label className="check option">
        <input type="checkbox" checked={volumes} disabled={busy} onChange={(e) => setVolumes(e.target.checked)} />
        <span>
          볼륨의 데이터 포함
          <span className="sub">데이터베이스 내용처럼 볼륨에 든 것입니다. 비밀번호 같은 민감한 값이 들어 있을 수 있으니 파일을 건넬 때 주의하세요.</span>
        </span>
      </label>
      <label className="file-line" hidden={remote()}>
        저장할 파일
        <div className="pair">
          <input className="field" aria-label="저장할 파일" value={file} disabled={busy} onChange={(e) => setFile(e.target.value)} />
          <button type="button" disabled={busy} onClick={browse}>
            찾아보기
          </button>
        </div>
      </label>
      <p className="muted footnote">환경변수(비밀번호 포함)와 포트 설정도 함께 담깁니다. 내 PC의 폴더를 연결한 부분은 경로만 담기고 폴더의 내용은 담기지 않습니다.</p>
      <Steps steps={steps} busy={busy} />
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button onClick={onClose} disabled={busy}>
          취소
        </button>
        <button className="primary" disabled={busy || ids.length === 0 || !file.trim()} onClick={go}>
          {busy ? "내보내는 중…" : "내보내기"}
        </button>
      </div>
    </Dialog>
  );
}

interface ImportProps {
  run: Run;
  onClose: () => void;
  onDone: (names: string[], notes: string[]) => void;
}

/** Opens a bundle file, shows what it holds, and makes it here. */
export function ImportDialog({ run, onClose, onDone }: ImportProps) {
  const [file, setFile] = useState("");
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const key = useRef(`b${++serial}`).current;
  const [steps, setSteps] = useSteps(key);

  const look = async (f: string) => {
    setInfo(null);
    setError("");
    if (!f.trim()) return;
    try {
      setInfo(await call<Info>("InspectBundle", f));
    } catch (e: any) {
      const m: string = e.message;
      setError(
        m.includes("newer BoxForge")
          ? "더 새로운 BoxForge가 만든 파일입니다. BoxForge를 업데이트한 뒤 다시 시도하세요."
          : m.includes("not a BoxForge bundle")
            ? "BoxForge에서 내보낸 파일(.boxforge)이 아니거나 손상된 파일입니다."
            : m,
      );
    }
  };
  const browse = async () => {
    try {
      const f = await call<string>("PickImportFile");
      if (f) {
        setFile(f);
        look(f);
      }
    } catch (e: any) {
      setError(e.message);
    }
  };
  // The desktop app opens its file dialog at once; a browser has none.
  useEffect(() => {
    if (!remote()) browse();
  }, []);
  // From a browser elsewhere the file is on this device: it is sent first.
  const [sending, setSending] = useState(false);
  const send = async (f: File | undefined) => {
    if (!f) return;
    setSending(true);
    setError("");
    setInfo(null);
    try {
      const path = await upload(f);
      setFile(path);
      await look(path);
    } catch (e: any) {
      setError(e.message);
    }
    setSending(false);
  };

  const go = async () => {
    if (!info) return;
    setBusy(true);
    setError("");
    setSteps([]);
    let failed = "";
    let notes: string[] = [];
    const ok = await run(`# ${file} 에서: docker load, 볼륨 데이터 풀기, docker create`, async () => {
      try {
        notes = (await call<string[]>("ImportBundle", key, file)) ?? [];
      } catch (e: any) {
        failed = e.message;
        throw e;
      }
    });
    setBusy(false);
    if (ok) onDone(info.containers.map((c) => c.name), importNotes(notes));
    else setError(failed);
  };

  return (
    <Dialog title="파일에서 가져오기" onClose={busy ? () => {} : onClose} wide>
      <p>BoxForge에서 내보낸 파일(.boxforge)을 열어, 담긴 컨테이너를 지금 엔진에 만듭니다. 만들어진 컨테이너는 멈춘 상태이며, 확인한 뒤 시작하면 됩니다.</p>
      {remote() && (
        <label className="file-line">
          가져올 파일
          <input type="file" accept=".boxforge" aria-label="가져올 파일 고르기" disabled={busy || sending} onChange={(e) => send(e.target.files?.[0])} />
          {sending && <span className="muted">서버로 보내는 중… 큰 파일은 시간이 걸립니다.</span>}
        </label>
      )}
      <form
        className="pair"
        hidden={remote()}
        onSubmit={(e) => {
          e.preventDefault();
          look(file);
        }}
      >
        <input className="field" aria-label="가져올 파일" placeholder="예: C:\Users\me\Downloads\myapp.boxforge" value={file} disabled={busy} onChange={(e) => setFile(e.target.value)} />
        <button type="button" disabled={busy} onClick={browse}>
          찾아보기
        </button>
        <button type="submit" disabled={busy || !file.trim()}>
          열기
        </button>
      </form>
      {info && (
        <div className="note-box bundle-info" data-testid="bundle-info">
          <strong>이 파일에 담긴 것</strong>
          <ul>
            {info.containers.map((c) => (
              <li key={c.name}>
                컨테이너 <strong>{c.name}</strong> <span className="muted">{c.image}</span>
                {c.volumes.length > 0 && <span className="muted"> · 볼륨 {c.volumes.join(", ")}</span>}
              </li>
            ))}
          </ul>
          <span className="sub">
            {new Date(info.created * 1000).toLocaleString()} · BoxForge {info.app} · {info.runtime === "containerd" ? "containerd" : "Docker"}에서 내보냄
          </span>
        </div>
      )}
      {info && <p className="muted footnote">같은 이름의 컨테이너나 볼륨이 이미 있으면 건드리지 않고 건너뜁니다. 모르는 사람이 준 파일은 가져오지 마세요: 컨테이너는 내 PC의 폴더와 포트를 쓸 수 있습니다.</p>}
      <Steps steps={steps} busy={busy} />
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button onClick={onClose} disabled={busy}>
          취소
        </button>
        <button className="primary" disabled={busy || !info} onClick={go}>
          {busy ? "가져오는 중…" : "가져오기"}
        </button>
      </div>
    </Dialog>
  );
}
