import { useEffect, useState } from "react";
import { call, on, type Image, type PullState, type Run, type RunSpec } from "./bridge";
import { shq, words } from "./format";
import { Dialog, IconButton, Progress } from "./ui";

type Pair = { a: string; b: string };

const restarts: [string, string][] = [
  ["", "다시 시작하지 않음"],
  ["unless-stopped", "멈추지 않는 한 항상 (직접 중지하면 그대로 둠)"],
  ["always", "항상"],
  ["on-failure", "오류로 끝났을 때만"],
];

/** Rows of two inputs with add and remove: ports, folders, variables. */
function Pairs(props: { label: string; help: string; rows: Pair[]; onChange: (rows: Pair[]) => void; a: string; b: string; sep: string; numeric?: boolean }) {
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
  image: string;
  images: Image[];
  run: Run;
  onClose: () => void;
  onStarted: (id: string) => void;
}

export default function RunDialog({ image: initial, images, run, onClose, onStarted }: Props) {
  const [image, setImage] = useState(initial);
  const [name, setName] = useState("");
  const [ports, setPorts] = useState<Pair[]>([]);
  const [mounts, setMounts] = useState<Pair[]>([]);
  const [env, setEnv] = useState<Pair[]>([]);
  const [restart, setRestart] = useState("");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [pull, setPull] = useState<PullState | null>(null);
  const [error, setError] = useState("");

  useEffect(() => on("pull", (p: PullState) => setPull(p.done ? null : p)), []);

  const badPort = filled(ports).find((p) => !/^\d+$/.test(p.a.trim()) || !/^\d+$/.test(p.b.trim()) || +p.a > 65535 || +p.b > 65535 || +p.a < 1 || +p.b < 1);
  const spec: RunSpec = {
    image: image.trim(),
    name: name.trim(),
    ports: filled(ports).map((p) => ({ host: +p.a, container: +p.b, proto: "tcp" })),
    mounts: filled(mounts).map((m) => ({ source: m.a.trim(), target: m.b.trim() })),
    env: env.filter((e) => e.a.trim()).map((e) => `${e.a.trim()}=${e.b}`),
    restart,
    command: words(command),
  };

  const cli = [
    "docker run -d",
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
        id = await call<string>("RunContainer", spec);
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
    <Dialog title="새 컨테이너 실행" onClose={busy ? () => {} : onClose} wide>
      <form
        className="run-form"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
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

        <Pairs label="포트" help="내 PC의 포트로 들어온 접속을 컨테이너의 포트로 보냅니다. 예: 8080 → 80 이면 브라우저에서 localhost:8080 으로 엽니다." rows={ports} onChange={setPorts} a="내 PC 포트" b="컨테이너 포트" sep="→" numeric />
        {badPort && <p className="warn">포트는 1부터 65535 사이의 숫자여야 합니다.</p>}
        <Pairs label="저장 공간" help="컨테이너를 지워도 남길 데이터의 자리입니다. 왼쪽에 볼륨 이름(예: pgdata)이나 내 PC의 폴더 경로를 적습니다." rows={mounts} onChange={setMounts} a="볼륨 이름 또는 폴더" b="컨테이너 안 경로" sep="→" />
        <Pairs label="환경변수" help="프로그램에 넘기는 설정값입니다. 예: POSTGRES_PASSWORD = 비밀번호" rows={env} onChange={setEnv} a="이름" b="값" sep="=" />

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
            {busy ? "실행하는 중…" : "실행"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
