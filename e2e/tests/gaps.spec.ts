import { expect, test } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALPINE, closeDetail, go, open, sh, sweep } from "./helpers";

test.describe.configure({ mode: "serial" });
test.afterAll(sweep);

test("put a file into a running container and into a volume", async ({ page }) => {
  sh(`docker run -d --name bfe2e-up -v bfe2e-updata:/data ${ALPINE} sleep 1d`);
  const file = join(mkdtempSync(join(tmpdir(), "bfe2e-up-")), "hello.txt");
  writeFileSync(file, "from this device\n");
  await open(page);
  await go(page, "containers");
  await page.getByRole("button", { name: "bfe2e-up", exact: true }).click();
  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByTestId("file-srv").getByRole("button").first().click();
  await page.getByTestId("upload-input").setInputFiles(file);
  await expect(page.getByText("올렸습니다: hello.txt → /srv")).toBeVisible();
  await expect(page.getByTestId("file-hello.txt")).toBeVisible();
  expect(sh(`docker exec bfe2e-up cat /srv/hello.txt`)).toBe("from this device");
  await closeDetail(page);

  await go(page, "volumes");
  await page.locator("tr", { hasText: "bfe2e-updata" }).getByRole("button", { name: /파일 보기|내용 보기/ }).click();
  await page.getByTestId("upload-input").setInputFiles(file);
  await expect(page.getByText("올렸습니다: hello.txt → /")).toBeVisible({ timeout: 30_000 });
  expect(sh(`docker exec bfe2e-up cat /data/hello.txt`)).toBe("from this device");
});

test("change a running container's limits without remaking it", async ({ page }) => {
  const id = sh(`docker inspect bfe2e-up --format '{{.Id}}'`);
  await open(page);
  await go(page, "containers");
  await page.locator("tr", { hasText: "bfe2e-up" }).getByRole("button", { name: "더보기" }).click();
  await page.getByRole("menuitem", { name: "자원 제한 바꾸기" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("메모리 (MB)").fill("128");
  await dlg.getByLabel("CPU (코어 수)").fill("0.5");
  await expect(dlg.locator("code")).toContainText("docker update --memory 128m --memory-swap 256m --cpus 0.5 bfe2e-up");
  await dlg.getByRole("button", { name: "바꾸기" }).click();
  await expect(dlg).toBeHidden();
  expect(sh(`docker inspect bfe2e-up --format '{{.Id}} {{.HostConfig.Memory}} {{.HostConfig.NanoCpus}}'`)).toBe(`${id} ${128 << 20} 500000000`);
  await page.getByRole("button", { name: "bfe2e-up", exact: true }).click();
  await expect(page.getByText("메모리 128MB · CPU 0.5코어")).toBeVisible();
});

test("health is shown, and a failure is announced", async ({ page }) => {
  sh(`docker run -d --name bfe2e-sick --health-cmd 'exit 1' --health-interval 1s --health-retries 1 ${ALPINE} sleep 1d`);
  sh(`docker run -d --name bfe2e-dies ${ALPINE} sh -c 'sleep 6; exit 3'`);
  await open(page);
  await go(page, "containers");
  await expect(page.locator("tr", { hasText: "bfe2e-sick" }).getByTestId("health")).toHaveText("이상", { timeout: 30_000 });
  const alerts = page.getByTestId("alerts");
  await expect(alerts).toContainText("bfe2e-dies", { timeout: 30_000 });
  await expect(alerts).toContainText("종료 코드 3");
  await alerts.getByRole("button", { name: /bfe2e-dies/ }).click();
  await expect(page.getByTestId("why")).toContainText("종료 코드 3");
});

test("images BoxForge left behind can be cleared from home", async ({ page }) => {
  // An image of its own, as a cut-short copy leaves: nothing uses it.
  sh(`docker create --name bfe2e-left ${ALPINE} true`);
  sh(`docker commit bfe2e-left boxforge-copy/bfe2e:left`);
  sh(`docker rm bfe2e-left`);
  await open(page);
  const box = page.getByTestId("leftovers");
  await expect(box).toContainText("1개", { timeout: 30_000 });
  await box.getByRole("button", { name: "지우기" }).click();
  await expect(page.getByRole("dialog")).toContainText("boxforge-copy/bfe2e:left");
  await page.getByRole("dialog").getByRole("button", { name: "지우기" }).click();
  await expect(box).toHaveCount(0, { timeout: 30_000 });
  expect(sh(`docker image inspect boxforge-copy/bfe2e:left --format ok`, true)).toContain("ERR");
});
