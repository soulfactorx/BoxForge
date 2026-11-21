import { devices, expect, test } from "@playwright/test";
import { ALPINE, go, open, sh, sweep } from "./helpers";

const pages = ["home", "containers", "compose", "map", "images", "volumes", "networks", "builds", "kube", "settings"];

test.beforeAll(() => {
  sh(`docker run -d --name bfe2e-layout ${ALPINE} sleep 1d`, true);
});
test.afterAll(sweep);

/** What sticks out past the window's sides, outside the tables (which scroll inside their own box). */
const spill = () => {
  const w = window.innerWidth;
  const out: string[] = [];
  for (const e of document.querySelectorAll(".main *")) {
    if (e.closest("table, pre, .xterm, .map-wrap, svg")) continue;
    const r = e.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && (r.right > w + 1 || r.left < -1)) out.push(`${e.tagName.toLowerCase()}.${e.className}`.slice(0, 60));
  }
  return out.slice(0, 5);
};

test.describe("phone, upright", () => {
  const { viewport, deviceScaleFactor, isMobile, hasTouch, userAgent } = devices["Pixel 7"];
  test.use({ viewport, deviceScaleFactor, isMobile, hasTouch, userAgent, locale: "ko-KR" });
  for (const id of pages) {
    test(`${id}: nothing runs off the screen`, async ({ page }) => {
      await open(page);
      await go(page, id);
      await page.waitForTimeout(800);
      expect(await page.evaluate(spill)).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    });
  }
  test("a container can be renamed without a mouse", async ({ page }) => {
    await open(page);
    await go(page, "containers");
    await expect(page.locator("tr", { hasText: "bfe2e-layout" }).getByRole("button", { name: "이름 변경" })).toBeVisible();
  });
  test("the cells of a table row stay in line", async ({ page }) => {
    await open(page);
    await go(page, "containers");
    const rows = await page.locator("table.grid tbody tr").evaluateAll((trs) => trs.map((tr) => new Set([...tr.children].map((td) => Math.round(td.getBoundingClientRect().top))).size));
    expect(rows.every((n) => n === 1)).toBe(true);
  });
});

test.describe("phone, sideways", () => {
  test.use({ viewport: { width: 844, height: 390 }, locale: "ko-KR" });
  test("every menu entry can be reached and used", async ({ page }) => {
    await open(page);
    for (const id of pages) {
      const entry = page.getByTestId("nav-" + id);
      await entry.scrollIntoViewIfNeeded();
      const hit = await entry.evaluate((e) => {
        const r = e.getBoundingClientRect();
        const t = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return r.height >= 20 && (e === t || e.contains(t));
      });
      expect(hit, id).toBe(true);
    }
  });
});

test.describe("menus", () => {
  test.use({ viewport: { width: 1000, height: 600 }, locale: "ko-KR" });
  test("a row's menu shows whole, even at the bottom", async ({ page }) => {
    for (let i = 0; i < 6; i++) sh(`docker run -d --name bfe2e-menu${i} ${ALPINE} sleep 1d`, true);
    await open(page);
    await go(page, "containers");
    await page.waitForTimeout(2000);
    const more = page.getByRole("button", { name: "더보기" });
    await more.last().scrollIntoViewIfNeeded();
    await more.last().click();
    const box = (await page.getByRole("menu").boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(600);
  });
});
