import { devices, expect, test, type Page } from "@playwright/test";
import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALPINE, go, open, sh, sweep } from "./helpers";

test.describe.configure({ mode: "serial" });
test.setTimeout(600_000);

// The box's user is an ordinary one (1000 when the tests run as root):
// the folder is opened to it as a user's own folder would be.
const work = mkdtempSync(join(tmpdir(), "bfe2e-agent-"));
chmodSync(work, 0o777);
const box = "bfa-bfe2e-box";
const inBox = (cmd: string) => sh(`docker exec ${box}-agent sh -c '${cmd}'`);

test.afterAll(() => {
  sh(`docker compose -p ${box} down --volumes --remove-orphans`, true);
  sh(`docker compose -p bfa-bfe2e-pi down --volumes --rmi local --remove-orphans`, true);
  sh(`docker compose -p bfa-bfe2e-web down --volumes --remove-orphans`, true);
  sweep();
});

async function make(page: Page, name: string, fill: (d: ReturnType<Page["getByRole"]>) => Promise<void>) {
  await open(page);
  await go(page, "agents");
  await page.getByRole("button", { name: "새 에이전트 상자" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("상자 이름").fill(name);
  await d.getByRole("textbox", { name: "작업 폴더" }).fill(work);
  await fill(d);
  await d.getByRole("button", { name: "만들고 시작" }).click();
}

test("an agent box: keys kept out of the container's settings, only listed addresses, changes, saved copies, delete", async ({ page }) => {
  await make(page, "bfe2e-box", async (d) => {
    await d.getByLabel("내가 가진 이미지로 (에이전트를 넣지 않음)").check();
    await d.getByLabel("이미지", { exact: true }).fill(ALPINE);
    await d.getByLabel("에이전트를 시작하는 명령").fill("sh");
    await d.getByLabel("연결해도 되는 주소").fill("example.org");
  });
  await expect(page.getByTestId("agent-state")).toContainText("실행 중", { timeout: 180_000 });
  await expect(page.getByTestId("agent-output")).toContainText("끝났습니다");

  // Made safe whatever the image: an ordinary user, no privileges, no way out but the proxy.
  const cfg = JSON.parse(sh(`docker inspect ${box}-agent`))[0];
  expect(cfg.Config.User).not.toBe("");
  expect(cfg.HostConfig.CapDrop).toContain("ALL");
  expect(cfg.HostConfig.SecurityOpt.join()).toContain("no-new-privileges");
  expect(Object.keys(cfg.NetworkSettings.Networks)).toEqual([`${box}_inside`]);

  // A key: in the box's file, not in what the engine shows.
  await page.getByRole("tab", { name: "API 키" }).click();
  await page.getByLabel("키 이름").fill("BFE2E_KEY");
  await page.getByLabel("키 값").fill("s3cret-value");
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByTestId("agent-keys")).toContainText("BFE2E_KEY");
  await expect(page.getByTestId("agent-keys")).not.toContainText("s3cret-value");
  expect(sh(`docker inspect ${box}-agent`)).not.toContain("s3cret-value");
  // What a terminal outside the app runs: plain words, the keys read in the box.
  expect(sh(`docker exec ${box}-agent sh /opt/boxforge/run printenv BFE2E_KEY`)).toBe("s3cret-value");
  expect(sh(`docker exec ${box}-agent sh /opt/boxforge/run pwd`)).toBe("/workspace");

  // The terminals, as an editor's tabs: the first opened with the box.
  await page.getByRole("tab", { name: "터미널" }).click();
  const tabs = page.getByTestId("term-tabs");
  await expect(tabs.getByRole("tab")).toHaveText(["sh"]);
  // A new one beside it: a key saved after a terminal opened reaches the next one.
  await page.locator(".agent-term").getByRole("button", { name: "+ sh" }).click();
  await expect(tabs.getByRole("tab")).toHaveText(["sh", "sh 2"]);
  const pane = page.locator('[data-testid="term-pane"]:not([hidden])');
  const rows = pane.locator(".xterm-rows");
  // Typed once the shell is there: keys pressed before the session opens are not kept.
  await expect(rows).toContainText("/workspace", { timeout: 30_000 });
  await pane.locator(".xterm").click();
  await page.keyboard.type("wget -q -T 5 -O- http://blocked.bfe2e.test; echo key-is-$BFE2E_KEY\n");
  await expect(rows).toContainText("key-is-s3cret-value", { timeout: 30_000 });

  // The right-click menu: paste what is on the clipboard, select all, copy.
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("echo pasted-$((40+2))"));
  await pane.locator(".term-box").click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: /복사/ })).toBeDisabled();
  await page.getByRole("menuitem", { name: /붙여넣기/ }).click();
  await expect(rows).toContainText("echo pasted-$((40+2))");
  await pane.locator(".xterm").click();
  await page.keyboard.press("Enter");
  await expect(rows).toContainText("pasted-42");
  await pane.locator(".term-box").click({ button: "right" });
  await page.getByRole("menuitem", { name: "모두 선택" }).click();
  await pane.locator(".term-box").click({ button: "right" });
  await page.getByRole("menuitem", { name: /복사/ }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain("pasted-42");

  // The special-key bar (shown on a phone by itself; here asked for): Ctrl
  // for the next key typed, Tab, and the arrows.
  await pane.getByRole("button", { name: /특수 키 보이기/ }).click();
  const keys = pane.getByTestId("term-keys");
  await pane.locator(".xterm").click();
  await page.keyboard.type("sleep 555\n");
  await expect.poll(() => inBox("ps -o args")).toContain("sleep 555");
  await keys.getByRole("button", { name: "Ctrl" }).click();
  await expect(keys.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.type("c");
  await expect.poll(() => inBox("ps -o args")).not.toContain("sleep 555");
  await expect(keys.getByRole("button", { name: "Ctrl" })).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.type("echo key");
  await keys.getByRole("button", { name: "Tab" }).click(); // no file "key…": the shell rings, nothing more
  await page.keyboard.type("bar-ok\n");
  await expect(rows).toContainText("keybar-ok");
  await keys.getByRole("button", { name: "위" }).click();
  await keys.getByRole("button", { name: "Esc" }).click(); // a lone Esc changes nothing at the prompt here
  await page.keyboard.press("Enter");
  await expect.poll(async () => ((await rows.innerText()).match(/^keybar-ok$/gm) ?? []).length).toBe(2);
  await keys.getByRole("button", { name: "Fn" }).click();
  await expect(keys.getByRole("button", { name: "F12" })).toBeVisible();

  // Another page of the box and back: the same terminal, what runs in it still running.
  await page.keyboard.type("sleep 777\n");
  await expect.poll(() => inBox("ps -o args")).toContain("sleep 777");
  await page.getByRole("tab", { name: "API 키" }).click();
  await page.getByRole("tab", { name: "터미널" }).click();
  await expect(rows).toContainText("sleep 777");
  // The list of boxes and back: still open, and counted on the box.
  await page.locator(".crumbs:visible").getByRole("button", { name: "AI 에이전트" }).click();
  await expect(page.getByTestId("agent-bfe2e-box")).toContainText("터미널 2개 열림");
  await page.getByTestId("agent-bfe2e-box").getByRole("button", { name: "제어판 열기" }).click();
  await expect(rows).toContainText("sleep 777");
  expect(inBox("ps -o args")).toContain("sleep 777");
  // Each tab is a terminal of its own.
  await tabs.getByRole("tab", { name: "sh", exact: true }).click();
  await expect(rows).toContainText("/workspace");
  await expect(rows).not.toContainText("sleep 777");

  // Its size: dragged shorter, and the whole window and back.
  const before = (await pane.locator(".term-box").boundingBox())!.height;
  const handle = page.getByRole("separator", { name: "터미널 높이 조절" });
  await handle.scrollIntoViewIfNeeded();
  const grip = (await handle.boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - 120, { steps: 5 });
  await page.mouse.up();
  expect((await pane.locator(".term-box").boundingBox())!.height).toBeLessThan(before - 100);
  await page.getByRole("button", { name: "크게 보기" }).click();
  expect((await pane.locator(".term-box").boundingBox())!.height).toBeGreaterThan(700);
  await page.getByRole("button", { name: "원래 크기로" }).click();
  expect((await pane.locator(".term-box").boundingBox())!.height).toBeLessThan(before - 100);

  // All but this one closed: what the other ran is stopped, not left in the box.
  await tabs.getByRole("button", { name: "이 탭 빼고 모두 닫기" }).click();
  await expect(tabs.getByRole("tab")).toHaveText(["sh"]);
  await expect.poll(() => inBox("ps -o args"), { timeout: 15_000 }).not.toContain("sleep 777");

  await page.locator(".agent-term").getByRole("button", { name: "+ 셸" }).click();
  await expect(tabs.getByRole("tab")).toHaveText(["sh", "셸"]);

  // On a phone, the bar is there without asking.
  const phone = await page.context().browser()!.newContext({ ...devices["Pixel 7"], locale: "ko-KR" });
  const mobile = await phone.newPage();
  await mobile.goto(page.url());
  await go(mobile, "agents");
  await mobile.getByTestId("agent-bfe2e-box").getByRole("button", { name: "제어판 열기" }).click();
  const mpane = mobile.locator('[data-testid="term-pane"]:not([hidden])');
  await expect(mpane.getByTestId("term-keys")).toBeVisible();
  // A finger drawn down the terminal scrolls back through what it showed;
  // its scrollbar can be dragged with a finger too.
  const mrows = mpane.locator(".xterm-rows");
  await expect(mrows).toContainText("/workspace", { timeout: 30_000 });
  await mpane.locator(".xterm").tap();
  await mobile.keyboard.type("seq 1 300\n");
  await expect(mrows).toContainText("300");
  const last = () => mrows.innerText().then((t) => Math.max(0, ...(t.match(/^\d+$/gm) ?? ["0"]).map(Number)));
  expect(await last()).toBe(300);
  const cdp = await phone.newCDPSession(mobile);
  const touch = async (x: number, from: number, to: number) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: from }] });
    for (let i = 1; i <= 10; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: from + ((to - from) * i) / 10 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const area = (await mpane.locator(".xterm-screen").boundingBox())!;
  await touch(area.x + area.width / 2, area.y + 40, area.y + area.height - 40);
  await expect.poll(last).toBeLessThan(290);
  const swiped = await last();
  const slider = mpane.locator(".xterm-scrollable-element > .scrollbar.vertical > .slider");
  const knob = (await slider.boundingBox())!;
  await touch(knob.x + knob.width / 2, knob.y + knob.height / 2, area.y + 5);
  await expect.poll(last).toBeLessThan(swiped - 50);
  await phone.close();

  await tabs.getByRole("button", { name: "모두 닫기", exact: true }).click();
  await expect(page.locator(".agent-term")).toContainText("열린 터미널이 없습니다");

  await page.getByRole("tab", { name: "연결 기록" }).click();
  const conns = page.getByTestId("agent-connections");
  const row = conns.getByRole("row", { name: /blocked\.bfe2e\.test/ });
  await expect(row).toContainText("막힘", { timeout: 15_000 });
  await row.getByRole("button", { name: "허용" }).click();
  await expect(row).toContainText("허용함");
  const dir = sh(`docker inspect ${box}-egress --format '{{range .Mounts}}{{.Source}}{{end}}'`);
  expect(readFileSync(join(dir, "allow.txt"), "utf8")).toContain("blocked.bfe2e.test");

  // What the agent changed, and going back to a saved copy.
  inBox("echo first > /workspace/notes.txt");
  await page.getByRole("tab", { name: "저장 · 되돌리기" }).click();
  await page.getByLabel("저장 이름").fill("before");
  await page.getByRole("button", { name: "지금 상태 저장" }).click();
  await expect(page.getByTestId("agent-snapshots")).toContainText("before");
  inBox("echo second > /workspace/notes.txt; echo x > /workspace/extra.txt");

  await page.getByRole("tab", { name: "바뀐 파일" }).click();
  const changes = page.getByTestId("agent-changes");
  await expect(changes).toContainText("extra.txt");
  await changes.getByRole("button", { name: "notes.txt" }).click();
  await expect(page.locator(".log-box.diff")).toContainText("second");

  await page.getByRole("tab", { name: "저장 · 되돌리기" }).click();
  await page.getByTestId("agent-snapshots").getByRole("button", { name: "되돌리기" }).click();
  const ask = page.getByRole("dialog");
  await expect(ask).toContainText("모두 지워지고");
  await ask.getByRole("button", { name: "되돌리기" }).click();
  await expect.poll(() => inBox("cat /workspace/notes.txt; ls /workspace")).toBe("first\nnotes.txt");

  // Deleting says what goes, and takes the box and its copies away; the folder stays.
  await page.getByRole("button", { name: "상자 삭제" }).click();
  const del = page.getByRole("dialog");
  await expect(del).toContainText("저장해 둔 작업 폴더 복사본");
  await expect(del).toContainText(work);
  await del.getByRole("button", { name: "삭제" }).click();
  await expect(page.getByRole("button", { name: "새 에이전트 상자" })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId("agent-bfe2e-box")).toHaveCount(0);
  expect(sh(`docker ps -aq --filter name=${box}`)).toBe("");
  expect(sh(`docker volume ls -q --filter name=${box}`)).toBe("");
  expect(readFileSync(join(work, "notes.txt"), "utf8")).toBe("first\n");
});

test("a box's port opens at once, the box running on; its browser box shows the box's own page", async ({ page, request }) => {
  await make(page, "bfe2e-web", async (d) => {
    await d.getByLabel("내가 가진 이미지로 (에이전트를 넣지 않음)").check();
    await d.getByLabel("이미지", { exact: true }).fill(ALPINE);
    await d.getByLabel("에이전트를 시작하는 명령").fill("sh");
    await d.getByLabel("브라우저 상자 함께 만들기").check();
  });
  const web = "bfa-bfe2e-web";
  await expect(page.getByTestId("agent-state")).toContainText("실행 중", { timeout: 300_000 });
  await expect.poll(() => sh(`docker inspect -f '{{.State.Running}}' ${web}-browser`, true), { timeout: 120_000 }).toBe("true");
  // A page served in the box on its localhost only: each request written down.
  sh(`docker exec -d ${web}-agent sh -c 'while true; do printf "HTTP/1.0 200 OK\\r\\nContent-Length: 10\\r\\n\\r\\nhello-port" | nc -l -s 127.0.0.1 -p 18080 >> /tmp/req; done'`);
  const id = sh(`docker inspect -f '{{.Id}}' ${web}-agent`);

  await page.getByRole("tab", { name: "웹 · 포트" }).click();
  const ports = page.getByTestId("agent-ports");
  await ports.getByLabel("열 포트").fill("18080");
  await ports.getByRole("button", { name: "포트 열기" }).click();
  const row = ports.getByRole("row", { name: /localhost:18080/ });
  await expect(row).toContainText("127.0.0.1:");
  const local = +(/127\.0\.0\.1:(\d+)/.exec(await row.innerText())![1]);
  await expect.poll(async () => (await request.get(`http://127.0.0.1:${local}/`).catch(() => null))?.text() ?? "").toBe("hello-port");
  // Opened at once: the box wasn't made again.
  expect(sh(`docker inspect -f '{{.Id}}' ${web}-agent`)).toBe(id);

  // The browser box opens the box's page as its own localhost; on this PC only its picture's page opens.
  const shown = page.context().waitForEvent("page");
  await row.getByRole("button", { name: "브라우저 상자로" }).click();
  const view = await shown;
  await view.waitForLoadState();
  expect(view.url()).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  await expect.poll(() => sh(`docker exec ${web}-agent cat /tmp/req`, true), { timeout: 90_000 }).toContain("GET / HTTP");
  await view.close();

  await row.getByRole("button", { name: "빼기" }).click();
  await expect(ports.getByRole("row", { name: /localhost:18080/ })).toHaveCount(0);
  await expect.poll(async () => (await request.get(`http://127.0.0.1:${local}/`, { timeout: 3000 }).catch(() => null)) === null).toBe(true);
  sh(`docker compose -p ${web} down --volumes --remove-orphans`, true);
});

test("a Pi box is built with the agent in it", async ({ page }) => {
  // Builds install from the internet: not where builds can't reach it.
  test.skip(!!process.env.E2E_NO_AGENT_BUILD, "builds can't reach the internet here");
  await make(page, "bfe2e-pi", async (d) => {
    await expect(d.getByLabel(/Pi Coding Agent/)).toBeChecked();
  });
  await expect(page.getByTestId("agent-state")).toContainText("실행 중", { timeout: 540_000 });
  expect(sh(`docker exec bfa-bfe2e-pi-agent sh -c 'id -u; command -v pi'`)).toMatch(/^\d+\n.*\/pi$/);
});
