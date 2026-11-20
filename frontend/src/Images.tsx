import { useEffect, useMemo, useState } from "react";
import { Avatar, splitRef } from "./brand";
import { call, on, type Container, type Image, type PullState, type Run } from "./bridge";
import { ago, bytes, shortId } from "./format";
import { Dialog, Icon, IconButton, Progress } from "./ui";

interface Props {
  images: Image[];
  containers: Container[];
  run: Run;
  onRun: (image: string) => void;
  onOpen: (containerId: string) => void;
}

type Filter = "all" | "used" | "unused";
type SortKey = "name" | "size" | "created";

/** One line of the table: an image under one of its names, as `docker images` lists them. */
interface Row {
  im: Image;
  ref: string; // "" for an image with no name
  repo: string;
  tag: string;
  users: Container[];
}

export default function Images({ images, containers, run, onRun, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<{ key: SortKey; down: boolean }>({ key: "name", down: false });
  const [ref, setRef] = useState("");
  const [pull, setPull] = useState<PullState | null>(null);
  const [removing, setRemoving] = useState<Row | null>(null);
  const [tagging, setTagging] = useState<{ row: Row; draft: string } | null>(null);
  const [pruning, setPruning] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => on("pull", (p: PullState) => setPull(p.done ? null : p)), []);

  const rows = useMemo(() => {
    const out: Row[] = [];
    for (const im of images) {
      // Build workers last: the containers the user made are the ones worth naming.
      const users = containers
        .filter((c) => c.imageId === im.id)
        .sort((a, b) => Number(a.system) - Number(b.system) || a.name.localeCompare(b.name));
      if (im.tags.length === 0) out.push({ im, ref: "", repo: "이름 없음", tag: "", users });
      for (const t of im.tags) out.push({ im, ref: t, ...splitRef(t), users });
    }
    return out;
  }, [images, containers]);

  const counts = {
    all: rows.length,
    used: rows.filter((r) => r.users.length > 0).length,
    unused: rows.filter((r) => r.users.length === 0).length,
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const by: Record<SortKey, (a: Row, b: Row) => number> = {
      name: (a, b) => a.repo.localeCompare(b.repo) || a.tag.localeCompare(b.tag),
      size: (a, b) => a.im.size - b.im.size,
      created: (a, b) => a.im.created - b.im.created,
    };
    const list = rows
      .filter((r) => filter === "all" || (filter === "used") === r.users.length > 0)
      .filter((r) => !q || r.ref.toLowerCase().includes(q) || r.im.id.includes(q))
      .sort(by[sort.key]);
    return sort.down ? list.reverse() : list;
  }, [rows, query, filter, sort]);

  const dangling = images.filter((im) => im.tags.length === 0 && im.inUse === 0);
  const total = images.reduce((n, im) => n + im.size, 0);

  const doPull = async (name: string) => {
    if (!name || pull) return false;
    setNote("");
    setPull({ ref: name, status: "", percent: -1, done: false, error: "" });
    const ok = await run(`docker pull ${name}`, () => call("PullImage", name));
    if (ok) setNote(`${name} 이미지를 받았습니다.`);
    setPull(null);
    return ok;
  };

  // A name the image shares with others comes off alone, as `docker rmi name`
  // does. Its last name takes the image with it, which needs force when a
  // container was made from it. An image with no name goes by ID.
  const removal = (r: Row) => {
    const last = r.im.tags.length <= 1;
    const force = last && r.users.length > 0;
    const target = r.ref || r.im.id;
    return { last, force, target, command: `docker rmi${force ? " -f" : ""} ${r.ref || shortId(r.im.id)}` };
  };

  const confirmRemove = async () => {
    if (!removing) return;
    const { force, target, command } = removal(removing);
    setRemoving(null);
    await run(command, () => call("RemoveImage", target, force));
  };

  const confirmTag = async () => {
    if (!tagging) return;
    const { row, draft } = tagging;
    const target = draft.trim();
    setTagging(null);
    if (!target) return;
    await run(`docker tag ${row.ref || shortId(row.im.id)} ${target}`, () => call("TagImage", row.ref || row.im.id, target));
  };

  const confirmPrune = async () => {
    setPruning(false);
    let freed = 0;
    if (await run("docker image prune -f", async () => (freed = await call<number>("PruneImages")))) {
      setNote(`이름 없는 이미지를 정리해 ${bytes(freed)}를 확보했습니다.`);
    }
  };

  const chip = (f: Filter, label: string) => (
    <button className={"chip" + (filter === f ? " on" : "")} onClick={() => setFilter(f)} data-testid={`chip-${f}`}>
      {label} <span className="count">{counts[f]}</span>
    </button>
  );

  const head = (key: SortKey, label: string) => (
    <button
      className={"sort" + (sort.key === key ? " on" : "")}
      title="누르면 이 기준으로 정렬합니다"
      onClick={() => setSort({ key, down: sort.key === key ? !sort.down : key !== "name" })}
    >
      {label}
      {sort.key === key ? <span aria-hidden="true">{sort.down ? "↓" : "↑"}</span> : <Icon name="sort" />}
    </button>
  );

  return (
    <section>
      <header className="page-head">
        <h1>이미지</h1>
        <span className="muted">{bytes(total)}</span>
        <div className="chips">
          {chip("all", "전체")}
          {chip("used", "사용 중")}
          {chip("unused", "사용 안 함")}
        </div>
        <input className="search" type="search" placeholder="이름·ID 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        {dangling.length > 0 && <button onClick={() => setPruning(true)}>이름 없는 이미지 정리</button>}
      </header>

      <form
        className="pull-bar"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await doPull(ref.trim())) setRef("");
        }}
      >
        <label htmlFor="pull-ref">이미지 받기</label>
        <input
          id="pull-ref"
          placeholder="예: nginx, postgres:17, ghcr.io/owner/app:1.0"
          value={ref}
          onChange={(e) => setRef(e.target.value)}
          disabled={!!pull}
        />
        <button className="primary" type="submit" disabled={!ref.trim() || !!pull}>
          받기
        </button>
      </form>
      {pull && (
        <div className="pull-progress" data-testid="pull-progress">
          <span>
            {pull.ref} 받는 중{pull.percent >= 0 ? ` · ${pull.percent}%` : ""} <span className="muted">{pull.status}</span>
          </span>
          <Progress percent={pull.percent} />
        </div>
      )}
      {note && !pull && <p className="note">{note}</p>}

      {shown.length === 0 ? (
        <p className="empty">{images.length === 0 ? "이미지가 없습니다. 위에서 이름을 넣어 받아 보세요." : "조건에 맞는 이미지가 없습니다."}</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th>{head("name", "리포지토리")}</th>
              <th>태그</th>
              <th>사용처</th>
              <th>ID</th>
              <th className="num">{head("size", "크기")}</th>
              <th>{head("created", "만든 때")}</th>
              <th className="actions">작업</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.im.id + r.ref} data-testid={`image-${r.ref || "none"}`}>
                <td className="name-cell">
                  <div className="name-wrap">
                    <Avatar image={r.ref} kind="layers" />
                    <span className={"name" + (r.ref ? "" : " muted")}>{r.repo}</span>
                  </div>
                </td>
                <td>{r.tag ? <span className="pill">{r.tag}</span> : <span className="muted">—</span>}</td>
                <td>
                  {r.users.length === 0 ? (
                    <span className="muted">사용 안 함</span>
                  ) : (
                    <span className="used">
                      {r.users.slice(0, 3).map((c) => (
                        <button key={c.id} className="link" title="이 컨테이너의 상세 보기" onClick={() => onOpen(c.id)}>
                          {c.name}
                        </button>
                      ))}
                      {r.users.length > 3 && <span className="muted">외 {r.users.length - 3}개</span>}
                    </span>
                  )}
                </td>
                <td>
                  <code className="muted">{shortId(r.im.id)}</code>
                </td>
                <td className="num nowrap">{bytes(r.im.size)}</td>
                <td className="muted nowrap">{ago(r.im.created)}</td>
                <td className="actions">
                  {r.ref && <IconButton icon="play" label="이 이미지로 컨테이너 실행" tone="go" onClick={() => onRun(r.ref)} />}
                  {r.ref && <IconButton icon="download" label="다시 받기 (새 버전 확인)" disabled={!!pull} onClick={() => doPull(r.ref)} />}
                  <IconButton icon="tag" label="태그 추가" onClick={() => setTagging({ row: r, draft: "" })} />
                  <IconButton icon="trash" label="삭제" tone="danger" onClick={() => setRemoving(r)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {removing && (
        <Dialog title="이미지 삭제" onClose={() => setRemoving(null)}>
          {removal(removing).last ? (
            <p>
              <strong>{removing.ref || "이름 없는"}</strong> 이미지를 삭제합니다. 다시 쓰려면 새로 받아야 합니다.
            </p>
          ) : (
            <p>
              <strong>{removing.ref}</strong> 이름만 지웁니다. 이미지는 다른 이름({removing.im.tags.filter((t) => t !== removing.ref).join(", ")})으로
              남습니다.
            </p>
          )}
          {removal(removing).force && (
            <p className="warn">컨테이너 {removing.users.length}개가 이 이미지로 만들어졌습니다. 강제로 삭제하며, 그 컨테이너들은 남습니다.</p>
          )}
          <div className="dialog-actions">
            <button onClick={() => setRemoving(null)}>취소</button>
            <button className="danger solid" onClick={confirmRemove}>
              삭제
            </button>
          </div>
        </Dialog>
      )}

      {tagging && (
        <Dialog title="태그 추가" onClose={() => setTagging(null)}>
          <p>
            <strong>{tagging.row.ref || "이름 없는 이미지"}</strong>에 이름을 하나 더 붙입니다. 이미지가 복사되지는 않습니다.
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              confirmTag();
            }}
          >
            <input
              autoFocus
              className="field"
              aria-label="새 태그"
              placeholder="예: myapp:1.0"
              value={tagging.draft}
              onChange={(e) => setTagging({ ...tagging, draft: e.target.value })}
            />
            <div className="dialog-actions">
              <button type="button" onClick={() => setTagging(null)}>
                취소
              </button>
              <button className="primary" type="submit" disabled={!tagging.draft.trim()}>
                추가
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {pruning && (
        <Dialog title="이름 없는 이미지 정리" onClose={() => setPruning(false)}>
          <p>
            이름이 없고 어떤 컨테이너도 쓰지 않는 이미지 {dangling.length}개를 삭제합니다. 약{" "}
            {bytes(dangling.reduce((n, im) => n + im.size, 0))}입니다. 보통 이미지를 다시 빌드하거나 새로 받으면서 남은
            예전 버전입니다.
          </p>
          <div className="dialog-actions">
            <button onClick={() => setPruning(false)}>취소</button>
            <button className="danger solid" onClick={confirmPrune}>
              정리
            </button>
          </div>
        </Dialog>
      )}
    </section>
  );
}
