# BoxForge

Docker를 쉽게, 눈으로 보면서 다루기 위한 데스크톱 앱 (Windows / Linux / macOS).
설계는 [docs/DESIGN.md](docs/DESIGN.md)에 있습니다.

## 지금 되는 것 (M0)

- Docker 엔진 연결과 상태 표시 (끊기면 자동 재연결)
- 컨테이너 목록: Compose 프로젝트별 묶음, 상태 필터, 검색
- 시작 · 중지 · 재시작 · 일시정지 · 재개 · **이름 변경**(더블클릭) · 삭제
- 터미널에서 `docker` 명령으로 바꾼 것도 화면에 바로 반영
- 모든 작업에 같은 일을 하는 `docker` 명령 표시

아직 앱이 Docker를 설치해 주지는 않습니다. Docker Engine이 실행 중이어야 합니다.

## 필요한 것

- Go 1.24+, Node.js 20+
- Wails CLI: `go install github.com/wailsapp/wails/v2/cmd/wails@latest`
- Linux: `libgtk-3-dev`, `libwebkit2gtk-4.1-dev` (Windows은 WebView2, macOS는 추가 설치 없음)

## 빌드와 실행

```bash
wails build                    # Windows, macOS
```

```bash
wails build -tags webkit2_41   # Linux (Ubuntu 24.04 등 WebKitGTK 4.1)
```

결과물은 `build/bin/`에 생깁니다. 개발 중에는 `wails dev`(Linux는 같은 `-tags`)로 띄우면 코드를 고칠 때마다 다시 불러옵니다.

## 브라우저로 화면만 띄우기

데스크톱 창 없이 화면을 개발하거나 시험할 때 씁니다.

```bash
cd frontend && npm install && npm run build && cd ..
```

```bash
go run ./cmd/devserver
```

http://127.0.0.1:34116 을 엽니다. Docker가 없는 PC에서는 가짜 엔진으로 띄울 수 있습니다.

```bash
BOXFORGE_ENGINE=fake go run ./cmd/devserver
```

이 서버는 개발용입니다. 접속할 수 있으면 누구나 Docker를 조작할 수 있으므로 127.0.0.1에만 열립니다.

## 테스트

```bash
go test ./internal/...
```
