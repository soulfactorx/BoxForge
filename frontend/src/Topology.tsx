import { useMemo, useState } from "react";
import { openURL, type Container, type Network, type Volume } from "./bridge";
import { published } from "./Containers";
import { isUp, stateLabel } from "./format";

interface Props {
  containers: Container[];
  networks: Network[];
  volumes: Volume[];
  onOpen: (containerId: string) => void;
  onGo: (page: "networks" | "volumes") => void;
}

type Kind = "port" | "container" | "network" | "volume";
interface Node {
  key: string;
  kind: Kind;
  x: number;
  y: number; // top
  w: number;
  h: number;
  title: string;
  sub: string;
  dim?: boolean;
  state?: string;
  act: () => void;
  hint: string;
}
interface Edge {
  a: string; // left node
  b: string; // right node
  kind: "port" | "network" | "volume";
}

// Column positions and sizes, in SVG units.
const PORT = { x: 8, w: 132, h: 30 };
const BOX = { x: 220, w: 260, h: 46 };
const SIDE = { x: 580, w: 230, h: 40 };
const GAP = 10;
const WIDTH = SIDE.x + SIDE.w + 8;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const anonymous = (name: string) => /^[0-9a-f]{64}$/.test(name);

/** Places items at the heights they ask for, pushed down where they would overlap. */
function settle<T extends { want: number; h: number }>(items: T[], gap: number): (T & { y: number })[] {
  let floor = 0;
  return items
    .slice()
    .sort((a, b) => a.want - b.want)
    .map((it) => {
      const y = Math.max(it.want - it.h / 2, floor);
      floor = y + it.h + gap;
      return { ...it, y };
    });
}

/** Everything on one picture: which ports lead to which containers, and what networks and volumes they share. */
export default function Topology({ containers, networks, volumes, onOpen, onGo }: Props) {
  const [stopped, setStopped] = useState(true);
  const [focus, setFocus] = useState<string | null>(null);

  const { nodes, edges, groups, height } = useMemo(() => {
    const shown = containers
      .filter((c) => !c.system && (stopped || isUp(c)))
      .sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name));
    const nodes: Node[] = [];
    const edges: Edge[] = [];
    const groups: { name: string; y: number; h: number }[] = [];
    const centre = new Map<string, number>();

    // Containers, down the middle; a Compose project's are boxed together.
    let y = 8;
    const cur: { open: { name: string; y: number } | null } = { open: null };
    const close = () => {
      if (cur.open) groups.push({ name: cur.open.name, y: cur.open.y, h: y - GAP - cur.open.y + 8 });
      cur.open = null;
    };
    for (const c of shown) {
      if ((cur.open?.name ?? "") !== c.project) {
        close();
        if (c.project) {
          y += 6;
          cur.open = { name: c.project, y };
          y += 26;
        }
      }
      nodes.push({
        key: "c:" + c.id, kind: "container", x: BOX.x, y, w: BOX.w, h: BOX.h,
        title: clip(c.name, 30), sub: clip(c.image, 36), dim: !isUp(c), state: c.failed ? "failed" : c.state,
        act: () => onOpen(c.id), hint: `${c.name} · ${c.failed ? "실패" : stateLabel[c.state] ?? c.state} · 눌러서 상세 보기`,
      });
      centre.set(c.id, y + BOX.h / 2);
      y += BOX.h + GAP;
    }
    close();

    // Published ports, on the left, each beside its container.
    const ports = shown.flatMap((c) => {
      const list = published(c);
      return list.map((p, i) => ({ c, p, want: centre.get(c.id)! + (i - (list.length - 1) / 2) * (PORT.h + 4), h: PORT.h }));
    });
    for (const it of settle(ports, 4)) {
      const key = `p:${it.c.id}:${it.p.public}`;
      nodes.push({
        key, kind: "port", x: PORT.x, y: it.y, w: PORT.w, h: PORT.h,
        title: `localhost:${it.p.public}`, sub: "", dim: !isUp(it.c),
        act: () => openURL(`http://localhost:${it.p.public}`),
        hint: `내 PC의 ${it.p.public}번 포트 → ${it.c.name}의 ${it.p.private}번. 눌러서 브라우저로 열기`,
      });
      edges.push({ a: key, b: "c:" + it.c.id, kind: "port" });
    }

    // Networks and volumes, on the right, each level with what uses it.
    const ids = new Set(shown.map((c) => c.id));
    const side: { key: string; kind: Kind; title: string; sub: string; users: string[]; want: number; h: number; act: () => void; hint: string }[] = [];
    for (const n of networks) {
      const users = shown.filter((c) => c.networks.some((a) => a.network === n.name)).map((c) => c.id);
      // The engine's own networks only when something is on them.
      if (users.length === 0 && n.builtin) continue;
      side.push({
        key: "n:" + n.id, kind: "network", title: clip(n.name, 26), sub: n.subnet || (n.builtin ? "기본 네트워크" : "네트워크"), users,
        want: 0, h: SIDE.h, act: () => onGo("networks"), hint: `네트워크 ${n.name} · 컨테이너 ${users.length}개 · 눌러서 네트워크 화면으로`,
      });
    }
    for (const v of volumes) {
      const users = shown.filter((c) => c.volumes.includes(v.name)).map((c) => c.id);
      if (users.length === 0) continue; // unused volumes are the Volumes page's business
      const name = anonymous(v.name) ? v.name.slice(0, 12) : v.name;
      side.push({
        key: "v:" + v.name, kind: "volume", title: clip(name, 26), sub: "볼륨", users,
        want: 0, h: SIDE.h, act: () => onGo("volumes"), hint: `볼륨 ${name} · 컨테이너 ${users.length}개 · 눌러서 볼륨 화면으로`,
      });
    }
    let spare = y; // where things nothing uses go: below the rest
    for (const s of side) {
      const ys = s.users.filter((id) => ids.has(id)).map((id) => centre.get(id)!);
      s.want = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : (spare += SIDE.h + GAP);
    }
    let bottom = y;
    for (const s of settle(side, GAP)) {
      nodes.push({ key: s.key, kind: s.kind, x: SIDE.x, y: s.y, w: SIDE.w, h: s.h, title: s.title, sub: s.sub, act: s.act, hint: s.hint, dim: s.users.length === 0 });
      s.users.forEach((id) => edges.push({ a: "c:" + id, b: s.key, kind: s.kind as "network" | "volume" }));
      bottom = Math.max(bottom, s.y + s.h + GAP);
    }
    nodes.filter((n) => n.kind === "port").forEach((n) => (bottom = Math.max(bottom, n.y + n.h + GAP)));
    return { nodes, edges, groups, height: bottom + 4 };
  }, [containers, networks, volumes, stopped]);

  const at = useMemo(() => new Map(nodes.map((n) => [n.key, n])), [nodes]);
  // With a node under the pointer, only it and what it touches stay bright.
  const lit = useMemo(() => {
    if (!focus) return null;
    const set = new Set([focus]);
    edges.forEach((e) => {
      if (e.a === focus) set.add(e.b);
      if (e.b === focus) set.add(e.a);
    });
    return set;
  }, [focus, edges]);

  const count = nodes.filter((n) => n.kind === "container").length;
  return (
    <section>
      <header className="page-head">
        <h1>관계도</h1>
        <label className="check">
          <input type="checkbox" checked={stopped} onChange={(e) => setStopped(e.target.checked)} />
          멈춘 컨테이너도 보기
        </label>
        <span className="spacer" />
        <span className="legend" aria-hidden="true">
          <span className="key port" /> 포트
          <span className="key network" /> 네트워크
          <span className="key volume" /> 볼륨
        </span>
      </header>
      <p className="lead">
        왼쪽은 내 PC에서 접속하는 포트, 가운데는 컨테이너, 오른쪽은 컨테이너들이 함께 쓰는 네트워크와 볼륨입니다. 마우스를 올리면 연결된
        것만 남고, 누르면 그 항목으로 갑니다.
      </p>
      {count === 0 ? (
        <p className="empty">{containers.some((c) => !c.system) ? "실행 중인 컨테이너가 없습니다." : "컨테이너가 없습니다."}</p>
      ) : (
        <div className="map-wrap">
          <svg className="map" viewBox={`0 0 ${WIDTH} ${height}`} width={WIDTH} height={height} role="group" aria-label={`컨테이너 ${count}개의 관계도`} data-testid="map">
            {groups.map((g) => (
              <g key={g.name} className="map-group">
                <rect x={BOX.x - 12} y={g.y} width={BOX.w + 24} height={g.h} rx="10" />
                <text x={BOX.x} y={g.y + 17}>
                  {clip(g.name, 34)}
                </text>
              </g>
            ))}
            {edges.map((e) => {
              const a = at.get(e.a)!;
              const b = at.get(e.b)!;
              const x1 = a.x + a.w;
              const y1 = a.y + a.h / 2;
              const x2 = b.x;
              const y2 = b.y + b.h / 2;
              const bend = (x2 - x1) / 2;
              const off = lit && !(lit.has(e.a) && lit.has(e.b) && (e.a === focus || e.b === focus));
              return (
                <path
                  key={e.a + ">" + e.b}
                  className={`map-edge ${e.kind}` + (off ? " off" : "")}
                  d={`M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`}
                  data-testid={`edge-${e.kind}`}
                />
              );
            })}
            {nodes.map((n) => (
              <g
                key={n.key}
                className={`map-node ${n.kind}` + (n.dim ? " dim" : "") + (lit && !lit.has(n.key) ? " off" : "")}
                transform={`translate(${n.x},${n.y})`}
                role="button"
                tabIndex={0}
                aria-label={n.hint}
                data-testid={`node-${n.kind}-${n.title}`}
                onMouseEnter={() => setFocus(n.key)}
                onMouseLeave={() => setFocus(null)}
                onFocus={() => setFocus(n.key)}
                onBlur={() => setFocus(null)}
                onClick={n.act}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), n.act())}
              >
                <title>{n.hint}</title>
                <rect width={n.w} height={n.h} rx={n.kind === "port" ? n.h / 2 : 8} />
                {n.kind === "container" && <circle className={"map-dot " + n.state} cx="14" cy={n.h / 2} r="4.5" />}
                <text className="map-title" x={n.kind === "container" ? 28 : 12} y={n.sub ? 18 : n.h / 2 + 4.5}>
                  {n.title}
                </text>
                {n.sub && (
                  <text className="map-sub" x={n.kind === "container" ? 28 : 12} y={n.h - 9}>
                    {n.sub}
                  </text>
                )}
              </g>
            ))}
          </svg>
        </div>
      )}
    </section>
  );
}
