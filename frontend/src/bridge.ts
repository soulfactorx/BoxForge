// The one place that knows how the page reaches the Go side: Wails' bindings
// inside the desktop app, or the dev server's HTTP API in a browser.

export interface Port {
  ip: string;
  private: number;
  public: number;
  proto: string;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  failed: boolean;
  /** healthy, unhealthy, starting; "" when the image has no health check. */
  health?: string;
  exitCode: number;
  system: boolean;
  imageId: string;
  created: number;
  ports: Port[];
  project: string;
  service: string;
  volumes: string[];
  networks: { network: string; ip: string }[];
  labels: Record<string, string> | null;
}

export interface Volume {
  name: string;
  driver: string;
  created: number;
  project: string;
}

export interface Network {
  id: string;
  name: string;
  driver: string;
  subnet: string;
  gateway: string;
  internal: boolean;
  builtin: boolean;
  created: number;
  project: string;
}

export interface Size {
  rw: number;
  rootFs: number;
}

export interface Image {
  id: string;
  tags: string[];
  size: number;
  /** How much of size is layers other images use too (kept once on disk). */
  shared?: number;
  created: number;
  inUse: number;
}

export interface RunSpec {
  image: string;
  name: string;
  ports: { host: number; container: number; proto: string }[];
  mounts: { source: string; target: string }[];
  env: string[];
  restart: string;
  command: string[];
  interactive?: boolean;
  network?: string;
}

export interface PullState {
  ref: string;
  status: string;
  percent: number;
  done: boolean;
  error: string;
}

export interface LogChunk {
  id: string;
  text: string;
  end: boolean;
  error: string;
}

/** Runs one engine call for the user, showing the docker command it stands for. Resolves false when it failed. */
export type Run = (command: string, action: () => Promise<unknown>) => Promise<boolean>;

export interface EngineInfo {
  runtime: string;
  name: string;
  version: string;
  os: string;
  arch: string;
  cpus: number;
  memTotal: number;
  containers: number;
  running: number;
  images: number;
}

export interface EngineStatus {
  connected: boolean;
  error: string;
  info: EngineInfo | null;
}

type Listener = (data: any) => void;

const w = window as any;
const bound = () => w.go?.app?.App;

/** Calls a method as the page goes away (closed, reloaded): sent even so, its answer not waited for. */
export function callOnLeave(method: string, ...args: unknown[]) {
  const b = bound();
  if (b) return void Promise.resolve(b[method](...args)).catch(() => {});
  fetch(`/api/call/${method}`, { method: "POST", body: JSON.stringify(args), keepalive: true }).catch(() => {});
}

/** Calls a method of the Go App. Rejects with an Error carrying the engine's message. */
export async function call<T>(method: string, ...args: unknown[]): Promise<T> {
  const b = bound();
  if (b) {
    try {
      return await b[method](...args);
    } catch (e: any) {
      throw new Error(e?.message ?? String(e));
    }
  }
  const res = await fetch(`/api/call/${method}`, { method: "POST", body: JSON.stringify(args) });
  if (res.status === 401) {
    window.dispatchEvent(new Event("boxforge-signed-out"));
    throw new Error("로그인이 필요합니다.");
  }
  const body = await res.json();
  if (body.error === "viewer") throw new Error("보기 전용으로 로그인했습니다. 바꾸는 일은 관리용 비밀번호로 로그인해야 할 수 있습니다.");
  if (body.error) throw new Error(body.error);
  // A file the server wrote for this browser: fetched at once, and what
  // the caller is told is its name, not a path on the server.
  if (method.endsWith("Save") && typeof body.result === "string" && fetchable(body.result)) return download(body.result) as T;
  return body.result as T;
}

const listeners = new Map<string, Set<Listener>>();
let source: EventSource | null = null;

/** Event sent to listeners whenever the browser's event stream (re)opens: reload then. */
export const STREAM_OPEN = "stream-open";

function dispatch(event: string, data: unknown) {
  listeners.get(event)?.forEach((l) => l(data));
}

/** Subscribes to an event from the Go side. Returns the unsubscribe function. */
export function on(event: string, cb: Listener): () => void {
  if (w.runtime?.EventsOn) return w.runtime.EventsOn(event, cb);
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event)!.add(cb);
  if (!source) {
    source = new EventSource("/api/events");
    source.onopen = () => dispatch(STREAM_OPEN, null);
    source.onmessage = (m) => {
      const { event, data } = JSON.parse(m.data);
      dispatch(event, data);
    };
  }
  return () => listeners.get(event)?.delete(cb);
}

/** Opens a URL in the user's browser. */
export function openURL(url: string) {
  if (w.runtime?.BrowserOpenURL) w.runtime.BrowserOpenURL(url);
  else window.open(url, "_blank", "noopener");
}

/** Whether the page is in the desktop app's window (not a browser). */
export const inWindow = () => !!bound();

// What the web server said about itself: whether it is the one for use
// from other machines, and where it writes files for the browser to fetch.
let server: { remote?: boolean; outbox?: string; viewer?: boolean } = {};
export const setServer = (s: { remote?: boolean; outbox?: string; viewer?: boolean }) => {
  server = s ?? {};
};

/** Whether this sign-in may only look (the web server's second password). */
export const viewer = () => !!server.viewer;

/** Whether BoxForge is being used from a browser, on a server elsewhere. */
export const remote = () => !!server.remote;

const fetchable = (path: string) => !!server.outbox && (path.startsWith(server.outbox + "/") || path.startsWith(server.outbox + "\\"));

/** Has the browser fetch a file the server wrote for it; returns its name. */
export function download(path: string): string {
  const name = path.split(/[\\/]/).pop()!;
  const a = document.createElement("a");
  a.href = `/api/outbox/${encodeURIComponent(name)}`;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  return `${name} (브라우저가 내려받음)`;
}

/** Sends a file to the server; returns where the server put it. */
export async function upload(file: File): Promise<string> {
  const res = await fetch("/api/upload", { method: "POST", body: file, headers: { "X-File-Name": encodeURIComponent(file.name) } });
  const body = await res.json();
  if (body.error) throw new Error(body.error);
  return body.result as string;
}

/** Ends the sign-in. */
export async function signOut() {
  await fetch("/api/logout", { method: "POST" });
  location.reload();
}
