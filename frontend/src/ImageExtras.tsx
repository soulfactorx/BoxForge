import { useEffect, useRef, useState } from "react";
import { call, on, type Run } from "./bridge";
import { ago, bytes } from "./format";
import { CopyButton, Dialog, IconButton } from "./ui";

interface Layer {
  command: string;
  size: number;
  created: number;
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

/** A history line as the Dockerfile step it was: "RUN apk add …", "CMD [\"sh\"]". */
export function stepOf(command: string): { op: string; text: string } {
  let c = command.trim();
  if (!c) return { op: "", text: "" };
  c = c.replace(/^\/bin\/sh -c #\(nop\)\s+/, "");
  // BuildKit: "RUN |2 A=1 B=2 /bin/sh -c …" carries its build arguments first.
  c = c.replace(/^RUN \|\d+ (?:\S+=\S* )*/, "RUN ");
  c = c.replace(/^(RUN )?\/bin\/sh -c /, "RUN ");
  const m = /^([A-Z]+)\s+([\s\S]*)$/.exec(c);
  const ops = ["RUN", "COPY", "ADD", "ENV", "CMD", "ENTRYPOINT", "EXPOSE", "LABEL", "WORKDIR", "USER", "VOLUME", "ARG", "ONBUILD", "SHELL", "STOPSIGNAL", "HEALTHCHECK", "MAINTAINER"];
  if (m && ops.includes(m[1])) return { op: m[1], text: m[2].replace(/\s+# buildkit$/, "").trim() };
  return { op: "", text: c };
}

// What each step does, in a few words.
const opMeaning: Record<string, string> = {
  RUN: "명령 실행",
  COPY: "파일 복사",
  ADD: "파일 추가",
  ENV: "환경변수",
  CMD: "기본 실행 명령",
  ENTRYPOINT: "실행 프로그램",
  EXPOSE: "포트 알림",
  LABEL: "라벨",
  WORKDIR: "작업 폴더",
  USER: "사용자",
  VOLUME: "데이터 폴더",
  ARG: "빌드 인자",
  SHELL: "셸",
  HEALTHCHECK: "상태 검사",
  STOPSIGNAL: "멈춤 신호",
  MAINTAINER: "만든 사람",
  ONBUILD: "나중 빌드",
};

/** The layers, oldest first as they were built, each as its Dockerfile step. */
function LayerList({ image, showCli }: { image: string; showCli: (cmd: string) => void }) {
  const [layers, setLayers] = useState<Layer[] | null>(null);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [hideEmpty, setHideEmpty] = useState(false);
  useEffect(() => {
    showCli(`docker history --no-trunc ${image}`);
    setLayers(null);
    call<Layer[]>("ImageHistory", image).then((l) => setLayers([...(l ?? [])].reverse()), (e) => setError(e.message));
  }, [image]);
  if (error) return <p className="warn">{error}</p>;
  if (!layers) return <p className="muted">읽는 중…</p>;
  const biggest = Math.max(1, ...layers.map((l) => l.size));
  const total = layers.reduce((n, l) => n + l.size, 0);
  const shown = layers.map((l, i) => ({ l, i })).filter(({ l }) => !hideEmpty || l.size > 0);
  return (
    <div className="layer-list" data-testid="layers">
      <div className="layer-sum">
        <span>{`${layers.length}단계 · 합계 ${bytes(total)} · 파일을 바꾼 단계 ${layers.filter((l) => l.size > 0).length}개`}</span>
        <label className="check">
          <input type="checkbox" checked={hideEmpty} onChange={(e) => setHideEmpty(e.target.checked)} />
          크기가 0인 단계 숨기기
        </label>
      </div>
      <p className="muted">위에서부터 만든 순서입니다. 아래로 갈수록 그 위에 쌓은 단계이고, 막대는 그 단계가 더한 크기입니다. 줄을 누르면 명령 전체가 보입니다.</p>
      <ol className="steps">
        {shown.map(({ l, i }) => {
          const s = stepOf(l.command);
          return (
            <li key={i} className={(l.size === 0 ? "zero " : "") + (open === i ? "open" : "")} data-testid="layer">
              <button type="button" className="step-row" aria-expanded={open === i} onClick={() => setOpen(open === i ? null : i)}>
                <span className="step-no">{i + 1}</span>
                <span className={"op op-" + (s.op || "none").toLowerCase()} title={opMeaning[s.op] ?? ""}>
                  {s.op || "—"}
                </span>
                <code className="step-text">{s.text || "(명령 기록 없음)"}</code>
                <span className="step-size">{l.size > 0 ? bytes(l.size) : "0 B"}</span>
                <span className="layer-bar">
                  <span style={{ width: `${Math.max(l.size > 0 ? 2 : 0, (l.size * 100) / biggest)}%` }} />
                </span>
              </button>
              {open === i && (
                <div className="step-more">
                  <pre>{s.text || l.command}</pre>
                  <span className="muted">
                    {opMeaning[s.op] ? `${opMeaning[s.op]} · ` : ""}
                    {l.created > 0 ? `${ago(l.created)}에 만들어짐` : ""}
                  </span>
                  <CopyButton text={l.command} label="명령 복사" />
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** What the image is: ids, how it runs, what it declares. */
function ImageInfo({ image, showCli }: { image: string; showCli: (cmd: string) => void }) {
  const [info, setInfo] = useState<any>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    showCli(`docker image inspect ${image}`);
    call<string>("InspectImage", image).then((raw) => setInfo(JSON.parse(raw)), (e) => setError(e.message));
  }, [image]);
  if (error) return <p className="warn">{error}</p>;
  if (!info) return <p className="muted">읽는 중…</p>;
  const cfg = info.Config ?? {};
  const list = (v: any) => (Array.isArray(v) ? v.join(" ") : "");
  const rows: [string, string][] = [
    ["ID", info.Id ?? ""],
    ["태그", (info.RepoTags ?? []).join(", ")],
    ["다이제스트", (info.RepoDigests ?? []).join("\n")],
    ["만든 때", info.Created ? new Date(info.Created).toLocaleString() : ""],
    ["크기", info.Size ? bytes(info.Size) : ""],
    ["종류", [info.Os, info.Architecture, info.Variant].filter(Boolean).join(" / ")],
    ["실행 프로그램 (ENTRYPOINT)", list(cfg.Entrypoint)],
    ["기본 명령 (CMD)", list(cfg.Cmd)],
    ["작업 폴더", cfg.WorkingDir ?? ""],
    ["사용자", cfg.User ?? ""],
    ["열어 두는 포트", Object.keys(cfg.ExposedPorts ?? {}).join(", ")],
    ["데이터 폴더 (VOLUME)", Object.keys(cfg.Volumes ?? {}).join(", ")],
    ["만든 사람", info.Author ?? ""],
  ];
  const env: string[] = cfg.Env ?? [];
  const labels = Object.entries<string>(cfg.Labels ?? {});
  return (
    <div className="image-info" data-testid="image-info">
      <dl className="facts">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="fact">
              <dt>{k}</dt>
              <dd>
                <code>{v}</code>
                <CopyButton text={v} label={`${k} 복사`} />
              </dd>
            </div>
          ))}
      </dl>
      <h3>
        환경변수 {env.length > 0 && <CopyButton text={env.join("\n")} label="환경변수 모두 복사" />}
      </h3>
      {env.length === 0 ? (
        <p className="muted">—</p>
      ) : (
        <ul className="plain env">
          {env.map((e) => (
            <li key={e}>
              <code>{e}</code>
            </li>
          ))}
        </ul>
      )}
      {labels.length > 0 && (
        <>
          <h3>라벨</h3>
          <ul className="plain env">
            {labels.map(([k, v]) => (
              <li key={k}>
                <code>{k}</code> = <code>{v}</code>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** An image's own panel: its layers at once, and what it is. */
export function ImageDetail(props: { image: string; title: string; tab?: "layers" | "info"; showCli: (cmd: string) => void; onRun?: () => void; onClose: () => void }) {
  const [tab, setTab] = useState<"layers" | "info">(props.tab ?? "layers");
  return (
    <aside className="drawer" data-testid="image-detail">
      <header>
        <h2>{props.title}</h2>
        {props.onRun && (
          <button type="button" className="primary" onClick={props.onRun}>
            실행
          </button>
        )}
        <IconButton icon="close" label="닫기" onClick={props.onClose} />
      </header>
      <div className="tabs" role="tablist">
        {(
          [
            ["layers", "레이어"],
            ["info", "정보"],
          ] as const
        ).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="drawer-body">{tab === "layers" ? <LayerList image={props.image} showCli={props.showCli} /> : <ImageInfo image={props.image} showCli={props.showCli} />}</div>
    </aside>
  );
}
