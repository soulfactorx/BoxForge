import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { go, open, sh, sweep } from "./helpers";

test.describe.configure({ mode: "serial" });
const dir = join(mkdtempSync(join(tmpdir(), "bfe2e-compose-")), "bfe2e-shop");
let holder: Server | null = null;
test.afterAll(() => {
  holder?.close();
  sh(`docker compose -p bfe2e-shop down -v`, true);
  sweep();
});

test("a new project: a taken port is found and moved, and it comes up", async ({ page }) => {
  // Something else holds 8080, as on many PCs.
  holder = createServer().listen(8080, "0.0.0.0");
  const errors = await open(page);
  await go(page, "compose");
  await page.getByRole("button", { name: "새로 만들기" }).click();
  const form = page.getByRole("dialog", { name: "새 Compose 프로젝트" });
  await expect(form.getByLabel("새 compose 파일 내용")).toHaveValue(/# 내 PC의 8080/);
  await expect(form.getByTestId("ports-taken")).toContainText("8080");
  await form.getByLabel("프로젝트 폴더").fill("not/a/whole/path");
  await form.getByRole("button", { name: "만들고 올리기" }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await form.getByLabel("프로젝트 폴더").fill(dir);
  await form.getByTestId("ports-taken").getByRole("button", { name: "비어 있는 포트로 바꾸기" }).click();
  await expect(form.getByTestId("ports-taken")).toHaveCount(0);
  await form.getByRole("button", { name: "만들고 올리기" }).click();
  await expect(page.getByTestId("compose-progress")).toContainText("끝났습니다", { timeout: 120_000 });
  expect(sh(`docker ps --format '{{.Names}}'`)).toContain("bfe2e-shop-web-1");
  expect(readFileSync(join(dir, "compose.yaml"), "utf8")).not.toContain('"8080:80"');
  // all of it runs: bringing it up again is not offered on the list
  await expect(page.locator(".project", { hasText: "bfe2e-shop" }).getByRole("button", { name: /모두 실행 중/ })).toBeDisabled();
  expect(errors).toEqual([]);
});

test("change a service from the picture; the file keeps its comments", async ({ page }) => {
  await open(page);
  await go(page, "compose");
  await page.getByRole("button", { name: "자세히" }).first().click();
  await page.getByTestId("svc-edit-web").click();
  const dlg = page.getByRole("dialog");
  await dlg.getByLabel("환경변수").fill("MODE=prod");
  await dlg.getByRole("button", { name: "파일에 반영하고 확인하기" }).click();
  await expect(page.getByTestId("draft-note")).toBeVisible();
  const text = await page.getByLabel("compose 파일 내용").inputValue();
  expect(text).toContain("MODE=prod");
  expect(text).toContain("# 내 PC의");
  expect(readFileSync(join(dir, "compose.yaml"), "utf8")).not.toContain("MODE=prod");
  await page.getByRole("button", { name: /저장하고 적용/ }).click();
  await expect.poll(() => sh(`docker exec bfe2e-shop-web-1 sh -c 'echo $MODE'`, true), { timeout: 90_000 }).toBe("prod");
});
