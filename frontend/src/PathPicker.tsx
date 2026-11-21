import { useEffect, useState } from "react";
import { call, inWindow } from "./bridge";
import { Dialog, Icon } from "./ui";

interface Listing {
  path: string;
  parent: string;
  home: string;
  entries: { name: string; dir: boolean }[];
  sep: string;
}

interface Request {
  /** What is being chosen: a folder, or a file whose name ends in one of these. */
  kind: "folder" | "file";
  title: string;
  ends?: string[];
  done: (path: string) => void;
}

let ask: ((r: Request) => void) | null = null;

/**
 * Asks the user for a folder or a file on the machine BoxForge runs on.
 * The desktop app opens the system's own window (native); in a browser
 * the page shows the folders itself. Resolves to "" when cancelled.
 */
export function pick(kind: "folder" | "file", title: string, native: string, ends?: string[]): Promise<string> {
  if (inWindow()) return call<string>(native).catch(() => "");
  return new Promise((done) => (ask ? ask({ kind, title, ends, done }) : done("")));
}

/** The page's own window for choosing a folder or file. Mounted once. */
export default function PathPicker() {
  const [req, setReq] = useState<Request | null>(null);
  const [at, setAt] = useState<Listing | null>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    ask = (r) => {
      setReq(r);
      go("");
    };
    return () => {
      ask = null;
    };
  }, []);

  const go = (dir: string) => {
    setError("");
    call<Listing>("Browse", dir).then(
      (l) => {
        setAt(l);
        setTyped(l.path === "drives" ? "" : l.path);
      },
      (e) => setError(e.message),
    );
  };
  if (!req) return null;
  const finish = (path: string) => {
    req.done(path);
    setReq(null);
    setAt(null);
  };
  const join = (name: string) => (at!.path === "drives" ? name : at!.path.endsWith(at!.sep) ? at!.path + name : at!.path + at!.sep + name);
  const fits = (name: string) => !req.ends || req.ends.some((e) => name.toLowerCase().endsWith(e));
  const shown = (at?.entries ?? []).filter((e) => e.dir || (req.kind === "file" && fits(e.name)));

  return (
    <Dialog title={req.title} onClose={() => finish("")} wide>
      <p className="muted">
        {inWindow() ? "이 PC" : "BoxForge가 켜져 있는 기기(서버)"}의 폴더입니다. 폴더를 눌러 들어가고,{" "}
        {req.kind === "folder" ? '원하는 폴더에서 "이 폴더 선택"을 누릅니다. 새 폴더를 만들려면 아래 칸의 경로 끝에 이름을 덧붙여 적으면 됩니다.' : "파일을 누르면 선택됩니다."}
      </p>
      <form
        className="pair"
        onSubmit={(e) => {
          e.preventDefault();
          go(typed);
        }}
      >
        <input className="field" aria-label="경로" value={typed} onChange={(e) => setTyped(e.target.value)} spellCheck={false} />
        <button type="submit">이동</button>
      </form>
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      <ul className="path-list" data-testid="path-list">
        {at?.parent && (
          <li>
            <button type="button" onClick={() => go(at.parent)}>
              <Icon name="back" /> <span>위 폴더로</span>
            </button>
          </li>
        )}
        {at && at.path !== at.home && at.home && (
          <li>
            <button type="button" onClick={() => go(at.home)}>
              <Icon name="home" /> <span>홈 폴더</span>
            </button>
          </li>
        )}
        {shown.map((e) => (
          <li key={e.name}>
            <button type="button" className={e.dir ? "" : "file"} onClick={() => (e.dir ? go(join(e.name)) : finish(join(e.name)))}>
              <Icon name={e.dir ? "folder" : "file"} /> <span>{e.name}</span>
            </button>
          </li>
        ))}
        {at && shown.length === 0 && <li className="muted empty">{req.kind === "file" ? "여기에는 고를 수 있는 파일이나 폴더가 없습니다." : "안에 폴더가 없습니다."}</li>}
      </ul>
      <div className="dialog-actions">
        <button type="button" onClick={() => finish("")}>
          취소
        </button>
        {req.kind === "folder" && (
          <button className="primary" type="button" disabled={!typed.trim()} onClick={() => finish(typed.trim())}>
            이 폴더 선택
          </button>
        )}
      </div>
    </Dialog>
  );
}
