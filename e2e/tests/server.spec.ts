import { expect, test } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    env: { ...process.env, XDG_CONFIG_HOME: mkdtempSync(join(tmpdir(), "bfe2e-server-")), BOXFORGE_PASSWORD: "right-password-1", BOXFORGE_VIEWER_PASSWORD: "just-looking-1" },
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
