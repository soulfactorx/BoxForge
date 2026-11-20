import { useEffect, useMemo, useRef, useState } from "react";
import type { Container, Image } from "./bridge";
import { parseRun, type RunInit } from "./recipes";
import { Icon } from "./ui";

interface Entry {
  icon: string;
  title: string;
  hint: string;
  act: () => void;
}

interface Props {
  pages: { id: string; label: string; icon: string }[];
  containers: Container[];
  images: Image[];
  onPage: (id: string) => void;
  onContainer: (id: string) => void;
  onRun: (init: RunInit) => void;
  onClose: () => void;
}

/** Ctrl+K: go anywhere by typing, or paste a `docker run` line to open it in the run form. */
export default function Palette({ pages, containers, images, onPage, onContainer, onRun, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [at, setAt] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out: Entry[] = [];
    const parsed = parseRun(query);
    if (parsed) {
      out.push({ icon: "play", title: `실행 창에서 열기: ${parsed.image}`, hint: "붙여넣은 docker run 명령을 풀어서 채웁니다", act: () => onRun(parsed) });
      return out;
    }
    for (const p of pages) if (!q || p.label.toLowerCase().includes(q) || p.id.includes(q)) out.push({ icon: p.icon, title: p.label, hint: "화면으로 이동", act: () => onPage(p.id) });
    if (q) {
      for (const c of containers) if (!c.system && (c.name.toLowerCase().includes(q) || c.image.toLowerCase().includes(q))) out.push({ icon: "box", title: c.name, hint: `컨테이너 · ${c.image}`, act: () => onContainer(c.id) });
      for (const im of images) for (const t of im.tags) if (t.toLowerCase().includes(q)) out.push({ icon: "layers", title: t, hint: "이 이미지로 컨테이너 실행", act: () => onRun({ image: t }) });
    }
    return out.slice(0, 40);
  }, [query, pages, containers, images]);

  useEffect(() => setAt(0), [query]);
  useEffect(() => {
    list.current?.children[at]?.scrollIntoView({ block: "nearest" });
  }, [at]);

  const pick = (e: Entry | undefined) => {
    if (!e) return;
    onClose();
    e.act();
  };

  return (
    <div className="overlay palette-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="빠른 이동">
        <input
          autoFocus
          aria-label="찾을 이름이나 docker run 명령"
          placeholder="화면 · 컨테이너 · 이미지 이름, 또는 docker run 명령을 붙여넣기"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "ArrowDown") (e.preventDefault(), setAt((n) => Math.min(n + 1, entries.length - 1)));
            if (e.key === "ArrowUp") (e.preventDefault(), setAt((n) => Math.max(n - 1, 0)));
            // The key is used up here: left to go on, it would press a
            // button in whatever opens next.
            if (e.key === "Enter") (e.preventDefault(), pick(entries[at]));
          }}
        />
        <div className="palette-list" ref={list} role="listbox">
          {entries.length === 0 ? (
            <p className="muted">맞는 것이 없습니다.</p>
          ) : (
            entries.map((e, i) => (
              <button key={e.title + e.hint} role="option" aria-selected={i === at} className={i === at ? "on" : ""} onMouseEnter={() => setAt(i)} onClick={() => pick(e)}>
                <Icon name={e.icon} />
                <strong>{e.title}</strong>
                <span className="muted">{e.hint}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
