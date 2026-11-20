import { useCallback, useEffect, useState } from "react";
import { call, on, STREAM_OPEN, type Container, type EngineStatus, type Image } from "./bridge";
import Containers from "./Containers";
import Detail, { type Tab } from "./Detail";
import Images from "./Images";
import RunDialog from "./RunDialog";
import { Icon } from "./ui";

type Page = "containers" | "images";
const upcoming = ["볼륨", "네트워크", "Compose", "빌드"];

function gib(bytes: number) {
  return (bytes / 2 ** 30).toFixed(1) + " GB";
}

export default function App() {
  const [engine, setEngine] = useState<EngineStatus>({ connected: false, error: "", info: null });
  const [containers, setContainers] = useState<Container[]>([]);
  const [images, setImages] = useState<Image[]>([]);
  const [page, setPage] = useState<Page>("containers");
  const [detail, setDetail] = useState<{ id: string; tab: Tab } | null>(null);
  const [running, setRunning] = useState<string | null>(null); // the run dialog's starting image
  const [cli, setCli] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const load = () => {
      call<EngineStatus>("Engine").then(setEngine).catch(() => {});
      call<Container[]>("Containers").then((l) => setContainers(l ?? [])).catch(() => {});
      call<Image[]>("Images").then((l) => setImages(l ?? [])).catch(() => {});
    };
    const off = [
      on("engine", setEngine),
      on("containers", (l) => setContainers(l ?? [])),
      on("images", (l) => setImages(l ?? [])),
      on(STREAM_OPEN, load),
    ];
    load();
    return () => off.forEach((f) => f());
  }, []);

  const showCli = useCallback((command: string) => {
    setCli(command);
    setCopied(false);
  }, []);

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
          {nav("images", "layers", "이미지", images.length)}
          {upcoming.map((name) => (
            <div key={name} className="nav-item disabled" title="아직 만들지 않은 화면입니다">
              <span className="icon" />
              <span>{name}</span>
              <span className="soon">예정</span>
            </div>
          ))}
        </nav>
        <div className="engine-card" data-testid="engine-card">
          <div className="engine-head">
            <span className={"dot " + (engine.connected ? "ok" : "bad")} />
            <strong>{info ? `${info.runtime} ${info.version}` : "엔진"}</strong>
            <span className="muted">{engine.connected ? "실행 중" : "연결 안 됨"}</span>
          </div>
          {info && engine.connected && (
            <dl>
              <dt>실행 중</dt>
              <dd>
                {info.running} / {info.containers}
              </dd>
              <dt>CPU</dt>
              <dd>{info.cpus}개</dd>
              <dt>메모리</dt>
              <dd>{gib(info.memTotal)}</dd>
            </dl>
          )}
        </div>
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
            run={run}
            onOpen={(id, tab = "overview") => setDetail({ id, tab })}
            onNew={() => setRunning("")}
          />
        )}
        {page === "images" && <Images images={images} run={run} onRun={(image) => setRunning(image)} />}
      </main>

      {open && detail && (
        <Detail
          c={open}
          tab={detail.tab}
          onTab={(tab) => setDetail({ id: detail.id, tab })}
          onClose={() => setDetail(null)}
          showCli={showCli}
        />
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
            <button
              className="link"
              onClick={() => navigator.clipboard?.writeText(cli).then(() => setCopied(true), () => {})}
            >
              {copied ? "복사됨" : "복사"}
            </button>
          </span>
        ) : (
          <span className="muted">작업을 하면 같은 일을 하는 docker 명령이 여기에 표시됩니다.</span>
        )}
      </footer>
    </div>
  );
}
