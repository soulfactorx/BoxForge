import { useEffect, useRef, useState, type ReactNode } from "react";

const paths: Record<string, ReactNode> = {
  play: <path d="M6 4.5v11l9-5.5z" />,
  stop: <rect x="5.5" y="5.5" width="9" height="9" rx="1.5" />,
  restart: <path d="M15.5 10a5.5 5.5 0 1 1-1.7-4M14.5 3v3.5H11" />,
  trash: <path d="M4.5 6h11M8 6V4.5h4V6M6 6l.7 9.5h6.6L14 6M8.5 9v4M11.5 9v4" />,
  more: <path d="M5 10h.01M10 10h.01M15 10h.01" strokeWidth="2.4" />,
  edit: <path d="M4.5 15.5l.6-3L13 4.6l2.4 2.4-7.9 7.9zM11.6 6l2.4 2.4" />,
  plus: <path d="M10 4.5v11M4.5 10h11" />,
  close: <path d="M5.5 5.5l9 9M14.5 5.5l-9 9" />,
  tag: <path d="M4.5 4.5h5l6 6-5 5-6-6zM7.5 7.5h.01" />,
  box: <path d="M10 3l6 3.3v7.4L10 17l-6-3.3V6.3zM4 6.3l6 3.4 6-3.4M10 9.7V17" />,
  layers: <path d="M10 3.5l6.5 3.5L10 10.5 3.5 7zM3.5 10.5L10 14l6.5-3.5M3.5 13.5L10 17l6.5-3.5" />,
  download: <path d="M10 3.5v9M6.5 9.5l3.5 3.5 3.5-3.5M4 16h12" />,
  volume: <path d="M4.5 6c0-1.4 2.5-2.5 5.5-2.5s5.5 1.100 5.500 2.500v8c0 1.400-2.500 2.500-5.500 2.500s-5.500-1.100-5.500-2.500zM4.500 6c0 1.400 2.500 2.500 5.500 2.500s5.500-1.100 5.500-2.500M4.500 10c0 1.400 2.500 2.500 5.500 2.500s5.500-1.100 5.500-2.500" />,
  network: <path d="M7.200 9l5.600-2.800M7.200 11l5.600 2.800M5.500 12.200a2.200 2.200 0 1 0 0-4.400 2.200 2.200 0 0 0 0 4.400zM14.500 7.700a2.200 2.200 0 1 0 0-4.400 2.200 2.200 0 0 0 0 4.400zM14.500 16.700a2.200 2.200 0 1 0 0-4.400 2.200 2.200 0 0 0 0 4.400z" />,
  compose: <path d="M4 5h5v4H4zM11 5h5v4h-5zM7.500 11.500h5v4h-5zM6.500 9v1.200h7V9M10 10.200v1.300" />,
  build: <path d="M11 4.500l4.500 4.500-1.800 1.800-1.400-1.400-6.500 6.500-1.700-1.700 6.500-6.500-1.400-1.400zM4.500 4.500h3" />,
  folder: <path d="M3.500 6.500a1.500 1.500 0 0 1 1.500-1.500h3l1.500 1.500h5.500a1.500 1.500 0 0 1 1.500 1.500v6a1.500 1.500 0 0 1-1.500 1.500H5a1.500 1.500 0 0 1-1.500-1.500z" />,
  file: <path d="M6 3.500h5.500l3 3V16a.500.500 0 0 1-.500.500H6a.500.500 0 0 1-.500-.500V4a.500.500 0 0 1 .500-.500zM11.500 3.500v3h3" />,
  send: <path d="M4 10h11M11 5.500l4.500 4.500-4.500 4.500M4 4.500v11" />,
  map: <path d="M5.500 6.500h3v3h-3zM11.500 4h3v3h-3zM11.500 13h3v3h-3zM8.500 8h1.500v-2.500h1.500M8.500 8h1.500v6.500h1.500" />,
  minus: <path d="M4.500 10h11" />,
  kube: <path d="M10 3l6 2.800 1.300 6.300-4.100 5H6.800l-4.100-5L4 5.800zM10 7.500v5M7.800 8.800l4.400 2.400M12.200 8.800l-4.400 2.400" />,
  sort: <path d="M6 8l4-4 4 4M6 12l4 4 4-4" />,
};

export function Icon({ name }: { name: keyof typeof paths | string }) {
  return (
    <svg className="icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {paths[name]}
    </svg>
  );
}

/** A square button showing only an icon; label is its tooltip and accessible name. */
export function IconButton(props: { icon: string; label: string; onClick: () => void; tone?: "danger" | "go"; disabled?: boolean }) {
  return (
    <button
      className={"icon-btn " + (props.tone ?? "")}
      title={props.label}
      aria-label={props.label}
      disabled={props.disabled}
      onClick={(e) => {
        e.stopPropagation();
        props.onClick();
      }}
    >
      <Icon name={props.icon} />
    </button>
  );
}

export interface MenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

/** The "…" button and the list it opens. */
export function Menu({ items, label = "더보기" }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  return (
    <span className="menu-wrap" ref={ref}>
      <IconButton icon="more" label={label} onClick={() => setOpen(!open)} />
      {open && (
        <div className="menu" role="menu">
          {items.map((it) => (
            <button
              key={it.label}
              role="menuitem"
              className={it.danger ? "danger" : ""}
              onClick={() => {
                setOpen(false);
                it.onClick();
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export function Dialog(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && props.onClose();
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  });
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={"dialog" + (props.wide ? " wide" : "")} role="dialog" aria-modal="true" aria-label={props.title}>
        <h2>{props.title}</h2>
        {props.children}
      </div>
    </div>
  );
}

export function Progress({ percent }: { percent: number }) {
  return (
    <div className={"progress" + (percent < 0 ? " unknown" : "")} role="progressbar" aria-valuenow={percent < 0 ? undefined : percent}>
      <div style={{ width: percent < 0 ? "30%" : `${percent}%` }} />
    </div>
  );
}
