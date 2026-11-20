import { useEffect, useState } from "react";
import { call, openURL, type Run } from "./bridge";
import { Dialog } from "./ui";

export interface UpdateInfo {
  current: string;
  latest: string;
  available: boolean;
  installed: boolean;
  notes: string;
  page: string;
}

export type Theme = "system" | "light" | "dark";

interface Props {
  run: Run;
  theme: Theme;
  onTheme: (t: Theme) => void;
  autoUpdate: boolean;
  onAutoUpdate: (on: boolean) => void;
  update: UpdateInfo | null;
  updating: string; // what the update is doing, "" when idle
  onCheck: () => Promise<void>;
  onInstall: () => void;
  onEngine: () => void;
}

export default function Settings({ run, theme, onTheme, autoUpdate, onAutoUpdate, update, updating, onCheck, onInstall, onEngine }: Props) {
  const [version, setVersion] = useState("");
  const [checked, setChecked] = useState("");
  const [servers, setServers] = useState<string[]>([]);
  const [login, setLogin] = useState<{ server: string; user: string; password: string } | null>(null);
  const [note, setNote] = useState("");

  const loadServers = () => call<string[]>("Registries").then((s) => setServers((s ?? []).sort()), () => {});
  useEffect(() => {
    call<string>("Version").then(setVersion, () => {});
    loadServers();
  }, []);

  const check = async () => {
    setChecked("확인하는 중…");
    await onCheck();
    setChecked("방금 확인했습니다.");
  };

  const signIn = async () => {
    if (!login) return;
    const { server, user, password } = login;
    if (await run(`docker login ${server} -u ${user}`.replace("  ", " "), () => call("RegistryLogin", server, user, password))) {
      setLogin(null);
      setNote(`${server || "Docker Hub"}에 로그인했습니다.`);
      loadServers();
    }
  };

  const signOut = async (server: string) => {
    if (await run(`docker logout ${server}`, () => call("RegistryLogout", server))) loadServers();
  };

  return (
    <section className="settings">
      <header className="page-head">
        <h1>설정</h1>
      </header>
      {note && <p className="note">{note}</p>}

      <div className="panel">
        <h2>화면</h2>
        <div className="setting">
          <span>
            <strong>테마</strong>
            <span className="sub">밝게, 어둡게, 또는 PC 설정을 따릅니다.</span>
          </span>
          <div className="segmented" role="radiogroup" aria-label="테마">
            {(["system", "light", "dark"] as Theme[]).map((t) => (
              <button key={t} role="radio" aria-checked={theme === t} className={theme === t ? "on" : ""} onClick={() => onTheme(t)}>
                {t === "system" ? "PC 설정" : t === "light" ? "밝게" : "어둡게"}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel" data-testid="update-panel">
        <h2>업데이트</h2>
        <div className="setting">
          <span>
            <strong>BoxForge {version === "dev" ? "(개발 빌드)" : version}</strong>
            <span className="sub">
              {version === "dev"
                ? "직접 빌드한 프로그램은 자동으로 업데이트하지 않습니다."
                : update?.installed
                  ? `새 버전 ${update.latest}을 받아 두었습니다. 다시 시작하면 적용됩니다.`
                  : update?.available
                    ? `새 버전 ${update.latest}이 나왔습니다.`
                    : update
                      ? "최신 버전입니다."
                      : "아직 확인하지 않았습니다."}{" "}
              {checked}
            </span>
          </span>
          <span className="setting-actions">
            {update?.installed ? (
              <button className="primary" onClick={() => call("Restart")}>
                다시 시작
              </button>
            ) : update?.available ? (
              <button className="primary" disabled={!!updating} onClick={onInstall}>
                {updating || "지금 업데이트"}
              </button>
            ) : null}
            <button onClick={check}>업데이트 확인</button>
          </span>
        </div>
        <label className="setting">
          <span>
            <strong>자동 업데이트</strong>
            <span className="sub">새 버전이 나오면 알아서 받아 두고, 다음에 켤 때 적용합니다.</span>
          </span>
          <input type="checkbox" className="switch" checked={autoUpdate} onChange={(e) => onAutoUpdate(e.target.checked)} />
        </label>
        {update?.available && update.notes && (
          <details>
            <summary>{update.latest}에서 바뀐 것</summary>
            <pre className="log-box notes">{update.notes}</pre>
          </details>
        )}
      </div>

      <div className="panel">
        <h2>엔진</h2>
        <div className="setting">
          <span>
            <strong>컨테이너 엔진</strong>
            <span className="sub">어느 엔진을 쓸지 고르거나, 새로 설치하거나, BoxForge가 설치한 엔진을 제거합니다.</span>
          </span>
          <button onClick={onEngine}>엔진 설치 · 선택</button>
        </div>
      </div>

      <div className="panel" data-testid="registries">
        <h2>레지스트리 로그인</h2>
        <p className="muted">
          회사의 비공개 레지스트리나 Docker Hub의 비공개 이미지를 받으려면 로그인이 필요합니다. 로그인 정보는 <code>docker login</code>과 같은 곳에
          저장됩니다.
        </p>
        {servers.length > 0 && (
          <ul className="plain servers">
            {servers.map((s) => (
              <li key={s}>
                <code>{s}</code>
                <button className="link danger" onClick={() => signOut(s)}>
                  로그아웃
                </button>
              </li>
            ))}
          </ul>
        )}
        <button onClick={() => setLogin({ server: "", user: "", password: "" })}>로그인 추가</button>
      </div>

      <div className="panel">
        <h2>정보</h2>
        <p className="muted">
          BoxForge는 Docker Engine 같은 무료 컨테이너 엔진을 쉽게 쓰기 위한 프로그램입니다. Docker Desktop을 쓰지 않으며, 사용 정보를 어디에도
          보내지 않습니다. 업데이트 확인 때만 GitHub에 접속합니다.
        </p>
        <button className="link" onClick={() => openURL("https://github.com/soulfactorx/BoxForge")}>
          프로젝트 페이지 · 문제 알리기
        </button>
      </div>

      {login && (
        <Dialog title="레지스트리 로그인" onClose={() => setLogin(null)}>
          <form
            className="run-form"
            onSubmit={(e) => {
              e.preventDefault();
              signIn();
            }}
          >
            <label>
              레지스트리 주소
              <input placeholder="비워 두면 Docker Hub (예: registry.example.com)" value={login.server} onChange={(e) => setLogin({ ...login, server: e.target.value })} />
            </label>
            <label>
              사용자 이름
              <input autoFocus autoComplete="username" value={login.user} onChange={(e) => setLogin({ ...login, user: e.target.value })} />
            </label>
            <label>
              비밀번호 또는 토큰
              <input type="password" autoComplete="current-password" value={login.password} onChange={(e) => setLogin({ ...login, password: e.target.value })} />
              <span className="help">BoxForge는 비밀번호를 저장하지 않고 docker 명령에 바로 넘깁니다.</span>
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setLogin(null)}>
                취소
              </button>
              <button className="primary" type="submit" disabled={!login.user.trim() || !login.password}>
                로그인
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
