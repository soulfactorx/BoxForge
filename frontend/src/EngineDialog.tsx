import { useEffect, useState } from "react";
import { call } from "./bridge";
import { Dialog } from "./ui";

interface Target {
  id: string;
  kind: "default" | "context" | "wsl";
  label: string;
  host: string;
  distro: string;
}

const hint: Record<Target["kind"], (t: Target) => string> = {
  default: () => "터미널에서 docker 명령을 쳤을 때 쓰이는 엔진입니다.",
  context: (t) => t.host,
  wsl: (t) => `${t.distro} 배포판 안에 설치된 Docker Engine에 연결합니다. 네트워크 포트를 열지 않습니다.`,
};

const install = [
  "curl -fsSL https://get.docker.com | sudo sh",
  "sudo systemctl enable --now docker",
];

/** Chooses which engine BoxForge works with. */
export default function EngineDialog({ onClose, onSwitched }: { onClose: () => void; onSwitched: (command: string) => void }) {
  const [targets, setTargets] = useState<Target[] | null>(null);
  const [current, setCurrent] = useState("");
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    call<{ current: string; targets: Target[] }>("Engines").then(
      (c) => {
        setTargets(c.targets ?? []);
        setCurrent(c.current);
        setPicked(c.current);
      },
      (e) => setError(e.message),
    );
  }, []);

  const use = async () => {
    const t = targets?.find((x) => x.id === picked);
    if (!t) return;
    setBusy(true);
    setError("");
    try {
      await call("UseEngine", t.id);
      onSwitched(
        t.kind === "wsl" ? `wsl -d ${t.distro} docker info` : t.kind === "context" ? `docker context use ${t.id.slice(8)}` : "docker context use default",
      );
      onClose();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  const hasWSL = targets?.some((t) => t.kind === "wsl");
  return (
    <Dialog title="엔진 선택" onClose={busy ? () => {} : onClose} wide>
      <p className="muted">BoxForge가 다룰 컨테이너 엔진을 고릅니다. 고른 엔진은 다음에 켤 때도 그대로 씁니다.</p>
      {targets === null && !error && <p className="muted">찾는 중…</p>}
      <div className="engine-list" role="radiogroup" aria-label="엔진">
        {targets?.map((t) => (
          <label key={t.id} className={"engine-option" + (picked === t.id ? " on" : "")} data-testid={`engine-${t.id}`}>
            <input type="radio" name="engine" checked={picked === t.id} disabled={busy} onChange={() => setPicked(t.id)} />
            <span>
              <strong>{t.label}</strong>
              {t.id === current && <span className="pill tag-inline">사용 중</span>}
              <span className="sub">{hint[t.kind](t)}</span>
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p className="warn" role="alert">
          연결하지 못해 엔진을 바꾸지 않았습니다: {error}
        </p>
      )}
      <details className="engine-help">
        <summary>Docker Engine을 새로 쓰고 싶다면</summary>
        <p>
          Docker Engine은 무료입니다(유료인 것은 Docker Desktop). Windows에서는 WSL의 Linux 배포판 안에 설치합니다.
          {hasWSL ? " 위 목록의 WSL 배포판" : " 먼저 Microsoft Store에서 Ubuntu를 설치한 뒤, 그 배포판"} 터미널에서 아래 두 줄을 실행하고, 이 창을 다시 열어
          "WSL: … 안의 Docker"를 고르면 됩니다.
        </p>
        <pre className="log-box">{install.join("\n")}</pre>
        <p className="muted">Linux에서는 같은 두 줄을 그대로 실행하면 되고, 그 엔진은 맨 위 항목으로 연결됩니다.</p>
      </details>
      <div className="dialog-actions">
        <button onClick={onClose} disabled={busy}>
          닫기
        </button>
        <button className="primary" disabled={busy || !picked || picked === current} onClick={use}>
          {busy ? "연결 확인 중…" : "이 엔진 사용"}
        </button>
      </div>
    </Dialog>
  );
}
