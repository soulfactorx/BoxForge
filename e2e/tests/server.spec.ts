import { expect, test } from "@playwright/test";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// The web server for other machines: sign-in, the look-only password,
// and what it refuses. Its own program, on its own port, over TLS.
test.describe.configure({ mode: "serial" });
const port = 34191;
const base = `https://127.0.0.1:${port}`;
let server: ChildProcess;

test.beforeAll(async () => {
  const bin = join(__dirname, "..", ".bin", "boxforge-server");
  execFileSync("go", ["build", "-o", bin, "../cmd/boxforge-server"], { stdio: "inherit" });
  server = spawn(bin, ["-listen", `:${port}`, "-tls"], {
    env: { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "bfe2e-server-")), BOXFORGE_PASSWORD: "right-password-1", BOXFORGE_VIEWER_PASSWORD: "just-looking-1", BOXFORGE_AGENT_BASE: process.env.E2E_NODE ?? "" },
    stdio: "ignore",
  });
  for (let i = 0; i < 60; i++) {
    try {
      await fetch(base, { signal: AbortSignal.timeout(1000) });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
});
test.afterAll(() => server?.kill());
test.use({ ignoreHTTPSErrors: true });

test("nothing but the page answers without signing in", async ({ request }) => {
  expect((await request.get(base + "/")).status()).toBe(200);
  expect((await request.post(base + "/api/call/Containers", { data: [] })).status()).toBe(401);
  expect((await request.get(base + "/api/events")).status()).toBe(401);
  expect((await request.post(base + "/api/upload", { data: "x", headers: { "X-File-Name": "a" } })).status()).toBe(401);
});

test("sign in, and a request from another site's page is refused", async ({ request }) => {
  expect((await request.post(base + "/api/login", { data: { password: "wrong" } })).status()).toBe(401);
  expect((await request.post(base + "/api/login", { data: { password: "right-password-1" } })).status()).toBe(200);
  expect(await (await request.post(base + "/api/call/Version", { data: [] })).json()).toHaveProperty("result");
  const other = await request.post(base + "/api/call/Version", { data: [], headers: { Origin: "https://elsewhere.example" } });
  expect(other.status()).toBe(403);
});

test("the look-only password looks and changes nothing", async ({ request }) => {
  expect(await (await request.post(base + "/api/login", { data: { password: "just-looking-1" } })).json()).toMatchObject({ viewer: true });
  expect(await (await request.post(base + "/api/call/Containers", { data: [] })).json()).toHaveProperty("result");
  for (const [m, args] of [["ContainerAction", ["x", "stop"]], ["TermOpen", ["x", 80, 24]], ["ContainerFiles", ["x", "/"]], ["Browse", [""]]] as const) {
    expect(await (await request.post(`${base}/api/call/${m}`, { data: args })).json(), m).toEqual({ error: "viewer" });
  }
});

test("an AI agent box's port is opened from other devices over the server's HTTPS, to signed-in browsers only", async ({ playwright }) => {
  test.setTimeout(300_000);
  const signed = async (password: string) => {
    const r = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    expect((await r.post(base + "/api/login", { data: { password } })).status()).toBe(200);
    return r;
  };
  const admin = await signed("right-password-1");
  const call = async (method: string, ...args: unknown[]) => {
    const res = await admin.post(base + "/api/call/" + method, { data: args });
    const body = await res.json();
    if (res.status() !== 200) throw new Error(`${method}: ${JSON.stringify(body)}`);
    return body.result;
  };
  const work = mkdtempSync(join(tmpdir(), "bfe2e-share-"));
  chmodSync(work, 0o777);
  const name = "bfe2e-share";
  const box = await call("AgentSave", { name, agents: [], image: process.env.E2E_ALPINE ?? "alpine:3", command: "sh", workspace: work, network: "ai", allow: ["example.org"], memory: 1, cpus: 1, pids: 128, readOnlyRoot: false }, true);
  try {
    await call("ComposeAction", { key: "share-1", project: box.project, files: [box.file], action: "upbuild" });
    execFileSync("docker", ["exec", "-d", `${box.project}-agent`, "sh", "-c", `while true; do printf "HTTP/1.0 200 OK\\r\\nContent-Length: 10\\r\\n\\r\\nhello-port" | nc -l -s 127.0.0.1 -p 18081 >/dev/null; done`]);
    const ext: number = await call("AgentPortShare", name, 18081);
    const at = `https://127.0.0.1:${ext}/`;
    // Signed in: the box's page, over HTTPS.
    await expect.poll(async () => (await admin.get(at).catch(() => null))?.text() ?? "", { timeout: 30_000 }).toBe("hello-port");
    // Not signed in, or only to look: refused, the box not reached.
    const stranger = await playwright.request.newContext({ ignoreHTTPSErrors: true });
    expect((await stranger.get(at)).status()).toBe(403);
    const viewer = await signed("just-looking-1");
    expect((await viewer.get(at)).status()).toBe(403);
    expect(await call("AgentPorts", name)).toEqual([{ port: 18081, local: expect.any(Number), shared: ext }]);
  } finally {
    await call("ComposeAction", { key: "share-2", project: box.project, files: [box.file], action: "purge" }).catch(() => {});
    await call("AgentForget", name).catch(() => {});
  }
});

test("the sign-in page on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base);
  await page.getByLabel("비밀번호").fill("right-password-1");
  await page.getByRole("button", { name: "들어가기" }).click();
  await expect(page.getByTestId("nav-containers")).toBeVisible();
  await expect(page.getByTestId("app-version")).toBeVisible();
});

test("-daemon runs it in the background, -status sees it, -stop ends it", async ({ request }) => {
  const bin = join(__dirname, "..", ".bin", "boxforge-server");
  const env = { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "bfe2e-daemon-")) };
  const run = (...args: string[]) => execFileSync(bin, args, { env, encoding: "utf8" });
  const started = run("-daemon", "-listen", "127.0.0.1:34199", "-tls");
  expect(started).toContain("백그라운드에서 실행했습니다");
  expect(started).toContain("https://127.0.0.1:34199");
  expect(started).toMatch(/비밀번호: \S+/);
  expect((await request.get("https://127.0.0.1:34199/")).status()).toBe(200);
  expect(run("-status")).toContain("실행 중 (-daemon");
  expect(() => run("-daemon", "-listen", "127.0.0.1:34199", "-tls")).toThrow(/이미 실행 중/);
  expect(run("-stop")).toContain("서버를 껐습니다");
  await expect(request.get("https://127.0.0.1:34199/", { timeout: 3000 })).rejects.toThrow();
});

test("-install makes it a service that runs, -uninstall takes it away", async ({ request }) => {
  // It really installs one (sudo, systemd or OpenRC): only where asked to (CI).
  test.skip(!process.env.E2E_INSTALL, "set E2E_INSTALL=1 to install a real service");
  const bin = join(__dirname, "..", ".bin", "boxforge-server");
  const out = execFileSync("sudo", [bin, "-install", "-listen", "127.0.0.1:34200", "-tls"], { encoding: "utf8" });
  expect(out).toContain("설치했습니다");
  try {
    await expect.poll(async () => (await request.get("https://127.0.0.1:34200/").catch(() => null))?.status(), { timeout: 30_000 }).toBe(200);
    expect(execFileSync("/opt/boxforge/boxforge-server", ["-status"], { encoding: "utf8" })).toMatch(/서비스\((systemd|openrc)\): (active|.*started)/);
  } finally {
    expect(execFileSync("sudo", ["/opt/boxforge/boxforge-server", "-uninstall"], { encoding: "utf8" })).toContain("서비스를 지웠습니다");
  }
  await expect(request.get("https://127.0.0.1:34200/", { timeout: 3000 })).rejects.toThrow();
});

test("-update puts the newest release in place, checked, and starts the running one again on it", async ({ request }) => {
  // A release of our own: version 9.9.9, served from here.
  const dir = mkdtempSync(join(tmpdir(), "bfe2e-update-"));
  const old = join(dir, "boxforge-server");
  const fresh = join(dir, "release-program");
  const v = (n: string) => ["build", "-ldflags", `-X github.com/soulfactorx/boxforge/internal/version.Version=${n}`];
  execFileSync("go", [...v("0.0.1"), "-o", old, "../cmd/boxforge-server"], { stdio: "inherit" });
  execFileSync("go", [...v("9.9.9"), "-o", fresh, "../cmd/boxforge-server"], { stdio: "inherit" });
  const os = process.platform === "win32" ? "windows" : process.platform;
  const arch = process.arch === "x64" ? "amd64" : process.arch;
  const asset = `BoxForge-server-${os}-${arch}${os === "windows" ? ".exe" : ""}`;
  const program = readFileSync(fresh);
  let sum = createHash("sha256").update(program).digest("hex");
  const releases = createHttpServer((req, res) => {
    const at = "http://127.0.0.1:34202";
    if (req.url === "/latest") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ tag_name: "v9.9.9", body: "", html_url: at, assets: [{ name: asset, browser_download_url: `${at}/p` }, { name: "checksums.txt", browser_download_url: `${at}/sums` }] }));
    } else if (req.url === "/p") res.end(program);
    else if (req.url === "/sums") res.end(`${sum}  ${asset}\n`);
    else res.writeHead(404).end();
  });
  await new Promise<void>((ok, fail) => releases.once("error", fail).listen(34202, "127.0.0.1", () => ok()));
  try {
    const env = { ...process.env, XDG_CONFIG_HOME: join(dir, "config"), BOXFORGE_UPDATE_API: "http://127.0.0.1:34202/latest" };
    // Not execFileSync: the release server above answers from this very process.
    const run = async (...args: string[]) => (await execFileAsync(old, args, { env, encoding: "utf8" })).stdout;

    // A download that doesn't match the release's checksum is not installed.
    sum = "0".repeat(64);
    await expect(run("-update")).rejects.toThrow(/checksum/);
    expect((await run("-version")).trim()).toBe("0.0.1");
    sum = createHash("sha256").update(program).digest("hex");

    await run("-daemon", "-listen", "127.0.0.1:34203", "-tls");
    const out = await run("-update");
    expect(out).toContain("지금 버전: 0.0.1");
    expect(out).toContain("9.9.9(으)로 바꿨습니다");
    expect(out).toContain("새 버전으로 다시 켭니다");
    expect(out).toContain("BoxForge 서버 9.9.9");
    expect((await run("-version")).trim()).toBe("9.9.9");
    expect((await request.get("https://127.0.0.1:34203/")).status()).toBe(200);
    expect(await run("-update")).toContain("이미 최신 버전입니다");
    expect(await run("-stop")).toContain("서버를 껐습니다");
  } finally {
    releases.close();
  }
});
