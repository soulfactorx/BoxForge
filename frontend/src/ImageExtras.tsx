import { useEffect, useRef, useState } from "react";
import { call, on, type Run } from "./bridge";
import { ago, bytes } from "./format";
import { Dialog } from "./ui";

interface Layer {
  command: string;
  size: number;
  created: number;
}

/** The steps an image was built in, with what each added. */
export function LayersDialog({ image, showCli, onClose }: { image: string; showCli: (cmd: string) => void; onClose: () => void }) {
  const [layers, setLayers] = useState<Layer[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    showCli(`docker history ${image}`);
    call<Layer[]>("ImageHistory", image).then(setLayers, (e) => setError(e.message));
  }, [image]);
  const biggest = Math.max(1, ...(layers ?? []).map((l) => l.size));
  const total = (layers ?? []).reduce((n, l) => n + l.size, 0);
  return (
    <Dialog title={`${image} 의 레이어`} onClose={onClose} wide>
      <p className="muted">
        이미지는 만들 때의 단계가 한 겹씩 쌓인 것입니다. 아래는 가장 나중 단계부터이며, 막대는 그 단계가 더한 크기입니다. 크기가 0인 단계는 파일을 바꾸지 않고 설정만
        적은 것입니다.
      </p>
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      {!layers && !error && <p className="muted">읽는 중…</p>}
      {layers && (
        <ol className="layers" data-testid="layers">
          {layers.map((l, i) => (
            <li key={i} className={l.size === 0 ? "empty" : ""}>
              <span className="layer-bar">
                <span style={{ width: `${Math.max(l.size > 0 ? 2 : 0, (l.size * 100) / biggest)}%` }} />
              </span>
              <span className="layer-size">{l.size > 0 ? bytes(l.size) : "—"}</span>
              <code title={l.command}>{l.command || "(명령 기록 없음)"}</code>
            </li>
          ))}
        </ol>
      )}
      {layers && (
        <p className="muted footnote">
          {layers.length}단계 · 합계 {bytes(total)}
          {layers[layers.length - 1]?.created > 0 && ` · 가장 아래 단계는 ${ago(layers[layers.length - 1].created)}에 만들어짐`}
        </p>
      )}
      <div className="dialog-actions">
        <button onClick={onClose}>닫기</button>
      </div>
    </Dialog>
  );
}

let serial = 0;

/** Uploads an image to its registry. */
export function PushDialog({ tags, run, onClose, onDone }: { tags: string[]; run: Run; onClose: () => void; onDone: (ref: string) => void }) {
  const [ref, setRef] = useState(tags[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [error, setError] = useState("");
  const key = useRef(`p${++serial}`).current;
  useEffect(
    () =>
      on("transfer", (t: { key: string; text: string }) => {
        // A layer's line that only counts up replaces the one before it.
        if (t.key === key) setLines((l) => (l.length && l[l.length - 1].split(":")[0] === t.text.split(":")[0] ? [...l.slice(0, -1), t.text] : [...l, t.text]).slice(-12));
      }),
    [],
  );
  // "nginx" or "library/nginx" has no owner of the user's: it would go to Docker's own.
  // The tag is what follows the last ":" after the last "/": a registry's
  // address ("localhost:5000/…") has a ":" of its own.
  const repo = ref.replace(/:[^/:]*$/, "");
  const noOwner = !!ref && !repo.includes("/");
  const go = async () => {
    setBusy(true);
    setError("");
    setLines([]);
    let failed = "";
    const ok = await run(`docker push ${ref}`, async () => {
      try {
        await call("PushImage", key, ref);
      } catch (e: any) {
        failed = e.message;
        throw e;
      }
    });
    setBusy(false);
    if (ok) onDone(ref);
    else setError(failed);
  };
  return (
    <Dialog title="레지스트리에 올리기 (push)" onClose={busy ? () => {} : onClose}>
      <p>
        이미지를 레지스트리(이미지 저장소)에 올려 다른 PC나 동료가 받을 수 있게 합니다. 어디로 올라갈지는 이미지의 이름이 정합니다: <code>사용자/이름:태그</code>는 Docker
        Hub의 그 사용자에게, <code>ghcr.io/사용자/이름:태그</code>는 그 레지스트리로 갑니다.
      </p>
      {tags.length > 1 ? (
        <select className="field" aria-label="올릴 태그" value={ref} disabled={busy} onChange={(e) => setRef(e.target.value)}>
          {tags.map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
      ) : (
        <p>
          <code>{ref}</code>
        </p>
      )}
      {noOwner && <p className="warn">이 이름에는 올릴 곳(사용자나 레지스트리)이 없습니다. 먼저 "태그 추가"로 <code>내아이디/{repo}</code> 같은 이름을 붙인 뒤 그 태그를 올리세요.</p>}
      <p className="muted footnote">먼저 설정 → 레지스트리 로그인에서 로그인해 두어야 합니다. 공개 저장소에 올리면 누구나 받을 수 있습니다.</p>
      {lines.length > 0 && (
        <pre className="log-box push-log" data-testid="push-log">
          {lines.join("\n")}
        </pre>
      )}
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button onClick={onClose} disabled={busy}>
          취소
        </button>
        <button className="primary" disabled={busy || !ref || noOwner} onClick={go}>
          {busy ? "올리는 중…" : "레지스트리에 올리기"}
        </button>
      </div>
    </Dialog>
  );
}

interface Found {
  name: string;
  about: string;
  stars: number;
  official: boolean;
}

/** Finds images on Docker Hub by name. */
export function HubSearch({ query, showCli, onPick, onClose }: { query: string; showCli: (cmd: string) => void; onPick: (name: string) => void; onClose: () => void }) {
  const [text, setText] = useState(query);
  const [found, setFound] = useState<Found[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const search = async (q: string) => {
    if (!q.trim()) return;
    setBusy(true);
    setError("");
    showCli(`docker search ${q.trim()}`);
    try {
      setFound(await call<Found[]>("SearchImages", q));
    } catch (e: any) {
      setError(e.message);
    }
    setBusy(false);
  };
  useEffect(() => {
    search(query);
  }, []);
  return (
    <Dialog title="Docker Hub에서 이미지 찾기" onClose={onClose} wide>
      <form
        className="pair"
        onSubmit={(e) => {
          e.preventDefault();
          search(text);
        }}
      >
        <input autoFocus className="field" aria-label="찾을 이름" placeholder="예: nginx, postgres, redis" value={text} onChange={(e) => setText(e.target.value)} />
        <button className="primary" type="submit" disabled={busy || !text.trim()}>
          {busy ? "찾는 중…" : "찾기"}
        </button>
      </form>
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      {found && found.length === 0 && <p className="muted">찾은 것이 없습니다.</p>}
      {found && found.length > 0 && (
        <ul className="hub-list" data-testid="hub-list">
          {found.map((f) => (
            <li key={f.name}>
              <button type="button" onClick={() => onPick(f.name)}>
                <span className="hub-name">
                  {f.name}
                  {f.official && <span className="badge">공식</span>}
                  <span className="muted">★ {f.stars.toLocaleString()}</span>
                </span>
                <span className="sub">{f.about || "설명 없음"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="muted footnote">
        누르면 "이미지 받기" 칸에 이름이 들어갑니다. "공식"은 Docker가 관리하는 이미지입니다. 그 밖의 것은 누구나 올릴 수 있으므로 만든 곳을 확인하고 쓰세요. 검색어는
        Docker Hub로 보내집니다.
      </p>
      <div className="dialog-actions">
        <button onClick={onClose}>닫기</button>
      </div>
    </Dialog>
  );
}
