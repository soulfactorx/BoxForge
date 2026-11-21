import { expect, test, type Page } from "@playwright/test";
import { go, open, sh } from "./helpers";

// Kubernetes: a real k3s in a container on the engine. The cluster fetches
// its images itself, so these name an image it can reach (E2E_KUBE_NGINX),
// or E2E_KUBE_PRELOAD=1 hands it the engine's copy.
//
// A cluster that was there before the tests is left as it was; one the
// tests made is removed at the end.
test.describe.configure({ mode: "serial" });
const WEB = process.env.E2E_KUBE_NGINX ?? "nginx:alpine";
const had = !sh("docker ps -aq --filter name=^boxforge-k3s$", true).startsWith("ERR") && sh("docker ps -aq --filter name=^boxforge-k3s$", true) !== "";
const kubectl = (rest: string) => sh(`docker exec boxforge-k3s kubectl ${rest}`, true);

test.setTimeout(420_000);

test.afterAll(() => {
  for (const what of ["deployment/bfe2e-web", "deployment/bfe2e-broken", "service/bfe2e-web", "ingress/bfe2e-web", "pvc/bfe2e-web-data", "secret/bfe2e-secret", "pvc/bfe2e-disk"]) kubectl(`delete ${what} --wait=false`);
  if (!had) sh("docker rm -f -v boxforge-k3s && docker volume rm boxforge-k3s", true);
});

async function kube(page: Page) {
  await open(page);
  await go(page, "kube");
  const state = page.getByTestId("kube-state");
  await expect(state).toBeVisible();
  if (!(await state.innerText()).includes("준비됨")) {
    const start = page.getByTestId("kube-start");
    if (await start.isVisible()) await start.click();
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
  await expect
    .poll(async () => (await request.get("http://127.0.0.1:8080/", { headers: { Host: "bfe2e-web.localhost" } }).catch(() => null))?.status(), { timeout: 180_000 })
    .toBe(200);

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
