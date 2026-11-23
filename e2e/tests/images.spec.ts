import { expect, test } from "@playwright/test";
import { ALPINE, REGISTRY, go, open, sh, sweep } from "./helpers";

test.afterAll(() => {
  sh(`docker rm -f bfe2e-registry`, true);
  sweep();
});

test("layers of an image", async ({ page }) => {
  await open(page);
  await go(page, "images");
  await page.locator("tr", { hasText: ALPINE.split(":")[0].split("/").pop()! }).first().getByRole("button", { name: "더보기" }).click();
  await page.getByRole("menuitem", { name: "레이어 보기" }).click();
  await expect(page.getByTestId("layers").locator("li").first()).toBeVisible();
  await expect(page.getByTestId("layers")).toContainText(/ADD|COPY|CMD/);
});

test("clicking an image's name shows its layers, then its details", async ({ page }) => {
  await open(page);
  await go(page, "images");
  await page.locator("tr", { hasText: ALPINE.split(":")[0].split("/").pop()! }).first().getByTitle("레이어와 정보 보기").click();
  const panel = page.getByTestId("image-detail");
  await expect(panel.getByTestId("layer").first()).toBeVisible();
  await expect(panel.getByTestId("layers")).toContainText("단계 · 합계");
  // a row opens to its whole command
  await panel.getByTestId("layer").first().getByRole("button").first().click();
  await expect(panel.getByTestId("layer").first().getByRole("button").first()).toHaveAttribute("aria-expanded", "true");
  await panel.getByRole("tab", { name: "정보" }).click();
  await expect(panel.getByTestId("image-info")).toContainText("다이제스트");
  await expect(panel.getByTestId("image-info")).toContainText("PATH=");
});

test("push to a registry", async ({ page }) => {
  sh(`docker run -d --name bfe2e-registry -p 127.0.0.1:5055:5000 ${REGISTRY}`);
  sh(`docker tag ${ALPINE} localhost:5055/bfe2e/alpine:1`);
  await open(page);
  await go(page, "images");
  await page.locator("tr", { hasText: "localhost:5055/bfe2e/alpine" }).getByRole("button", { name: "더보기" }).click();
  await page.getByRole("menuitem", { name: /레지스트리에 올리기/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "레지스트리에 올리기" }).click();
  await expect(page.getByRole("dialog")).toBeHidden({ timeout: 60_000 });
  await expect.poll(() => sh(`curl -s http://127.0.0.1:5055/v2/_catalog`, true)).toContain("bfe2e/alpine");
  sh(`docker rmi localhost:5055/bfe2e/alpine:1`, true);
});
