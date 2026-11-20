# 릴리스 내는 법

릴리스는 버전 태그를 올리면 GitHub Actions(`.github/workflows/release.yml`)가 만든다. 앱은 이 릴리스를 보고 스스로 업데이트한다.

## 순서

1. `CHANGELOG.md` 맨 위에 새 버전의 절(`## 1.2.3`)을 쓴다. 사용자에게 보이는 글이므로 사용자의 말로, 바뀐 것만.
2. `wails.json`의 `info.productVersion`을 같은 버전으로 맞춘다.
3. 검사: `gofmt -l .`(출력 없어야 함), `go vet ./internal/... ./cmd/... .`, `go test ./internal/...`, `cd frontend && npm run build`.
4. 커밋해서 `main`에 올린다.
5. 태그를 올린다.

   ```bash
   git tag v1.2.3
   ```

   ```bash
   git push origin v1.2.3
   ```

6. Actions의 "Release" 실행이 끝나면 릴리스 페이지에 `BoxForge-windows-amd64.exe`, `BoxForge-linux-amd64`, `checksums.txt`가 있는지 확인한다.

## 버전 번호

`주.부.수` 세 자리 숫자만 쓴다(태그는 앞에 `v`). 앱은 이 형식만 버전으로 알아본다.

- 수(0.9.**1**): 고친 것만 있을 때
- 부(0.**10**.0): 기능이 더해졌을 때
- 주(**1**.0.0): 크게 바뀌었을 때

## 지켜야 할 것

- 릴리스 파일 이름과 `checksums.txt`는 앱의 업데이트 코드(`internal/update`)와 약속된 이름이다. 바꾸려면 양쪽을 함께 바꾸고, 옛 버전이 새 릴리스를 못 찾게 된다는 점을 감안한다.
- 이미 낸 태그는 다시 쓰지 않는다. 잘못 냈으면 수 버전을 올려 새로 낸다.
- 프로그램은 서명되어 있지 않다. Windows는 처음 실행할 때 SmartScreen 경고를 보여준다(README에 안내 있음).
