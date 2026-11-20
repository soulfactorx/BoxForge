import { useEffect, useState } from "react";
import { Avatar } from "./brand";
import { call, type Container, type EngineStatus, type Image, type Run, type Volume } from "./bridge";
import { bytes, isUp, statusText } from "./format";
import { recipes, type RunInit } from "./recipes";
import { Dialog, Icon } from "./ui";

interface Usage {
  images: number;
  imagesFree: number;
  containers: number;
  containersFree: number;
  volumes: number;
  volumesFree: number;
  buildCache: number;
  buildCacheFree: number;
  stoppedCount: number;
  unusedVolumes: number;
  unusedImages: number;
}

interface Props {
  engine: EngineStatus;
  containers: Container[];
  images: Image[];
  volumes: Volume[];
  run: Run;
  go: (page: "containers" | "images" | "volumes" | "compose" | "builds" | "kube" | "map") => void;
  onRun: (init: RunInit) => void;
  onOpen: (containerId: string) => void;
  onEngine: () => void;
}

type Sweep = "containers" | "images" | "volumes" | "cache";

/** The first screen: what is running, what one might want to do, what needs a look. */
export default function Home({ engine, containers, images, volumes, run, go, onRun, onOpen, onEngine }: Props) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const [note, setNote] = useState("");

  const mine = containers.filter((c) => !c.system);
  const running = mine.filter(isUp);
  const failed = mine.filter((c) => c.failed);
  const projects = new Set(mine.filter((c) => c.project).map((c) => c.project)).size;

  const measure = () => call<Usage>("DiskUsage").then(setUsage, () => setUsage(null));
  const key = engine.connected ? mine.length + ":" + images.length + ":" + volumes.length : "";
  useEffect(() => {
    if (engine.connected) measure();
  }, [key]);

  const sweeps: Record<Sweep, { title: string; what: string; command: string; method: string }> = {
    containers: { title: "멈춘 컨테이너 정리", what: `멈춰 있는 컨테이너 ${usage?.stoppedCount ?? 0}개를 삭제합니다. 그 안에서 바뀐 파일은 사라집니다. 볼륨의 데이터는 남습니다.`, command: "docker container prune -f", method: "PruneContainers" },
    images: { title: "이름 없는 이미지 정리", what: "이름이 없고 어떤 컨테이너도 쓰지 않는 이미지를 삭제합니다. 보통 다시 빌드하거나 새로 받으면서 남은 예전 버전입니다.", command: "docker image prune -f", method: "PruneImages" },
    volumes: { title: "안 쓰는 볼륨 정리", what: `어떤 컨테이너도 쓰지 않는 볼륨 ${usage?.unusedVolumes ?? 0}개와 그 안의 데이터를 삭제합니다. 데이터베이스 내용이 들어 있을 수 있으니 볼륨 화면에서 먼저 확인하세요.`, command: "docker volume prune -a -f", method: "PruneVolumes" },
    cache: { title: "빌드 캐시 지우기", what: "빌드를 빠르게 하려고 저장해 둔 중간 결과를 지웁니다. 다음 빌드가 오래 걸립니다.", command: "docker builder prune -f", method: "PruneBuildCache" },
  };

  const doSweep = async () => {
    if (!sweep) return;
    const s = sweeps[sweep];
    setSweep(null);
    let freed: unknown = 0;
    if (await run(s.command, async () => (freed = await call(s.method)))) {
      setNote(typeof freed === "number" ? `${s.title}: ${bytes(freed)}를 확보했습니다.` : `${s.title}를 마쳤습니다.`);
      measure();
    }
  };

  const rows: { id: Sweep; label: string; total: number; free: number }[] = usage
    ? [
        { id: "images", label: "이미지", total: usage.images, free: usage.imagesFree },
        { id: "containers", label: "컨테이너가 쓴 것", total: usage.containers, free: usage.containersFree },
        { id: "volumes", label: "볼륨", total: usage.volumes, free: usage.volumesFree },
        { id: "cache", label: "빌드 캐시", total: usage.buildCache, free: usage.buildCacheFree },
      ]
    : [];
  const most = Math.max(1, ...rows.map((r) => r.total));

  return (
    <section className="home">
      <header className="hero">
        <div>
          <h1>{engine.connected ? "무엇을 해 볼까요?" : "먼저 엔진이 필요합니다"}</h1>
          <p className="muted">
            {engine.connected
              ? `컨테이너 ${running.length}개가 돌고 있습니다.`
              : "컨테이너를 실행하는 프로그램(Docker Engine)에 연결되지 않았습니다. 설치되어 있지 않다면 BoxForge가 설치해 드립니다."}
          </p>
        </div>
        {!engine.connected && (
          <button className="primary big" onClick={onEngine}>
            엔진 설치 · 선택
          </button>
        )}
      </header>

      {engine.connected && (
        <>
          <div className="tiles">
            <button className="tile" onClick={() => go("containers")}>
              <Icon name="box" />
              <strong>
                {running.length}
                <small> / {mine.length}</small>
              </strong>
              <span>실행 중인 컨테이너</span>
            </button>
            <button className="tile" onClick={() => go("compose")}>
              <Icon name="compose" />
              <strong>{projects}</strong>
              <span>Compose 프로젝트</span>
            </button>
            <button className="tile" onClick={() => go("images")}>
              <Icon name="layers" />
              <strong>{images.length}</strong>
              <span>이미지</span>
            </button>
            <button className="tile" onClick={() => go("volumes")}>
              <Icon name="volume" />
              <strong>{volumes.length}</strong>
              <span>볼륨</span>
            </button>
          </div>

          {failed.length > 0 && (
            <div className="panel attention" data-testid="attention">
              <h2>살펴볼 것</h2>
              {failed.slice(0, 5).map((c) => (
                <button key={c.id} className="attention-row" onClick={() => onOpen(c.id)}>
                  <span className="state failed">
                    <span className="dot" />
                  </span>
                  <strong>{c.name}</strong>
                  <span className="muted">{statusText(c)}</span>
                  <span className="link">왜 멈췄는지 보기</span>
                </button>
              ))}
            </div>
          )}

          <div className="panel">
            <h2>바로 실행하기</h2>
            <p className="muted">자주 쓰는 프로그램은 설정이 미리 채워집니다. 눌러서 확인하고 실행하세요.</p>
            <div className="recipes">
              {recipes.map((r) => (
                <button key={r.title} className="recipe" onClick={() => onRun(r)} data-testid={`recipe-${r.title}`}>
                  <Avatar image={r.image} kind="box" />
                  <span>
                    <strong>{r.title}</strong>
                    <span className="sub">{r.about}</span>
                  </span>
                </button>
              ))}
              <button className="recipe other" onClick={() => onRun({ image: "" })}>
                <span className="avatar">
                  <Icon name="plus" />
                </span>
                <span>
                  <strong>다른 이미지</strong>
                  <span className="sub">이름을 직접 입력</span>
                </span>
              </button>
            </div>
          </div>

          <div className="two-up">
            <div className="panel">
              <h2>더 해 보기</h2>
              <div className="ways">
                <button onClick={() => go("compose")}>
                  <Icon name="compose" />
                  <span>
                    <strong>여러 개를 묶어서 실행</strong>
                    <span className="sub">compose 파일을 열어 한 번에 올립니다</span>
                  </span>
                </button>
                <button onClick={() => go("builds")}>
                  <Icon name="build" />
                  <span>
                    <strong>내 코드를 이미지로 만들기</strong>
                    <span className="sub">폴더와 Dockerfile로 빌드합니다</span>
                  </span>
                </button>
                <button onClick={() => go("map")}>
                  <Icon name="map" />
                  <span>
                    <strong>전체 구조 보기</strong>
                    <span className="sub">포트 · 컨테이너 · 네트워크 · 볼륨의 관계</span>
                  </span>
                </button>
                <button onClick={() => go("kube")}>
                  <Icon name="kube" />
                  <span>
                    <strong>Kubernetes 연습</strong>
                    <span className="sub">작은 클러스터를 켜고 배포해 봅니다</span>
                  </span>
                </button>
              </div>
            </div>

            <div className="panel" data-testid="disk">
              <h2>디스크</h2>
              {note && <p className="note">{note}</p>}
              {!usage ? (
                <p className="muted">재는 중…</p>
              ) : (
                <div className="disk">
                  {rows.map((r) => (
                    <div key={r.id} className="disk-row">
                      <span>{r.label}</span>
                      <span className="disk-bar" role="img" aria-label={`${r.label} ${bytes(r.total)}, 그중 비울 수 있는 것 ${bytes(r.free)}`}>
                        <span style={{ width: `${(r.total / most) * 100}%` }}>
                          <span style={{ width: r.total > 0 ? `${(r.free / r.total) * 100}%` : 0 }} />
                        </span>
                      </span>
                      <span className="num">{bytes(r.total)}</span>
                      <button disabled={r.free <= 0} title={r.free > 0 ? `${bytes(r.free)} 비울 수 있음` : "비울 것이 없습니다"} onClick={() => setSweep(r.id)}>
                        정리
                      </button>
                    </div>
                  ))}
                  <p className="muted disk-key">
                    <span className="key-free" /> 옅은 부분은 아무도 쓰지 않아 비울 수 있는 양입니다.
                  </p>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {sweep && (
        <Dialog title={sweeps[sweep].title} onClose={() => setSweep(null)}>
          <p>{sweeps[sweep].what}</p>
          <p className="muted">되돌릴 수 없습니다.</p>
          <div className="dialog-actions">
            <button onClick={() => setSweep(null)}>취소</button>
            <button className="danger solid" onClick={doSweep}>
              정리
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
