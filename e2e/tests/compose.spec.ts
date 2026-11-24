import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALPINE, go, open, sh, sweep } from "./helpers";

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

test("join two services in the picture by dragging, part them by clicking the line", async ({ page }) => {
  await open(page);
  await go(page, "compose");
  await page.getByRole("button", { name: "자세히" }).first().click();
  // A second service to join to.
  await page.getByRole("tab", { name: "Compose 파일" }).click();
  const box = page.getByLabel("compose 파일 내용");
  await expect(page.getByTestId("file-state")).toHaveText("저장됨");
  const before = await box.inputValue();
  await box.fill(before.replace(/^services:\n/m, `services:\n  worker:\n    image: ${ALPINE}\n    command: ["sleep", "infinity"]\n`));
  await page.getByRole("button", { name: /저장하고 적용/ }).click();
  await expect.poll(() => sh(`docker ps --format '{{.Names}}'`), { timeout: 90_000 }).toContain("bfe2e-shop-worker-1");

  await page.getByRole("tab", { name: "구조" }).click();
  await expect(page.getByTestId("edge-needs")).toHaveCount(0);
  await page.getByTestId("svc-link-worker").dragTo(page.getByTestId("svc-node-web"));
  await expect(page.getByTestId("draft-note")).toContainText("worker가 web를 기다리게 잇기");
  expect(await box.inputValue()).toMatch(/worker:[\s\S]*depends_on:\s*\n\s*- web/);
  await page.getByRole("button", { name: /저장하고 적용/ }).click();
  await expect.poll(() => readFileSync(join(dir, "compose.yaml"), "utf8")).toMatch(/depends_on:\s*\n\s*- web/);

  await page.getByRole("tab", { name: "구조" }).click();
  await expect(page.getByTestId("edge-needs")).toHaveCount(1);
  // The other way round would make each wait for the other: refused.
  await page.getByTestId("svc-link-web").dragTo(page.getByTestId("svc-node-worker"));
  await expect(page.getByRole("alert")).toContainText("둘 다 시작하지 못합니다");

  await page.getByTestId("edge-worker-web").click({ force: true });
  await expect(page.getByTestId("draft-note")).toContainText("worker → web 연결 끊기");
  expect(await box.inputValue()).not.toContain("depends_on");
  expect(await box.inputValue()).toContain("# 내 PC의");
});

test("a folder that isn't the user's is said above the file, the editor's columns kept", async ({ page }) => {
  // As a folder an import made as root looks to a user who isn't (the tests run as root here).
  await page.route("**/api/call/ComposeNotMine", (r) => r.fulfill({ contentType: "application/json", body: JSON.stringify({ result: dir }) }));
  await open(page);
  await go(page, "compose");
  await page.locator(".project", { hasText: "bfe2e-shop" }).getByRole("button", { name: "자세히" }).first().click();
  await page.getByRole("tab", { name: "Compose 파일" }).click();
  const note = page.getByTestId("not-mine");
  await expect(note).toContainText("다른 사용자(root)의 것");
  await expect(note.getByRole("button", { name: "내 것으로 바꾸기" })).toBeVisible();
  // Above the services, the file and the preview: not one of their columns.
  const n = (await note.boundingBox())!;
  const index = (await page.locator(".svc-index").boundingBox())!;
  expect(index.y).toBeGreaterThan(n.y + n.height - 1);
  expect(Math.abs(index.x - n.x)).toBeLessThan(2);
});

test("a stopped dependency is said in the plan, and applying stays possible", async ({ page }) => {
  // A service waiting for another to be healthy, that one stopped now: the
  // trial run can't start it (it starts nothing) and ends there.
  const where = mkdtempSync(join(tmpdir(), "bfe2e-dry-"));
  writeFileSync(
    join(where, "compose.yaml"),
    `services:
  app:
    image: ${ALPINE}
    command: sleep 1d
    depends_on:
      db:
        condition: service_healthy
  db:
    image: ${ALPINE}
    command: sleep 1d
    healthcheck: { test: ["CMD", "true"], interval: 2s }
`,
  );
  const compose = `docker compose -p bfe2e-dry -f ${join(where, "compose.yaml")}`;
  sh(`${compose} up -d`);
  sh(`${compose} stop`);
  try {
    await open(page);
    await go(page, "compose");
    await page.locator(".project", { hasText: "bfe2e-dry" }).getByRole("button", { name: "자세히" }).first().click();
    await page.getByRole("tab", { name: "Compose 파일" }).click();
    const plan = page.getByTestId("apply-plan");
    await expect(plan.getByTestId("plan-waits")).toContainText("bfe2e-dry-db-1", { timeout: 30_000 });
    await expect(plan).not.toContainText("이대로는 적용할 수 없습니다");
    await expect(page.getByRole("button", { name: "적용", exact: true })).toBeEnabled();
  } finally {
    sh(`${compose} down`, true);
  }
});
