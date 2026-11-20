import { useEffect, useRef, useState } from "react";
import { call, on } from "./bridge";
import { bytes } from "./format";
import { Dialog, Progress } from "./ui";

interface Step {
  id: string;
  title: string;
  state: "todo" | "active" | "done" | "error";
  detail: string;
}

export interface SetupStatus {
  supported: boolean;
  reason: string;
  installed: boolean;
  running: boolean;
  needsRestart: boolean;
  error: string;
  steps: Step[];
  done: number;
  total: number;
  log: string[] | null;
}

const mark: Record<Step["state"], string> = { todo: "○", active: "", done: "✔", error: "✖" };

/** Installs a Docker Engine for BoxForge: WSL, a Linux of its own, Docker's packages. */
export default function SetupWizard({ onClose, onInstalled }: { onClose: () => void; onInstalled: () => void }) {
  const [st, setSt] = useState<SetupStatus | null>(null);
  const [switching, setSwitching] = useState("");
  const told = useRef(false);

  useEffect(() => {
    const off = on("setup", setSt);
    call<SetupStatus>("SetupStatus").then(setSt, () => {});
    return off;
  }, []);

  // Once it is in, BoxForge moves over to the new engine by itself.
  useEffect(() => {
    if (!st?.installed || st.running || told.current) return;
    told.current = true;
    setSwitching("새 엔진에 연결하는 중…");
    call("UseEngine", "wsl:BoxForge").then(
      () => {
        setSwitching("");
        onInstalled();
      },
      (e) => setSwitching(`설치는 끝났지만 연결하지 못했습니다: ${e.message}`),
    );
  }, [st?.installed, st?.running]);

  const downloading = st?.running && st.steps.find((s) => s.id === "download")?.state === "active";
  return (
    <Dialog title="Docker Engine 설치" onClose={st?.running ? () => {} : onClose} wide>
      <p className="muted">
        이 PC에 BoxForge 전용 Docker Engine을 설치합니다. 설치하는 것은 모두 무료이고(WSL 2, Ubuntu, Docker Engine · Compose · Buildx), 이미 쓰고
        있는 WSL 배포판이나 다른 엔진은 건드리지 않습니다. 디스크 약 2GB와 인터넷 연결이 필요합니다.
      </p>
      {st && !st.supported && <p className="warn">{st.reason}</p>}
      {st?.supported && (
        <ol className="setup-steps">
          {st.steps.map((s) => (
            <li key={s.id} className={s.state} data-testid={`setup-${s.id}`}>
              <span className="setup-mark">{s.state === "active" ? <span className="spinner" /> : mark[s.state]}</span>
              <span>
                <strong>{s.title}</strong>
                {s.detail && <span className="sub">{s.detail}</span>}
                {s.id === "download" && downloading && (
                  <span className="setup-progress">
                    <Progress percent={st.total > 0 ? Math.floor((st.done * 100) / st.total) : -1} />
                    <span className="sub">
                      {bytes(st.done)}
                      {st.total > 0 && ` / ${bytes(st.total)}`}
                    </span>
                  </span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      {st?.needsRestart && (
        <p className="note-box" role="status">
          WSL을 설치했습니다. <strong>Windows를 다시 시작</strong>한 뒤 BoxForge를 열고 이 창에서 "설치 계속"을 누르면 이어서 진행합니다.
        </p>
      )}
      {st?.error && (
        <p className="warn" role="alert">
          {st.error}
        </p>
      )}
      {switching && <p className="muted">{switching}</p>}
      {st?.log && st.log.length > 0 && (
        <details className="setup-log">
          <summary>자세한 진행 내용 ({st.log.length}줄)</summary>
          <pre className="log-box">{st.log.join("\n")}</pre>
        </details>
      )}
      <div className="dialog-actions">
        {st?.running ? (
          <button onClick={() => call("SetupCancel")}>취소</button>
        ) : (
          <button onClick={onClose}>닫기</button>
        )}
        {st?.supported && !st.installed && (
          <button className="primary" disabled={st.running} onClick={() => call("SetupStart")}>
            {st.running ? "설치하는 중…" : st.error || st.needsRestart ? "설치 계속" : "설치 시작"}
          </button>
        )}
      </div>
    </Dialog>
  );
}
