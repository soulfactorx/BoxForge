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
  const body = await res.json();
  if (body.error) throw new Error(body.error);
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
