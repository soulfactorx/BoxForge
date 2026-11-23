import { useMemo, useState, useEffect } from "react";
import { Avatar } from "./brand";
import { call, openURL, type Container, type Image, type Run, type Size, remote } from "./bridge";
import { ago, bytes, isUp, stateLabel, statusText } from "./format";
import { ExportDialog, ImportDialog } from "./Bundle";
import type { RunInit } from "./recipes";
import { type Deploy, kubeName } from "./KubeExtras";
import EngineCopy, { explain } from "./EngineCopy";
import { BulkBar, Dialog, IconButton, Menu, PickBox, useSelection, type MenuItem } from "./ui";

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
  onRecreate: (init: RunInit) => void;
  /** Opens Kubernetes' deploy form filled from a container. */
  onKube?: (init: Partial<Deploy>) => void;
}

const healthText: Record<string, string> = { healthy: "정상", unhealthy: "이상", starting: "확인 중" };

/** What the image's own health check says of a running container. */
export function HealthBadge({ health }: { health: string }) {
  return (
    <span className={"health " + health} title="이미지에 정해진 상태 검사(healthcheck)의 결과입니다." data-testid="health">
      {healthText[health] ?? health}
    </span>
  );
}

/** Changes how much memory and CPU a running container may use, without remaking it. */
function LimitDialog({ c, run, onClose }: { c: Container; run: Run; onClose: () => void }) {
  const [mem, setMem] = useState("");
  const [cpus, setCpus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    call<string>("InspectContainer", c.id).then((raw) => {
      const h = JSON.parse(raw)?.HostConfig ?? {};
      if (h.Memory > 0) setMem(String(Math.round(h.Memory / (1 << 20))));
      if (h.NanoCpus > 0) setCpus(String(h.NanoCpus / 1e9));
    }, () => {});
  }, []);
  const m = mem.trim() === "" ? 0 : Number(mem);
  const k = cpus.trim() === "" ? 0 : Number(cpus);
  const bad = !(m >= 0) || !(k >= 0) || (m > 0 && m < 6);
  const command = `docker update --memory ${m > 0 ? m + "m" : "0"} --memory-swap ${m > 0 ? m * 2 + "m" : "-1"} --cpus ${k} ${c.name}`;
  const save = async () => {
    setBusy(true);
    setError("");
    let failed = "";
    const ok = await run(command, async () => {
      try {
        await call("LimitContainer", c.id, { memory: Math.round(m * (1 << 20)), cpus: k });
      } catch (e: any) {
        failed = e.message;
        throw e;
      }
    });
    setBusy(false);
    if (ok) onClose();
    else setError(failed);
  };
  return (
    <Dialog title={`${c.name}: 자원 제한`} onClose={onClose}>
      <p>컨테이너가 쓸 수 있는 메모리와 CPU의 상한입니다. 실행 중에 바로 바뀌고, 다시 만들 필요가 없습니다. 비워 두면 제한하지 않습니다.</p>
      <form
        className="run-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!bad) save();
        }}
      >
        <label>
          메모리 (MB)
          <input inputMode="numeric" aria-label="메모리 (MB)" placeholder="제한 없음" value={mem} onChange={(e) => setMem(e.target.value.replace(/[^\d]/g, ""))} />
          <span className="help">넘게 쓰면 엔진이 그 컨테이너의 프로그램을 끝냅니다. 6 이상. 예: 512</span>
        </label>
        <label>
          CPU (코어 수)
          <input inputMode="decimal" aria-label="CPU (코어 수)" placeholder="제한 없음" value={cpus} onChange={(e) => setCpus(e.target.value.replace(/[^\d.]/g, ""))} />
          <span className="help">1이면 코어 하나만큼, 0.5면 그 절반까지 씁니다.</span>
        </label>
        {bad && <p className="warn">메모리는 6MB 이상의 숫자, CPU는 0보다 큰 숫자로 적어 주세요.</p>}
        <div className="cli-preview">
          <span className="muted">같은 일을 하는 명령</span>
          <code>{command}</code>
        </div>
        {error && (
          <p className="warn" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            취소
          </button>
          <button className="primary" type="submit" disabled={bad || busy}>
            {busy ? "바꾸는 중…" : "바꾸기"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * A container as Kubernetes' deploy form takes it: image, name, the port it
 * serves, its environment, and a terminal kept open if it had one. Not its
 * command (in Kubernetes that would replace the image's entrypoint) and not
 * its data: a volume's content stays in the engine.
 */
function toDeploy(c: Container, s: RunInit): Partial<Deploy> {
  return {
    image: c.image,
    name: kubeName(c.name),
    port: (s.ports ?? []).map((p) => p.b).find((p) => /^\d+$/.test(p)) ?? "",
    env: s.env ?? [],
    keepOpen: !!s.interactive,
  };
}

/** The ports a container was made to publish: host → container. */
function bindings(info: any, c: Container): { a: string; b: string }[] {
  const out: { a: string; b: string }[] = [];
  for (const [key, list] of Object.entries<any>(info?.HostConfig?.PortBindings ?? {})) {
    const [port, proto] = key.split("/");
    if (proto && proto !== "tcp") continue; // the form makes TCP ports
    for (const b of list ?? []) if (b?.HostPort) out.push({ a: b.HostPort, b: port });
  }
  if (out.length) return out;
  return c.ports.filter((p) => p.public).map((p) => ({ a: String(p.public), b: String(p.private) }));
}

/** Reads a container's settings back into the form that made it. */
export async function settingsOf(c: Container): Promise<RunInit> {
  const info = JSON.parse(await call<string>("InspectContainer", c.id));
  const env: string[] = info?.Config?.Env ?? [];
  const mode: string = info?.HostConfig?.NetworkMode ?? "";
  const own = c.networks.map((n) => n.network).find((n) => !["bridge", "host", "none"].includes(n));
  return {
    image: c.image,
    name: c.name,
    // From its settings, not the list: a container just started may not
    // show its published ports there yet.
    ports: bindings(info, c),
    mounts: (info?.Mounts ?? []).filter((m: any) => m.Destination && (m.Name || m.Source)).map((m: any) => ({ a: m.Type === "volume" ? m.Name : m.Source, b: m.Destination })),
    env: env
      .filter((e) => !/^(PATH|HOSTNAME)=/.test(e))
      .map((e) => ({ a: e.slice(0, e.indexOf("=")), b: e.slice(e.indexOf("=") + 1) })),
    restart: ["always", "unless-stopped", "on-failure"].includes(info?.HostConfig?.RestartPolicy?.Name) ? info.HostConfig.RestartPolicy.Name : "",
    command: (info?.Config?.Cmd ?? []).map((w: string) => (/[\s"']/.test(w) ? JSON.stringify(w) : w)).join(" "),
    network: own ?? (mode && !["default", "bridge", "host", "none"].includes(mode) && !mode.startsWith("container:") ? mode : ""),
    interactive: info?.Config?.Tty ? true : undefined,
    replace: { id: c.id, name: c.name },
  };
}

export default function Containers({ containers, sizes, images, run, onOpen, onNew, onRecreate, onKube }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [showSystem, setShowSystem] = useState(false);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState<{ id: string; draft: string } | null>(null);
  const [removing, setRemoving] = useState<{ c: Container; volumes: boolean } | null>(null);
  const [copying, setCopying] = useState<Container | null>(null);
  const [exporting, setExporting] = useState<string[] | null>(null);
  const [limiting, setLimiting] = useState<Container | null>(null);
  const [importing, setImporting] = useState(false);
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

  // Rows picked for one action on them all.
  const shownAll = useMemo(() => items.flatMap((g) => g.members), [items]);
  const pick = useSelection(shownAll.map((c) => c.id));
  const picked = shownAll.filter((c) => pick.has(c.id));
  const [bulkRemoving, setBulkRemoving] = useState<{ volumes: boolean } | null>(null);

  // All at once (a stop waits for its container), every failure told
  // together at the end.
  const each = async (list: Container[], work: (c: Container) => Promise<unknown>) => {
    const done = await Promise.allSettled(list.map(work));
    const failed = done.flatMap((d, i) => (d.status === "rejected" ? [`${list[i].name}: ${d.reason?.message ?? d.reason}`] : []));
    if (failed.length) throw new Error(failed.join("\n"));
  };
  const bulk = (action: "start" | "stop" | "restart") => {
    const todo = picked.filter((c) => (action === "start" ? !isUp(c) : action === "stop" ? isUp(c) : true));
    if (todo.length === 0) return;
    return during(todo.map((c) => c.id), action, () =>
      run(`docker ${action} ${todo.map((c) => c.name).join(" ")}`, () => each(todo, (c) => call("ContainerAction", c.id, action))),
    );
  };
  const confirmBulkRemove = async () => {
    if (!bulkRemoving) return;
    const { volumes } = bulkRemoving;
    const list = picked;
    setBulkRemoving(null);
    pick.clear();
    await during(list.map((c) => c.id), "remove", () =>
      run(`docker rm -f${volumes ? " -v" : ""} ${list.map((c) => c.name).join(" ")}`, () => each(list, (c) => call("RemoveContainer", c.id, isUp(c), volumes))),
    );
  };

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
      if (!remote()) items.push({ label: "외부 터미널 열기", onClick: () => run(`docker exec -it ${c.name} sh`, () => call("OpenTerminal", c.name)) });
    }
    if (isUp(c)) items.push({ label: "자원 제한 바꾸기", onClick: () => setLimiting(c) });
    items.push({ label: "설정 바꿔 다시 만들기", onClick: () => settingsOf(c).then(onRecreate, () => {}) });
    items.push({ label: "다른 엔진으로 복사", onClick: () => setCopying(c) });
    items.push({ label: "파일로 내보내기", onClick: () => setExporting([c.id]) });
    if (onKube) items.push({ label: "Kubernetes로 배포", onClick: () => settingsOf(c).then((s) => onKube(toDeploy(c, s)), () => {}) });
    if (isUp(c)) items.push({ label: "강제 종료", onClick: () => act(c, "kill"), danger: true });
    return items;
  };

  const row = (c: Container, nested: boolean) => (
    <tr key={c.id} className={(nested ? "nested" : "") + (pick.has(c.id) ? " picked" : "")} data-testid={`row-${c.name}`}>
      <td className="pick">
        <PickBox label={`${c.name} 고르기`} state={pick.has(c.id)} onChange={() => pick.toggle(c.id)} />
      </td>
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
              {c.health && c.state === "running" && <HealthBadge health={c.health} />}
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
        <button onClick={() => setImporting(true)}>가져오기</button>
        <button disabled={containers.length === 0} onClick={() => setExporting([])}>
          내보내기
        </button>
        <button className="primary" onClick={onNew}>
          새 컨테이너 실행
        </button>
      </header>

      <BulkBar count={pick.size} onClear={pick.clear}>
        <button type="button" disabled={!picked.some((c) => !isUp(c))} onClick={() => bulk("start")}>
          시작
        </button>
        <button type="button" disabled={!picked.some(isUp)} onClick={() => bulk("stop")}>
          중지
        </button>
        <button type="button" onClick={() => bulk("restart")}>
          재시작
        </button>
        <button type="button" onClick={() => setExporting(picked.map((c) => c.id))}>
          파일로 내보내기
        </button>
        <button type="button" className="danger" onClick={() => setBulkRemoving({ volumes: false })}>
          삭제
        </button>
      </BulkBar>

      {items.length === 0 ? (
        <p className="empty">{visible.length === 0 ? "컨테이너가 없습니다." : "조건에 맞는 컨테이너가 없습니다."}</p>
      ) : (
        <table className="grid">
          <thead>
            <tr>
              <th className="pick">
                <PickBox label="보이는 컨테이너 모두 고르기" state={pick.state(shownAll.map((c) => c.id))} onChange={(on) => pick.setMany(shownAll.map((c) => c.id), on)} />
              </th>
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
                  <td className="pick">
                    <PickBox label={`${g.project} 프로젝트 모두 고르기`} state={pick.state(g.members.map((c) => c.id))} onChange={(on) => pick.setMany(g.members.map((c) => c.id), on)} />
                  </td>
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

      {limiting && <LimitDialog c={limiting} run={run} onClose={() => setLimiting(null)} />}
      {exporting && (
        <ExportDialog
          containers={containers}
          picked={exporting}
          run={run}
          onClose={() => setExporting(null)}
          onDone={(file) => {
            setCopied({ text: `파일로 내보냈습니다: ${file} — 이 파일을 다른 PC의 BoxForge에서 "가져오기"로 열면 됩니다.`, notes: [] });
            setExporting(null);
          }}
        />
      )}
      {importing && (
        <ImportDialog
          run={run}
          onClose={() => setImporting(false)}
          onDone={(names, notes) => {
            setCopied({ text: `가져왔습니다: ${names.join(", ")}. 멈춘 상태로 만들어졌으니 확인한 뒤 시작하세요.`, notes });
            setImporting(false);
          }}
        />
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
            { key: "folders", label: "연결한 폴더와 Compose 파일도 복사", help: "컨테이너가 엔진의 컴퓨터에서 연결해 쓰는 폴더 · 파일(./config 등)과 Compose 파일을 받는 쪽의 같은 경로에 둡니다. 이미 있으면 그대로 둡니다." },
          ]}
          run={run}
          command={(other) => `docker commit ${copying.name} copy:tmp && docker save copy:tmp | ${other} load && ${other} create --name ${copying.name} copy:tmp`}
          copy={(key, target, chosen) => call<string[]>("CopyContainer", key, copying.id, target, { changes: chosen.changes, volumes: chosen.volumes, folders: chosen.folders })}
          onClose={() => setCopying(null)}
          onDone={(label, notes) => {
            setCopied({ text: `${copying.name} 컨테이너를 "${label}"에 만들었습니다. 그 엔진으로 바꿔서 시작하면 됩니다.`, notes: explain(notes) });
            setCopying(null);
          }}
        />
      )}

      {bulkRemoving && (
        <Dialog title={`컨테이너 ${picked.length}개 삭제`} onClose={() => setBulkRemoving(null)}>
          <p>고른 컨테이너를 삭제합니다. 컨테이너 안에서 바뀐 파일은 사라지며 되돌릴 수 없습니다. 볼륨(이름 붙은 데이터)은 남습니다.</p>
          <ul className="bulk-list" data-testid="bulk-remove-list">
            {picked.map((c) => (
              <li key={c.id}>
                <strong>{c.name}</strong> <span className="muted">{c.image}</span> {isUp(c) && <span className="warn">· 실행 중 (강제로 멈춘 뒤 삭제)</span>}
              </li>
            ))}
          </ul>
          <label className="check">
            <input type="checkbox" checked={bulkRemoving.volumes} onChange={(e) => setBulkRemoving({ volumes: e.target.checked })} />
            이 컨테이너들의 이름 없는 볼륨도 함께 삭제
          </label>
          <div className="dialog-actions">
            <button type="button" onClick={() => setBulkRemoving(null)}>
              취소
            </button>
            <button type="button" className="danger solid" onClick={confirmBulkRemove}>
              {`${picked.length}개 삭제`}
            </button>
          </div>
        </Dialog>
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
