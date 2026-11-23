import { useEffect, useMemo, useState } from "react";
import { call, type Container, type Run, type Volume } from "./bridge";
import { ago, bytes } from "./format";
import EngineCopy from "./EngineCopy";
import { Dialog, Icon, IconButton, Note } from "./ui";
import VolumeBrowser from "./VolumeBrowser";

interface Props {
  volumes: Volume[];
  containers: Container[];
  run: Run;
  showCli: (cmd: string) => void;
  onOpen: (containerId: string) => void;
}

type Filter = "all" | "used" | "unused";

// Docker names a volume nobody named with 64 hex digits.
const anonymous = (name: string) => /^[0-9a-f]{64}$/.test(name);

export default function Volumes({ volumes, containers, run, showCli, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sizes, setSizes] = useState<Record<string, number> | null>(null);
  const [creating, setCreating] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Volume | null>(null);
  const [pruning, setPruning] = useState(false);
  const [note, setNote] = useState("");
  const [browsing, setBrowsing] = useState<string | null>(null);
  const [copying, setCopying] = useState<Volume | null>(null);

  const names = volumes.map((v) => v.name).sort().join(",");
  useEffect(() => {
    if (!names) return;
    // Measuring is slow, and some engines can't: the column then stays empty.
    call<Record<string, number>>("VolumeSizes").then((s) => setSizes(s ?? {}), () => setSizes({}));
  }, [names]);

  const rows = useMemo(
    () =>
      volumes
        .map((v) => ({ v, users: containers.filter((c) => c.volumes.includes(v.name)).sort((a, b) => a.name.localeCompare(b.name)) }))
        .sort((a, b) => Number(anonymous(a.v.name)) - Number(anonymous(b.v.name)) || a.v.name.localeCompare(b.v.name)),
    [volumes, containers],
  );
  const unused = rows.filter((r) => r.users.length === 0);
  const counts = { all: rows.length, used: rows.length - unused.length, unused: unused.length };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows
      .filter((r) => filter === "all" || (filter === "used") === r.users.length > 0)
      .filter((r) => !q || r.v.name.toLowerCase().includes(q) || r.v.project.toLowerCase().includes(q));
  }, [rows, query, filter]);

  const confirmCreate = async () => {
    const name = (creating ?? "").trim();
    setCreating(null);
    if (name) await run(`docker volume create ${name}`, () => call("CreateVolume", name));
  };

  const confirmRemove = async () => {
    if (!removing) return;
    const name = removing.name;
    setRemoving(null);
    await run(`docker volume rm ${name}`, () => call("RemoveVolume", name));
  };

  const confirmPrune = async () => {
    setPruning(false);
    let freed = 0;
    if (await run("docker volume prune -a -f", async () => (freed = await call<number>("PruneVolumes")))) {
      setNote(`안 쓰는 볼륨을 정리해 ${bytes(freed)}를 확보했습니다.`);
    }
  };

  const chip = (f: Filter, label: string) => (
    <button className={"chip" + (filter === f ? " on" : "")} onClick={() => setFilter(f)} data-testid={`chip-${f}`}>
      {label} <span className="count">{counts[f]}</span>
    </button>
  );

  return (
    <section>
      <header className="page-head">
        <h1>볼륨</h1>
        <div className="chips">
          {chip("all", "전체")}
          {chip("used", "사용 중")}
          {chip("unused", "사용 안 함")}
        </div>
        <input className="search" type="search" placeholder="이름·프로젝트 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        {unused.length > 0 && <button onClick={() => setPruning(true)}>안 쓰는 볼륨 정리</button>}
        <button className="primary" onClick={() => setCreating("")}>
          새 볼륨
        </button>
      </header>
      <p className="lead">
        볼륨은 컨테이너를 지워도 남는 데이터 보관함입니다. 데이터베이스처럼 잃으면 안 되는 데이터는 볼륨에 둡니다.
      </p>
      {note && <Note onClose={() => setNote("")}>{note}</Note>}

      {shown.length === 0 ? (
        <p className="empty">{volumes.length === 0 ? "볼륨이 없습니다." : "조건에 맞는 볼륨이 없습니다."}</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>이름</th>
              <th>사용처</th>
              <th className="num">크기</th>
              <th>만든 때</th>
              <th className="actions">작업</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ v, users }) => (
              <tr key={v.name} data-testid={`volume-${v.name}`}>
                <td className="name-cell">
                  <div className="name-wrap">
                    <span className="avatar">
                      <Icon name="volume" />
                    </span>
                    <div className="name-text">
                      <button className="link name" title="안에 든 파일 보기" onClick={() => setBrowsing(v.name)}>
                        {anonymous(v.name) ? v.name.slice(0, 12) : v.name}
                      </button>
                      <span className="sub">
                        {anonymous(v.name) ? "이름 없이 자동으로 만들어진 볼륨" : v.project ? `Compose · ${v.project}` : v.driver}
                      </span>
                    </div>
                  </div>
                </td>
                <td>
                  {users.length === 0 ? (
                    <span className="muted">사용 안 함</span>
                  ) : (
                    <span className="used">
                      {users.slice(0, 3).map((c) => (
                        <button key={c.id} className="link" title="이 컨테이너의 상세 보기" onClick={() => onOpen(c.id)}>
                          {c.name}
                        </button>
                      ))}
                      {users.length > 3 && <span className="muted">외 {users.length - 3}개</span>}
                    </span>
                  )}
                </td>
                <td className="num nowrap">
                  {sizes === null ? <span className="muted">…</span> : v.name in sizes ? bytes(sizes[v.name]) : <span className="muted">—</span>}
                </td>
                <td className="muted nowrap">{ago(v.created)}</td>
                <td className="actions">
                  <IconButton icon="folder" label="내용 보기" onClick={() => setBrowsing(v.name)} />
                  <IconButton icon="send" label="다른 엔진으로 복사" onClick={() => setCopying(v)} />
                  <IconButton icon="trash" label="삭제" tone="danger" onClick={() => setRemoving(v)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {browsing && volumes.some((v) => v.name === browsing) && (
        <VolumeBrowser
          key={browsing}
          name={browsing}
          label={anonymous(browsing) ? browsing.slice(0, 12) : browsing}
          run={run}
          showCli={showCli}
          onClose={() => setBrowsing(null)}
        />
      )}

      {copying && (
        <EngineCopy
          title="볼륨을 다른 엔진으로 복사"
          what={
            <p>
              <strong>{anonymous(copying.name) ? copying.name.slice(0, 12) : copying.name}</strong> 볼륨과 그 안의 데이터를 다른 엔진에 넣습니다. 받는
              쪽에 같은 이름의 볼륨이 있으면 그 안에 채워 넣고, 이름이 같은 파일은 덮어씁니다. 여기 있는 볼륨은 그대로 남습니다.
            </p>
          }
          run={run}
          command={(other) =>
            `docker run --rm -v ${copying.name}:/v:ro alpine tar -cf - -C /v . | ${other} run --rm -i -v ${copying.name}:/v alpine tar -xf - -C /v`
          }
          copy={(key, target) => call<void>("CopyVolume", key, copying.name, target)}
          onClose={() => setCopying(null)}
          onDone={(label) => {
            setNote(`${anonymous(copying.name) ? copying.name.slice(0, 12) : copying.name} 볼륨을 "${label}"(으)로 복사했습니다.`);
            setCopying(null);
          }}
        />
      )}

      {creating !== null && (
        <Dialog title="새 볼륨" onClose={() => setCreating(null)}>
          <p>빈 볼륨을 만듭니다. 컨테이너를 실행할 때 "저장 공간"에 이 이름을 적어 연결합니다.</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              confirmCreate();
            }}
          >
            <input autoFocus className="field" aria-label="볼륨 이름" placeholder="예: pgdata" value={creating} onChange={(e) => setCreating(e.target.value)} />
            <div className="dialog-actions">
              <button type="button" onClick={() => setCreating(null)}>
                취소
              </button>
              <button className="primary" type="submit" disabled={!creating.trim()}>
                만들기
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {removing && (
        <Dialog title="볼륨 삭제" onClose={() => setRemoving(null)}>
          <p>
            <strong>{anonymous(removing.name) ? removing.name.slice(0, 12) : removing.name}</strong> 볼륨과 그 안의 데이터를 모두 삭제합니다.
            되돌릴 수 없습니다.
          </p>
          {containers.some((c) => c.volumes.includes(removing.name)) && (
            <p className="warn">컨테이너가 이 볼륨을 쓰고 있어 엔진이 삭제를 거부합니다. 먼저 그 컨테이너를 삭제해야 합니다.</p>
          )}
          <div className="dialog-actions">
            <button onClick={() => setRemoving(null)}>취소</button>
            <button className="danger solid" onClick={confirmRemove}>
              삭제
            </button>
          </div>
        </Dialog>
      )}

      {pruning && (
        <Dialog title="안 쓰는 볼륨 정리" onClose={() => setPruning(false)}>
          <p>어떤 컨테이너도 쓰지 않는 볼륨 {unused.length}개와 그 안의 데이터를 삭제합니다. 되돌릴 수 없습니다.</p>
          <ul className="plain doomed">
            {unused.map(({ v }) => (
              <li key={v.name}>
                <code>{anonymous(v.name) ? v.name.slice(0, 12) : v.name}</code>
                {sizes && v.name in sizes && <span className="muted"> {bytes(sizes[v.name])}</span>}
              </li>
            ))}
          </ul>
          <p className="warn">지금 멈춰 있는 컨테이너가 쓰는 볼륨은 남습니다. 컨테이너까지 지운 볼륨만 여기에 나옵니다.</p>
          <div className="dialog-actions">
            <button onClick={() => setPruning(false)}>취소</button>
            <button className="danger solid" onClick={confirmPrune}>
              {unused.length}개 삭제
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
