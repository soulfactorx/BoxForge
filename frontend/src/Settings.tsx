import { useEffect, useState } from "react";
import { choose, chosen, lang } from "./i18n";
import { pick } from "./PathPicker";
import { call, openURL, type Run, remote, signOut as leaveServer, viewer } from "./bridge";
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
  const [restarting, setRestarting] = useState(false);
  // The desktop app closes and opens again by itself. A server goes away
  // for a moment: the page waits for it to answer again, then reloads.
  const restartNow = async () => {
    setRestarting(true);
    try {
      await call("Restart");
    } catch (e: any) {
      setRestarting(false);
      setNote(`다시 시작하지 못했습니다: ${e.message}`);
      return;
    }
    if (!remote()) return;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        if ((await fetch("/api/session", { cache: "no-store" })).ok) break;
      } catch {
        // not back yet
      }
    }
    location.reload();
  };
  const [tray, setTray] = useState<{ available: boolean; close: boolean } | null>(null);
  const [net, setNet] = useState<{ proxy: string; noProxy: string; canEngine: boolean; keep: boolean } | null>(null);
  const [proxy, setProxy] = useState("");
  const [noProxy, setNoProxy] = useState("");
  const [cert, setCert] = useState<string | null>(null);
  const [working, setWorking] = useState("");

  const loadNet = () =>
    call<{ proxy: string; noProxy: string; canEngine: boolean; keep: boolean }>("Network").then((n) => {
      setNet(n);
      setProxy(n.proxy);
      setNoProxy(n.noProxy);
    }, () => {});

  const saveProxy = async () => {
    setWorking("proxy");
    if (await run(proxy.trim() ? `# 프록시 ${proxy.trim()} 적용, 엔진 재시작` : "# 프록시 해제, 엔진 재시작", () => call("SetProxy", proxy, noProxy))) {
      setNote(proxy.trim() ? "프록시를 적용했습니다." : "프록시를 껐습니다.");
      loadNet();
    }
    setWorking("");
  };

  const trust = async () => {
    const file = (cert ?? "").trim();
    if (!file) return;
    setWorking("cert");
    if (await run(`# 인증서 ${file} 를 엔진이 믿는 목록에 추가, 엔진 재시작`, () => call("TrustCertificate", file))) {
      setCert(null);
      setNote("인증서를 추가했습니다.");
    }
    setWorking("");
  };

  const browseCert = async () => {
    const file = await pick("file", "인증서 파일 고르기", "PickCertificate", [".crt", ".pem", ".cer"]);
    if (file) setCert(file);
  };

  const keep = async (on: boolean) => {
    setNet((n) => n && { ...n, keep: on });
    await run(on ? "# 앱을 닫아도 엔진 유지" : "# 앱을 닫으면 엔진도 쉬게 함", () => call("SetKeepEngine", on));
  };

  const loadServers = () => call<string[]>("Registries").then((s) => setServers((s ?? []).sort()), () => {});
  useEffect(() => {
    call<string>("Version").then(setVersion, () => {});
    loadServers();
    loadNet();
    call<{ available: boolean; close: boolean }>("Tray").then(setTray, () => {});
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
        <div className="setting">
          <span>
            <strong>언어</strong>
            <span className="sub">화면의 글을 어느 말로 보여줄지 고릅니다. 영어는 한국어 화면을 옮긴 것이라 어색한 곳이 있을 수 있습니다. 바꾸면 화면이 새로 열립니다.</span>
          </span>
          <div className="segmented" role="radiogroup" aria-label="언어" data-keep-text>
            {(["", "ko", "en"] as const).map((l) => (
              <button key={l} role="radio" aria-checked={chosen() === l} className={chosen() === l ? "on" : ""} onClick={() => choose(l)}>
                {l === "" ? (lang() === "en" ? "Auto" : "PC 설정") : l === "ko" ? "한국어" : "English"}
              </button>
            ))}
          </div>
        </div>
        {tray?.available && (
          <label className="setting">
            <span>
              <strong>창을 닫아도 트레이에서 계속 실행</strong>
              <span className="sub">닫기(X)를 눌러도 BoxForge가 꺼지지 않고 작업 표시줄의 트레이 아이콘으로 남습니다. 아이콘을 누르면 다시 열리고, 아이콘 메뉴의 "종료"로 완전히 끕니다.</span>
            </span>
            <input
              type="checkbox"
              className="switch"
              aria-label="창을 닫아도 트레이에서 계속 실행"
              checked={tray.close}
              onChange={(e) => {
                setTray({ ...tray, close: e.target.checked });
                call("SetCloseToTray", e.target.checked);
              }}
            />
          </label>
        )}
      </div>

      {remote() && (
        <div className="panel" data-testid="server-panel">
          <h2>웹 서버</h2>
          <p className="muted">
            지금 다른 기기의 브라우저로 서버의 BoxForge를 쓰고 있습니다. 파일을 저장하면 이 브라우저가 내려받고, 폴더 · 파일 경로를 적는 칸은 서버 쪽 경로입니다. 업데이트 뒤 "다시 시작"을 누르면 서버가 새 버전으로 다시 켜지고, 비밀번호를 한 번 다시
            넣어야 합니다. 컨테이너는 그대로 돕니다.
          </p>
          {viewer() && <p className="note-box">보기 전용으로 로그인했습니다. 목록 · 로그 · 상태를 볼 수 있고, 시작 · 중지 · 삭제 같은 바꾸는 일과 파일 보기 · 터미널은 할 수 없습니다.</p>}
          <button onClick={leaveServer}>로그아웃</button>
        </div>
      )}

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
              <button className="primary" disabled={restarting} onClick={restartNow}>
                {restarting ? "다시 시작하는 중…" : "다시 시작"}
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
        <label className="setting">
          <span>
            <strong>앱을 닫아도 엔진 유지</strong>
            <span className="sub">
              WSL 안의 엔진은 BoxForge를 닫으면 잠시 뒤 멈춥니다. 켜 두면 컨테이너가 계속 돕니다(PC를 껐다 켜면 BoxForge를 한 번 열어야 다시
              시작됩니다).{net && !net.canEngine && " 지금 엔진은 WSL 안의 엔진이 아니라 해당하지 않습니다."}
            </span>
          </span>
          <input type="checkbox" className="switch" aria-label="앱을 닫아도 엔진 유지" checked={!!net?.keep} onChange={(e) => keep(e.target.checked)} />
        </label>
      </div>

      <div className="panel" data-testid="network-panel">
        <h2>회사 네트워크</h2>
        <p className="muted">
          회사에서 프록시를 거쳐야 인터넷이 되거나, 보안 장비가 HTTPS를 검사하는 경우에 필요합니다. 해당하지 않으면 비워 두세요.
          {net && !net.canEngine && " 지금 엔진은 WSL 안의 엔진이 아니어서, 프록시는 BoxForge 자신의 내려받기(업데이트, 엔진 설치)에만 적용됩니다."}
        </p>
        <form
          className="run-form"
          onSubmit={(e) => {
            e.preventDefault();
            saveProxy();
          }}
        >
          <label>
            프록시 주소
            <input placeholder="예: http://proxy.company.com:8080" aria-label="프록시 주소" value={proxy} onChange={(e) => setProxy(e.target.value)} />
          </label>
          <label>
            프록시를 거치지 않을 주소
            <input placeholder="예: localhost,127.0.0.1,.company.com" aria-label="프록시 제외 주소" value={noProxy} onChange={(e) => setNoProxy(e.target.value)} />
          </label>
          <div className="dialog-actions">
            <button type="submit" disabled={!!working || (net !== null && proxy === net.proxy && noProxy === net.noProxy)}>
              {working === "proxy" ? "적용하는 중…" : "프록시 적용"}
            </button>
          </div>
        </form>
        <div className="setting">
          <span>
            <strong>사내 인증서</strong>
            <span className="sub">
              이미지를 받을 때 "certificate signed by unknown authority" 오류가 나면, IT 부서에서 받은 루트 인증서(.crt, .pem)를 추가합니다. BoxForge가 설치한 WSL 엔진과
              BoxForge의 Kubernetes 클러스터에 적용됩니다.{net && !net.canEngine && " 지금 엔진은 WSL 안의 엔진이 아니어서 Kubernetes 클러스터에만 적용됩니다."}
            </span>
          </span>
          <button onClick={() => setCert("")}>
            인증서 추가
          </button>
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

      {cert !== null && (
        <Dialog title="사내 인증서 추가" onClose={() => setCert(null)}>
          <p>엔진과 Kubernetes 클러스터가 이 인증서로 서명된 서버를 믿게 됩니다. 추가한 뒤 다시 시작되므로, 실행 중인 컨테이너와 파드는 잠시 멈췄다 켜질 수 있습니다.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              trust();
            }}
          >
            <div className="pair">
              <input autoFocus className="field" aria-label="인증서 파일 경로" placeholder="예: C:\\certs\\company-root.crt" value={cert} onChange={(e) => setCert(e.target.value)} />
              <button type="button" onClick={browseCert}>
                찾아보기
              </button>
            </div>
            <div className="dialog-actions">
              <button type="button" onClick={() => setCert(null)}>
                취소
              </button>
              <button className="primary" type="submit" disabled={!cert.trim() || !!working}>
                {working === "cert" ? "추가하는 중…" : "추가"}
              </button>
            </div>
          </form>
        </Dialog>
      )}

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
