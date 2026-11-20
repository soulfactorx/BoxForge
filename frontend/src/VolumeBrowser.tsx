import { useEffect, useState } from "react";
import { call, type Run } from "./bridge";
import { ago, bytes } from "./format";
import { Icon, IconButton } from "./ui";

interface Entry {
  name: string;
  kind: "dir" | "file" | "link" | "other";
  size: number;
  modified: number;
}

interface Preview {
  text: string;
  binary: boolean;
  truncated: boolean;
  size: number;
}

const join = (dir: string, name: string) => (dir === "/" ? "/" + name : dir + "/" + name);
const kindLabel: Record<string, string> = { dir: "폴더", file: "파일", link: "바로가기", other: "특수 파일" };

/** Looks inside a volume: folders to walk, files to read or save. Read-only. */
export default function VolumeBrowser({ name, label, run, onClose }: { name: string; label: string; run: Run; onClose: () => void }) {
  const [dir, setDir] = useState("/");
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<{ path: string; preview: Preview | null } | null>(null);
  const [saved, setSaved] = useState("");

  useEffect(() => {
    let stale = false;
    setEntries(null);
    setError("");
    call<Entry[]>("VolumeFiles", name, dir).then(
      (l) => !stale && setEntries(l ?? []),
      (e) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, [name, dir]);

  const show = async (path: string) => {
    setOpen({ path, preview: null });
    setSaved("");
    try {
      const preview = await call<Preview>("VolumePreview", name, path);
      setOpen((cur) => (cur?.path === path ? { path, preview } : cur));
    } catch (e: any) {
      setOpen(null);
      setError(e.message);
    }
  };

  const save = async (path: string) => {
    let where = "";
    setSaved("");
    if (await run(`docker cp <${label} 볼륨을 쓰는 컨테이너>:${path} ~/Downloads/`, async () => (where = await call<string>("VolumeSave", name, path)))) {
      setSaved(where);
    }
  };

  // "/a/b" → [["/", label], ["/a", "a"], ["/a/b", "b"]]
  const crumbs: [string, string][] = [["/", label]];
  dir.split("/").filter(Boolean).reduce((at, part) => {
    const next = join(at, part);
    crumbs.push([next, part]);
    return next;
  }, "/");

  return (
    <aside className="drawer" data-testid="volume-browser">
      <header>
        <h2>{label} 볼륨의 내용</h2>
        <IconButton icon="close" label="닫기" onClick={onClose} />
      </header>
      <div className="drawer-body">
        <nav className="crumbs" aria-label="현재 위치">
          {crumbs.map(([path, text], i) => (
            <span key={path}>
              {i > 0 && <span className="muted"> / </span>}
              {i === crumbs.length - 1 && !open ? (
                <strong>{text}</strong>
              ) : (
                <button
                  className="link"
                  onClick={() => {
                    setOpen(null);
                    setDir(path);
                  }}
                >
                  {text}
                </button>
              )}
            </span>
          ))}
          {open && (
            <span>
              <span className="muted"> / </span>
              <strong>{open.path.split("/").pop()}</strong>
            </span>
          )}
        </nav>
        {error && (
          <p className="warn" role="alert">
            {error}
          </p>
        )}
        {saved && <p className="note">저장했습니다: {saved}</p>}

        {open ? (
          <div className="file-view">
            <div className="logs-bar">
              <button onClick={() => setOpen(null)}>목록으로</button>
              <button onClick={() => save(open.path)}>내 PC로 저장</button>
              {open.preview && <span className="muted">{bytes(open.preview.size)}</span>}
            </div>
            {!open.preview ? (
              <p className="muted">읽는 중…</p>
            ) : open.preview.binary ? (
              <p className="muted">글자로 된 파일이 아니라 여기서 보여줄 수 없습니다. 내 PC로 저장해서 여세요.</p>
            ) : (
              <>
                <pre className="log-box" data-testid="file-text">
                  {open.preview.text || <span className="muted">빈 파일입니다.</span>}
                </pre>
                {open.preview.truncated && <p className="muted">파일이 커서 앞부분만 보여줍니다. 전체는 내 PC로 저장해서 보세요.</p>}
              </>
            )}
          </div>
        ) : entries === null && !error ? (
          <p className="muted">읽는 중…</p>
        ) : entries && entries.length === 0 ? (
          <p className="muted">{dir === "/" ? "비어 있는 볼륨입니다." : "비어 있는 폴더입니다."}</p>
        ) : (
          entries && (
            <table className="grid files">
              <thead>
                <tr>
                  <th>이름</th>
                  <th className="num">크기</th>
                  <th>바뀐 때</th>
                  <th className="actions">작업</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.name} data-testid={`file-${e.name}`}>
                    <td>
                      <span className="file-name" title={kindLabel[e.kind]}>
                        <Icon name={e.kind === "dir" ? "folder" : "file"} />
                        {e.kind === "dir" ? (
                          <button className="link name" onClick={() => setDir(join(dir, e.name))}>
                            {e.name}
                          </button>
                        ) : e.kind === "file" ? (
                          <button className="link name" onClick={() => show(join(dir, e.name))}>
                            {e.name}
                          </button>
                        ) : (
                          <span>
                            {e.name} <span className="muted">({kindLabel[e.kind]})</span>
                          </span>
                        )}
                      </span>
                    </td>
                    <td className="num nowrap">{e.kind === "file" ? bytes(e.size) : <span className="muted">—</span>}</td>
                    <td className="muted nowrap">{ago(e.modified)}</td>
                    <td className="actions">
                      {(e.kind === "dir" || e.kind === "file") && (
                        <IconButton icon="download" label={e.kind === "dir" ? "폴더를 tar 파일로 내 PC에 저장" : "내 PC로 저장"} onClick={() => save(join(dir, e.name))} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        )}
        <p className="muted footnote">읽기 전용입니다. 여기서는 볼륨 안의 파일을 바꾸거나 지울 수 없습니다.</p>
      </div>
    </aside>
  );
}
