import { execSync } from "node:child_process";
import { expect, type Page } from "@playwright/test";

export const ALPINE = process.env.E2E_ALPINE ?? "alpine:3";
export const REGISTRY = process.env.E2E_REGISTRY ?? "registry:2";
export const NGINX = "nginx:alpine";

/** Runs a shell command; its output, or "ERR …" when it fails and quiet is set. */
export function sh(cmd: string, quiet = false): string {
  try {
    return execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
  } catch (e: any) {
    if (quiet) return "ERR " + String(e.stderr ?? e.message);
    throw new Error(`${cmd}\n${e.stderr ?? e.message}`);
  }
}

/** Removes every container, compose project, volume, network and image the tests made. */
export function sweep() {
  const ids = sh(`docker ps -aq --filter name=bfe2e`, true);
  if (ids && !ids.startsWith("ERR")) sh(`docker rm -f ${ids.split("\n").join(" ")}`, true);
  for (const v of sh(`docker volume ls -q --filter name=bfe2e`, true).split("\n")) if (v && !v.startsWith("ERR")) sh(`docker volume rm -f ${v}`, true);
  for (const n of sh(`docker network ls -q --filter name=bfe2e`, true).split("\n")) if (n && !n.startsWith("ERR")) sh(`docker network rm ${n}`, true);
  for (const i of sh(`docker images --format '{{.Repository}}:{{.Tag}}'`, true).split("\n")) if (/bfe2e|boxforge-(export|copy|undo)\//.test(i)) sh(`docker rmi -f ${i}`, true);
}

/** Opens BoxForge and waits until it shows the engine. */
export async function open(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("/");
  await expect(page.getByTestId("nav-containers")).toBeVisible();
  return errors;
}

/** Goes to a page by its menu entry. */
export async function go(page: Page, id: string) {
  const entry = page.getByTestId("nav-" + id);
  await entry.scrollIntoViewIfNeeded();
  await entry.click();
}

/** Closes a container's detail panel if one is open. */
export async function closeDetail(page: Page) {
  const d = page.getByTestId("detail");
  if (await d.count()) await d.getByRole("button", { name: "닫기" }).first().click();
}
