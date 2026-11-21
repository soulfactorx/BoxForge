import { useEffect, useRef, useState } from "react";
import { call, type Container } from "./bridge";
import { Icon } from "./ui";

interface Alert {
  key: string;
  id: string;
  name: string;
  text: string;
}

/** Whether alerts are on (the setting "notify.fail", on unless turned off). */
let enabled = true;
export function setAlerts(on: boolean) {
  enabled = on;
}

/** Asks the system to show notifications too (a browser asks the user). */
export async function allowSystem(): Promise<string> {
  if (!("Notification" in window)) return "unsupported";
  if (Notification.permission === "default") return await Notification.requestPermission();
  return Notification.permission;
}

/**
 * Watches the containers and says so when one fails or turns unhealthy:
 * a note in the corner of the window, and a system notification when
 * those are allowed. A container that the user stopped is not a failure.
 */
export default function Alerts({ containers, engine, onOpen }: { containers: Container[]; engine: string; onOpen: (id: string) => void }) {
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const last = useRef<{ engine: string; seen: Map<string, Container> } | null>(null);

  useEffect(() => {
    call<string>("Setting", "notify.fail").then((v) => (enabled = v !== "off"), () => {});
  }, []);

  useEffect(() => {
    const now = new Map(containers.map((c) => [c.id, c]));
    const before = last.current;
    last.current = { engine, seen: now };
    // The first list of an engine is how things are, not what happened.
    if (!before || before.engine !== engine || before.seen.size === 0 || !enabled) return;
    const fresh: Alert[] = [];
    for (const c of containers) {
      const was = before.seen.get(c.id);
      if (!was || c.system) continue;
      if (c.failed && !was.failed && was.state === "running") fresh.push({ key: c.id + "f" + Date.now(), id: c.id, name: c.name, text: `실패로 멈췄습니다 (종료 코드 ${c.exitCode})` });
      else if (c.health === "unhealthy" && was.health !== "unhealthy") fresh.push({ key: c.id + "h" + Date.now(), id: c.id, name: c.name, text: "상태 검사가 이상을 알립니다" });
    }
    if (fresh.length === 0) return;
    setAlerts((a) => [...a, ...fresh].slice(-4));
    if ("Notification" in window && Notification.permission === "granted") {
      for (const f of fresh) {
        try {
          const n = new Notification(`BoxForge: ${f.name}`, { body: f.text, tag: f.key });
          n.onclick = () => {
            window.focus();
            onOpen(f.id);
          };
        } catch {
          // no system notifications here (a desktop window may not have them)
        }
      }
    }
  }, [containers, engine]);

  if (alerts.length === 0) return null;
  return (
    <div className="alerts" role="status" data-testid="alerts">
      {alerts.map((a) => (
        <div key={a.key} className="alert">
          <button
            className="alert-body"
            onClick={() => {
              onOpen(a.id);
              setAlerts((all) => all.filter((x) => x.key !== a.key));
            }}
          >
            <strong>{a.name}</strong>
            <span>{a.text}</span>
            <span className="sub">눌러서 이유 보기</span>
          </button>
          <button className="icon-btn" aria-label="알림 닫기" onClick={() => setAlerts((all) => all.filter((x) => x.key !== a.key))}>
            <Icon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}
