# BoxForge

Docker를 쉽게, 눈으로 보면서 다루기 위한 데스크톱 앱 (Windows / Linux / macOS).
설계는 [docs/DESIGN.md](docs/DESIGN.md)에 있습니다.

## 지금 되는 것

- **엔진**: 연결과 상태 표시, 끊기면 자동 재연결. 엔진 고르기(사이드바 아래 엔진 카드): `docker` 명령과 같은 엔진, Docker context, WSL 배포판 안의 Docker Engine. WSL 안의 엔진은 네트워크 포트 없이 `wsl.exe`를 통해 연결
- **진행 표시**: 시작 · 중지처럼 시간이 걸리는 작업은 끝날 때까지 그 행에 "중지하는 중…"으로 표시
- **외부 터미널**: 컨테이너의 셸을 PC의 터미널 창으로 열기
- **명령 기록**: 화면에서 한 모든 일(목록 보기, 볼륨 안 보기 포함)을 같은 일을 하는 명령으로 기록
- **컨테이너**: Compose 프로젝트별 묶음, 상태 필터, 검색, 디스크 크기(엔진이 알려주지 않으면 이미지 크기). 시작 · 중지 · 재시작 · 일시정지 · 재개 · 강제 종료 · 이름 변경 · 삭제
- **새 컨테이너 실행**: 이미지, 이름, 포트, 저장 공간, 환경변수, 재시작 정책, 실행 명령을 채우는 창. 없는 이미지는 먼저 내려받음
- **컨테이너 상세**: 개요(실시간 CPU · 메모리 그래프, 포트 · 저장 공간 · 네트워크 · 환경변수, 비밀값은 가림), 실시간 로그(검색), 터미널(컨테이너 안의 셸), 원본(inspect)
- **이미지**: 리포지토리 · 태그 · 사용처 · 크기 목록, 사용 여부 필터, 정렬, 받기(진행률), 다시 받기, 태그 추가, 삭제, 이름 없는 이미지 정리, 이 이미지로 실행
- **Compose**: 프로젝트 목록(서비스 · 상태 · 포트), compose 파일 열어서 올리기, 중지 · 재시작 · 이미지 받기 · 내리기, 명령 출력 실시간 표시, compose 파일 보기. PC에 `docker compose` 명령이 있어야 함
- **빌드**: 폴더와 Dockerfile로 이미지 만들기, 단계별 진행(완료 · 캐시 사용 · 실패)과 각 단계의 출력, 빌드 인자, Dockerfile 보기 · 편집, 취소, 빌드 캐시 지우기. PC에 `docker` 명령이 있어야 함
- **볼륨**: 목록(사용처 · 크기), 사용 여부 필터, 만들기, 삭제, 안 쓰는 볼륨 정리(지워질 목록을 먼저 보여 줌), 안에 든 파일 보기(폴더 이동 · 글자 파일 미리보기 · 내 PC로 저장, 읽기 전용)
- **네트워크**: 목록(주소 범위 · 연결된 컨테이너와 IP), 만들기, 컨테이너 연결 · 연결 끊기, 삭제, 안 쓰는 네트워크 정리
- 이름으로 알 수 있는 제품(ubuntu, postgres, nginx 등)은 그 제품의 아이콘으로 표시
- 터미널에서 `docker` 명령으로 바꾼 것도 화면에 바로 반영
- 모든 작업에 같은 일을 하는 `docker` 명령 표시

아직 앱이 Docker를 설치해 주지는 않습니다. Docker Engine(또는 Docker API를 제공하는 엔진)이 실행 중이어야 합니다.

### Windows에서 Docker Engine 쓰기 (Docker Desktop 없이)

Docker Engine은 무료이고 WSL의 Linux 배포판 안에 설치합니다.

1. WSL 배포판(예: Microsoft Store의 Ubuntu) 터미널에서 Docker Engine을 설치합니다.

   ```bash
   curl -fsSL https://get.docker.com | sudo sh
   ```

   ```bash
   sudo systemctl enable --now docker
   ```

2. BoxForge 사이드바 아래의 엔진 카드를 눌러 "WSL: (배포판) 안의 Docker"를 고릅니다.

이후 Compose와 빌드도 그 배포판 안의 `docker` 명령으로 실행됩니다.
비공개 레지스트리 로그인은 아직 없어서 공개 이미지만 받을 수 있습니다.

제품 아이콘은 [Simple Icons](https://simpleicons.org)(CC0)의 것이며, 각 상표는 해당 소유자의 것입니다.

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
