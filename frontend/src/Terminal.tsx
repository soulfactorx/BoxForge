import { useEffect, useRef, useState } from "react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { call, on, type Run, remote } from "./bridge";

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
}

export default function Terminal({ id, name, showCli, run, open, command }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [note, setNote] = useState("");

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
    fit.fit();
    setNote("");
    showCli(command ?? `docker exec -it ${name} sh`);

    let session = "";
    let closed = false;
    // Output can arrive before TermOpen's answer names the session: keep it until then.
    const early: TermData[] = [];
    const show = (d: TermData) => {
      if (d.data) term.write(Uint8Array.from(atob(d.data), (ch) => ch.charCodeAt(0)));
      if (d.end) setNote("셸이 끝났습니다. 탭을 다시 열면 새로 시작합니다.");
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
        term.focus();
      },
      (e) => setNote(e.message),
    );
    const typed = term.onData((data) => session && call("TermWrite", session, data).catch(() => {}));
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
      <div className="term-box" ref={box} data-testid="terminal" />
      {note && <p className="muted">{note}</p>}
    </div>
  );
}
