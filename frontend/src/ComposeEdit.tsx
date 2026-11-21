import { useEffect, useState } from "react";
import { call } from "./bridge";
import { Dialog } from "./ui";

interface Edit {
  op: "set" | "add" | "remove";
  name: string;
  image: string;
  ports: string[];
  environment: string[];
  volumes: string[];
  restart: string;
  dependsOn: string[];
  locked: string[];
  build: boolean;
}

const blank: Edit = { op: "add", name: "", image: "", ports: [], environment: [], volumes: [], restart: "", dependsOn: [], locked: [], build: false };

interface Props {
  /** The compose file the service is written in. */
  file: string;
  /** The service to change; "" to add one. */
  name: string;
  /** The other services, to choose what this one waits for. */
  others: string[];
  showCli: (cmd: string) => void;
  /** The file's new text, to be reviewed before it is saved. */
  onDraft: (text: string, what: string) => void;
  onClose: () => void;
}

/** One block of text, one entry a line. */
function Lines(props: { label: string; help: string; placeholder: string; value: string[]; locked: boolean; onChange: (v: string[]) => void }) {
  return (
    <label>
      {props.label}
      {props.locked ? (
        <span className="help">이 항목은 파일에 긴 형식으로 적혀 있어 여기서는 고칠 수 없습니다. "파일" 탭에서 직접 고치세요. 다른 항목을 고쳐도 이 항목은 그대로 둡니다.</span>
      ) : (
        <>
          <textarea className="lines" rows={Math.max(2, props.value.length + 1)} aria-label={props.label} placeholder={props.placeholder} spellCheck={false} value={props.value.join("\n")} onChange={(e) => props.onChange(e.target.value.split("\n"))} />
          <span className="help">{props.help}</span>
        </>
      )}
    </label>
  );
}

/** Changes a service of a compose file through a form; the file's text is rewritten, not the engine. */
export default function ServiceForm({ file, name, others, showCli, onDraft, onClose }: Props) {
  const adding = name === "";
  const [text, setText] = useState<string | null>(null);
  const [e, setE] = useState<Edit | null>(adding ? blank : null);
  const [error, setError] = useState("");
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    showCli(`# ${file} 의 ${adding ? "services 에 새 서비스 추가" : `services.${name} 고치기`} (파일을 고친 뒤 docker compose up -d)`);
    call<string>("ComposeFile", file)
      .then(async (t) => {
        setText(t);
        if (!adding) setE(await call<Edit>("ComposeService", t, name));
      })
      .catch((err) => setError(err.message));
  }, []);

  const send = async (edit: Edit, what: string) => {
    if (text === null) return;
    setError("");
    try {
      onDraft(await call<string>("ComposeEdit", text, edit), what);
    } catch (err: any) {
      setError(err.message);
    }
  };
  const locked = (k: string) => !!e?.locked.includes(k);

  return (
    <Dialog title={adding ? "서비스 추가" : `${name} 서비스 설정`} onClose={onClose} wide>
      <p className="muted">
        여기서 고친 것은 compose 파일의 글에 반영됩니다. 바로 적용하지 않고 "파일" 탭으로 넘어가, 바뀐 글과 적용하면 일어날 일을 확인한 뒤 저장합니다. 파일의 주석과 다른
        설정은 그대로 둡니다.
      </p>
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      {!e && !error && <p className="muted">읽는 중…</p>}
      {e && (
        <form
          className="run-form"
          onSubmit={(ev) => {
            ev.preventDefault();
            send({ ...e, op: adding ? "add" : "set" }, adding ? `${e.name} 서비스를 추가` : `${name} 서비스의 설정을 고침`);
          }}
        >
          {adding && (
            <label>
              이름
              <input autoFocus aria-label="서비스 이름" placeholder="예: cache" value={e.name} onChange={(ev) => setE({ ...e, name: ev.target.value })} />
              <span className="help">다른 서비스가 이 이름으로 접속합니다. 영문 · 숫자 · 점 · 밑줄 · 하이픈.</span>
            </label>
          )}
          <label>
            이미지
            <input aria-label="이미지" placeholder={e.build ? "비워 두면 소스에서 빌드한 것을 씁니다" : "예: redis:7"} value={e.image} onChange={(ev) => setE({ ...e, image: ev.target.value })} />
            {e.build && <span className="help">이 서비스는 소스에서 빌드합니다(build). 빌드 설정은 "파일" 탭에서 고칩니다.</span>}
          </label>
          <Lines label="포트" help="한 줄에 하나. 내 PC 포트:컨테이너 포트" placeholder="8080:80" value={e.ports} locked={locked("ports")} onChange={(v) => setE({ ...e, ports: v })} />
          <Lines label="환경변수" help="한 줄에 하나. 이름=값" placeholder="POSTGRES_PASSWORD=비밀번호" value={e.environment} locked={locked("environment")} onChange={(v) => setE({ ...e, environment: v })} />
          <Lines label="저장 공간" help="한 줄에 하나. 볼륨 이름 또는 폴더:컨테이너 안 경로" placeholder="data:/var/lib/data" value={e.volumes} locked={locked("volumes")} onChange={(v) => setE({ ...e, volumes: v })} />
          <label>
            꺼졌을 때
            <select aria-label="꺼졌을 때" value={e.restart} onChange={(ev) => setE({ ...e, restart: ev.target.value })}>
              <option value="">다시 시작하지 않음</option>
              <option value="unless-stopped">멈추지 않는 한 항상</option>
              <option value="always">항상</option>
              <option value="on-failure">오류로 끝났을 때만</option>
              {e.restart && !["unless-stopped", "always", "on-failure"].includes(e.restart) && <option value={e.restart}>{e.restart}</option>}
            </select>
          </label>
          {others.length > 0 && !locked("depends_on") && (
            <fieldset className="plain">
              <legend>먼저 켜져 있어야 하는 서비스</legend>
              <div className="recipe-chips">
                {others.map((o) => (
                  <label key={o} className="check">
                    <input type="checkbox" checked={e.dependsOn.includes(o)} onChange={(ev) => setE({ ...e, dependsOn: ev.target.checked ? [...e.dependsOn, o] : e.dependsOn.filter((d) => d !== o) })} />
                    <span>{o}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="dialog-actions">
            {!adding &&
              (confirming ? (
                <>
                  <span className="warn">파일에서 이 서비스를 지웁니다. 적용하면 그 컨테이너도 사라집니다.</span>
                  <button type="button" className="danger" onClick={() => send({ ...e, op: "remove" }, `${name} 서비스를 삭제`)}>
                    지우기
                  </button>
                </>
              ) : (
                <button type="button" className="danger" onClick={() => setConfirming(true)}>
                  서비스 삭제
                </button>
              ))}
            <span className="spacer" />
            <button type="button" onClick={onClose}>
              취소
            </button>
            <button className="primary" type="submit" disabled={text === null || (adding && (!e.name.trim() || !e.image.trim()))}>
              파일에 반영하고 확인하기
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
