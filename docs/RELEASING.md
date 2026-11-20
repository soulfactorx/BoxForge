# 릴리스 내는 법

`main`에 올라온 버전(`wails.json`의 `info.productVersion`)이 아직 릴리스되지 않은 것이면, GitHub Actions(`.github/workflows/release.yml`)가 프로그램을 빌드하고 `v<버전>` 태그와 릴리스를 만든다. 앱은 이 릴리스를 보고 스스로 업데이트한다.

## 순서

1. `wails.json`의 `info.productVersion`을 새 버전으로 올린다.
2. `CHANGELOG.md` 맨 위에 그 버전의 절(`## 1.2.3`)을 쓴다. 사용자에게 보이는 글이므로 사용자의 말로, 바뀐 것만. 이 절이 없으면 릴리스가 실패한다.
3. 검사: `gofmt -l .`(출력 없어야 함), `go vet ./internal/... ./cmd/... .`, `go test ./internal/...`, `cd frontend && npm run build`.
4. 커밋해서 `main`에 올린다.
5. Actions의 "Release" 실행이 끝나면 릴리스 페이지에 `BoxForge-windows-amd64.exe`, `BoxForge-linux-amd64`, `checksums.txt`가 있는지 확인한다.

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
- macOS 릴리스에는 파일이 둘이다: 사람이 받는 `BoxForge-macos.zip`(앱)과 앱이 자기를 업데이트할 때 받는 `BoxForge-darwin-universal`(앱 안의 프로그램).
