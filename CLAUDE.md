# BoxForge

Docker를 쉽게 쓰기 위한 데스크톱 앱. Go 백엔드(`internal/`) + React 화면(`frontend/src`), Wails v2로 묶는다. 설계는 `docs/DESIGN.md`.

## 일하는 방식

- 사용자는 한국어로 쓴다. 화면 글, 문서, 답변 모두 한국어. Docker 초보자도 쓰는 앱이므로 화면 글은 쉬운 말로.
- 화면에서 하는 모든 일은 같은 일을 하는 `docker` 명령을 하단 표시줄에 보여준다(`run(command, action)` 또는 `showCli`).
- 되돌릴 수 없는 일(삭제 · 정리)은 무엇이 사라지는지 보여주고 확인받는다.
- Docker Desktop에는 의존하지 않는다(유료). 무료 엔진만.
- 폼 안의 버튼은 `type="button"`을 명시한다(안 하면 Enter가 그 버튼을 누른다).

## 검사

```bash
gofmt -l . && go vet ./internal/... ./cmd/... . && go test ./internal/...
```

```bash
cd frontend && npm run build
```

화면은 `go run ./cmd/devserver`(실제 Docker) 또는 `BOXFORGE_ENGINE=fake go run ./cmd/devserver`로 띄워 브라우저에서 확인한다. 바꾼 기능은 Playwright로 실제 엔진을 상대로 확인한다.
Windows 전용 동작(WSL, 외부 터미널, 설치)은 여기서 실행해 볼 수 없다: `BOXFORGE_WSL`에 대역 스크립트를 주어 흐름만 확인하고, 사용자에게 Windows에서 확인해 달라고 분명히 말한다.

## 수정 후에는 릴리스까지

사용자가 고쳐 달라고 한 것을 고치면, 따로 말하지 않아도 릴리스까지 낸다. 순서는 `docs/RELEASING.md`:
CHANGELOG에 새 버전 절 → `wails.json` 버전 → 검사 → `main`에 푸시 → `vX.Y.Z` 태그 푸시 → Actions의 Release 실행이 성공했는지 확인.
고친 것만이면 수 버전을, 기능이 더해지면 부 버전을 올린다. 사용자에게는 무엇을 고쳤고 어느 버전으로 나갔는지 알린다.
