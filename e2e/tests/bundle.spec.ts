import { expect, test } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALPINE, go, open, sh, sweep } from "./helpers";

test.afterAll(sweep);

test("export a container to a file, delete it, import it back with its data", async ({ page }) => {
  sh(`docker run -d --name bfe2e-box -v bfe2e-boxdata:/data ${ALPINE} sh -c 'echo saved > /data/k.txt; echo inside > /srv/changed.txt; sleep 1d'`);
  sh(`sleep 1`);
  const file = join(mkdtempSync(join(tmpdir(), "bfe2e-bundle-")), "box.boxforge");
  await open(page);
  await go(page, "containers");
  await page.locator("tr", { hasText: "bfe2e-box" }).getByRole("button", { name: "더보기" }).click();
  await page.getByRole("menuitem", { name: "파일로 내보내기" }).click();
  const dlg = page.getByRole("dialog");
  // Typed at once: the proposed place, coming late, is only shown grey and never mixes in.
  await dlg.getByLabel("저장할 파일").fill(file);
  await expect(dlg.getByLabel("저장할 파일")).toHaveAttribute("placeholder", /bfe2e-box\.boxforge$/);
  await expect(dlg.getByLabel("저장할 파일")).toHaveValue(file);
  await dlg.getByRole("button", { name: "내보내기", exact: true }).click();
  await expect(page.getByText("파일로 내보냈습니다")).toBeVisible({ timeout: 90_000 });
  expect(existsSync(file) && statSync(file).size > 1e6).toBe(true);

  sh(`docker rm -f bfe2e-box`);
  sh(`docker volume rm bfe2e-boxdata`);
  await page.getByRole("button", { name: "가져오기", exact: true }).click();
  await dlg.getByLabel("가져올 파일").fill(file);
  await dlg.getByRole("button", { name: "열기" }).click();
  await expect(dlg.getByTestId("bundle-info")).toContainText("bfe2e-box");
  await dlg.getByRole("button", { name: "가져오기", exact: true }).click();
  await expect(page.getByText("가져왔습니다: bfe2e-box")).toBeVisible({ timeout: 90_000 });
  sh(`docker start bfe2e-box`);
  expect(sh(`docker exec bfe2e-box sh -c 'cat /data/k.txt /srv/changed.txt'`)).toBe("saved\ninside");
});

test("an imported container is back on its own network, with its fixed address, alias and MAC address", async ({ page }) => {
  sh(`docker network create --subnet 172.31.88.0/24 bfe2e-licnet`);
  sh(`docker run -d --name bfe2e-lic --network bfe2e-licnet --ip 172.31.88.20 --network-alias license --mac-address 02:42:00:00:88:20 --hostname lichost ${ALPINE} sleep 1d`);
  const file = join(mkdtempSync(join(tmpdir(), "bfe2e-bundle-")), "lic.boxforge");
  try {
    await open(page);
    await go(page, "containers");
    await page.locator("tr", { hasText: "bfe2e-lic" }).getByRole("button", { name: "더보기" }).click();
    await page.getByRole("menuitem", { name: "파일로 내보내기" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("저장할 파일").fill(file);
    await dlg.getByRole("button", { name: "내보내기", exact: true }).click();
    await expect(page.getByText("파일로 내보냈습니다")).toBeVisible({ timeout: 90_000 });

    // As on another engine: neither the container nor its network is there.
    sh(`docker rm -f bfe2e-lic`);
    sh(`docker network rm bfe2e-licnet`);
    await page.getByRole("button", { name: "가져오기", exact: true }).click();
    await dlg.getByLabel("가져올 파일").fill(file);
    await dlg.getByRole("button", { name: "열기" }).click();
    await dlg.getByRole("button", { name: "가져오기", exact: true }).click();
    await expect(page.getByText("가져왔습니다: bfe2e-lic")).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(/없던 네트워크 "bfe2e-licnet"를 같은 설정/)).toBeVisible();
    expect(sh(`docker network inspect bfe2e-licnet --format '{{(index .IPAM.Config 0).Subnet}}'`)).toBe("172.31.88.0/24");
    sh(`docker start bfe2e-lic`);
    expect(sh(`docker inspect bfe2e-lic --format '{{with index .NetworkSettings.Networks "bfe2e-licnet"}}{{.IPAddress}} {{.MacAddress}} {{.Aliases}}{{end}} {{.Config.Hostname}}'`)).toBe("172.31.88.20 02:42:00:00:88:20 [license] lichost");
  } finally {
    sh(`docker rm -f bfe2e-lic`, true);
    sh(`docker network rm bfe2e-licnet`, true);
  }
});

test("a Compose project is exported with its folders and files, and comes back whole where they are missing", async ({ page }) => {
  // As in Kiri's engine: the project's folder lives on that engine's machine only.
  const dir = mkdtempSync(join(tmpdir(), "bfe2e-clone-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "app.conf"), "license=abc\n");
  writeFileSync(
    join(dir, "compose.yaml"),
    `services:
  app:
    image: ${ALPINE}
    command: sh -c "cat /cfg/app.conf; sleep 1d"
    volumes: ["./config:/cfg"]
    depends_on:
      db:
        condition: service_healthy
  db:
    image: ${ALPINE}
    command: sh -c "sleep 4; touch /ready; sleep 1d"
    healthcheck: { test: ["CMD", "test", "-f", "/ready"], interval: 2s, retries: 30 }
`,
  );
  const compose = `docker compose -p bfe2e-clone -f ${join(dir, "compose.yaml")}`;
  sh(`${compose} up -d`);
  const file = join(mkdtempSync(join(tmpdir(), "bfe2e-bundle-")), "clone.boxforge");
  try {
    await open(page);
    await go(page, "containers");
    await page.locator("tr", { hasText: "bfe2e-clone-app" }).getByRole("button", { name: "더보기" }).click();
    await page.getByRole("menuitem", { name: "파일로 내보내기" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "bfe2e-clone" }).click(); // the whole project
    await expect(dlg.getByRole("checkbox", { name: /연결한 폴더와 Compose 파일 포함/ })).toBeChecked();
    await dlg.getByLabel("저장할 파일").fill(file);
    await dlg.getByRole("button", { name: "내보내기", exact: true }).click();
    await expect(page.getByText("파일로 내보냈습니다")).toBeVisible({ timeout: 90_000 });

    // The other engine: no containers, no network, no folder.
    sh(`${compose} down`);
    rmSync(dir, { recursive: true, force: true });
    await page.getByRole("button", { name: "가져오기", exact: true }).click();
    await dlg.getByLabel("가져올 파일").fill(file);
    await dlg.getByRole("button", { name: "열기" }).click();
    await expect(dlg.getByTestId("bundle-folders")).toContainText(join(dir, "config"));
    await expect(dlg.getByTestId("bundle-folders")).toContainText("compose.yaml");
    await dlg.getByRole("checkbox", { name: /가져온 뒤 바로 시작/ }).check();
    await dlg.getByRole("button", { name: "가져오기", exact: true }).click();
    await expect(page.getByText(/가져왔습니다: /)).toBeVisible({ timeout: 90_000 });
    await expect(page.getByText(`폴더 ${join(dir, "config")} 를 같은 경로에 되살렸습니다.`)).toBeVisible();

    // Running, reading its folder; and Compose knows the project from its file again.
    await expect.poll(() => sh(`docker inspect bfe2e-clone-app-1 --format '{{.State.Status}}'`, true)).toBe("running");
    // app waited for db to be healthy, as Compose does.
    const at = (c: string, f: string) => Date.parse(sh(`docker inspect ${c} --format '{{${f}}}'`));
    expect(at("bfe2e-clone-app-1", ".State.StartedAt")).toBeGreaterThan(at("bfe2e-clone-db-1", ".State.StartedAt") + 3000);
    // host.docker.internal is there, as on Docker Desktop and Kiri.
    expect(sh(`docker exec bfe2e-clone-app-1 grep -c host.docker.internal /etc/hosts`)).toBe("1");
    await expect.poll(() => sh(`docker logs bfe2e-clone-app-1`, true)).toContain("license=abc");
    expect(readFileSync(join(dir, "compose.yaml"), "utf8")).toContain("./config:/cfg");
    expect(sh(`${compose} ps --services`).split("\n").sort()).toEqual(["app", "db"]);
  } finally {
    sh(`${compose} down`, true);
  }
});

test("an image made on this PC comes back under its own name, for Compose to find", async ({ page }) => {
  sh(`docker tag ${ALPINE} bfe2e-own:v1`);
  sh(`docker run -d --name bfe2e-own bfe2e-own:v1 sleep 1d`);
  const file = join(mkdtempSync(join(tmpdir(), "bfe2e-bundle-")), "own.boxforge");
  try {
    await open(page);
    await go(page, "containers");
    await page.locator("tr", { hasText: "bfe2e-own" }).getByRole("button", { name: "더보기" }).click();
    await page.getByRole("menuitem", { name: "파일로 내보내기" }).click();
    const dlg = page.getByRole("dialog");
    // The container's changes go in: as an image of the journey's own name.
    await expect(dlg.getByRole("checkbox", { name: /컨테이너 안에서 바뀐 파일 포함/ })).toBeChecked();
    await dlg.getByLabel("저장할 파일").fill(file);
    await dlg.getByRole("button", { name: "내보내기", exact: true }).click();
    await expect(page.getByText("파일로 내보냈습니다")).toBeVisible({ timeout: 90_000 });

    // Another engine: neither the container nor the image is there.
    sh(`docker rm -f bfe2e-own`);
    sh(`docker rmi bfe2e-own:v1`);
    await page.getByRole("button", { name: "가져오기", exact: true }).click();
    await dlg.getByLabel("가져올 파일").fill(file);
    await dlg.getByRole("button", { name: "열기" }).click();
    await dlg.getByRole("button", { name: "가져오기", exact: true }).click();
    await expect(page.getByText(/가져왔습니다: /)).toBeVisible({ timeout: 90_000 });
    expect(sh(`docker inspect bfe2e-own --format '{{.Config.Image}}'`)).toBe("bfe2e-own:v1");
    expect(sh(`docker image inspect bfe2e-own:v1 --format ok`)).toBe("ok");
    expect(sh(`docker images --format '{{.Repository}}' | grep -c 'boxforge-export/bfe2e-own' || true`)).toBe("0");
  } finally {
    sh(`docker rm -f bfe2e-own`, true);
    sh(`docker rmi bfe2e-own:v1`, true);
  }
});

test("a file whose containers ran on carried images still gives back the images' own names, from its Compose file", async ({ page }) => {
  // As made by an import before 0.34.1: the container runs on boxforge-export/…,
  // while the project's Compose file names the image bfe2e-cmp:v1.
  const dir = mkdtempSync(join(tmpdir(), "bfe2e-carried-"));
  const yml = (image: string) => `services:\n  app:\n    image: ${image}\n    command: sleep 1d\n`;
  sh(`docker tag ${ALPINE} boxforge-export/bfe2e-cmp:old`);
  writeFileSync(join(dir, "compose.yaml"), yml("boxforge-export/bfe2e-cmp:old"));
  const compose = `docker compose -p bfe2e-carried -f ${join(dir, "compose.yaml")}`;
  sh(`${compose} up -d`);
  writeFileSync(join(dir, "compose.yaml"), yml("bfe2e-cmp:v1"));
  const file = join(mkdtempSync(join(tmpdir(), "bfe2e-bundle-")), "carried.boxforge");
  try {
    await open(page);
    await go(page, "containers");
    await page.locator("tr", { hasText: "bfe2e-carried-app" }).getByRole("button", { name: "더보기" }).click();
    await page.getByRole("menuitem", { name: "파일로 내보내기" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByLabel("저장할 파일").fill(file);
    await dlg.getByRole("button", { name: "내보내기", exact: true }).click();
    await expect(page.getByText("파일로 내보냈습니다")).toBeVisible({ timeout: 90_000 });

    sh(`${compose} down`);
    sh(`docker rmi boxforge-export/bfe2e-cmp:old`);
    await page.getByRole("button", { name: "가져오기", exact: true }).click();
    await dlg.getByLabel("가져올 파일").fill(file);
    await dlg.getByRole("button", { name: "열기" }).click();
    await dlg.getByRole("button", { name: "가져오기", exact: true }).click();
    await expect(page.getByText(/가져왔습니다: /)).toBeVisible({ timeout: 90_000 });
    expect(sh(`docker inspect bfe2e-carried-app-1 --format '{{.Config.Image}}'`)).toBe("bfe2e-cmp:v1");
    // Compose finds its image again: up starts it, fetching nothing.
    sh(`${compose} up -d`);
    expect(sh(`docker inspect bfe2e-carried-app-1 --format '{{.State.Status}}'`)).toBe("running");
  } finally {
    sh(`${compose} down`, true);
    sh(`docker rmi bfe2e-cmp:v1 boxforge-export/bfe2e-cmp:old`, true);
  }
});

test("starting after an import can be given up while it waits, the imported things kept", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "bfe2e-never-"));
  writeFileSync(
    join(dir, "compose.yaml"),
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
    healthcheck: { test: ["CMD", "false"], interval: 2s, retries: 1000 }
`,
  );
  const compose = `docker compose -p bfe2e-never -f ${join(dir, "compose.yaml")}`;
  sh(`${compose} create`);
  const file = join(mkdtempSync(join(tmpdir(), "bfe2e-bundle-")), "never.boxforge");
  try {
    await open(page);
    await go(page, "containers");
    await page.locator("tr", { hasText: "bfe2e-never-app" }).getByRole("button", { name: "더보기" }).click();
    await page.getByRole("menuitem", { name: "파일로 내보내기" }).click();
    const dlg = page.getByRole("dialog");
    await dlg.getByRole("button", { name: "bfe2e-never" }).click();
    await dlg.getByLabel("저장할 파일").fill(file);
    await dlg.getByRole("button", { name: "내보내기", exact: true }).click();
    await expect(page.getByText("파일로 내보냈습니다")).toBeVisible({ timeout: 90_000 });

    sh(`${compose} down`);
    await page.getByRole("button", { name: "가져오기", exact: true }).click();
    await dlg.getByLabel("가져올 파일").fill(file);
    await dlg.getByRole("button", { name: "열기" }).click();
    await dlg.getByRole("checkbox", { name: /가져온 뒤 바로 시작/ }).check();
    await dlg.getByRole("button", { name: "가져오기", exact: true }).click();
    // db never gets healthy: the wait says so, and can be given up.
    await expect(dlg.getByText(/bfe2e-never-db-1가 준비\(healthy\)되기를 기다리는 중/)).toBeVisible({ timeout: 90_000 });
    await dlg.getByRole("button", { name: "시작 그만두기" }).click();
    await expect(page.getByText("시작을 그만두었습니다")).toBeVisible({ timeout: 30_000 });
    expect(sh(`docker inspect -f '{{.State.Running}}' bfe2e-never-db-1 bfe2e-never-app-1`)).toBe("false\nfalse");
  } finally {
    sh(`${compose} down`, true);
  }
});
