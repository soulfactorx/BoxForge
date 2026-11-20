import { useMemo, useState } from "react";
import { call, type Container, type Network, type Run } from "./bridge";
import { ago, isUp } from "./format";
import { Dialog, Icon, IconButton } from "./ui";

interface Props {
  networks: Network[];
  containers: Container[];
  run: Run;
  onOpen: (containerId: string) => void;
}

const builtinHelp: Record<string, string> = {
  bridge: "따로 정하지 않은 컨테이너가 들어가는 기본 네트워크. 여기서는 이름으로 서로를 찾지 못합니다",
  host: "컨테이너가 내 PC의 네트워크를 그대로 씀",
  none: "네트워크 없음",
};

export default function Networks({ networks, containers, run, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState<{ name: string; subnet: string } | null>(null);
  const [removing, setRemoving] = useState<Network | null>(null);
  const [connecting, setConnecting] = useState<{ net: Network; id: string } | null>(null);
  const [pruning, setPruning] = useState(false);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return networks
      .map((n) => ({
        n,
        members: containers
          .filter((c) => c.networks.some((a) => a.network === n.name))
          .sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name)),
      }))
      .filter(({ n }) => !q || n.name.toLowerCase().includes(q) || n.project.toLowerCase().includes(q))
      .sort((a, b) => Number(a.n.builtin) - Number(b.n.builtin) || a.n.name.localeCompare(b.n.name));
  }, [networks, containers, query]);
  const idle = rows.filter((r) => !r.n.builtin && r.members.length === 0);

  const confirmCreate = async () => {
    if (!creating) return;
    const name = creating.name.trim();
    const subnet = creating.subnet.trim();
    setCreating(null);
    if (name) await run(`docker network create ${subnet ? `--subnet ${subnet} ` : ""}${name}`, () => call("CreateNetwork", name, subnet));
  };

  const confirmRemove = async () => {
    if (!removing) return;
    const n = removing;
    setRemoving(null);
    await run(`docker network rm ${n.name}`, () => call("RemoveNetwork", n.id));
  };

  const confirmConnect = async () => {
    if (!connecting) return;
    const { net, id } = connecting;
    const c = containers.find((x) => x.id === id);
    setConnecting(null);
    if (c) await run(`docker network connect ${net.name} ${c.name}`, () => call("ConnectNetwork", net.id, c.id));
  };

  const disconnect = (n: Network, c: Container) =>
    run(`docker network disconnect ${n.name} ${c.name}`, () => call("DisconnectNetwork", n.id, c.id));

  const confirmPrune = async () => {
    setPruning(false);
    await run("docker network prune -f", () => call("PruneNetworks"));
  };

  return (
    <section>
      <header className="page-head">
        <h1>네트워크</h1>
        <input className="search" type="search" placeholder="이름·프로젝트 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        {idle.length > 0 && <button onClick={() => setPruning(true)}>안 쓰는 네트워크 정리</button>}
        <button className="primary" onClick={() => setCreating({ name: "", subnet: "" })}>
          새 네트워크
        </button>
      </header>
      <p className="lead">
        같은 네트워크에 있는 컨테이너끼리는 컨테이너 이름을 주소로 써서 서로 접속할 수 있습니다. 예를 들어 앱 컨테이너에서
        데이터베이스 주소로 <code>db:5432</code>를 씁니다. 직접 만든 네트워크에서만 이렇게 됩니다.
      </p>

      {rows.length === 0 ? (
        <p className="empty">{networks.length === 0 ? "네트워크가 없습니다." : "조건에 맞는 네트워크가 없습니다."}</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>이름</th>
              <th>주소 범위</th>
              <th>연결된 컨테이너</th>
              <th>만든 때</th>
              <th className="actions">작업</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ n, members }) => (
              <tr key={n.id} data-testid={`network-${n.name}`}>
                <td className="name-cell">
                  <div className="name-wrap">
                    <span className="avatar">
                      <Icon name="network" />
                    </span>
                    <div className="name-text">
                      <span className="name">{n.name}</span>
                      {n.builtin && <span className="pill tag-inline">기본</span>}
                      {n.internal && <span className="pill tag-inline">외부 차단</span>}
                      <span className="sub">{n.builtin ? builtinHelp[n.name] : n.project ? `Compose · ${n.project}` : n.driver}</span>
                    </div>
                  </div>
                </td>
                <td className="nowrap">
                  {n.subnet ? (
                    <>
                      <code>{n.subnet}</code>
                      {n.gateway && <span className="sub">게이트웨이 {n.gateway}</span>}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  {members.length === 0 ? (
                    <span className="muted">없음</span>
                  ) : (
                    <span className="used">
                      {members.map((c) => {
                        const ip = c.networks.find((a) => a.network === n.name)?.ip;
                        return (
                          <span key={c.id} className="member">
                            <button className="link" title="이 컨테이너의 상세 보기" onClick={() => onOpen(c.id)}>
                              {c.name}
                            </button>
                            {ip && <code className="muted">{ip}</code>}
                            {n.name !== "host" && n.name !== "none" && (
                              <button className="link unlink" title={`${c.name}을(를) 이 네트워크에서 떼기`} aria-label={`${c.name} 연결 끊기`} onClick={() => disconnect(n, c)}>
                                끊기
                              </button>
                            )}
                          </span>
                        );
                      })}
                    </span>
                  )}
                </td>
                <td className="muted nowrap">{ago(n.created)}</td>
                <td className="actions">
                  {n.name !== "host" && n.name !== "none" && (
                    <IconButton icon="plus" label="컨테이너 연결" onClick={() => setConnecting({ net: n, id: "" })} />
                  )}
                  {!n.builtin && <IconButton icon="trash" label="삭제" tone="danger" onClick={() => setRemoving(n)} />}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {creating && (
        <Dialog title="새 네트워크" onClose={() => setCreating(null)}>
          <p>컨테이너들이 이름으로 서로를 찾을 수 있는 네트워크를 만듭니다.</p>
          <form
            className="run-form"
            onSubmit={(e) => {
              e.preventDefault();
              confirmCreate();
            }}
          >
            <label>
              이름
              <input autoFocus placeholder="예: myapp" value={creating.name} onChange={(e) => setCreating({ ...creating, name: e.target.value })} />
            </label>
            <label>
              주소 범위
              <input placeholder="비워 두면 Docker가 정합니다 (예: 172.30.0.0/16)" value={creating.subnet} onChange={(e) => setCreating({ ...creating, subnet: e.target.value })} />
              <span className="help">대부분 비워 두면 됩니다. 회사 네트워크 주소와 겹칠 때만 직접 정합니다.</span>
            </label>
            <div className="dialog-actions">
              <button type="button" onClick={() => setCreating(null)}>
                취소
              </button>
              <button className="primary" type="submit" disabled={!creating.name.trim()}>
                만들기
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {connecting && (
        <Dialog title="컨테이너 연결" onClose={() => setConnecting(null)}>
          <p>
            <strong>{connecting.net.name}</strong> 네트워크에 컨테이너를 연결합니다. 컨테이너는 여러 네트워크에 동시에 있을 수 있습니다.
          </p>
          <select className="field" aria-label="연결할 컨테이너" value={connecting.id} onChange={(e) => setConnecting({ ...connecting, id: e.target.value })}>
            <option value="">컨테이너 선택</option>
            {containers
              .filter((c) => !c.system && !c.networks.some((a) => a.network === connecting.net.name))
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} {isUp(c) ? "" : "(멈춤)"}
                </option>
              ))}
          </select>
          <div className="dialog-actions">
            <button onClick={() => setConnecting(null)}>취소</button>
            <button className="primary" disabled={!connecting.id} onClick={confirmConnect}>
              연결
            </button>
          </div>
        </Dialog>
      )}

      {removing && (
        <Dialog title="네트워크 삭제" onClose={() => setRemoving(null)}>
          <p>
            <strong>{removing.name}</strong> 네트워크를 삭제합니다.
          </p>
          {containers.some((c) => c.networks.some((a) => a.network === removing.name)) && (
            <p className="warn">연결된 컨테이너가 있어 엔진이 삭제를 거부할 수 있습니다. 먼저 연결을 끊으세요.</p>
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
        <Dialog title="안 쓰는 네트워크 정리" onClose={() => setPruning(false)}>
          <p>컨테이너가 하나도 연결되지 않은 네트워크 {idle.length}개를 삭제합니다.</p>
          <ul className="plain doomed">
            {idle.map(({ n }) => (
              <li key={n.id}>
                <code>{n.name}</code>
              </li>
            ))}
          </ul>
          <div className="dialog-actions">
            <button onClick={() => setPruning(false)}>취소</button>
            <button className="danger solid" onClick={confirmPrune}>
              {idle.length}개 삭제
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
