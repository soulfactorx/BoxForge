import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { call, on, type Run, remote } from "./bridge";
import { copyText } from "./ui";

/** Reads the clipboard: the desktop app's own, else the browser's (which may ask, or refuse on a page that isn't a secure one). */
async function readClipboard(): Promise<string | null> {
  const w = window as unknown as { runtime?: { ClipboardGetText?: () => Promise<string> } };
  try {
    if (w.runtime?.ClipboardGetText) return await w.runtime.ClipboardGetText();
  } catch {
    /* tried the browser's next */
  }
  try {
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}

interface TermData {
  session: string;
  data: string;
  end: boolean;
}

/** A shell inside a running container. */
interface Props {
  id: string;
  name: string;
  showCli: (cmd: string) => void;
  run: Run;
  /** Opens the session, for a shell somewhere other than a container: a pod. */
  open?: (cols: number, rows: number) => Promise<string>;
  /** The command that does the same in a terminal. */
  command?: string;
  /** Told when what runs in it has ended. */
  onEnd?: () => void;
}

export default function Terminal({ id, name, showCli, run, open, command, onEnd }: Props) {
  const ended = useRef(onEnd);
  ended.current = onEnd;
  const box = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState("");
  // The menu a right click opens, where it opened; and pasting by hand where the clipboard can't be read.
  const [menu, setMenu] = useState<{ x: number; y: number; selected: boolean } | null>(null);
  const [pasting, setPasting] = useState(false);
  const xterm = useRef<XTerm | null>(null);
  const copy = async () => {
    const t = xterm.current;
    if (t?.hasSelection()) await copyText(t.getSelection());
    t?.focus();
  };
  const paste = async () => {
    const text = await readClipboard();
    if (text === null) return setPasting(true);
    // As typed, and as a paste: a program that asked to know pastes (bracketed paste) is told.
    xterm.current?.paste(text);
    xterm.current?.focus();
  };
  useEffect(() => {
    if (!menu) return;
    const away = () => setMenu(null);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", away);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", away);
    };
  }, [menu]);

  useEffect(() => {
    if (!box.current) return;
    const term = new XTerm({
      fontFamily: 'ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: "#0f1218", foreground: "#e6e9ef" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(box.current);
    xterm.current = term;
    fit.fit();
    // Ctrl+Shift+C and Ctrl+Shift+V copy and paste, as in terminals on Linux
    // (Ctrl+C alone stays the program's interrupt).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown" || !e.ctrlKey || !e.shiftKey) return true;
      if (e.code === "KeyC") {
        if (term.hasSelection()) copyText(term.getSelection());
        return false;
      }
      if (e.code === "KeyV") {
        e.preventDefault();
        readClipboard().then((t) => (t === null ? setPasting(true) : term.paste(t)));
        return false;
      }
      return true;
    });
    setNote("");
    showCli(command ?? `docker exec -it ${name} sh`);

    let session = "";
    let closed = false;
    // Output can arrive before TermOpen's answer names the session: keep it until then.
    const early: TermData[] = [];
    const show = (d: TermData) => {
      if (d.data) term.write(Uint8Array.from(atob(d.data), (ch) => ch.charCodeAt(0)));
      if (d.end) {
        setNote("셸이 끝났습니다. 탭을 다시 열면 새로 시작합니다.");
        ended.current?.();
      }
    };
    const off = on("term", (d: TermData) => {
      if (!session) early.push(d);
      else if (d.session === session) show(d);
    });
    (open ? open(term.cols, term.rows) : call<string>("TermOpen", id, term.cols, term.rows)).then(
      (s) => {
        if (closed) return void call("TermClose", s).catch(() => {});
        session = s;
        early.filter((d) => d.session === s).forEach(show);
        flush(); // what was typed before it opened
        term.focus();
      },
      (e) => setNote(e.message),
    );
    // Keys go one send after another, in order: sent each as it came, two
    // could overtake each other on the way (a busy PC, the web server) and
    // reach the program swapped. What is typed while one is on its way goes
    // in the next.
    let pending = "";
    let sending = false;
    const flush = async () => {
      if (sending) return;
      sending = true;
      while (pending && session && !closed) {
        const data = pending;
        pending = "";
        await call("TermWrite", session, data).catch(() => {});
      }
      sending = false;
    };
    const typed = term.onData((data) => {
      pending += data;
      flush();
    });
    const resized = term.onResize(({ cols, rows }) => session && call("TermResize", session, cols, rows).catch(() => {}));
    const watch = new ResizeObserver(() => fit.fit());
    watch.observe(box.current);

    return () => {
      closed = true;
      off();
      typed.dispose();
      resized.dispose();
      watch.disconnect();
      if (session) call("TermClose", session).catch(() => {});
      term.dispose();
    };
  }, [id]);

  return (
    <div className="term">
      {!open && !remote() && (
        <div className="logs-bar">
          <span className="muted">컨테이너 안의 셸입니다.</span>
          <span className="spacer" />
          <button onClick={() => run(`docker exec -it ${name} sh`, () => call("OpenTerminal", name))}>외부 터미널로 열기</button>
        </div>
      )}
      <div
        className="term-box"
        ref={box}
        data-testid="terminal"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY, selected: !!xterm.current?.hasSelection() });
        }}
      />
      {menu && (
        <div className="menu term-menu" role="menu" style={{ position: "fixed", left: menu.x, top: menu.y }} onMouseDown={(e) => e.stopPropagation()}>
          <button type="button" role="menuitem" disabled={!menu.selected} onClick={() => (setMenu(null), copy())}>
            복사 <span className="muted">Ctrl+Shift+C</span>
          </button>
          <button type="button" role="menuitem" onClick={() => (setMenu(null), paste())}>
            붙여넣기 <span className="muted">Ctrl+Shift+V</span>
          </button>
          <button type="button" role="menuitem" onClick={() => (setMenu(null), xterm.current?.selectAll())}>
            모두 선택
          </button>
          <button type="button" role="menuitem" onClick={() => (setMenu(null), xterm.current?.clear(), xterm.current?.focus())}>
            화면 지우기
          </button>
        </div>
      )}
      {pasting && (
        <PasteBox
          onPaste={(t) => {
            setPasting(false);
            if (t) xterm.current?.paste(t);
            xterm.current?.focus();
          }}
        />
      )}
      {note && <p className="muted">{note}</p>}
    </div>
  );
}

/** Where the clipboard can't be read (a browser on a page that isn't secure): pasted by hand into a box, then sent. */
function PasteBox({ onPaste }: { onPaste: (text: string) => void }) {
  const [text, setText] = useState("");
  return (
    <div className="note-box term-paste" role="dialog" aria-label="터미널에 붙여넣기">
      <span>이 브라우저에서는 클립보드를 바로 읽을 수 없습니다. 아래 칸에 붙여 넣고(Ctrl+V) "보내기"를 누르세요.</span>
      <textarea aria-label="붙여 넣을 내용" autoFocus rows={3} value={text} onChange={(e) => setText(e.target.value)} />
      <span>
        <button type="button" className="primary" disabled={!text} onClick={() => onPaste(text)}>
          보내기
        </button>{" "}
        <button type="button" onClick={() => onPaste("")}>
          취소
        </button>
      </span>
    </div>
  );
}
