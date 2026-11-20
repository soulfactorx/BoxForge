import { useEffect, useRef, useState, type ReactNode } from "react";
import { call, on, type Run } from "./bridge";
import { Dialog } from "./ui";

export interface CopyTarget {
  id: string;
  kind: string;
  label: string;
  distro: string;
}

interface Option {
  key: string;
  label: string;
  help: string;
}

interface Props {
  title: string;
  what: ReactNode;
  options?: Option[];
  run: Run;
  /** The docker command line that would do the same, given how to call docker on the other engine. */
  command: (other: string) => string;
  /** Does the copy. key tags the progress events; the result is notes for the user. */
  copy: (key: string, target: string, chosen: Record<string, boolean>) => Promise<string[] | void>;
  onClose: () => void;
  onDone: (label: string, notes: string[]) => void;
}

/** How the docker command reaches a target, for showing the equivalent command. */
export const dockerOn = (t: CopyTarget | undefined) =>
  t?.kind === "wsl" ? `wsl -d ${t.distro} docker` : t?.kind === "context" ? `docker --context ${t.id.slice(8)}` : "docker --context default";

let serial = 0;

/** Asks which other engine to copy something to, and shows the copy's progress. */
export default function EngineCopy({ title, what, options = [], run, command, copy, onClose, onDone }: Props) {
  const [targets, setTargets] = useState<CopyTarget[] | null>(null);
  const [target, setTarget] = useState("");
  const [chosen, setChosen] = useState<Record<string, boolean>>(Object.fromEntries(options.map((o) => [o.key, true])));
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState("");
  const key = useRef(`x${++serial}`);

  useEffect(() => {
    call<{ current: string; targets: CopyTarget[] }>("Engines").then(
      (e) => {
        const others = (e.targets ?? []).filter((t) => t.id !== e.current);
        setTargets(others);
        setTarget(others[0]?.id ?? "");
      },
      (e) => {
        setTargets([]);
        setError(e.message);
      },
    );
    return on("transfer", (t: { key: string; text: string }) => {
      if (t.key !== key.current) return;
      // A line that only counts up replaces the one before it.
      setSteps((s) => (s.length && s[s.length - 1].split(" · ")[0] === t.text.split(" · ")[0] ? [...s.slice(0, -1), t.text] : [...s, t.text]));
    });
  }, []);

  const go = async () => {
    const t = targets?.find((x) => x.id === target);
    if (!t) return;
    setBusy(true);
    setError("");
    setSteps([]);
    let notes: string[] = [];
    let failed = "";
    const ok = await run(command(dockerOn(t)), async () => {
      try {
        notes = (await copy(key.current, t.id, chosen)) ?? [];
      } catch (e: any) {
        failed = e.message;
        throw e;
      }
    });
    setBusy(false);
    if (ok) onDone(t.label, notes);
    else setError(failed);
  };

  return (
    <Dialog title={title} onClose={busy ? () => {} : onClose}>
      {what}
      {targets === null ? (
        <p className="muted">엔진을 찾는 중…</p>
      ) : targets.length === 0 ? (
        <p className="warn">복사할 다른 엔진이 없습니다. 엔진이 하나뿐입니다.</p>
      ) : (
        <select className="field" aria-label="복사할 엔진" value={target} disabled={busy} onChange={(e) => setTarget(e.target.value)}>
          {targets.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      )}
      {options.map((o) => (
        <label key={o.key} className="check option">
          <input type="checkbox" checked={chosen[o.key]} disabled={busy} onChange={(e) => setChosen({ ...chosen, [o.key]: e.target.checked })} />
          <span>
            {o.label}
            <span className="sub">{o.help}</span>
          </span>
        </label>
      ))}
      {steps.length > 0 && (
        <ol className="transfer" data-testid="transfer">
          {steps.map((s, i) => (
            <li key={i} className={busy && i === steps.length - 1 ? "now" : ""}>
              {busy && i === steps.length - 1 ? <span className="spinner" /> : <span className="setup-mark">✔</span>}
              {s}
            </li>
          ))}
        </ol>
      )}
      {error && (
        <p className="warn" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button onClick={onClose} disabled={busy}>
          취소
        </button>
        <button className="primary" disabled={busy || !target} onClick={go}>
          {busy ? "복사하는 중…" : "복사"}
        </button>
      </div>
    </Dialog>
  );
}

/** Turns the engine's notes on a copied container into sentences. */
export function explain(notes: string[]) {
  return notes.map((n) => {
    const [kind, ...rest] = n.split(":");
    const value = rest.join(":");
    if (kind === "network") return `네트워크 "${value}"에는 연결하지 않았습니다. 받는 쪽 엔진에서 같은 네트워크를 만들고 연결해 주세요.`;
    if (kind === "bind") return `내 PC의 폴더 ${value} 를 그대로 가리킵니다. 받는 쪽 엔진에서도 같은 경로가 보여야 합니다.`;
    return n;
  });
}
