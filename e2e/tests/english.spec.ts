import { expect, test } from "@playwright/test";
import { go } from "./helpers";

test.use({ locale: "en-US" });

const pages = ["home", "containers", "compose", "map", "images", "volumes", "networks", "builds", "kube", "settings"];

test("every screen is in English when the browser is", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await expect(page.getByTestId("nav-containers")).toContainText("Containers");
  const left: string[] = [];
  for (const id of pages) {
    await go(page, id);
    await page.waitForTimeout(1000);
    const found = await page.evaluate(() => {
      const hangul = /[가-힣]/;
      const skip = ".xterm, textarea, pre.log-box, [data-keep-text]";
      const out: string[] = [];
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (n.nodeType === 3) {
          if (hangul.test(n.nodeValue!) && !n.parentElement!.closest(skip)) out.push(n.nodeValue!.trim().slice(0, 60));
        } else {
          for (const a of ["placeholder", "title", "aria-label"]) {
            const v = (n as Element).getAttribute(a);
            if (v && hangul.test(v) && !(n as Element).closest(skip)) out.push(`${a}=${v.slice(0, 50)}`);
          }
        }
      }
      return out;
    });
    left.push(...found.map((f) => `${id}: ${f}`));
  }
  expect(left).toEqual([]);
  expect(errors).toEqual([]);
});
