// Ready-made settings for programs people start most often, and reading a
// `docker run` line someone found on the web into the same shape.
import { words } from "./format";

export type Pair = { a: string; b: string };

/** What the run form starts out filled with. */
export interface RunInit {
  image: string;
  name?: string;
  ports?: Pair[];
  mounts?: Pair[];
  env?: Pair[];
  restart?: string;
  command?: string;
}

export interface Recipe extends RunInit {
  title: string;
  about: string;
}

export const recipes: Recipe[] = [
  { title: "PostgreSQL", about: "관계형 데이터베이스", image: "postgres:17", name: "postgres", ports: [{ a: "5432", b: "5432" }], mounts: [{ a: "pgdata", b: "/var/lib/postgresql/data" }], env: [{ a: "POSTGRES_PASSWORD", b: "" }], restart: "unless-stopped" },
  { title: "MySQL", about: "관계형 데이터베이스", image: "mysql:8", name: "mysql", ports: [{ a: "3306", b: "3306" }], mounts: [{ a: "mysqldata", b: "/var/lib/mysql" }], env: [{ a: "MYSQL_ROOT_PASSWORD", b: "" }], restart: "unless-stopped" },
  { title: "MariaDB", about: "MySQL과 호환되는 데이터베이스", image: "mariadb:11", name: "mariadb", ports: [{ a: "3306", b: "3306" }], mounts: [{ a: "mariadbdata", b: "/var/lib/mysql" }], env: [{ a: "MARIADB_ROOT_PASSWORD", b: "" }], restart: "unless-stopped" },
  { title: "Redis", about: "메모리 캐시 · 저장소", image: "redis:7", name: "redis", ports: [{ a: "6379", b: "6379" }], mounts: [{ a: "redisdata", b: "/data" }], restart: "unless-stopped" },
  { title: "MongoDB", about: "문서 데이터베이스", image: "mongo:7", name: "mongo", ports: [{ a: "27017", b: "27017" }], mounts: [{ a: "mongodata", b: "/data/db" }], restart: "unless-stopped" },
  { title: "nginx", about: "웹 서버", image: "nginx:alpine", name: "nginx", ports: [{ a: "8080", b: "80" }] },
];

// Flags of `docker run` that take no value, so the word after them is not theirs.
const bare = new Set(["-d", "--detach", "--rm", "-i", "-t", "-it", "-ti", "-itd", "-dit", "-P", "--privileged", "--init", "--read-only"]);

/** Reads a `docker run …` line. Returns null when the line is not one. */
export function parseRun(line: string): RunInit | null {
  const w = words(line.trim());
  let i = 0;
  if (w[i] === "sudo") i++;
  if (w[i] !== "docker") return null;
  i++;
  if (w[i] === "container") i++;
  if (w[i] !== "run") return null;
  i++;
  const init: RunInit = { image: "", ports: [], mounts: [], env: [] };
  const take = (flag: string, value: string) => {
    const cut = (s: string, sep: string): Pair => {
      const at = s.indexOf(sep);
      return at < 0 ? { a: s, b: "" } : { a: s.slice(0, at), b: s.slice(at + 1) };
    };
    if (flag === "-p" || flag === "--publish") {
      // "8080:80", "127.0.0.1:8080:80", "8080:80/tcp"
      const parts = value.replace(/\/\w+$/, "").split(":");
      if (parts.length >= 2) init.ports!.push({ a: parts[parts.length - 2], b: parts[parts.length - 1] });
    } else if (flag === "-v" || flag === "--volume") {
      // "name:/path", "C:\dir:/path", "/host:/path:ro"
      const m = /^(.+?):(\/[^:]*)(?::\w+)?$/.exec(value);
      if (m) init.mounts!.push({ a: m[1], b: m[2] });
    } else if (flag === "-e" || flag === "--env") init.env!.push(cut(value, "="));
    else if (flag === "--name") init.name = value;
    else if (flag === "--restart") init.restart = value;
  };
  for (; i < w.length; i++) {
    const word = w[i];
    if (!word.startsWith("-")) break;
    if (bare.has(word)) continue;
    const eq = word.indexOf("=");
    if (word.startsWith("--") && eq > 0) take(word.slice(0, eq), word.slice(eq + 1));
    else if (/^-[pve]./.test(word)) take(word.slice(0, 2), word.slice(2)); // "-p8080:80"
    else take(word, w[++i] ?? "");
  }
  init.image = w[i] ?? "";
  if (!init.image) return null;
  init.command = w.slice(i + 1).map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(" ");
  return init;
}
