import { execFileSync } from "node:child_process";
import { ALPINE, REGISTRY, NGINX, sh, sweep } from "./tests/helpers";

// Fetches the images the tests use, once, so that no test waits on a
// download; and clears what an earlier run left.
export default async function setup() {
  sh(`docker info --format '{{.ServerVersion}}'`);
  for (const img of [ALPINE, REGISTRY]) {
    if (sh(`docker image inspect ${img} --format ok`, true) !== "ok") execFileSync("docker", ["pull", "-q", img], { stdio: "inherit" });
  }
  // The compose starters name nginx:alpine; where Docker Hub can't be
  // reached a small image stands in under that name: one that keeps
  // running, as a web server does.
  if (sh(`docker image inspect ${NGINX} --format ok`, true) !== "ok") {
    if (sh(`docker pull -q ${NGINX}`, true).startsWith("ERR")) {
      execFileSync("docker", ["build", "-q", "-t", NGINX, "-"], { input: `FROM ${ALPINE}\nCMD ["sleep", "infinity"]\n`, stdio: ["pipe", "inherit", "inherit"] });
    }
  }
  sweep();
}
