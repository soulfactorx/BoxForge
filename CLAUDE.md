# BoxForge

Docker를 쉽게 쓰기 위한 앱. Go 백엔드(`internal/`) + React 화면(`frontend/src`). 데스크톱은 Wails v2(`main.go`), 브라우저용은 웹 서버(`cmd/boxforge-server`)로 같은 화면을 낸다. 설계와 지금 있는 것 · 없는 것은 `docs/DESIGN.md`, 서버 사용법은 `docs/SERVER.md`.

기능을 더하거나 바꾸면 `README.md`와 `docs/DESIGN.md`의 해당 부분도 함께 고친다(없는 기능을 있다고 적지 않는다).

## 일하는 방식

- 사용자는 한국어로 쓴다. 화면 글, 문서, 답변 모두 한국어. Docker 초보자도 쓰는 앱이므로 화면 글은 쉬운 말로.
- 화면에서 하는 모든 일은 같은 일을 하는 `docker` 명령을 하단 표시줄에 보여준다(`run(command, action)` 또는 `showCli`).
- 되돌릴 수 없는 일(삭제 · 정리)은 무엇이 사라지는지 보여주고 확인받는다.
- Docker Desktop에는 의존하지 않는다(유료). 무료 엔진만.
- 폼 안의 버튼은 `type="button"`을 명시한다(안 하면 Enter가 그 버튼을 누른다).
- 화면 글은 한국어로 쓴다. 영어는 `frontend/src/i18n/en.json`의 표로 낸다: 글을 더하거나 고치면 `cd frontend && node scripts/extract-strings.cjs`가 번역이 없는 글을 알려 주니 그 표에 채운다(`{0}`은 실행 중에 채워지는 자리).
- Playwright 테스트는 한국어 라벨로 요소를 찾으므로 브라우저를 `locale: "ko-KR"`로 연다(아니면 영어 화면이 뜬다).

## 검사

```bash
gofmt -l . && go vet ./internal/... ./cmd/... ./frontend . && go test ./internal/...
```

```bash
cd frontend && npm run build
```

화면 테스트는 `e2e/`에 있다(Playwright, 실제 Docker 상대). CI와 릴리스가 돌리며, 실패하면 릴리스가 나가지 않는다.

```bash
cd e2e && npm ci && npx playwright test --trace off
```

이 환경처럼 Docker Hub에 닿지 않으면 `E2E_ALPINE=mirror.gcr.io/library/alpine:3 E2E_REGISTRY=mirror.gcr.io/library/registry:2 E2E_K3S=mirror.gcr.io/rancher/k3s:v1.33.5-k3s1 E2E_KUBE_NO_PODS=1`을 붙인다(이 환경의 k3s 안에서는 파드가 뜨지 못한다: 파드가 실제로 도는 Kubernetes 테스트는 CI에서만 돈다). 기능을 더하거나 고치면 그 기능의 테스트도 `e2e/tests/`에 더한다. 화면은 `go run ./cmd/devserver`(실제 Docker) 또는 `BOXFORGE_ENGINE=fake go run ./cmd/devserver`로 띄워 브라우저에서 확인한다.
웹 서버(`cmd/boxforge-server`, `internal/webserver`)는 로그인한 사람에게 엔진 전체를 내준다. 로그인 없이 응답하는 주소를 늘리거나, 암호화 없이 네트워크에 열리게 하거나, 다른 사이트의 요청을 받게 하는 변경은 하지 않는다. `devserver`는 개발용(로그인 없음, 127.0.0.1 전용)이다.
Windows 전용 동작(WSL, 외부 터미널, 설치)은 여기서 실행해 볼 수 없다: `BOXFORGE_WSL`에 대역 스크립트를 주어 흐름만 확인하고, 사용자에게 Windows에서 확인해 달라고 분명히 말한다.

## 수정 후에는 릴리스까지

사용자가 정한 방식이다(2026-11: "수정 사항이 생기면 변경 후 릴리스까지 한번에", "main에 버전 올리면 자동 릴리스"). 고쳐 달라고 한 것을 고치면 릴리스까지 낸다. 순서는 `docs/RELEASING.md`:

1. `wails.json`의 `info.productVersion`을 올린다. 고친 것만이면 수 버전(0.9.0 → 0.9.1), 기능이 더해지면 부 버전.
2. `CHANGELOG.md` 맨 위에 그 버전의 절을 쓴다.
3. 검사 후 작업 브랜치와 `main`에 푸시한다(`git push origin HEAD:main`). `main`에 새 버전이 올라가면 Actions가 태그와 릴리스를 만든다. 태그는 직접 올리지 않는다.
4. Actions의 Release 실행이 성공했는지 확인하고, 실패했으면 로그를 보고 고친다.

사용자에게는 무엇을 고쳤고 어느 버전으로 나갔는지 알린다.
