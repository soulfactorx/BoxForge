import { useEffect, useState } from "react";
import { call, on, type Image, type Network, type PullState, type Run, type RunSpec } from "./bridge";
import { shq, words } from "./format";
import { recipes, type Pair, type RunInit } from "./recipes";
import { Dialog, IconButton, Progress } from "./ui";

interface Defaults {
  ports: { host: number; container: number }[];
  volumes: string[];
  shell: boolean;
}

const restarts: [string, string][] = [
  ["", "다시 시작하지 않음"],
  ["unless-stopped", "멈추지 않는 한 항상 (직접 중지하면 그대로 둠)"],
  ["always", "항상"],
  ["on-failure", "오류로 끝났을 때만"],
];

/** Rows of two inputs with add and remove: ports, folders, variables. */
export function Pairs(props: { label: string; help: string; rows: Pair[]; onChange: (rows: Pair[]) => void; a: string; b: string; sep: string; numeric?: boolean }) {
  const set = (i: number, k: "a" | "b", v: string) => props.onChange(props.rows.map((r, n) => (n === i ? { ...r, [k]: v } : r)));
  return (
    <fieldset>
      <legend>{props.label}</legend>
      <p className="help">{props.help}</p>
      {props.rows.map((r, i) => (
        <div className="pair" key={i}>
          <input aria-label={`${props.label} ${i + 1}: ${props.a}`} placeholder={props.a} inputMode={props.numeric ? "numeric" : undefined} value={r.a} onChange={(e) => set(i, "a", e.target.value)} />
          <span className="muted">{props.sep}</span>
          <input aria-label={`${props.label} ${i + 1}: ${props.b}`} placeholder={props.b} inputMode={props.numeric ? "numeric" : undefined} value={r.b} onChange={(e) => set(i, "b", e.target.value)} />
          <IconButton icon="close" label="이 줄 빼기" onClick={() => props.onChange(props.rows.filter((_, n) => n !== i))} />
        </div>
      ))}
      <button type="button" onClick={() => props.onChange([...props.rows, { a: "", b: "" }])}>
        추가
      </button>
    </fieldset>
  );
}

const filled = (rows: Pair[]) => rows.filter((r) => r.a.trim() && r.b.trim());

interface Props {
  init: RunInit;
  images: Image[];
  networks: Network[];
  run: Run;
  onClose: () => void;
  onStarted: (id: string) => void;
}

export default function RunDialog({ init, images, networks, run, onClose, onStarted }: Props) {
  const replace = init.replace;
  const [network, setNetwork] = useState(init.network ?? "");
  const [keepOpen, setKeepOpen] = useState<boolean | null>(init.interactive ?? null);
  const [image, setImage] = useState(init.image);
  const [name, setName] = useState(init.name ?? "");
  const [ports, setPorts] = useState<Pair[]>(init.ports ?? []);
  const [mounts, setMounts] = useState<Pair[]>(init.mounts ?? []);
  const [env, setEnv] = useState<Pair[]>(init.env ?? []);
  const [restart, setRestart] = useState(init.restart ?? "");
  const [command, setCommand] = useState(init.command ?? "");
  const [declared, setDeclared] = useState<Defaults | null>(null);

  const fill = (r: RunInit) => {
    setImage(r.image);
    setName(r.name ?? "");
    setPorts(r.ports ?? []);
    setMounts(r.mounts ?? []);
    setEnv(r.env ?? []);
    setRestart(r.restart ?? "");
    setCommand(r.command ?? "");
  };

  // An image already on this PC says which ports its program listens on
  // and where it keeps data: offered, not imposed.
  const have = images.some((im) => im.tags.includes(image.trim()) || im.tags.includes(image.trim() + ":latest"));
  useEffect(() => {
    setDeclared(null);
    if (!have) return;
    let stale = false;
    call<Defaults>("ImageDefaults", image.trim()).then((d) => !stale && setDeclared(d), () => {});
    return () => {
      stale = true;
    };
  }, [image, have]);
  const offer = declared && (declared.ports.length > 0 || declared.volumes.length > 0) && ports.length === 0 && mounts.length === 0;
  const useDeclared = () => {
    if (!declared) return;
    setPorts(declared.ports.map((p) => ({ a: String(p.host), b: String(p.container) })));
    const base = (name.trim() || image.trim().split("/").pop()!.split(":")[0]).replace(/[^a-zA-Z0-9_.-]/g, "");
    setMounts(declared.volumes.map((dir, i) => ({ a: `${base}-data${declared.volumes.length > 1 ? i + 1 : ""}`, b: dir })));
  };
  const blank = env.filter((e) => e.a.trim() && !e.b);
  const [busy, setBusy] = useState(false);
  const [pull, setPull] = useState<PullState | null>(null);
  const [error, setError] = useState("");

  useEffect(() => on("pull", (p: PullState) => setPull(p.done ? null : p)), []);

  // A base image runs a bare shell, which ends at once with no terminal:
  // unless told otherwise, such a one is given a terminal to wait at.
  const shellOnly = !!declared?.shell && !command.trim();
  const interactive = keepOpen ?? shellOnly;
  const badPort = filled(ports).find((p) => !/^\d+$/.test(p.a.trim()) || !/^\d+$/.test(p.b.trim()) || +p.a > 65535 || +p.b > 65535 || +p.a < 1 || +p.b < 1);
  const spec: RunSpec = {
    image: image.trim(),
    name: name.trim(),
    ports: filled(ports).map((p) => ({ host: +p.a, container: +p.b, proto: "tcp" })),
    mounts: filled(mounts).map((m) => ({ source: m.a.trim(), target: m.b.trim() })),
    env: env.filter((e) => e.a.trim()).map((e) => `${e.a.trim()}=${e.b}`),
    restart,
    command: words(command),
    interactive,
    network: network || undefined,
  };

  const cli = [
    replace ? `docker rm -f ${shq(replace.name)} && docker run ${interactive ? "-dit" : "-d"}` : interactive ? "docker run -dit" : "docker run -d",
    spec.network && `--network ${shq(spec.network)}`,
    spec.name && `--name ${shq(spec.name)}`,
    ...spec.ports.map((p) => `-p ${p.host}:${p.container}`),
    ...spec.mounts.map((m) => `-v ${shq(m.source + ":" + m.target)}`),
    ...spec.env.map((e) => `-e ${shq(e)}`),
    spec.restart && `--restart ${spec.restart}`,
    shq(spec.image || "이미지"),
    ...spec.command.map(shq),
  ]
    .filter(Boolean)
    .join(" ");

  const submit = async () => {
    if (!spec.image || badPort || busy) return;
    setBusy(true);
    setError("");
    let id = "";
    const ok = await run(cli, async () => {
      try {
        id = replace ? await call<string>("RecreateContainer", replace.id, spec) : await call<string>("RunContainer", spec);
      } catch (e: any) {
        setError(e.message);
        throw e;
      }
    });
    setBusy(false);
    setPull(null);
    if (ok) onStarted(id);
  };

  const local = images.flatMap((im) => im.tags);
  return (
    <Dialog title={replace ? `${replace.name}: 설정 바꿔 다시 만들기` : "새 컨테이너 실행"} onClose={busy ? () => {} : onClose} wide>
      {replace && (
        <p className="note-box">
          포트 · 저장 공간 · 환경변수 · 네트워크는 컨테이너를 만들 때만 정할 수 있어서, 바꾸려면 지금 컨테이너를 지우고 새로 만듭니다. 볼륨에 든 데이터는 그대로 남지만,{" "}
          <strong>컨테이너 안에서 직접 바꾼 파일은 사라집니다.</strong> 새로 만들지 못하면 지금 것을 그대로 되돌려 놓습니다.
        </p>
      )}
      <form
        className="run-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {!init.image && !replace && (
          <div className="recipe-chips" aria-label="자주 쓰는 프로그램">
            <span className="muted">빠른 시작</span>
            {recipes.map((r) => (
              <button key={r.title} type="button" className={"chip" + (image === r.image ? " on" : "")} onClick={() => fill(r)}>
                {r.title}
              </button>
            ))}
          </div>
        )}
        <label>
          이미지
          <input autoFocus list="local-images" placeholder="예: nginx, postgres:17" value={image} onChange={(e) => setImage(e.target.value)} />
          <datalist id="local-images">
            {local.map((t) => (
              <option key={t} value={t} />
            ))}
          </datalist>
          <span className="help">
            {spec.image && !local.includes(spec.image) && !local.includes(spec.image + ":latest")
              ? "이 PC에 없는 이미지입니다. 실행할 때 먼저 내려받습니다."
              : "실행할 프로그램이 담긴 꾸러미입니다."}
          </span>
        </label>
        <label>
          이름
          <input placeholder="비워 두면 Docker가 지어 줍니다" value={name} onChange={(e) => setName(e.target.value)} />
        </label>

        {offer && (
          <div className="note-box suggestion" data-testid="suggestion">
            <span>
              이 이미지는 포트 {declared!.ports.map((p) => p.container).join(", ") || "없음"}
              {declared!.volumes.length > 0 && `, 데이터 폴더 ${declared!.volumes.join(", ")}`}을(를) 쓴다고 알려 줍니다.
            </span>
            <button type="button" onClick={useDeclared}>
              그대로 채우기
            </button>
          </div>
        )}
        <Pairs label="포트" help="내 PC의 포트로 들어온 접속을 컨테이너의 포트로 보냅니다. 예: 8080 → 80 이면 브라우저에서 localhost:8080 으로 엽니다." rows={ports} onChange={setPorts} a="내 PC 포트" b="컨테이너 포트" sep="→" numeric />
        {badPort && <p className="warn">포트는 1부터 65535 사이의 숫자여야 합니다.</p>}
        <Pairs label="저장 공간" help="컨테이너를 지워도 남길 데이터의 자리입니다. 왼쪽에 볼륨 이름(예: pgdata)이나 내 PC의 폴더 경로를 적습니다." rows={mounts} onChange={setMounts} a="볼륨 이름 또는 폴더" b="컨테이너 안 경로" sep="→" />
        <Pairs label="환경변수" help="프로그램에 넘기는 설정값입니다. 예: POSTGRES_PASSWORD = 비밀번호" rows={env} onChange={setEnv} a="이름" b="값" sep="=" />

        {blank.length > 0 && (
          <p className="warn">
            {blank.map((e) => e.a).join(", ")}의 값이 비어 있습니다. 비밀번호처럼 꼭 정해야 하는 값이면 채워 주세요.
          </p>
        )}
        <label>
          꺼졌을 때
          <select value={restart} onChange={(e) => setRestart(e.target.value)}>
            {restarts.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label>
          실행 명령
          <input placeholder="비워 두면 이미지에 정해진 대로 실행합니다" value={command} onChange={(e) => setCommand(e.target.value)} />
        </label>
        <label>
          네트워크
          <select aria-label="네트워크" value={network} onChange={(e) => setNetwork(e.target.value)}>
            <option value="">기본 네트워크</option>
            {networks
              .filter((n) => !n.builtin)
              .map((n) => (
                <option key={n.id} value={n.name}>
                  {n.name}
                </option>
              ))}
          </select>
          <span className="help">같은 네트워크의 컨테이너끼리는 서로 이름으로 접속할 수 있습니다. 네트워크는 "네트워크" 화면에서 만듭니다.</span>
        </label>
        {shellOnly && keepOpen === null && (
          <p className="note-box" data-testid="shell-note">
            이 이미지는 프로그램 없이 셸만 들어 있는 기본 이미지입니다. 그냥 실행하면 셸이 할 일이 없어 바로 끝나므로, 터미널을 연 채로 켜 둡니다. 실행한 뒤 "터미널" 탭에서 쓰면 됩니다.
          </p>
        )}
        <label className="check">
          <input type="checkbox" aria-label="터미널을 연 채로 켜 두기" checked={interactive} onChange={(e) => setKeepOpen(e.target.checked)} />
          <span>
            터미널을 연 채로 켜 두기 <span className="muted">(-it · 셸만 실행하는 이미지에 필요)</span>
          </span>
        </label>

        <div className="cli-preview">
          <span className="muted">같은 일을 하는 명령</span>
          <code data-testid="run-cli">{cli}</code>
        </div>

        {pull && (
          <div className="pull-progress">
            <span>
              {pull.ref} 받는 중{pull.percent >= 0 ? ` · ${pull.percent}%` : ""} <span className="muted">{pull.status}</span>
            </span>
            <Progress percent={pull.percent} />
          </div>
        )}
        {error && (
          <p className="warn" role="alert">
            {error}
          </p>
        )}

        <div className="dialog-actions">
          <button type="button" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button className="primary" type="submit" disabled={!spec.image || !!badPort || busy}>
            {busy ? (replace ? "다시 만드는 중…" : "실행하는 중…") : replace ? "지우고 다시 만들기" : "실행"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
