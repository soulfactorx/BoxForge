import { expect, test } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The engine's resources on Windows (.wslconfig, the disk's sparse
// setting). There is no Windows here: a stand-in wsl.exe runs commands on
// this machine and writes down what it was asked, and the app is told the
// engine in use is the BoxForge distribution inside it.
test.describe.configure({ mode: "serial" });
const port = 34192;
const base = `http://127.0.0.1:${port}`;
const dir = mkdtempSync(join(tmpdir(), "bfe2e-wsl-"));
const calls = join(dir, "wsl-calls");
const wslconfig = join(dir, "wslconfig");
let server: ChildProcess;

test.beforeAll(async () => {
  const wsl = join(dir, "wsl");
  writeFileSync(
    wsl,
    `#!/bin/sh
case "$1" in
  --status) exit 0 ;;
  -l) printf 'BoxForge\nkiri\n'; exit 0 ;;
  --shutdown|--terminate|--manage) echo "$*" >> ${calls}; exit 0 ;;
  -d) case "$*" in *fstrim*) echo "$*" >> ${calls}; exit 0 ;; esac ;;
esac
while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
shift
exec "$@"
`,
  );
  chmodSync(wsl, 0o755);
  writeFileSync(wslconfig, "[wsl2]\r\nmemory=8GB\r\nkernelCommandLine = quiet\r\n");
  const config = join(dir, "config");
  mkdirSync(join(config, "BoxForge"), { recursive: true });
  writeFileSync(join(config, "BoxForge", "config.json"), JSON.stringify({ engine: "wsl:BoxForge" }));
  const cache = join(dir, "cache");
  mkdirSync(join(cache, "BoxForge", "wsl"), { recursive: true });
  execFileSync("truncate", ["-s", "3G", join(cache, "BoxForge", "wsl", "ext4.vhdx")]);
  // Kiri's distribution's disk, and a stand-in diskpart that writes down its
  // script and shrinks the file as compacting would.
  const kiri = join(dir, "kiri.vhdx");
  execFileSync("truncate", ["-s", "5G", kiri]);
  const diskpart = join(dir, "diskpart");
  writeFileSync(diskpart, `#!/bin/sh\ncat >> ${calls}\necho "DiskPart successfully compacted the virtual disk file."\ntruncate -s 2G ${kiri}\n`);
  chmodSync(diskpart, 0o755);

  const bin = join(__dirname, "..", ".bin", "devserver");
  execFileSync("go", ["build", "-o", bin, "../cmd/devserver"], { stdio: "inherit" });
  server = spawn(bin, ["-port", String(port), "-dist", "../frontend/dist"], {
    env: { ...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, BOXFORGE_WSL: wsl, BOXFORGE_WSLCONFIG: wslconfig, BOXFORGE_WSL_DISKS: `kiri=${kiri}`, BOXFORGE_DISKPART: diskpart },
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

test("the engine's memory and CPU go into .wslconfig, the rest kept", async ({ page }) => {
  await page.goto(base);
  await page.getByTestId("nav-settings").click();
  const panel = page.getByTestId("engine-resources");
  await expect(panel.getByLabel("WSL 메모리 (GB)")).toHaveValue("8");
  await expect(panel).toContainText("3.0 GB");

  await panel.getByLabel("WSL 메모리 (GB)").fill("4");
  await panel.getByLabel("WSL CPU (개)").fill("2");
  await panel.getByRole("button", { name: "저장", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "저장만 (나중에 적용)" }).click();
  await expect(panel.getByText("아직 적용되지 않았습니다")).toBeVisible();
  expect(readFileSync(wslconfig, "utf8")).toBe("[wsl2]\r\nmemory=4GB\r\nkernelCommandLine = quiet\r\nprocessors=2\r\n");
  expect(existsSync(wslconfig + ".boxforge-backup")).toBe(true);
  expect(existsSync(calls)).toBe(false); // saved only: nothing stopped

  await panel.getByLabel("WSL CPU (개)").fill("3");
  await panel.getByRole("button", { name: "저장", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "저장하고 지금 적용" }).click();
  await expect.poll(() => (existsSync(calls) ? readFileSync(calls, "utf8") : "")).toContain("--shutdown");
  await expect(panel.getByText("아직 적용되지 않았습니다")).toBeHidden();
});

test("the disk gives back what is deleted", async ({ page }) => {
  await page.goto(base);
  await page.getByTestId("nav-settings").click();
  const panel = page.getByTestId("engine-resources");
  await panel.getByRole("button", { name: "자동 줄이기 켜기" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "WSL 멈추고 바꾸기" }).click();
  await expect.poll(() => readFileSync(calls, "utf8")).toContain("--manage BoxForge --set-sparse true");
  await expect(panel.getByRole("button", { name: "자동 줄이기 끄기" })).toBeVisible();
});

test("a WSL disk is shrunk: free blocks marked, WSL stopped, the file compacted", async ({ page }) => {
  await page.goto(base);
  await page.getByTestId("nav-settings").click();
  const panel = page.getByTestId("wsl-disks");
  await expect(panel.getByTestId("wsl-disk-kiri")).toContainText("5.0 GB");
  await expect(panel.getByTestId("wsl-disk-BoxForge")).toContainText("BoxForge 엔진");
  await panel.getByTestId("wsl-disk-kiri").getByRole("button", { name: "줄이기" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg).toContainText("모든 WSL 배포판");
  await dlg.getByRole("button", { name: "WSL 멈추고 줄이기" }).click();
  await expect(panel).toContainText("5.0 GB → 2.0 GB", { timeout: 30_000 });
  const said = readFileSync(calls, "utf8");
  expect(said).toContain("-d kiri -u root -- fstrim -a");
  expect(said.indexOf("fstrim")).toBeLessThan(said.lastIndexOf("--shutdown"));
  expect(said).toContain(`select vdisk file="${join(dir, "kiri.vhdx")}"`);
  expect(said).toContain("compact vdisk");
});
