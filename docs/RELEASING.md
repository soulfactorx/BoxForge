# 릴리스 내는 법

`main`에 올라온 버전(`wails.json`의 `info.productVersion`)이 아직 릴리스되지 않은 것이면, GitHub Actions(`.github/workflows/release.yml`)가 프로그램을 빌드하고 `v<버전>` 태그와 릴리스를 만든다. 앱은 이 릴리스를 보고 스스로 업데이트한다.

## 순서

1. `wails.json`의 `info.productVersion`을 새 버전으로 올린다.
2. `CHANGELOG.md` 맨 위에 그 버전의 절(`## 1.2.3`)을 쓴다. 사용자에게 보이는 글이므로 사용자의 말로, 바뀐 것만. 이 절이 없으면 릴리스가 실패한다.
3. 검사: `cd frontend && npm run build`를 먼저 하고(Go 프로그램이 화면 파일을 안에 넣는다), `gofmt -l .`(출력 없어야 함), `go vet ./internal/... ./cmd/... ./frontend .`, `go test ./internal/...`.
4. 화면 테스트(`e2e/`)를 돌린다. 실제 Docker가 있어야 한다: `cd e2e && npm ci && npx playwright test`. Docker Hub에 닿지 않는 곳에서는 `E2E_ALPINE`, `E2E_REGISTRY`, `E2E_K3S`, `E2E_KUBE_NGINX`로 다른 이미지를 준다. 클러스터 안에서 파드가 뜨지 못하는 곳은 `E2E_KUBE_NO_PODS=1`.
5. 커밋해서 `main`에 올린다. 릴리스 작업도 화면 테스트를 다시 돌리며, 하나라도 실패하면 릴리스를 내지 않는다(실패한 화면의 스크린숏이 Actions의 결과물로 남는다).
6. Actions의 "Release" 실행이 끝나면 릴리스 페이지에 아래 파일이 있는지 확인한다.

| 파일 | 무엇 |
|---|---|
| `BoxForge-windows-amd64.exe` | Windows 데스크톱 앱 |
| `BoxForge-linux-amd64` | Linux 데스크톱 앱 |
| `BoxForge-macos.zip` | macOS 앱(사람이 받는 것) |
| `BoxForge-darwin-universal` | macOS 앱 안의 프로그램(앱이 자기를 업데이트할 때 받는 것) |
| `BoxForge-server-linux-amd64`, `-linux-arm64`, `-windows-amd64.exe` | 웹 서버 |
| `checksums.txt` | 위 파일들의 SHA-256 |

데스크톱 앱은 각 OS의 실행기에서 `wails build`로, 웹 서버는 창 라이브러리가 필요 없어 Linux 실행기에서 세 가지 모두 빌드한다.

버전을 올리지 않은 푸시는 릴리스를 만들지 않는다("already released"로 끝남). 태그는 직접 만들지 않는다.

## 버전 번호

`주.부.수` 세 자리 숫자만 쓴다. 앱도 릴리스 작업도 이 형식만 버전으로 알아본다.

- 수(0.9.**1**): 고친 것만 있을 때
- 부(0.**10**.0): 기능이 더해졌을 때
- 주(**1**.0.0): 크게 바뀌었을 때

## 지켜야 할 것

- 릴리스 파일 이름과 `checksums.txt`는 앱의 업데이트 코드(`internal/update`)와 약속된 이름이다. 바꾸려면 양쪽을 함께 바꾸고, 옛 버전이 새 릴리스를 못 찾게 된다는 점을 감안한다.
- 이미 낸 릴리스는 고쳐 쓰지 않는다. 잘못 냈으면 수 버전을 올려 새로 낸다.
- 프로그램은 기본으로 서명되어 있지 않다. Windows는 처음 실행할 때 SmartScreen 경고를 보여준다(README에 안내 있음).
- Windows 코드 서명 인증서(.pfx)가 생기면 저장소 Settings → Secrets and variables → Actions에 `WINDOWS_CERTIFICATE`(pfx 파일을 base64로 바꾼 글자)와 `WINDOWS_CERTIFICATE_PASSWORD`를 넣는다. 그 뒤의 릴리스부터 Windows 프로그램이 서명된다. 없으면 그 단계는 건너뛴다.
- macOS 판은 임시(ad hoc) 서명만 되어 있다. Apple Developer ID 서명과 공증은 아직 없다.
- 데스크톱 앱과 웹 서버는 각자의 파일로 업데이트한다(`update.Server`). 서버 파일의 이름을 바꾸면 돌고 있는 서버들이 새 버전을 못 찾는다.
- 한 번에 여러 버전을 연달아 올려도 된다. 릴리스 작업은 차례로 돌며 각 커밋의 버전을 낸다.
