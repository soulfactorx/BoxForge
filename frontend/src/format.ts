import type { Container } from "./bridge";

export function ago(unix: number) {
  if (unix <= 0) return "알 수 없음"; // an image built without a date
  const s = Math.max(0, Date.now() / 1000 - unix);
  if (s < 60) return "방금";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

export const shortId = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);

export const isUp = (c: Container) => c.state === "running" || c.state === "paused" || c.state === "restarting";

const unit: Record<string, string> = {
  second: "초", minute: "분", hour: "시간", day: "일", week: "주", month: "개월", year: "년",
};

/** Docker's "3 hours", "About a minute", "Less than a second" in Korean. */
function duration(text: string) {
  if (/less than a second/i.test(text)) return "1초";
  const about = /about an? (minute|hour)/i.exec(text);
  if (about) return `1${unit[about[1].toLowerCase()]}`;
  const m = /(\d+) (second|minute|hour|day|week|month|year)s?/i.exec(text);
  return m ? `${m[1]}${unit[m[2].toLowerCase()]}` : text;
}

const health: Record<string, string> = { healthy: "정상", unhealthy: "비정상", "health: starting": "상태 확인 중" };

/** The engine's status line ("Up 1 hours (healthy)", "Exited (255) 13 hours ago") in Korean. */
export function statusText(c: Container) {
  const up = /^Up (.+?)(?: \((.+)\))?$/.exec(c.status);
  if (up) {
    const note = up[2] && health[up[2].toLowerCase()];
    return `${duration(up[1])}째 실행 중` + (note ? ` · ${note}` : "");
  }
  const exited = /^Exited \((-?\d+)\) (.+) ago$/.exec(c.status);
  if (exited) return `${duration(exited[2])} 전 종료` + (exited[1] === "0" ? "" : ` · 종료 코드 ${exited[1]}`);
  if (c.state === "created") return "시작한 적 없음";
  return c.status;
}

export const stateLabel: Record<string, string> = {
  running: "실행 중",
  paused: "일시정지",
  restarting: "재시작 중",
  exited: "중지됨",
  created: "생성됨",
  dead: "오류",
  removing: "삭제 중",
};

/** Splits a command line into words; quotes keep spaces together. */
export function words(line: string) {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/** Quotes a word for display in a shell command when it needs it. */
export const shq = (w: string) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, `'\\''`)}'`);
