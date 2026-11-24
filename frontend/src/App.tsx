import { useCallback, useEffect, useRef, useState } from "react";
import { call, on, STREAM_OPEN, type Container, type EngineStatus, type Image, type Network, type Size, type Volume, viewer } from "./bridge";
import Networks from "./Networks";
import Volumes from "./Volumes";
import Builds from "./Builds";
import Compose from "./Compose";
import Containers, { settingsOf } from "./Containers";
import Detail, { type Tab } from "./Detail";
import EngineDialog from "./EngineDialog";
import Home from "./Home";
import Palette from "./Palette";
import type { RunInit } from "./recipes";
import Settings, { type Theme, type UpdateInfo } from "./Settings";
import Images from "./Images";
import Kubernetes, { type KubeMove } from "./Kubernetes";
import type { Deploy } from "./KubeExtras";
import Agents from "./Agents";
import Alerts from "./Alerts";
import PathPicker from "./PathPicker";
import RunDialog from "./RunDialog";
import Topology from "./Topology";
import { bytes } from "./format";
import { Dialog, Icon, IconButton } from "./ui";

type Page = "home" | "containers" | "map" | "images" | "volumes" | "networks" | "compose" | "builds" | "kube" | "agents" | "settings";

// The sidebar, in the order shown; a null starts a new group.
const menu: ({ id: Page; label: string; icon: string } | null)[] = [
  { id: "home", label: "홈", icon: "home" },
  null,
  { id: "containers", label: "컨테이너", icon: "box" },
  { id: "compose", label: "Compose", icon: "compose" },
  { id: "map", label: "관계도", icon: "map" },
  null,
  { id: "images", label: "이미지", icon: "layers" },
  { id: "volumes", label: "볼륨", icon: "volume" },
  { id: "networks", label: "네트워크", icon: "network" },
  null,
  { id: "builds", label: "빌드", icon: "build" },
  { id: "kube", label: "Kubernetes", icon: "kube" },
  null,
  { id: "agents", label: "AI 에이전트", icon: "agent" },
];

const pageCommand: Record<Page, string> = {
  home: "docker info",
  settings: "docker version",
  containers: "docker ps -a --size",
  map: "docker ps -a && docker network ls && docker volume ls",
  compose: "docker compose ls -a",
  images: "docker images",
  volumes: "docker volume ls",
  networks: "docker network ls",
  builds: "docker buildx version",
  kube: "docker exec boxforge-k3s kubectl get pods,deployments,services -A",
  agents: "docker compose ls -a --filter name=bfa-",
};

function gib(bytes: number) {
  return (bytes / 2 ** 30).toFixed(1) + " GB";
}

/** Adds, to an engine's message that says little to a beginner, what it means and what to do. */
function friendly(message: string): string {
  if (!/address already in use|port is already allocated/i.test(message)) return message;
  const port = /(?:bind host port|Bind for) [^\s]*?:(\d+)/i.exec(message)?.[1];
  const example = port ? `"${port}:80" → "${+port + 1}:80"` : `"8080:80" → "8081:80"`;
  return `${message}\n\n→ 내 PC의 ${port ? port + "번 " : ""}포트를 이미 다른 프로그램이나 컨테이너가 쓰고 있습니다. 포트의 앞 숫자(내 PC 쪽)를 다른 값으로 바꿔 다시 실행하세요. 예: ${example}`;
}

export default function App() {
  const [engine, setEngine] = useState<EngineStatus>({ connected: false, error: "", info: null });
  const [containers, setContainers] = useState<Container[]>([]);
  const [images, setImages] = useState<Image[]>([]);
  const [sizes, setSizes] = useState<Record<string, Size> | null>(null);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [page, setPage] = useState<Page>("home");
  const [palette, setPalette] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [updating, setUpdating] = useState("");
  const settled = useRef(false);
  const [detail, setDetail] = useState<{ id: string; tab: Tab } | null>(null);
  const [running, setRunning] = useState<RunInit | null>(null); // what the run dialog starts filled with
  const [toKube, setToKube] = useState<Partial<Deploy> | KubeMove | null>(null); // a container, to be deployed to Kubernetes
  const [history, setHistory] = useState<{ cmd: string; at: number }[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => {
    call<string>("Version").then(setAppVersion, () => {});
  }, []);
  // The first time the window is closed with a tray to go to: ask.
  const [closing, setClosing] = useState(false);
  useEffect(() => on("closing", () => setClosing(true)), []);
  const [engineLabel, setEngineLabel] = useState("");
  const [memUsed, setMemUsed] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState("");
  const cli = history.length ? history[history.length - 1].cmd : "";

  const copy = (cmd: string) => navigator.clipboard?.writeText(cmd).then(() => setCopied(cmd), () => {});

  useEffect(() => {
    const load = () => {
      call<EngineStatus>("Engine").then(setEngine).catch(() => {});
      call<Container[]>("Containers").then((l) => setContainers(l ?? [])).catch(() => {});
      call<Image[]>("Images").then((l) => setImages(l ?? [])).catch(() => {});
      call<Volume[]>("Volumes").then((l) => setVolumes(l ?? [])).catch(() => {});
      call<Network[]>("Networks").then((l) => setNetworks(l ?? [])).catch(() => {});
    };
    const off = [
      on("engine", setEngine),
      on("containers", (l) => setContainers(l ?? [])),
      on("images", (l) => setImages(l ?? [])),
      on("volumes", (l) => setVolumes(l ?? [])),
      on("networks", (l) => setNetworks(l ?? [])),
      on(STREAM_OPEN, load),
    ];
    load();
    return () => off.forEach((f) => f());
  }, []);

  // Disk use is slow for the engine to measure, so it is asked for apart
  // from the list, once the set of containers has settled.
  const ids = containers.map((c) => c.id).sort().join(",");
  useEffect(() => {
    if (!ids) return;
    const timer = setTimeout(() => {
      call<Record<string, Size>>("ContainerSizes").then((s) => setSizes(s ?? {}), () => setSizes({}));
    }, 400);
    return () => clearTimeout(timer);
  }, [ids]);

  // Every command BoxForge's work stands for goes through here: the newest
  // shows in the status bar, all of them in the history panel.
  // Which engine this is, asked again whenever the connection changes.
  useEffect(() => {
    call<string>("EngineLabel").then(setEngineLabel, () => {});
  }, [engine.connected, engine.info?.name]);

  // What the running containers use, looked at every few seconds.
  const runningCount = containers.filter((c) => c.state === "running").length;
  useEffect(() => {
    if (!engine.connected) return setMemUsed(null);
    let stale = false;
    const ask = () => call<number>("MemoryUsed").then((n) => !stale && setMemUsed(n), () => {});
    ask();
    const timer = setInterval(ask, 5000);
    return () => {
      stale = true;
      clearInterval(timer);
    };
  }, [engine.connected, engineLabel, runningCount]);

  // The look, remembered across restarts.
  useEffect(() => {
    if (theme === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = theme;
  }, [theme]);

  const chooseTheme = (t: Theme) => {
    setTheme(t);
    call("SetSetting", "theme", t).catch(() => {});
  };
  const chooseAuto = (on: boolean) => {
    setAutoUpdate(on);
    call("SetSetting", "update.auto", on ? "on" : "off").catch(() => {});
  };

  const checkUpdate = useCallback(async () => {
    try {
      const info = await call<UpdateInfo>("CheckUpdate");
      setUpdate(info);
      return info;
    } catch {
      return null; // offline, or nothing released yet: ask again later
    }
  }, []);

  const installUpdate = useCallback(async () => {
    setUpdating("내려받는 중…");
    try {
      await call("ApplyUpdate");
      await checkUpdate();
    } catch (e: any) {
      setError(`업데이트하지 못했습니다: ${e.message}`);
    }
    setUpdating("");
  }, [checkUpdate]);

  // At start, and a few times a day: is there a newer version? With
  // automatic updates on it is fetched at once, to run at the next start.
  useEffect(() => {
    let auto = true;
    const round = async () => {
      const info = await checkUpdate();
      if (info?.available && !info.installed && auto) installUpdate();
    };
    Promise.all([
      call<string>("Setting", "theme").then((t) => (t === "light" || t === "dark") && setTheme(t), () => {}),
      call<string>("Setting", "update.auto").then((v) => {
        auto = v !== "off";
        setAutoUpdate(auto);
      }, () => {}),
    ]).then(() => {
      settled.current = true;
      round();
    });
    const timer = setInterval(round, 6 * 3600 * 1000);
    return () => clearInterval(timer);
  }, []);

  // Ctrl+K (⌘K) opens the palette from anywhere.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  // With containerd on its own the command is nerdctl, which takes the
  // docker command's words.
  const tool = useRef("docker");
  tool.current = engine.info?.runtime === "containerd" ? "nerdctl" : engine.info?.runtime === "podman" ? "podman" : "docker";
  const showCli = useCallback((shown: string) => {
    const command = tool.current === "docker" ? shown : shown.replace(/(^|[|;&(]\s*)docker /g, `$1${tool.current} `);
    setCopied("");
    setHistory((h) => (h.length && h[h.length - 1].cmd === command ? h : h.concat({ cmd: command, at: Date.now() }).slice(-200)));
  }, []);

  // Opening a page reads a list: that has a command too.
  useEffect(() => {
    showCli(pageCommand[page]);
  }, [page, showCli]);

  // Runs one engine call, showing the docker command it stands for, and the
  // engine's own message if it fails.
  const run = useCallback(
    async (command: string, action: () => Promise<unknown>) => {
      showCli(command);
      setError("");
      try {
        await action();
        return true;
      } catch (e: any) {
        setError(friendly(e.message));
        return false;
      } finally {
        // The lists follow the engine's own change reports; some engines
        // miss one, so after anything done here they are read again.
        call("Refresh").catch(() => {});
      }
    },
    [showCli],
  );
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    await run("docker ps -a  # 목록을 엔진에서 다시 읽기", () => call("Refresh"));
    setRefreshing(false);
  };

  const info = engine.info;
  const shownCount = containers.filter((c) => !c.system).length;
  const open = detail && containers.find((c) => c.id === detail.id);
  const counts: Partial<Record<Page, number>> = {
    containers: shownCount,
    compose: new Set(containers.filter((c) => c.project && !c.system).map((c) => c.project)).size,
    images: images.length,
    volumes: volumes.length,
    networks: networks.length,
  };
  const openDetail = (id: string) => setDetail({ id, tab: "overview" });

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <img src="./icon.svg" alt="" />
          <span>BoxForge</span>
          {viewer() && (
            <span className="brand-version viewer-mark" data-testid="viewer-mark" title="보기 전용으로 로그인했습니다. 목록 · 로그 · 상태를 볼 수 있고 바꿀 수는 없습니다.">
              보기 전용
            </span>
          )}
          {appVersion && (
            <span className="brand-version" data-testid="app-version" title="설정에서 업데이트를 확인할 수 있습니다">
              {/^\d/.test(appVersion) ? "v" + appVersion : appVersion}
            </span>
          )}
          <span className="brand-refresh">
            <IconButton icon="restart" label={refreshing ? "다시 읽는 중…" : "목록 새로 고침"} disabled={refreshing || !engine.connected} onClick={refresh} />
          </span>
        </div>
        <button className="search-button" onClick={() => setPalette(true)} data-testid="palette-open">
          <Icon name="search" />
          <span>찾기 · 명령 붙여넣기</span>
          <kbd>Ctrl K</kbd>
        </button>
        <nav>
          {menu.map((m, i) =>
            m === null ? (
              <hr key={i} />
            ) : (
              <button key={m.id} className={"nav-item" + (page === m.id ? " active" : "")} onClick={() => setPage(m.id)} data-testid={`nav-${m.id}`}>
                <Icon name={m.icon} />
                <span>{m.label}</span>
                {counts[m.id] !== undefined && <span className="count">{counts[m.id]}</span>}
              </button>
            ),
          )}
        </nav>
        <button className={"nav-item settings-link" + (page === "settings" ? " active" : "")} onClick={() => setPage("settings")} data-testid="nav-settings">
          <Icon name="gear" />
          <span>설정</span>
          {update?.available && <span className="badge">새 버전</span>}
        </button>
        <button className="engine-card" data-testid="engine-card" title="엔진 바꾸기" onClick={() => setChoosing(true)}>
          <div className="engine-head">
            <span className={"dot " + (engine.connected ? "ok" : "bad")} />
            <strong>{info ? `${info.runtime} ${info.version}` : "엔진"}</strong>
            <span className="muted">{engine.connected ? "실행 중" : "연결 안 됨"}</span>
          </div>
          {engineLabel && (
            <div className="engine-name" data-testid="engine-name">
              {engineLabel}
            </div>
          )}
          {info && engine.connected && (
            <dl>
              <dt>실행 중</dt>
              <dd>
                {info.running} / {info.containers}
              </dd>
              <dt>CPU</dt>
              <dd>{info.cpus}개</dd>
              <dt title="실행 중인 컨테이너들이 지금 쓰는 메모리 / 엔진이 쓸 수 있는 메모리">메모리</dt>
              <dd data-testid="engine-memory">
                {memUsed === null ? "…" : bytes(memUsed)} / {gib(info.memTotal)}
              </dd>
            </dl>
          )}
          {info && engine.connected && memUsed !== null && info.memTotal > 0 && (
            <div className="meter" role="img" aria-label={`메모리 ${Math.round((memUsed * 100) / info.memTotal)}% 사용`}>
              <div style={{ width: `${Math.min(100, (memUsed * 100) / info.memTotal)}%` }} />
            </div>
          )}
          <span className="engine-change">엔진 바꾸기</span>
        </button>
      </aside>

      <main className="main">
        {update?.installed && (
          <div className="banner good" role="status" data-testid="update-ready">
            <span>
              <strong>새 버전 {update.latest}을 받아 두었습니다.</strong> 다시 시작하면 적용됩니다.
            </span>
            <button className="primary" onClick={() => call("Restart")}>
              지금 다시 시작
            </button>
          </div>
        )}
        {!engine.connected && page !== "home" && page !== "settings" && (
          <div className="banner" role="alert">
            <span>
              <strong>엔진에 연결할 수 없습니다.</strong> 다시 연결을 시도하고 있습니다.
              {engine.error && <span className="banner-detail">{engine.error}</span>}
            </span>
            <button onClick={() => setChoosing(true)}>엔진 설치 · 선택</button>
          </div>
        )}
        {page === "home" && (
          <Home
            engine={engine}
            containers={containers}
            images={images}
            volumes={volumes}
            run={run}
            go={(to) => setPage(to)}
            onRun={(init) => setRunning(init)}
            onOpen={openDetail}
            onEngine={() => setChoosing(true)}
          />
        )}
        {page === "settings" && (
          <Settings
            run={run}
            theme={theme}
            onTheme={chooseTheme}
            autoUpdate={autoUpdate}
            onAutoUpdate={chooseAuto}
            update={update}
            updating={updating}
            onCheck={async () => void (await checkUpdate())}
            onInstall={installUpdate}
            onEngine={() => setChoosing(true)}
          />
        )}
        {page === "containers" && (
          <Containers
            containers={containers}
            sizes={sizes}
            images={images}
            run={run}
            onOpen={(id, tab = "overview") => setDetail({ id, tab })}
            onNew={() => setRunning({ image: "" })}
            onRecreate={(init) => setRunning(init)}
            onKube={(init) => {
              setToKube(init);
              setPage("kube");
            }}
          />
        )}
        {page === "images" && <Images
            images={images}
            containers={containers}
            run={run} showCli={showCli}
            onRun={(image) => setRunning({ image })}
            onOpen={(id) => setDetail({ id, tab: "overview" })}
          />}
        <div hidden={page !== "compose"}>
          <Compose
            containers={containers}
            run={run}
            showCli={showCli}
            onOpen={(id) => setDetail({ id, tab: "overview" })}
            onKube={(m) => {
              setToKube(m);
              setPage("kube");
            }}
          />
        </div>
        {/* Kept alive while hidden: a build or a compose command goes on,
            and its form and output are still there on coming back. */}
        {page === "kube" && <Kubernetes run={run} showCli={showCli} deployFrom={toKube} onDeployFromTaken={() => setToKube(null)} />}
        {page === "map" && (
          <Topology
            containers={containers}
            networks={networks}
            volumes={volumes}
            onOpen={(id) => setDetail({ id, tab: "overview" })}
            onGo={(to) => setPage(to)}
          />
        )}
        {/* Kept alive too: a box being built, or an agent's terminal. */}
        <div hidden={page !== "agents"}>
          <Agents containers={containers} run={run} showCli={showCli} onOpen={(id) => setDetail({ id, tab: "overview" })} />
        </div>
        <div hidden={page !== "builds"}>
          <Builds run={run} onRun={(image) => setRunning({ image })} />
        </div>
        {page === "volumes" && (
          <Volumes volumes={volumes} containers={containers} run={run} showCli={showCli} onOpen={(id) => setDetail({ id, tab: "overview" })} />
        )}
        {page === "networks" && (
          <Networks networks={networks} containers={containers} run={run} onOpen={(id) => setDetail({ id, tab: "overview" })} />
        )}
      </main>

      {open && detail && (
        <Detail
          c={open}
          tab={detail.tab}
          onTab={(tab) => setDetail({ id: detail.id, tab })}
          onClose={() => setDetail(null)}
          showCli={showCli}
          run={run}
          onEdit={viewer() ? undefined : () => settingsOf(open).then(setRunning, () => {})}
        />
      )}

      <PathPicker />
      <Alerts containers={containers} engine={engineLabel ?? ""} onOpen={(id) => setDetail({ id, tab: "overview" })} />
      {closing && (
        <Dialog title="창을 닫으면 어떻게 할까요?" onClose={() => setClosing(false)}>
          <p>BoxForge는 창을 닫아도 작업 표시줄의 트레이 아이콘으로 남아 계속 실행될 수 있습니다. 트레이 아이콘을 누르면 창이 다시 열립니다.</p>
          <p className="muted">나중에 설정 → 화면에서 바꿀 수 있습니다.</p>
          <div className="dialog-actions">
            <button
              onClick={() => {
                setClosing(false);
                call("CloseTo", false);
              }}
            >
              완전히 종료
            </button>
            <button
              className="primary"
              onClick={() => {
                setClosing(false);
                call("CloseTo", true);
              }}
            >
              트레이에 남기기
            </button>
          </div>
        </Dialog>
      )}
      {choosing && (
        <EngineDialog
          onClose={() => setChoosing(false)}
          onSwitched={(command) => {
            setDetail(null);
            setSizes(null);
            showCli(command);
            call<string>("EngineLabel").then(setEngineLabel, () => {});
          }}
        />
      )}

      {showHistory && (
        <aside className="drawer history" data-testid="history">
          <header>
            <h2>명령 기록</h2>
            <button onClick={() => setShowHistory(false)}>닫기</button>
          </header>
          <div className="drawer-body">
            <p className="muted">BoxForge에서 한 일을 터미널에서 하려면 치는 명령입니다. 최근 것이 위에 있습니다.</p>
            <ol className="history-list">
              {history
                .slice()
                .reverse()
                .map((h) => (
                  <li key={h.at + h.cmd}>
                    <span className="muted nowrap">{new Date(h.at).toLocaleTimeString()}</span>
                    <code>{h.cmd}</code>
                    <button className="link" onClick={() => copy(h.cmd)}>
                      {copied === h.cmd ? "복사됨" : "복사"}
                    </button>
                  </li>
                ))}
            </ol>
          </div>
        </aside>
      )}

      {palette && (
        <Palette
          pages={[...menu.filter((m) => m !== null), { id: "settings", label: "설정", icon: "gear" }] as { id: string; label: string; icon: string }[]}
          containers={containers}
          images={images}
          onPage={(id) => setPage(id as Page)}
          onContainer={openDetail}
          onRun={(init) => setRunning(init)}
          onClose={() => setPalette(false)}
        />
      )}

      {running !== null && (
        <RunDialog
          key={JSON.stringify(running)}
          init={running}
          images={images}
          networks={networks}
          run={run}
          onClose={() => setRunning(null)}
          onStarted={(id) => {
            setRunning(null);
            setPage("containers");
            if (id) setDetail({ id, tab: "logs" });
          }}
        />
      )}

      <footer className="statusbar">
        {error ? (
          <span className="status-error" role="alert" data-testid="error">
            {error}
            <button className="link" onClick={() => setError("")}>
              닫기
            </button>
          </span>
        ) : cli ? (
          <span className="cli" data-testid="cli">
            <span className="muted">같은 일을 하는 명령</span>
            <code>{cli}</code>
            <button className="link" onClick={() => copy(cli)}>
              {copied === cli ? "복사됨" : "복사"}
            </button>
            <button className="link" onClick={() => setShowHistory(!showHistory)} data-testid="history-toggle">
              기록 {history.length}
            </button>
          </span>
        ) : (
          <span className="muted">작업을 하면 같은 일을 하는 docker 명령이 여기에 표시됩니다.</span>
        )}
      </footer>
    </div>
  );
}
