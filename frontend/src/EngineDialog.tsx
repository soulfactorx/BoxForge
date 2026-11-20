import { useEffect, useState } from "react";
import { call } from "./bridge";
import SetupWizard, { type SetupStatus } from "./SetupWizard";
import { Dialog } from "./ui";

const ownEngine = "wsl:BoxForge";

interface Target {
  id: string;
  kind: "default" | "context" | "wsl" | "ssh" | "podman";
  label: string;
  host: string;
  distro: string;
}

const hint: Record<Target["kind"], (t: Target) => string> = {
  default: () => "터미널에서 docker 명령을 쳤을 때 쓰이는 엔진입니다.",
  context: (t) => t.host,
  wsl: (t) => `${t.distro} 배포판 안에 설치된 Docker Engine에 연결합니다. 네트워크 포트를 열지 않습니다.`,
  ssh: (t) => `다른 PC나 서버의 Docker Engine에 SSH로 연결합니다 (${t.host}). 비밀번호 없이 키로 로그인되어 있어야 합니다.`,
  podman: (t) => `Podman의 Docker 호환 API에 연결합니다 (${t.host}). 일부 기능은 다르게 동작할 수 있습니다.`,
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
  const [canInstall, setCanInstall] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [remote, setRemote] = useState<string | null>(null);
  const [remoteError, setRemoteError] = useState("");

  const addRemote = async () => {
    const addr = (remote ?? "").trim().replace(/^ssh:\/\//, "");
    setError("");
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*(:[0-9]{1,5})?$/.test(addr)) {
      setRemoteError("주소는 user@host 또는 user@host:포트 꼴로 적어 주세요. 예: dev@192.168.0.10");
      return;
    }
    setRemoteError("");
    try {
      await call("AddRemoteEngine", addr);
      setRemote(null);
      await load();
      setPicked("ssh:" + addr.replace(/^ssh:\/\//, ""));
    } catch (e: any) {
      setError(e.message);
    }
  };

  const dropRemote = async (id: string) => {
    setBusy(true);
    setError("");
    try {
      await call("RemoveRemoteEngine", id);
      await load();
    } catch (e: any) {
      setError(e.message);
    }
    setBusy(false);
  };

  const load = () =>
    call<{ current: string; targets: Target[] }>("Engines").then(
      (c) => {
        setTargets(c.targets ?? []);
        setCurrent(c.current);
        setPicked(c.current);
      },
      (e) => setError(e.message),
    );

  useEffect(() => {
    load();
    call<SetupStatus>("SetupStatus").then((s) => setCanInstall(s.supported), () => {});
  }, []);

  const remove = async () => {
    setRemoving(false);
    setBusy(true);
    setError("");
    try {
      await call("RemoveBoxForgeEngine");
      onSwitched("wsl --unregister BoxForge");
      await load();
    } catch (e: any) {
      setError(e.message);
    }
    setBusy(false);
  };

  if (installing) {
    return (
      <SetupWizard
        onClose={() => {
          setInstalling(false);
          load();
        }}
        onInstalled={() => {
          onSwitched("wsl -d BoxForge docker info");
          onClose();
        }}
      />
    );
  }

  if (removing) {
    return (
      <Dialog title="BoxForge 엔진 제거" onClose={() => setRemoving(false)}>
        <p>
          BoxForge가 설치한 Docker Engine과 그 안의 <strong>모든 이미지 · 컨테이너 · 볼륨</strong>을 삭제합니다. 되돌릴 수 없습니다.
        </p>
        <p className="muted">다른 엔진과 다른 WSL 배포판은 그대로 둡니다. 나중에 다시 설치할 수 있습니다.</p>
        <div className="dialog-actions">
          <button onClick={() => setRemoving(false)}>취소</button>
          <button className="danger solid" onClick={remove}>
            전부 삭제
          </button>
        </div>
      </Dialog>
    );
  }

  const use = async () => {
    const t = targets?.find((x) => x.id === picked);
    if (!t) return;
    setBusy(true);
    setError("");
    try {
      await call("UseEngine", t.id);
      onSwitched(
        t.kind === "wsl"
          ? `wsl -d ${t.distro} docker info`
          : t.kind === "context"
            ? `docker context use ${t.id.slice(8)}`
            : t.kind === "ssh"
              ? `docker -H ssh://${t.host} info`
              : t.kind === "podman"
                ? `docker -H ${t.host} info`
                : "docker context use default",
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
              <span className="sub">{t.id === ownEngine ? "BoxForge가 설치한 Docker Engine입니다." : hint[t.kind](t)}</span>
            </span>
            {t.kind === "ssh" && (
              <button
                type="button"
                className="link"
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  dropRemote(t.id);
                }}
              >
                목록에서 빼기
              </button>
            )}
            {t.id === ownEngine && (
              <button
                type="button"
                className="link danger"
                disabled={busy}
                onClick={(e) => {
                  e.preventDefault();
                  setRemoving(true);
                }}
              >
                제거
              </button>
            )}
          </label>
        ))}
      </div>
      {error && (
        <p className="warn" role="alert">
          연결하지 못해 엔진을 바꾸지 않았습니다: {error}
        </p>
      )}
      {canInstall && targets && !targets.some((t) => t.id === ownEngine) && (
        <div className="install-offer">
          <span>
            <strong>Docker Engine이 없나요?</strong>
            <span className="sub">BoxForge가 무료 Docker Engine을 설치해 드립니다. WSL 설치부터 알아서 합니다.</span>
          </span>
          <button className="primary" disabled={busy} onClick={() => setInstalling(true)}>
            Docker Engine 설치
          </button>
        </div>
      )}
      {remote === null ? (
        <button className="link add-remote" disabled={busy} onClick={() => setRemote("")}>
          + 다른 PC의 엔진 추가 (SSH)
        </button>
      ) : (
        <form
          className="pair add-remote"
          onSubmit={(e) => {
            e.preventDefault();
            addRemote();
          }}
        >
          <input autoFocus className="field" aria-label="원격 엔진 주소" placeholder="user@host 또는 user@host:포트" value={remote} onChange={(e) => setRemote(e.target.value)} />
          <button type="submit" className="primary" disabled={!remote.trim()}>
            추가
          </button>
          <button type="button" onClick={() => setRemote(null)}>
            취소
          </button>
        </form>
      )}
      {remote !== null && remoteError && (
        <p className="warn" role="alert">
          {remoteError}
        </p>
      )}
      <details className="engine-help">
        <summary>직접 설치하고 싶다면</summary>
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
