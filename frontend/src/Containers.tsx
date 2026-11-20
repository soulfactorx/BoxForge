import { useMemo, useState } from "react";
import { Avatar } from "./brand";
import { call, openURL, type Container, type Image, type Run, type Size } from "./bridge";
import { ago, bytes, isUp, stateLabel, statusText } from "./format";
import EngineCopy, { explain } from "./EngineCopy";
import { Dialog, IconButton, Menu, type MenuItem } from "./ui";

type Filter = "all" | "running" | "stopped" | "failed";

function bucket(c: Container): Exclude<Filter, "all"> {
  if (isUp(c)) return "running";
  return c.failed ? "failed" : "stopped";
}

/** Published ports, one per host port. */
export function published(c: Container) {
  const seen = new Set<number>();
  return c.ports.filter((p) => p.public > 0 && !seen.has(p.public) && seen.add(p.public));
}

type Item = { key: string; project: string; members: Container[] };

const doing: Record<string, string> = {
  start: "시작하는 중", stop: "중지하는 중", restart: "재시작하는 중", pause: "일시정지하는 중",
  unpause: "재개하는 중", kill: "강제 종료하는 중", remove: "삭제하는 중",
};
// Why some of these take a while.
const waitHint: Record<string, string> = {
  stop: "프로그램이 스스로 끝나기를 최대 10초 기다립니다",
  restart: "프로그램이 스스로 끝나기를 최대 10초 기다린 뒤 다시 시작합니다",
};

interface Props {
  containers: Container[];
  sizes: Record<string, Size> | null; // null until the engine has measured
  images: Image[];
  run: Run;
  onOpen: (id: string, tab?: "overview" | "logs") => void;
  onNew: () => void;
}

export default function Containers({ containers, sizes, images, run, onOpen, onNew }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [removing, setRemoving] = useState<{ c: Container; volumes: boolean } | null>(null);
  const [copying, setCopying] = useState<Container | null>(null);
  const [copied, setCopied] = useState<{ text: string; notes: string[] } | null>(null);
  // What is being done to each container right now, by ID: shown in its
  // row until the engine has answered.
  const [pending, setPending] = useState<Record<string, string>>({});

  const during = async (ids: string[], action: string, work: () => Promise<unknown>) => {
    setPending((p) => ({ ...p, ...Object.fromEntries(ids.map((id) => [id, action])) }));
    try {
      return await work();
    } finally {
      // A moment more: the row's new state comes from the engine just after.
      setTimeout(
        () =>
          setPending((p) => {
            const next = { ...p };
            ids.forEach((id) => next[id] === action && delete next[id]);
            return next;
          }),
        400,
      );
    }
  };

  const hidden = useMemo(() => containers.filter((c) => c.system).length, [containers]);
  const visible = useMemo(() => (showSystem ? containers : containers.filter((c) => !c.system)), [containers, showSystem]);

  const counts = useMemo(() => {
    const n = { all: visible.length, running: 0, stopped: 0, failed: 0 };
    visible.forEach((c) => n[bucket(c)]++);
    return n;
  }, [visible]);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = visible.filter(
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
  }, [visible, filter, query]);

  const act = (c: Container, action: string) =>
    during([c.id], action, () => run(`docker ${action} ${c.name}`, () => call("ContainerAction", c.id, action)));

  const actAll = (g: Item, action: "start" | "stop") => {
    const todo = g.members.filter((c) => (action === "start" ? !isUp(c) : isUp(c)));
    return during(todo.map((c) => c.id), action, () =>
      run(`docker compose -p ${g.project} ${action}`, () => Promise.all(todo.map((c) => call("ContainerAction", c.id, action)))),
    );
  };

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
    await during([c.id], "remove", () =>
      run(`docker rm${force ? " -f" : ""}${volumes ? " -v" : ""} ${c.name}`, () => call("RemoveContainer", c.id, force, volumes)),
    );
  };

  const toggle = (project: string) =>
    setCollapsed((old) => {
      const next = new Set(old);
      next.has(project) ? next.delete(project) : next.add(project);
      return next;
    });

  const menu = (c: Container): MenuItem[] => {
    const items: MenuItem[] = [
      { label: "상세 보기", onClick: () => onOpen(c.id) },
      { label: "로그 보기", onClick: () => onOpen(c.id, "logs") },
      { label: "이름 변경", onClick: () => setRenaming({ id: c.id, draft: c.name }) },
    ];
    if (c.state === "paused") items.push({ label: "재개", onClick: () => act(c, "unpause") });
    else if (c.state === "running") items.push({ label: "일시정지", onClick: () => act(c, "pause") });
    if (c.state === "running") {
      items.push({ label: "외부 터미널 열기", onClick: () => run(`docker exec -it ${c.name} sh`, () => call("OpenTerminal", c.name)) });
    }
    items.push({ label: "다른 엔진으로 복사", onClick: () => setCopying(c) });
    if (isUp(c)) items.push({ label: "강제 종료", onClick: () => act(c, "kill"), danger: true });
    return items;
  };

  const row = (c: Container, nested: boolean) => (
    <tr key={c.id} className={nested ? "nested" : ""} data-testid={`row-${c.name}`}>
      <td className="name-cell">
        <div className="name-wrap">
        <Avatar image={c.image} kind="box" />
        <div className="name-text">
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
          <span className="name-line">
            <button className="link name" onClick={() => onOpen(c.id)}>
              {c.name}
            </button>
            <span className="hover-only">
              <IconButton icon="edit" label="이름 변경" onClick={() => setRenaming({ id: c.id, draft: c.name })} />
            </span>
          </span>
        )}
        <span className="sub">{c.image}</span>
        </div>
        </div>
      </td>
      <td>
        {pending[c.id] ? (
          <>
            <span className="state busy" role="status">
              <span className="spinner" />
              {doing[pending[c.id]] ?? "처리하는 중"}…
            </span>
            <span className="sub">{waitHint[pending[c.id]] ?? "엔진의 응답을 기다리고 있습니다"}</span>
          </>
        ) : (
          <>
            <span className={"state " + (c.failed ? "failed" : c.state)}>
              <span className="dot" />
              {c.failed ? "실패" : stateLabel[c.state] ?? c.state}
            </span>
            <span className="sub" title={c.status}>
              {statusText(c)}
            </span>
          </>
        )}
      </td>
      <td className="ports">
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
      {sizeCell(c)}
      <td className="muted nowrap">{ago(c.created)}</td>
      <td className="actions">
        {isUp(c) && <IconButton icon="restart" label="재시작" disabled={!!pending[c.id]} onClick={() => act(c, "restart")} />}
        {isUp(c) ? (
          <IconButton icon="stop" label="중지" tone="danger" disabled={!!pending[c.id]} onClick={() => act(c, "stop")} />
        ) : (
          <IconButton icon="play" label="시작" tone="go" disabled={!!pending[c.id]} onClick={() => act(c, "start")} />
        )}
        <IconButton icon="trash" label="삭제" tone="danger" disabled={!!pending[c.id]} onClick={() => setRemoving({ c, volumes: false })} />
        <Menu items={menu(c)} />
      </td>
    </tr>
  );

  // The engine's own measure when it gives one. Some engines answer 0 for
  // every container; the image's size then stands in, which is the bulk of it.
  const sizeCell = (c: Container) => {
    const s = sizes?.[c.id];
    if (s && s.rootFs > 0) {
      return (
        <td className="num nowrap" title="컨테이너가 보는 전체 파일 크기입니다. 이미지와 겹치는 부분이 포함됩니다.">
          {bytes(s.rootFs)}
          {s.rw > 0 && <span className="sub">직접 쓴 것 {bytes(s.rw)}</span>}
        </td>
      );
    }
    if (sizes === null) {
      return (
        <td className="num">
          <span className="muted">…</span>
        </td>
      );
    }
    const im = images.find((i) => i.id === c.imageId) ?? images.find((i) => i.tags.includes(c.image));
    return (
      <td className="num nowrap" title="이 엔진은 컨테이너별 크기를 알려주지 않아, 컨테이너가 쓰는 이미지의 크기를 대신 보여줍니다.">
        {im ? (
          <>
            {bytes(im.size)}
            <span className="sub">이미지 크기</span>
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    );
  };

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
        <button className="primary" onClick={onNew}>
          새 컨테이너 실행
        </button>
      </header>

      {items.length === 0 ? (
        <p className="empty">{visible.length === 0 ? "컨테이너가 없습니다." : "조건에 맞는 컨테이너가 없습니다."}</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>이름</th>
              <th>상태</th>
              <th>포트</th>
              <th className="num">크기</th>
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
                  <td colSpan={5}>
                    <button className="twisty" aria-expanded={open} aria-label={open ? "접기" : "펼치기"} onClick={() => toggle(g.project)}>
                      {open ? "▾" : "▸"}
                    </button>
                    <strong>{g.project}</strong>
                    <span className="sub inline">
                      Compose · {g.members.length}개 중 {up}개 실행
                    </span>
                  </td>
                  <td className="actions">
                    {up < g.members.length && <IconButton icon="play" label="모두 시작" tone="go" onClick={() => actAll(g, "start")} />}
                    {up > 0 && <IconButton icon="stop" label="모두 중지" tone="danger" onClick={() => actAll(g, "stop")} />}
                  </td>
                </tr>,
                ...(open ? g.members.map((c) => row(c, true)) : []),
              ];
            })}
          </tbody>
        </table>
      )}

      {hidden > 0 && (
        <p className="footnote">
          {showSystem
            ? `빌드 도구가 만든 컨테이너 ${hidden}개를 함께 보여주고 있습니다.`
            : `빌드 도구가 만든 컨테이너 ${hidden}개는 숨겼습니다.`}
          <button className="link" onClick={() => setShowSystem(!showSystem)}>
            {showSystem ? "숨기기" : "보기"}
          </button>
        </p>
      )}

      {copied && (
        <div className="note-box copied" role="status" data-testid="copied">
          <strong>{copied.text}</strong>
          {copied.notes.length > 0 && (
            <ul>
              {copied.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          <button className="link" onClick={() => setCopied(null)}>
            닫기
          </button>
        </div>
      )}

      {copying && (
        <EngineCopy
          title="컨테이너를 다른 엔진으로 복사"
          what={
            <p>
              <strong>{copying.name}</strong>과 같은 컨테이너를 다른 엔진에 만듭니다. 받는 쪽에서는 시작하지 않은 상태로 만들어지고, 여기 있는
              컨테이너는 그대로 남습니다.
            </p>
          }
          options={[
            { key: "changes", label: "컨테이너 안에서 바뀐 파일도 가져가기", help: "지금 상태를 이미지로 만들어 보냅니다. 끄면 원래 이미지 그대로 새로 만듭니다." },
            {
              key: "volumes",
              label: `연결된 볼륨의 데이터도 복사${copying.volumes.length ? ` (${copying.volumes.length}개)` : ""}`,
              help: copying.volumes.length ? "데이터베이스 같은 볼륨의 내용이 함께 갑니다. 크면 오래 걸립니다." : "이 컨테이너에는 볼륨이 없습니다.",
            },
          ]}
          run={run}
          command={(other) => `docker commit ${copying.name} copy:tmp && docker save copy:tmp | ${other} load && ${other} create --name ${copying.name} copy:tmp`}
          copy={(key, target, chosen) => call<string[]>("CopyContainer", key, copying.id, target, { changes: chosen.changes, volumes: chosen.volumes })}
          onClose={() => setCopying(null)}
          onDone={(label, notes) => {
            setCopied({ text: `${copying.name} 컨테이너를 "${label}"에 만들었습니다. 그 엔진으로 바꿔서 시작하면 됩니다.`, notes: explain(notes) });
            setCopying(null);
          }}
        />
      )}

      {removing && (
        <Dialog title="컨테이너 삭제" onClose={() => setRemoving(null)}>
          <p>
            <strong>{removing.c.name}</strong> 컨테이너를 삭제합니다. 컨테이너 안에서 바뀐 파일은 사라지며 되돌릴 수 없습니다.
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
        </Dialog>
      )}
    </section>
  );
}
