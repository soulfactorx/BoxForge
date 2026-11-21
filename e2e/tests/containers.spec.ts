import { expect, test } from "@playwright/test";
import { ALPINE, closeDetail, go, open, sh, sweep } from "./helpers";

test.describe.configure({ mode: "serial" });
test.afterAll(sweep);

test("run a container from the form, then look inside it", async ({ page }) => {
  const errors = await open(page);
  await go(page, "containers");
  await page.getByRole("button", { name: "새 컨테이너 실행" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByPlaceholder("예: nginx, postgres:17").fill(ALPINE);
  await dlg.getByPlaceholder("비워 두면 Docker가 지어 줍니다").fill("bfe2e-one");
  await dlg.getByRole("button", { name: "추가" }).nth(1).click();
  await dlg.getByPlaceholder("볼륨 이름 또는 폴더").fill("bfe2e-data");
  await dlg.getByPlaceholder("컨테이너 안 경로").fill("/data");
  await dlg.getByRole("button", { name: "추가" }).nth(2).click();
  await dlg.getByPlaceholder("이름").last().fill("MODE");
  await dlg.getByPlaceholder("값").last().fill("first");
  await dlg.getByPlaceholder("비워 두면 이미지에 정해진 대로 실행합니다").fill('sh -c "echo ready-$MODE; echo kept > /data/k.txt; sleep 1d"');
  const cli = await dlg.getByTestId("run-cli").innerText();
  expect(cli).toContain("docker run -d --name bfe2e-one -v bfe2e-data:/data -e MODE=first");
  await dlg.getByRole("button", { name: "실행", exact: true }).click();
  await expect.poll(() => sh(`docker inspect bfe2e-one --format '{{.State.Status}}'`, true)).toBe("running");

  // the detail opens on its logs
  await expect(page.getByTestId("logs")).toContainText("ready-first");
  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByTestId("file-data").getByRole("button").first().click();
  await page.getByTestId("file-k.txt").getByRole("button").first().click();
  await expect(page.getByTestId("file-text")).toContainText("kept");
  await page.getByRole("tab", { name: "터미널" }).click();
  await page.locator(".xterm").first().click();
  await page.waitForTimeout(1500);
  await page.keyboard.type("echo t-$((6*7))\n");
  await expect(page.locator(".xterm-rows").first()).toContainText("t-42");
  await closeDetail(page);
  expect(errors).toEqual([]);
});

test("a base image is kept running with a terminal", async ({ page }) => {
  await open(page);
  await go(page, "containers");
  await page.getByRole("button", { name: "새 컨테이너 실행" }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByPlaceholder("예: nginx, postgres:17").fill(ALPINE);
  await dlg.getByPlaceholder("비워 두면 Docker가 지어 줍니다").fill("bfe2e-shell");
  await expect(dlg.getByTestId("shell-note")).toBeVisible();
  await expect(dlg.getByTestId("run-cli")).toContainText("docker run -dit");
  await dlg.getByRole("button", { name: "실행", exact: true }).click();
  await page.waitForTimeout(3000);
  expect(sh(`docker inspect bfe2e-shell --format '{{.State.Status}}'`)).toBe("running");
});

test("change settings by remaking the container, keeping its data", async ({ page }) => {
  await open(page);
  await go(page, "containers");
  await page.locator("tr", { hasText: "bfe2e-one" }).getByRole("button", { name: "더보기" }).click();
  await page.getByRole("menuitem", { name: "설정 바꿔 다시 만들기" }).click();
  const dlg = page.getByRole("dialog");
  await expect(dlg.getByTestId("run-cli")).toContainText("-e MODE=first");
  await dlg.getByLabel("환경변수 1: 값").fill("second");
  const before = sh(`docker inspect bfe2e-one --format '{{.Id}}'`);
  await dlg.getByRole("button", { name: "지우고 다시 만들기" }).click();
  await expect(dlg).toBeHidden({ timeout: 60_000 });
  expect(sh(`docker inspect bfe2e-one --format '{{.Id}}'`)).not.toBe(before);
  expect(sh(`docker exec bfe2e-one sh -c 'echo $MODE; cat /data/k.txt'`)).toBe("second\nkept");
});

test("rename, stop and delete", async ({ page }) => {
  await open(page);
  await go(page, "containers");
  const row = page.locator("tr", { hasText: "bfe2e-shell" });
  await row.hover();
  await row.getByRole("button", { name: "이름 변경" }).click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("bfe2e-renamed\n");
  await expect.poll(() => sh(`docker inspect bfe2e-renamed --format ok`, true)).toBe("ok");
  const renamed = page.locator("tr", { hasText: "bfe2e-renamed" });
  await renamed.getByRole("button", { name: "중지" }).click();
  await expect(renamed.getByText("중지됨")).toBeVisible({ timeout: 30_000 });
  await renamed.getByRole("button", { name: "삭제" }).click();
  await page.getByRole("dialog").getByRole("button", { name: /삭제/ }).last().click();
  await expect(renamed).toHaveCount(0, { timeout: 15_000 });
});
