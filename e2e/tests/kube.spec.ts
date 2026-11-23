import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALPINE, go, open, sh } from "./helpers";

// Kubernetes: a real k3s in a container on the engine. The cluster fetches
// its images itself, so these name an image it can reach (E2E_KUBE_NGINX),
// or E2E_KUBE_PRELOAD=1 hands it the engine's copy.
//
// A cluster that was there before the tests is left as it was; one the
// tests made is removed at the end.
// No retries: a retry would start over with a new cluster, minutes for nothing.
test.describe.configure({ mode: "serial", retries: 0 });
const WEB = process.env.E2E_KUBE_NGINX ?? "nginx:alpine";
const had = !sh("docker ps -aq --filter name=^boxforge-k3s$", true).startsWith("ERR") && sh("docker ps -aq --filter name=^boxforge-k3s$", true) !== "";
const kubectl = (rest: string) => sh(`docker exec boxforge-k3s kubectl ${rest}`, true);

test.setTimeout(420_000);

test.afterAll(() => {
  for (const what of ["deployment/bfe2e-web", "deployment/bfe2e-broken", "service/bfe2e-web", "ingress/bfe2e-web", "pvc/bfe2e-web-data", "secret/bfe2e-secret", "pvc/bfe2e-disk"]) kubectl(`delete ${what} --wait=false`);
  if (!had) sh("docker rm -f -v boxforge-k3s && docker volume rm boxforge-k3s", true);
  sh("docker rm -f bfe2e-kiri-k8s bfe2e-port-holder", true);
});

async function kube(page: Page) {
  await open(page);
  await go(page, "kube");
  const state = page.getByTestId("kube-state");
  await expect(state).toBeVisible();
  if (!(await state.innerText()).includes("준비됨")) {
    const start = page.getByTestId("kube-start");
    if (await start.isVisible()) {
      await start.click();
      // What the cluster says while it comes up is shown as it comes.
      await expect(page.getByTestId("kube-boot-log")).toContainText(/(info|warning|error): /, { timeout: 240_000 });
      // Left and come back while it starts: still shown as starting, log and all.
      await page.reload();
      await go(page, "kube");
      if (!(await state.innerText()).includes("준비됨")) {
        await expect(page.getByText("클러스터가 아직 시작하는 중입니다")).toBeVisible();
        await expect(page.getByTestId("kube-boot-log")).toContainText(/(info|warning|error): /);
      }
    }
    await expect(state).toContainText("준비됨", { timeout: 300_000 });
  }
  // Where the cluster can't reach the internet itself (E2E_KUBE_PRELOAD=1),
  // the engine's copy of the image is put into it.
  if (process.env.E2E_KUBE_PRELOAD && !preloaded) {
    sh(`docker image inspect ${WEB} >/dev/null 2>&1 || docker pull -q ${WEB}`);
    sh(`docker save ${WEB} | docker exec -i boxforge-k3s ctr -n k8s.io images import -`);
    preloaded = true;
  }
}
let preloaded = false;

test("another app's cluster is named, and a taken 6443 moves this one to the next port, on this PC only", async ({ page }) => {
  test.skip(had, "a cluster was already there");
  // As Kiri leaves one: its own k3s, and something already on 6443.
  const k3s = process.env.E2E_K3S || "rancher/k3s:v1.33.5-k3s1";
  sh(`docker image inspect ${k3s} >/dev/null 2>&1 || docker pull -q ${k3s}`);
  sh(`docker create --name bfe2e-kiri-k8s --label dev.kiri.k8s=1 ${k3s} server`);
  sh(`docker run -d --name bfe2e-port-holder -p 127.0.0.1:6443:80 ${ALPINE} sleep 600`);
  await open(page);
  await go(page, "kube");
  const others = page.getByTestId("kube-others");
  await expect(others).toContainText("bfe2e-kiri-k8s");
  await expect(others).toContainText("Kiri가 만든 것");
  await kube(page);
  expect(sh("docker port boxforge-k3s 6443")).toBe("127.0.0.1:6444");
});

test("a secret's keys show, its value never does", async ({ page, request }) => {
  await kube(page);
  await page.getByRole("tab", { name: /설정값/ }).click();
  await page.getByRole("button", { name: "설정값 만들기" }).click();
  const d = page.getByRole("dialog");
  await d.getByText("Secret — 비밀번호").click();
  await d.getByLabel("이름").fill("bfe2e-secret");
  await d.getByLabel("값 1: 키").fill("PASSWORD");
  await d.getByLabel("값 1: 값").fill("hunter2-e2e");
  await d.getByRole("button", { name: "만들기" }).click();
  const row = page.getByTestId("secret-bfe2e-secret");
  await expect(row).toContainText("PASSWORD");
  await expect(row).toContainText("11바이트");
  await expect(page.locator("body")).not.toContainText("hunter2-e2e");
  await expect(page.getByTestId("cli")).toContainText("--from-literal=PASSWORD=****");
  // Not in what the screen is sent either, nor kept in an annotation.
  const list = await (await request.post("/api/call/KubeGet", { data: ["secrets"] })).text();
  expect(list).toContain("bfe2e-secret");
  expect(list).not.toContain("hunter2-e2e");
  expect(list).not.toContain(Buffer.from("hunter2-e2e").toString("base64"));
  expect(kubectl("get secret bfe2e-secret -o jsonpath={.metadata.annotations}")).not.toContain("hunter2");
});

test("a ready cluster stays ready on the screen when asking it gets no answer for a while", async ({ page }) => {
  await kube(page);
  // As on a slow machine, where kubectl now and then doesn't answer in time.
  sh("docker exec boxforge-k3s mv /bin/kubectl /bin/kubectl.off");
  try {
    await page.waitForTimeout(20_000); // past the time a Ready answer is reused
    await expect(page.getByTestId("kube-state")).toContainText("준비됨");
    await go(page, "home");
    await go(page, "kube");
    await page.waitForTimeout(6_000);
    await expect(page.getByTestId("kube-state")).toContainText("준비됨");
    await expect(page.getByText("클러스터가 아직 시작하는 중입니다")).toHaveCount(0);
  } finally {
    sh("docker exec boxforge-k3s mv /bin/kubectl.off /bin/kubectl");
  }
});

test("a cluster made by an older BoxForge is made again at its start, its data kept", async ({ page }) => {
  test.skip(had, "a cluster was already there");
  const k3s = process.env.E2E_K3S || "rancher/k3s:v1.33.5-k3s1";
  // As 0.23 and before made it: no label, the node named after the container.
  sh("docker rm -f boxforge-k3s");
  sh(`docker run -d --name boxforge-k3s --privileged --tmpfs /run --tmpfs /var/run -e K3S_KUBECONFIG_MODE=644 -p 127.0.0.1:6450:6443 -v boxforge-k3s:/var/lib/rancher/k3s ${k3s} server`);
  await expect.poll(() => kubectl("get nodes --no-headers"), { timeout: 240_000 }).toMatch(/ Ready /);
  sh("docker stop boxforge-k3s");
  await open(page);
  await go(page, "kube");
  await expect(page.getByTestId("kube-state")).toContainText("꺼짐", { timeout: 60_000 });
  await kube(page);
  expect(sh("docker inspect -f '{{index .Config.Labels \"dev.boxforge.k3s\"}} {{json .Config.Cmd}}' boxforge-k3s")).toBe('3 ["server","--disable-network-policy","--node-name","boxforge","--kube-proxy-arg=masquerade-all=true"]');
  // What was in it is still there, on one node, the new one.
  expect(kubectl("get secret bfe2e-secret -o name")).toBe("secret/bfe2e-secret");
  await expect.poll(() => kubectl("get nodes -o jsonpath={.items[*].metadata.name}"), { timeout: 60_000 }).toBe("boxforge");
});

test("deploy with the helper: address, storage, settings, and the picture", async ({ page, request }) => {
  // Some machines can't run containers inside a container at all.
  test.skip(!!process.env.E2E_KUBE_NO_PODS, "pods can't run in a cluster here");
  await kube(page);
  await page.getByRole("button", { name: "앱 배포" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("이미지").fill(WEB);
  await d.getByLabel("이름").fill("bfe2e-web");
  await d.getByLabel("컨테이너 포트").fill("80");
  await d.getByText("주소로 (Ingress)").click();
  await d.getByLabel("설정값 모두 넣기").selectOption("secret:bfe2e-secret");
  await d.getByLabel("저장소 (GB)").fill("1");
  await d.getByLabel("붙일 경로").fill("/usr/share/nginx/html/data");
  await d.getByRole("button", { name: "만들어질 YAML 보기" }).click();
  const yaml = await d.getByTestId("deploy-yaml").innerText();
  for (const want of ["kind: Deployment", "kind: Service", "kind: Ingress", "kind: PersistentVolumeClaim", "secretRef: { name: bfe2e-secret }", 'host: "bfe2e-web.localhost"']) expect(yaml).toContain(want);
  await d.getByRole("button", { name: "배포" }).click();
  await expect(page.getByTestId("applied")).toContainText("deployment.apps/bfe2e-web created");
  // How it comes up, step by step, until all its pods are ready.
  const progress = page.getByTestId("deploy-progress");
  await expect(progress).toContainText("bfe2e-web");
  await expect(progress).toContainText("이미지를 받", { timeout: 120_000 });
  await expect(progress).toContainText("bfe2e-web 배포가 끝났습니다", { timeout: 180_000 });
  await progress.getByRole("button", { name: "닫기" }).click();
  await expect(progress).toHaveCount(0);

  // The picture: address → service → workload → a running pod.
  const flow = page.getByTestId("flow-bfe2e-web");
  await expect(flow).toContainText("bfe2e-web.localhost/");
  await expect(flow).toContainText("준비 1 / 1", { timeout: 180_000 });
  expect(kubectl("exec deploy/bfe2e-web -- printenv PASSWORD")).toBe("hunter2-e2e");

  // The address, opened on this PC through the cluster's way in.
  await page.getByRole("tab", { name: /주소/ }).click();
  await expect(page.getByTestId("ingress-bfe2e-web")).toBeVisible();
  await page.getByRole("button", { name: "내 PC로 연결 (8080)" }).click();
  await expect(page.getByTestId("ingress-bfe2e-web").getByRole("link")).toHaveAttribute("href", "http://bfe2e-web.localhost:8080/");
  let last = "";
  try {
    await expect
      .poll(
        async () => {
          const r = await request.get("http://127.0.0.1:8080/", { headers: { Host: "bfe2e-web.localhost" }, timeout: 10_000 }).catch((e) => (last = String(e), null));
          if (r) last = `${r.status()} ${(await r.text()).slice(0, 200)}`;
          return r?.status();
        },
        { timeout: 180_000 },
      )
      .toBe(200);
  } catch (e) {
    // What the cluster looked like, for a failure seen only in CI.
    console.log("last answer:", last);
    console.log(kubectl("get pods,svc,endpoints,ingress -A -o wide"));
    console.log(kubectl("get events -A --field-selector type=Warning"));
    console.log(sh("docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}'", true));
    throw e;
  }

  // The storage it asked for, in use by its pod.
  await page.getByRole("tab", { name: /저장소/ }).click();
  const pvc = page.getByTestId("pvc-bfe2e-web-data");
  await expect(pvc).toContainText("Bound");
  await expect(pvc).toContainText("bfe2e-web-");
});

test("an image that only runs a shell is kept open, and a command can be given", async ({ page }) => {
  await kube(page);
  await page.getByRole("button", { name: "앱 배포" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("이미지").fill(ALPINE);
  await d.getByLabel("이름").fill("bfe2e-shell");
  await expect(d.getByTestId("bare-shell")).toBeVisible();
  await expect(d.getByLabel("터미널을 연 채로 두기")).toBeChecked();
  // Fetched from a registry: the cluster fetches it too, nothing is copied by default.
  await expect(d.getByLabel("이 PC(엔진)에 있는 이미지를 클러스터에 넣어서 쓰기")).not.toBeChecked();
  await d.getByRole("button", { name: "만들어질 YAML 보기" }).click();
  await expect(d.getByTestId("deploy-yaml")).toContainText("tty: true");
  await d.getByLabel("실행할 명령").fill("sleep infinity");
  await expect(d.getByTestId("deploy-yaml")).toContainText('command: ["sh", "-c", "sleep infinity"]');
  await expect(d.getByTestId("deploy-yaml")).not.toContainText("tty: true");
  await d.getByLabel("실행할 명령").fill("");
  if (process.env.E2E_KUBE_NO_PODS) return;
  // Where pods run: it stays up instead of being restarted over and over.
  await d.getByRole("button", { name: "배포" }).click();
  await expect(page.getByTestId("deploy-progress")).toContainText("bfe2e-shell 배포가 끝났습니다", { timeout: 180_000 });
  await page.getByTestId("deploy-progress").getByRole("button", { name: "닫기" }).click();
  kubectl("delete deployment/bfe2e-shell --wait=false");
});

test("an image only the engine has goes into the cluster, and a deployment is changed by its YAML", async ({ page }) => {
  await kube(page);
  // Made here and never pushed anywhere: the cluster can't fetch it.
  sh(`docker create --name bfe2e-mk ${ALPINE} true`);
  sh(`docker commit bfe2e-mk bfe2e-local/app:1`);
  sh(`docker rm bfe2e-mk`);
  await page.getByRole("button", { name: "앱 배포" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("이미지").fill("bfe2e-local/app:1");
  await d.getByLabel("이름").fill("bfe2e-edit");
  const put = d.getByLabel("이 PC(엔진)에 있는 이미지를 클러스터에 넣어서 쓰기");
  await expect(put).not.toBeChecked(); // offered, not done unasked: copying is slow on a small machine
  await put.check();
  await d.getByRole("button", { name: "만들어질 YAML 보기" }).click();
  await expect(d.getByTestId("deploy-yaml")).toContainText("imagePullPolicy: IfNotPresent");
  await d.getByRole("button", { name: "배포" }).click();
  await expect(page.getByTestId("applied")).toContainText("deployment.apps/bfe2e-edit created", { timeout: 120_000 });
  expect(sh("docker exec boxforge-k3s ctr -n k8s.io images ls -q")).toContain("bfe2e-local/app:1");

  // Changed, not deleted: its YAML as it is, edited, applied.
  await page.getByRole("tab", { name: /워크로드/ }).click();
  await page.getByTestId("workload-bfe2e-edit").getByRole("button", { name: "고치기 (YAML)" }).click();
  const edit = page.getByRole("dialog", { name: "bfe2e-edit 고치기" });
  const box = edit.getByLabel("적용할 YAML");
  await expect(box).toHaveValue(/replicas: 1/);
  expect(await box.inputValue()).not.toContain("resourceVersion");
  await box.fill((await box.inputValue()).replace("replicas: 1", "replicas: 2"));
  await edit.getByRole("button", { name: "적용" }).click();
  await expect(page.getByTestId("applied")).toContainText("deployment.apps/bfe2e-edit configured");
  expect(kubectl("get deployment bfe2e-edit -o jsonpath={.spec.replicas}")).toBe("2");
  kubectl("delete deployment/bfe2e-edit --wait=false");
  sh("docker rmi bfe2e-local/app:1", true);
});

test("an image the cluster can't fetch is put in from the engine when the progress offers it", async ({ page }) => {
  test.skip(!!process.env.E2E_KUBE_NO_PODS, "pods can't run in a cluster here");
  await kube(page);
  sh(`docker create --name bfe2e-mk2 ${ALPINE}`);
  sh(`docker commit bfe2e-mk2 bfe2e-local/offer:1`);
  sh(`docker rm bfe2e-mk2`);
  try {
    await page.getByRole("button", { name: "앱 배포" }).click();
    const d = page.getByRole("dialog");
    await d.getByLabel("이미지").fill("bfe2e-local/offer:1");
    await d.getByLabel("이름", { exact: true }).fill("bfe2e-offer");
    await expect(d.getByLabel("이 PC(엔진)에 있는 이미지를 클러스터에 넣어서 쓰기")).not.toBeChecked();
    await d.getByRole("button", { name: "배포" }).click();
    const progress = page.getByTestId("deploy-progress");
    await progress.getByRole("button", { name: "이 PC의 이미지를 클러스터에 넣고 다시 해 보기" }).click({ timeout: 120_000 });
    await expect(progress).toContainText("bfe2e-offer 배포가 끝났습니다", { timeout: 180_000 });
  } finally {
    kubectl("delete deployment/bfe2e-offer --wait=false");
    sh("docker rmi bfe2e-local/offer:1", true);
  }
});

test("a running container is deployed to Kubernetes from its menu, the form filled", async ({ page }) => {
  await kube(page);
  sh(`docker run -dit --name bfe2e-kc -p 127.0.0.1:18089:80 -e MODE=prod ${ALPINE} sh`);
  try {
    await go(page, "containers");
    await page.locator("tr", { hasText: "bfe2e-kc" }).getByRole("button", { name: "더보기" }).click();
    await page.getByRole("menuitem", { name: "Kubernetes로 배포" }).click();
    const d = page.getByRole("dialog", { name: "앱 배포" });
    await expect(d.getByLabel("이미지")).toHaveValue(ALPINE);
    await expect(d.getByLabel("이름", { exact: true })).toHaveValue("bfe2e-kc");
    await expect(d.getByLabel("컨테이너 포트")).toHaveValue("80");
    await expect(d.getByLabel("환경변수 1: 이름")).toHaveValue("MODE");
    await expect(d.getByLabel("환경변수 1: 값")).toHaveValue("prod");
    await expect(d.getByLabel("터미널을 연 채로 두기")).toBeChecked();
    await d.getByRole("button", { name: "취소" }).click();
  } finally {
    sh("docker rm -f bfe2e-kc", true);
  }
});

test("a stuck pod says why, and deleting asks first", async ({ page }) => {
  await kube(page);
  await page.getByRole("button", { name: "앱 배포" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("이미지").fill("bfe2e.invalid/no-such-image:1");
  await d.getByLabel("이름").fill("bfe2e-broken");
  await d.getByRole("button", { name: "배포" }).click();
  const progress = page.getByTestId("deploy-progress");
  await expect(progress).toContainText("bfe2e-broken");
  // Left while it goes on, and come back: still followed, the lists not emptied.
  await go(page, "home");
  await go(page, "kube");
  await expect(progress).toContainText("bfe2e-broken");
  await expect(page.getByTestId("kube-loading")).toHaveCount(0);
  await expect(progress).toContainText("파드를 몇 개 둘지 정함", { timeout: 60_000 });
  await expect(progress.getByRole("button", { name: "그만 보기 (배포는 계속됨)" })).toBeVisible();
  await expect(page.getByTestId("flow-bfe2e-broken")).toContainText("원인:", { timeout: 120_000 });

  await page.getByRole("tab", { name: /파드/ }).click();
  const pod = page.locator('[data-testid^="pod-bfe2e-broken-"]').first();
  await expect(pod.getByTestId("pod-why")).toContainText("원인:");
  // Where pods can run at all (CI), the cause is the image that isn't there.
  if (process.env.CI) await expect(pod.getByTestId("pod-why")).toContainText("bfe2e.invalid");

  await page.getByRole("tab", { name: /워크로드/ }).click();
  const w = page.getByTestId("workload-bfe2e-broken");
  await expect(w).toContainText("원인:");
  await w.getByRole("button", { name: "삭제 (파드도 함께 사라짐)" }).click();
  const confirm = page.getByRole("dialog");
  await expect(confirm).toContainText("파드");
  await expect(confirm).toContainText("kubectl delete deployment bfe2e-broken -n default");
  await confirm.getByRole("button", { name: "취소" }).click();
  await expect(w).toBeVisible();
  await w.getByRole("button", { name: "삭제 (파드도 함께 사라짐)" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "삭제" }).click();
  await expect(w).toBeHidden();
});

test("storage made on its own waits for a pod, and its delete warns of the data", async ({ page }) => {
  await kube(page);
  await page.getByRole("tab", { name: /저장소/ }).click();
  await page.getByRole("button", { name: "저장소 만들기" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("이름").fill("bfe2e-disk");
  await d.getByLabel("크기 (GB)").fill("2");
  await d.getByRole("button", { name: "만들기" }).click();
  await page.getByRole("tab", { name: /저장소/ }).click();
  const row = page.getByTestId("pvc-bfe2e-disk");
  await expect(row).toContainText("Pending");
  await expect(row).toContainText("2Gi");
  await row.getByRole("button", { name: "삭제" }).click();
  await expect(page.getByRole("dialog")).toContainText("데이터를 모두 지웁니다");
  await page.getByRole("dialog").getByRole("button", { name: "삭제" }).click();
  await expect(row).toBeHidden();
});

test("a stopped cluster shows the last lines it wrote", async ({ page }) => {
  test.skip(had, "a cluster was already there: it is left running");
  await kube(page);
  await page.getByRole("button", { name: "끄기" }).click();
  await expect(page.getByTestId("kube-state")).toContainText("꺼짐", { timeout: 120_000 });
  await expect(page.getByText("꺼지기 전에 남긴 로그")).toBeVisible();
  await expect(page.getByTestId("kube-boot-log")).toContainText(/(info|warning|error): /);
});

test("a Compose project is moved to Kubernetes as a whole, in a namespace of its own", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "bfe2e-kmove-"));
  writeFileSync(
    join(dir, "compose.yaml"),
    `services:
  web:
    image: ${ALPINE}
    tty: true
    ports: ["127.0.0.1:18090:80"]
    environment:
      MODE: prod
    depends_on: [db]
    volumes:
      - ./site:/srv/site
  db:
    image: ${ALPINE}
    tty: true
    expose: ["5432"]
    volumes:
      - dbdata:/var/lib/data
volumes:
  dbdata:
`,
  );
  sh(`docker compose -p bfe2e-kmove -f ${join(dir, "compose.yaml")} up -d`);
  // data in the volume, to be found in the cluster's storage after the move
  sh(`docker compose -p bfe2e-kmove -f ${join(dir, "compose.yaml")} exec -T db sh -c 'echo moved-data > /var/lib/data/k.txt'`);
  try {
    await kube(page);
    await go(page, "compose");
    await page.locator(".project", { hasText: "bfe2e-kmove" }).getByRole("button", { name: "자세히" }).first().click();
    await page.getByRole("button", { name: "Kubernetes로 옮기기" }).click();
    const d = page.getByRole("dialog", { name: "bfe2e-kmove 를 Kubernetes로 옮기기" });
    await expect(d.getByTestId("compose-kube")).toContainText("네임스페이스 bfe2e-kmove에 서비스 2개(db, web)");
    const notes = d.getByTestId("compose-kube-notes");
    await expect(notes).toContainText("/srv/site"); // a folder of this PC: left out, and said so
    await expect(notes).toContainText("새 저장소 dbdata");
    await expect(notes).toContainText("depends_on");
    await d.getByRole("button", { name: "만들어질 YAML 보기 · 고치기" }).click();
    await expect(d.getByLabel("옮길 YAML")).toHaveValue(/kind: PersistentVolumeClaim/);
    await expect(d.getByLabel("옮길 YAML")).toHaveValue(/imagePullPolicy: IfNotPresent/);
    // The images the project runs here go in by default: they may exist nowhere else.
    await expect(d.getByRole("checkbox", { name: ALPINE })).toBeChecked();
    const copy = d.getByRole("checkbox", { name: /dbdata → 저장소 dbdata/ });
    await expect(copy).toBeChecked();
    // Storage is given out only to a running pod: without pods there is nothing to copy into.
    if (process.env.E2E_KUBE_NO_PODS) await copy.uncheck();
    await d.getByRole("button", { name: "Kubernetes에 배포" }).click();

    await expect(page.getByTestId("applied")).toContainText("namespace/bfe2e-kmove created", { timeout: 120_000 });
    const progress = page.getByTestId("deploy-progress");
    await expect(progress).toContainText("db");
    await expect(progress).toContainText("web");
    expect(kubectl("get deploy,svc,pvc -n bfe2e-kmove -o name")).toMatch(/deployment.apps\/db[\s\S]*deployment.apps\/web[\s\S]*service\/db[\s\S]*service\/web[\s\S]*persistentvolumeclaim\/dbdata/);
    expect(kubectl("get deploy web -n bfe2e-kmove -o jsonpath={.spec.template.spec.containers[0].env[0].value}")).toBe("prod");
    if (!process.env.E2E_KUBE_NO_PODS) {
      await expect(progress).toContainText("web 배포가 끝났습니다", { timeout: 180_000 });
      await expect(progress).toContainText("db 배포가 끝났습니다", { timeout: 180_000 });
      // Found by name, as in Compose.
      // (BusyBox's nslookup answers, then ends with 1 for the IPv6 half: its words are what count.)
      const lookup = () => kubectl(`exec -n bfe2e-kmove deploy/web -- sh -c "nslookup db 2>&1; true"`);
      try {
        await expect.poll(lookup, { timeout: 90_000, intervals: [3000] }).toContain("db.bfe2e-kmove.svc.cluster.local");
      } catch (e) {
        // How the cluster's name service stood, for a failure seen only in CI.
        console.log(lookup());
        console.log(kubectl(`exec -n bfe2e-kmove deploy/web -- cat /etc/resolv.conf`));
        console.log(kubectl("get pods,svc,endpoints -n kube-system -o wide"));
        console.log(kubectl("get svc,endpoints -n bfe2e-kmove -o wide"));
        console.log(kubectl("logs -n kube-system deploy/coredns --tail=30"));
        console.log(sh("docker exec boxforge-k3s sh -c 'iptables-save | grep -c KUBE-SVC; ip route; lsmod 2>/dev/null | grep -E \"br_netfilter|vxlan\"'", true));
        throw e;
      }
      await expect(page.getByTestId("volume-copying")).toBeHidden({ timeout: 300_000 });
      await expect.poll(() => kubectl(`exec -n bfe2e-kmove deploy/db -- cat /var/lib/data/k.txt`), { timeout: 120_000, intervals: [3000] }).toBe("moved-data");
    }

    // The whole project goes at once, after saying what goes.
    await page.getByRole("tab", { name: "흐름 그림" }).click();
    const moved = page.getByTestId("moved-projects");
    await expect(moved).toContainText("bfe2e-kmove");
    await moved.getByRole("button", { name: "통째로 지우기" }).click();
    const ask = page.getByRole("dialog");
    await expect(ask).toContainText("워크로드 2개");
    await expect(ask).toContainText("bfe2e-kmove 프로젝트 지우기");
    await ask.getByRole("button", { name: "삭제" }).click();
    await expect.poll(() => kubectl("get namespace bfe2e-kmove -o jsonpath={.status.phase}"), { timeout: 120_000 }).not.toBe("Active");
    // Compose's own containers stay.
    expect(sh(`docker compose -p bfe2e-kmove -f ${join(dir, "compose.yaml")} ps -q`).split("\n").filter(Boolean)).toHaveLength(2);
  } finally {
    kubectl("delete namespace bfe2e-kmove --wait=false");
    sh(`docker compose -p bfe2e-kmove -f ${join(dir, "compose.yaml")} down -v`, true);
  }
});
