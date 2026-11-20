import { useCallback, useEffect, useState } from "react";
import { call, on, STREAM_OPEN, type Container, type EngineStatus, type Image, type Network, type Size, type Volume } from "./bridge";
import Networks from "./Networks";
import Volumes from "./Volumes";
import Builds from "./Builds";
import Compose from "./Compose";
import Containers from "./Containers";
import Detail, { type Tab } from "./Detail";
import EngineDialog from "./EngineDialog";
import Images from "./Images";
import Kubernetes from "./Kubernetes";
import RunDialog from "./RunDialog";
import Topology from "./Topology";
import { bytes } from "./format";
import { Icon } from "./ui";

type Page = "containers" | "map" | "images" | "volumes" | "networks" | "compose" | "builds" | "kube";

const pageCommand: Record<Page, string> = {
  containers: "docker ps -a --size",
  map: "docker ps -a && docker network ls && docker volume ls",
  compose: "docker compose ls -a",
  images: "docker images",
  volumes: "docker volume ls",
  networks: "docker network ls",
  builds: "docker buildx version",
  kube: "docker exec boxforge-k3s kubectl get pods,deployments,services -A",
};

function gib(bytes: number) {
  return (bytes / 2 ** 30).toFixed(1) + " GB";
}

export default function App() {
  const [engine, setEngine] = useState<EngineStatus>({ connected: false, error: "", info: null });
  const [containers, setContainers] = useState<Container[]>([]);
  const [images, setImages] = useState<Image[]>([]);
  const [sizes, setSizes] = useState<Record<string, Size> | null>(null);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [page, setPage] = useState<Page>("containers");
  const [detail, setDetail] = useState<{ id: string; tab: Tab } | null>(null);
  const [running, setRunning] = useState<string | null>(null); // the run dialog's starting image
  const [history, setHistory] = useState<{ cmd: string; at: number }[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [choosing, setChoosing] = useState(false);
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

  const showCli = useCallback((command: string) => {
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
        setError(e.message);
        return false;
      }
    },
    [showCli],
  );

  const info = engine.info;
  const shownCount = containers.filter((c) => !c.system).length;
  const open = detail && containers.find((c) => c.id === detail.id);
  const nav = (id: Page, icon: string, label: string, count: number) => (
    <button className={"nav-item" + (page === id ? " active" : "")} onClick={() => setPage(id)} data-testid={`nav-${id}`}>
      <Icon name={icon} />
      <span>{label}</span>
      <span className="count">{count}</span>
    </button>
  );

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">BoxForge</div>
        <nav>
          {nav("containers", "box", "컨테이너", shownCount)}
          <button className={"nav-item" + (page === "map" ? " active" : "")} onClick={() => setPage("map")} data-testid="nav-map">
            <Icon name="map" />
            <span>관계도</span>
          </button>
          {nav("compose", "compose", "Compose", new Set(containers.filter((c) => c.project).map((c) => c.project)).size)}
          {nav("images", "layers", "이미지", images.length)}
          {nav("volumes", "volume", "볼륨", volumes.length)}
          {nav("networks", "network", "네트워크", networks.length)}
          <button className={"nav-item" + (page === "builds" ? " active" : "")} onClick={() => setPage("builds")} data-testid="nav-builds">
            <Icon name="build" />
            <span>빌드</span>
          </button>
          <button className={"nav-item" + (page === "kube" ? " active" : "")} onClick={() => setPage("kube")} data-testid="nav-kube">
            <Icon name="kube" />
            <span>Kubernetes</span>
          </button>
        </nav>
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
        {!engine.connected && (
          <div className="banner" role="alert">
            <strong>Docker 엔진에 연결할 수 없습니다.</strong> 다시 연결을 시도하고 있습니다.
            {engine.error && <div className="banner-detail">{engine.error}</div>}
          </div>
        )}
        {page === "containers" && (
          <Containers
            containers={containers}
            sizes={sizes}
            images={images}
            run={run}
            onOpen={(id, tab = "overview") => setDetail({ id, tab })}
            onNew={() => setRunning("")}
          />
        )}
        {page === "images" && <Images
            images={images}
            containers={containers}
            run={run}
            onRun={(image) => setRunning(image)}
            onOpen={(id) => setDetail({ id, tab: "overview" })}
          />}
        <div hidden={page !== "compose"}>
          <Compose containers={containers} run={run} showCli={showCli} onOpen={(id) => setDetail({ id, tab: "overview" })} />
        </div>
        {/* Kept alive while hidden: a build or a compose command goes on,
            and its form and output are still there on coming back. */}
        {page === "kube" && <Kubernetes run={run} showCli={showCli} />}
        {page === "map" && (
          <Topology
            containers={containers}
            networks={networks}
            volumes={volumes}
            onOpen={(id) => setDetail({ id, tab: "overview" })}
            onGo={(to) => setPage(to)}
          />
        )}
        <div hidden={page !== "builds"}>
          <Builds run={run} onRun={(image) => setRunning(image)} />
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
        />
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

      {running !== null && (
        <RunDialog
          image={running}
          images={images}
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
