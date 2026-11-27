// BoxForge's screens, driven in a real browser against a real Docker
// engine: the development server (cmd/devserver) serves the built UI and
// the app's methods.
//
//   cd frontend && npm run build && cd ../e2e
//   npm ci && npx playwright test
//
// Needs: Go, a running Docker engine with docker compose, the built UI.
// The tests make containers, volumes, networks and images whose names
// start with "bfe2e" and remove them again.
//
// Where Docker Hub can't be reached, name other images:
//   E2E_ALPINE=mirror.gcr.io/library/alpine:3 E2E_REGISTRY=mirror.gcr.io/library/registry:2
//   E2E_K3S=mirror.gcr.io/rancher/k3s:v1.33.5-k3s1 E2E_KUBE_NGINX=mirror.gcr.io/library/nginx:alpine
//   E2E_NODE=mirror.gcr.io/library/node:24-bookworm-slim (AI agent boxes' base)
//   E2E_BROWSER=mirror.gcr.io/jlesage/firefox:latest (their browser box)
//   E2E_OPENCLAW_IMAGE=<an image with OpenClaw in it> (the OpenClaw box, where builds can't install it)
//   E2E_HERMES_IMAGE=<an image with Hermes in /home/agent> (the Hermes box, likewise)
// Where builds can't reach the internet, E2E_NO_AGENT_BUILD=1 skips building a real agent.
import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const port = 34190;
// A configuration of its own: the developer's chosen engine and settings
// are not touched, and every run starts from nothing.
const config = mkdtempSync(join(tmpdir(), "bfe2e-config-"));

export default defineConfig({
  testDir: "./tests",
  // One Docker engine for all: the tests run one after another.
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  globalSetup: "./global-setup.ts",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    // The tests find things by their Korean labels.
    locale: "ko-KR",
    viewport: { width: 1440, height: 900 },
    trace: "off",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: `go run ../cmd/devserver -port ${port} -dist ../frontend/dist`,
    url: `http://127.0.0.1:${port}/`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: { XDG_CONFIG_HOME: config, HOME: process.env.HOME ?? config, BOXFORGE_K3S_IMAGE: process.env.E2E_K3S ?? "", BOXFORGE_AGENT_BASE: process.env.E2E_NODE ?? "", BOXFORGE_BROWSER_IMAGE: process.env.E2E_BROWSER ?? "" },
  },
});
