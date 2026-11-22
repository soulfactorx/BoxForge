import { expect, test, type Page } from "@playwright/test";
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
  expect(sh("docker inspect -f '{{index .Config.Labels \"dev.boxforge.k3s\"}} {{json .Config.Cmd}}' boxforge-k3s")).toBe('2 ["server","--disable-network-policy","--node-name","boxforge"]');
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

test("a stuck pod says why, and deleting asks first", async ({ page }) => {
  await kube(page);
  await page.getByRole("button", { name: "앱 배포" }).click();
  const d = page.getByRole("dialog");
  await d.getByLabel("이미지").fill("bfe2e.invalid/no-such-image:1");
  await d.getByLabel("이름").fill("bfe2e-broken");
  await d.getByRole("button", { name: "배포" }).click();
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
