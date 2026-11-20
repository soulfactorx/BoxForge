import { useMemo, useState } from "react";
import { call, openURL, type Container } from "./bridge";

type Run = (command: string, action: () => Promise<unknown>) => Promise<boolean>;
type Filter = "all" | "running" | "stopped" | "failed";

const isUp = (c: Container) => c.state === "running" || c.state === "paused" || c.state === "restarting";

function bucket(c: Container): Exclude<Filter, "all"> {
  if (isUp(c)) return "running";
  return c.failed ? "failed" : "stopped";
}

const stateLabel: Record<string, string> = {
  running: "실행 중",
  paused: "일시정지",
  restarting: "재시작 중",
  exited: "중지됨",
  created: "생성됨",
  dead: "오류",
  removing: "삭제 중",
};

function ago(unix: number) {
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

/** Published ports, one per host port. */
function published(c: Container) {
  const seen = new Set<number>();
  return c.ports.filter((p) => p.public > 0 && !seen.has(p.public) && seen.add(p.public));
}

type Item = { key: string; project: string; members: Container[] };

export default function Containers({ containers, run }: { containers: Container[]; run: Run }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [removing, setRemoving] = useState<{ c: Container; volumes: boolean } | null>(null);

  const counts = useMemo(() => {
    const n = { all: containers.length, running: 0, stopped: 0, failed: 0 };
    containers.forEach((c) => n[bucket(c)]++);
    return n;
  }, [containers]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = containers.filter(
      (c) =>
        (filter === "all" || bucket(c) === filter) &&
        (!q || c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q) || c.project.toLowerCase().includes(q)),
    );
    const groups = new Map<string, Item>();
    const out: Item[] = [];
    for (const c of shown) {
      if (!c.project) {
        out.push({ key: c.name, project: "", members: [c] });
        continue;
      }
      let g = groups.get(c.project);
      if (!g) {
        g = { key: c.project, project: c.project, members: [] };
        groups.set(c.project, g);
        out.push(g);
      }
      g.members.push(c);
    }
    out.forEach((g) => g.members.sort((a, b) => a.name.localeCompare(b.name)));
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }, [containers, filter, query]);

  const act = (c: Container, action: string) =>
    run(`docker ${action} ${c.name}`, () => call("ContainerAction", c.id, action));

  const actAll = (g: Item, action: "start" | "stop") =>
    run(`docker compose -p ${g.project} ${action}`, () =>
      Promise.all(
        g.members.filter((c) => (action === "start" ? !isUp(c) : isUp(c))).map((c) => call("ContainerAction", c.id, action)),
      ),
    );

  const commitRename = async (c: Container) => {
    const name = renaming?.draft.trim() ?? "";
    setRenaming(null);
    if (!name || name === c.name) return;
    await run(`docker rename ${c.name} ${name}`, () => call("RenameContainer", c.id, name));
  };

  const confirmRemove = async () => {
    if (!removing) return;
    const { c, volumes } = removing;
    const force = isUp(c);
    setRemoving(null);
    await run(`docker rm${force ? " -f" : ""}${volumes ? " -v" : ""} ${c.name}`, () =>
      call("RemoveContainer", c.id, force, volumes),
    );
  };

  const toggle = (project: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      next.has(project) ? next.delete(project) : next.add(project);
      return next;
    });

  const row = (c: Container, nested: boolean) => (
    <tr key={c.id} className={nested ? "nested" : ""} data-testid={`row-${c.name}`}>
      <td className="name-cell">
        {renaming?.id === c.id ? (
          <input
            autoFocus
            className="rename"
            aria-label="새 이름"
            value={renaming.draft}
            onChange={(e) => setRenaming({ id: c.id, draft: e.target.value })}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename(c);
              if (e.key === "Escape") setRenaming(null);
            }}
            onBlur={() => setRenaming(null)}
          />
        ) : (
          <span
            className="name"
            title="더블클릭하면 이름을 바꿉니다"
            onDoubleClick={() => setRenaming({ id: c.id, draft: c.name })}
          >
            {c.name}
          </span>
        )}
        <span className="sub">{c.image}</span>
      </td>
      <td>
        <span className={"state " + (c.failed ? "failed" : c.state)}>
          <span className="dot" />
          {c.failed ? "실패" : stateLabel[c.state] ?? c.state}
        </span>
        <span className="sub">{c.status}</span>
      </td>
      <td>
        {published(c).length === 0
          ? "—"
          : published(c).map((p) => (
              <button
                key={p.public}
                className="link port"
                title={`브라우저에서 http://localhost:${p.public} 열기`}
                onClick={() => openURL(`http://localhost:${p.public}`)}
              >
                {p.public}→{p.private}
              </button>
            ))}
      </td>
      <td className="muted">{ago(c.created)}</td>
      <td className="actions">
        {c.state === "paused" ? (
          <button onClick={() => act(c, "unpause")}>재개</button>
        ) : isUp(c) ? (
          <>
            <button onClick={() => act(c, "stop")}>중지</button>
            <button onClick={() => act(c, "restart")}>재시작</button>
            <button onClick={() => act(c, "pause")}>일시정지</button>
          </>
        ) : (
          <button onClick={() => act(c, "start")}>시작</button>
        )}
        <button onClick={() => setRenaming({ id: c.id, draft: c.name })}>이름 변경</button>
        <button className="danger" onClick={() => setRemoving({ c, volumes: false })}>
          삭제
        </button>
      </td>
    </tr>
  );

  const chip = (f: Filter, label: string) => (
    <button className={"chip " + f + (filter === f ? " on" : "")} onClick={() => setFilter(f)} data-testid={`chip-${f}`}>
      {label} <span className="count">{counts[f]}</span>
    </button>
  );

  return (
    <section>
      <header className="page-head">
        <h1>컨테이너</h1>
        <div className="chips">
          {chip("all", "전체")}
          {chip("running", "실행 중")}
          {chip("stopped", "중지")}
          {chip("failed", "실패")}
        </div>
        <input
          className="search"
          type="search"
          placeholder="이름·이미지·프로젝트 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </header>

      {items.length === 0 ? (
        <p className="empty">
          {containers.length === 0 ? "컨테이너가 없습니다." : "조건에 맞는 컨테이너가 없습니다."}
        </p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>이름</th>
              <th>상태</th>
              <th>포트</th>
              <th>생성</th>
              <th className="actions">작업</th>
            </tr>
          </thead>
          <tbody>
            {items.flatMap((g) => {
              if (!g.project) return [row(g.members[0], false)];
              const up = g.members.filter(isUp).length;
              const open = !collapsed.has(g.project);
              return [
                <tr key={"g:" + g.project} className="group" data-testid={`group-${g.project}`}>
                  <td colSpan={4}>
                    <button className="twisty" aria-expanded={open} onClick={() => toggle(g.project)}>
                      {open ? "▾" : "▸"}
                    </button>
                    <strong>{g.project}</strong>
                    <span className="sub inline">
                      Compose · {g.members.length}개 중 {up}개 실행
                    </span>
                  </td>
                  <td className="actions">
                    {up < g.members.length && <button onClick={() => actAll(g, "start")}>모두 시작</button>}
                    {up > 0 && <button onClick={() => actAll(g, "stop")}>모두 중지</button>}
                  </td>
                </tr>,
                ...(open ? g.members.map((c) => row(c, true)) : []),
              ];
            })}
          </tbody>
        </table>
      )}

      {removing && (
        <div className="overlay" onClick={() => setRemoving(null)}>
          <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2>컨테이너 삭제</h2>
            <p>
              <strong>{removing.c.name}</strong> 컨테이너를 삭제합니다. 컨테이너 안에서 바뀐 파일은 사라지며 되돌릴 수
              없습니다.
            </p>
            {isUp(removing.c) && <p className="warn">지금 실행 중입니다. 강제로 멈춘 뒤 삭제합니다.</p>}
            <label className="check">
              <input
                type="checkbox"
                checked={removing.volumes}
                onChange={(e) => setRemoving({ ...removing, volumes: e.target.checked })}
              />
              이 컨테이너의 이름 없는 볼륨도 함께 삭제
            </label>
            <div className="dialog-actions">
              <button onClick={() => setRemoving(null)}>취소</button>
              <button className="danger solid" onClick={confirmRemove}>
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
