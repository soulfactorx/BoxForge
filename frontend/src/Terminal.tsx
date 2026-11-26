import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { call, on, type Run, remote } from "./bridge";
import { copyText } from "./ui";
import { keySeq, withMods, type Mods } from "./termkeys";

// Ctrl and Alt on the key bar: off, for the next key (one tap), or held (two quick taps).
type Hold = 0 | 1 | 2;

/** Whether the screen is touched rather than pointed at (a phone, a tablet). */
const touch = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

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
  // The bar of keys a phone's keyboard lacks: shown on touch screens, or when asked for.
  const [keysOn, setKeysOn] = useState(() => {
    try {
      const v = localStorage.getItem("bf.termKeys");
      return v ? v === "on" : touch();
    } catch {
      return touch();
    }
  });
  const [fn, setFn] = useState(false);
  const [hold, setHold] = useState<{ ctrl: Hold; alt: Hold }>({ ctrl: 0, alt: 0 });
  const holdRef = useRef(hold);
  holdRef.current = hold;
  const lastTap = useRef<{ key: string; at: number }>({ key: "", at: 0 });
  const send = useRef<(data: string) => void>(() => {});
  const mods = (): Mods => ({ ctrl: holdRef.current.ctrl > 0, alt: holdRef.current.alt > 0, shift: false });
  // A one-tap Ctrl or Alt lasts for one key.
  const used = () => setHold((h) => ({ ctrl: h.ctrl === 1 ? 0 : h.ctrl, alt: h.alt === 1 ? 0 : h.alt }));
  const tapMod = (k: "ctrl" | "alt") => {
    const now = Date.now();
    const twice = lastTap.current.key === k && now - lastTap.current.at < 400;
    lastTap.current = { key: k, at: now };
    setHold((h) => ({ ...h, [k]: twice ? 2 : h[k] ? 0 : 1 }));
  };
  const press = (key: string) => {
    const t = xterm.current;
    send.current(keySeq(key, mods(), !!t?.modes.applicationCursorKeysMode));
    used();
  };
  const showKeys = (on: boolean) => {
    setKeysOn(on);
    try {
      localStorage.setItem("bf.termKeys", on ? "on" : "off");
    } catch {
      /* for this time only */
    }
  };
  // All the terminal has shown, as text to select from (the phone's own
  // selection works there, scrolled past the screen as far as wanted).
  const [text, setText] = useState<{ text: string; at: number } | null>(null);
  const openText = () => {
    const t = xterm.current;
    if (!t) return;
    const buf = t.buffer.active;
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      const s = line?.translateToString(true) ?? "";
      // A line wrapped on the screen is one line of text.
      if (line?.isWrapped && lines.length) lines[lines.length - 1] += s;
      else lines.push(s);
    }
    while (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    setText({ text: lines.join("\n"), at: buf.viewportY / Math.max(1, buf.length) });
  };
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
    send.current = (data) => {
      pending += data;
      flush();
    };
    const typed = term.onData((data) => {
      // Ctrl or Alt tapped on the key bar applies to the next key typed.
      const h = holdRef.current;
      if ((h.ctrl || h.alt) && data.length === 1) {
        data = withMods(data, { ctrl: h.ctrl > 0, alt: h.alt > 0, shift: false });
        used();
      }
      pending += data;
      flush();
    });
    // A finger drawn up or down the terminal scrolls what it has shown, as a
    // page does (xterm's own scrolling is made for a mouse wheel), going on a
    // little after a flick. A full-screen program (less, vim) has nothing
    // above to scroll back to: it gets the arrow keys instead.
    const screen = box.current;
    let lastY = 0;
    let carry = 0;
    let speed = 0; // px per ms, last move
    let lastT = 0;
    let glide = 0;
    const lineHeight = () => (screen.querySelector(".xterm-rows")?.clientHeight ?? 0) / term.rows || 17;
    const scrollBy = (px: number) => {
      carry += px;
      const lines = Math.trunc(carry / lineHeight());
      if (!lines) return;
      carry -= lines * lineHeight();
      if (term.buffer.active.type === "alternate") {
        const seq = keySeq(lines > 0 ? "Down" : "Up", { ctrl: false, alt: false, shift: false }, !!term.modes.applicationCursorKeysMode);
        send.current(seq.repeat(Math.min(Math.abs(lines), 5)));
      } else term.scrollLines(lines);
    };
    const touchStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      cancelAnimationFrame(glide);
      lastY = e.touches[0].clientY;
      lastT = e.timeStamp;
      carry = 0;
      speed = 0;
    };
    const touchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      const y = e.touches[0].clientY;
      const dy = lastY - y; // finger up: later lines
      const dt = Math.max(1, e.timeStamp - lastT);
      lastY = y;
      lastT = e.timeStamp;
      const buf = term.buffer.active;
      // At the very top of what can be scrolled, a pull downward is the page's.
      const canScroll = buf.type === "alternate" || buf.baseY > 0;
      if (!canScroll || (dy < 0 && buf.type !== "alternate" && buf.viewportY === 0)) return;
      e.preventDefault();
      speed = dy / dt;
      scrollBy(dy);
    };
    const touchEnd = () => {
      if (Math.abs(speed) < 0.3 || term.buffer.active.type === "alternate") return;
      let v = speed * 16; // px per frame
      const step = () => {
        v *= 0.92;
        if (Math.abs(v) < 0.5) return;
        scrollBy(v);
        glide = requestAnimationFrame(step);
      };
      glide = requestAnimationFrame(step);
    };
    screen.addEventListener("touchstart", touchStart, { passive: true });
    screen.addEventListener("touchmove", touchMove, { passive: false });
    screen.addEventListener("touchend", touchEnd, { passive: true });

    const resized = term.onResize(({ cols, rows }) => session && call("TermResize", session, cols, rows).catch(() => {}));
    const watch = new ResizeObserver(() => fit.fit());
    watch.observe(box.current);

    return () => {
      closed = true;
      off();
      typed.dispose();
      resized.dispose();
      watch.disconnect();
      cancelAnimationFrame(glide);
      screen.removeEventListener("touchstart", touchStart);
      screen.removeEventListener("touchmove", touchMove);
      screen.removeEventListener("touchend", touchEnd);
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
      {keysOn ? (
        <div className="term-keys" role="toolbar" aria-label="특수 키" data-testid="term-keys" onPointerDown={(e) => e.preventDefault()}>
          {/* Two rows of eight, as on a phone's screen; Fn adds three more. */}
          <div className="term-keys-row">
            <button type="button" onClick={() => press("Esc")}>Esc</button>
            <button type="button" onClick={() => press("|")}>|</button>
            <button type="button" onClick={() => press("-")}>-</button>
            <button type="button" onClick={() => press("/")}>/</button>
            <button type="button" onClick={() => press("~")}>~</button>
            <button type="button" aria-label="위" onClick={() => press("Up")}>↑</button>
            <button type="button" className={fn ? "on" : ""} aria-pressed={fn} title="Home · End · PgUp · PgDn · F1~F12" onClick={() => setFn(!fn)}>
              Fn
            </button>
            <button type="button" title="지난 출력까지 모두 글로 보고, 골라서 복사" onClick={openText}>
              복사
            </button>
          </div>
          <div className="term-keys-row">
            <button type="button" onClick={() => press("Tab")}>Tab</button>
            <button type="button" className={hold.ctrl ? "on" + (hold.ctrl === 2 ? " held" : "") : ""} aria-pressed={hold.ctrl > 0} title="한 번: 다음 키에만 · 두 번: 계속" onClick={() => tapMod("ctrl")}>
              Ctrl
            </button>
            <button type="button" className={hold.alt ? "on" + (hold.alt === 2 ? " held" : "") : ""} aria-pressed={hold.alt > 0} title="한 번: 다음 키에만 · 두 번: 계속" onClick={() => tapMod("alt")}>
              Alt
            </button>
            <button type="button" aria-label="왼쪽" onClick={() => press("Left")}>←</button>
            <button type="button" aria-label="아래" onClick={() => press("Down")}>↓</button>
            <button type="button" aria-label="오른쪽" onClick={() => press("Right")}>→</button>
            <button type="button" aria-label="엔터" onClick={() => press("Enter")}>↵</button>
            <button type="button" className="term-keys-hide" aria-label="특수 키 숨기기" onClick={() => showKeys(false)}>
              ×
            </button>
          </div>
          {fn && (
            <>
              <div className="term-keys-row six">
                {["Home", "End", "PgUp", "PgDn", "Ins", "Del"].map((k) => (
                  <button key={k} type="button" onClick={() => press(k)}>
                    {k}
                  </button>
                ))}
              </div>
              <div className="term-keys-row six">
                {["F1", "F2", "F3", "F4", "F5", "F6"].map((k) => (
                  <button key={k} type="button" onClick={() => press(k)}>
                    {k}
                  </button>
                ))}
              </div>
              <div className="term-keys-row six">
                {["F7", "F8", "F9", "F10", "F11", "F12"].map((k) => (
                  <button key={k} type="button" onClick={() => press(k)}>
                    {k}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      ) : (
        <button type="button" className="link term-keys-show" onClick={() => showKeys(true)}>
          특수 키 보이기 (방향키 · Tab · Ctrl · Alt · F1~F12)
        </button>
      )}
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
          <button type="button" role="menuitem" onClick={() => (setMenu(null), openText())}>
            글로 보고 골라 복사
          </button>
          <button type="button" role="menuitem" onClick={() => (setMenu(null), xterm.current?.clear(), xterm.current?.focus())}>
            화면 지우기
          </button>
        </div>
      )}
      {text !== null && <TextView text={text.text} at={text.at} onClose={() => (setText(null), xterm.current?.focus())} />}
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

/** The terminal's text, to select from as any text is selected, and copy. */
function TextView({ text, at, onClose }: { text: string; at: number; onClose: () => void }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [said, setSaid] = useState("");
  useEffect(() => {
    // Opened where the terminal was looking.
    const a = area.current;
    if (a) a.scrollTop = at * a.scrollHeight;
  }, []);
  const put = async (what: string, how: string) => {
    setSaid((await copyText(what)) ? how : "복사하지 못했습니다. 길게 눌러 나오는 메뉴의 복사를 쓰세요.");
  };
  const picked = () => {
    const a = area.current;
    return a ? a.value.slice(a.selectionStart, a.selectionEnd) : "";
  };
  return (
    <div className="term-text" role="dialog" aria-label="터미널 글" data-testid="term-text">
      <div className="term-text-bar">
        <span className="muted">길게 누르거나 끌어서 고르세요. 화면 밖의 지난 출력도 스크롤해서 고를 수 있습니다.</span>
        <span className="spacer" />
        <button type="button" className="primary" onPointerDown={(e) => e.preventDefault()} onClick={() => {
          const p = picked();
          if (p) put(p, "고른 것을 복사했습니다.");
          else setSaid("고른 글이 없습니다.");
        }}>
          고른 것 복사
        </button>
        <button type="button" onClick={() => put(text, "모두 복사했습니다.")}>모두 복사</button>
        <button type="button" onClick={onClose}>닫기</button>
      </div>
      {said && <p className="muted" role="status">{said}</p>}
      <textarea ref={area} readOnly aria-label="터미널에 나온 글" value={text} spellCheck={false} wrap="off" />
    </div>
  );
}
