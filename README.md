# BoxForge

Docker를 쉽게, 눈으로 보면서 다루기 위한 데스크톱 앱 (Windows / Linux / macOS).
설계는 [docs/DESIGN.md](docs/DESIGN.md)에 있습니다.

## 지금 되는 것

- **엔진**: 연결과 상태 표시, 끊기면 자동 재연결. 엔진 고르기(사이드바 아래 엔진 카드): `docker` 명령과 같은 엔진, Docker context, WSL 배포판 안의 Docker Engine. WSL 안의 엔진은 네트워크 포트 없이 `wsl.exe`를 통해 연결
- **관계도**: 포트 · 컨테이너 · 네트워크 · 볼륨을 한 그림으로. Compose 프로젝트는 상자로 묶이고, 마우스를 올리면 연결된 것만 남으며, 누르면 그 항목으로 이동
- **Kubernetes**: 컨테이너 하나로 도는 작은 클러스터(k3s)를 켜기 · 끄기 · 삭제. 파드(상태와 그 뜻, 로그, describe, 삭제), 워크로드(준비된 파드 수, 늘리기 · 줄이기, 재시작, 삭제), 서비스, 경고 이벤트, YAML 적용, kubeconfig 저장
- **엔진 간 복사**: 이미지, 볼륨(데이터 포함), 컨테이너를 다른 엔진으로. 컨테이너는 안에서 바뀐 파일과 연결된 볼륨의 데이터까지 가져가서, 받는 쪽에 같은 설정(환경변수 · 포트 · 마운트 · 재시작 정책)으로 시작하지 않은 채 만들어 둠
- **진행 표시**: 시작 · 중지처럼 시간이 걸리는 작업은 끝날 때까지 그 행에 "중지하는 중…"으로 표시
- **외부 터미널**: 컨테이너의 셸을 PC의 터미널 창으로 열기
- **명령 기록**: 화면에서 한 모든 일(목록 보기, 볼륨 안 보기 포함)을 같은 일을 하는 명령으로 기록
- **컨테이너**: Compose 프로젝트별 묶음, 상태 필터, 검색, 디스크 크기(엔진이 알려주지 않으면 이미지 크기). 시작 · 중지 · 재시작 · 일시정지 · 재개 · 강제 종료 · 이름 변경 · 삭제
- **새 컨테이너 실행**: 이미지, 이름, 포트, 저장 공간, 환경변수, 재시작 정책, 실행 명령을 채우는 창. 없는 이미지는 먼저 내려받음
- **컨테이너 상세**: 개요(실시간 CPU · 메모리 그래프, 포트 · 저장 공간 · 네트워크 · 환경변수, 비밀값은 가림), 실시간 로그(검색), 터미널(컨테이너 안의 셸), 원본(inspect)
- **이미지**: 리포지토리 · 태그 · 사용처 · 크기 목록, 사용 여부 필터, 정렬, 받기(진행률), 다시 받기, 태그 추가, 삭제, 이름 없는 이미지 정리, 이 이미지로 실행
- **Compose**: 프로젝트 목록(서비스 · 상태 · 포트), compose 파일 열어서 올리기, 중지 · 재시작 · 이미지 받기 · 내리기, 명령 출력 실시간 표시, compose 파일 보기. PC에 `docker compose` 명령이 있어야 함
- **빌드**: 폴더와 Dockerfile로 이미지 만들기, 설정 저장 · 불러오기 · 새 빌드, 단계별 진행(완료 · 캐시 사용 · 실패)과 각 단계의 출력, 빌드 인자, Dockerfile 보기 · 편집, 취소, 빌드 캐시 지우기. PC에 `docker` 명령이 있어야 함
- **볼륨**: 목록(사용처 · 크기), 사용 여부 필터, 만들기, 삭제, 안 쓰는 볼륨 정리(지워질 목록을 먼저 보여 줌), 안에 든 파일 보기(폴더 이동 · 글자 파일 미리보기 · 내 PC로 저장, 읽기 전용)
- **네트워크**: 목록(주소 범위 · 연결된 컨테이너와 IP), 만들기, 컨테이너 연결 · 연결 끊기, 삭제, 안 쓰는 네트워크 정리
- 이름으로 알 수 있는 제품(ubuntu, postgres, nginx 등)은 그 제품의 아이콘으로 표시
- 터미널에서 `docker` 명령으로 바꾼 것도 화면에 바로 반영
- 모든 작업에 같은 일을 하는 `docker` 명령 표시

### Docker Engine이 없을 때

**Windows**: 사이드바 아래의 엔진 카드 → "Docker Engine 설치". BoxForge가 다음을 차례로 합니다.

1. WSL 2 준비 (없으면 설치. 관리자 권한을 한 번 묻고, Windows를 다시 시작해야 할 수 있음)
2. 고른 Linux 내려받기 (체크섬 확인). 고를 수 있는 것은 BoxForge가 Docker까지 설치할 수 있는 배포판입니다: Microsoft의 WSL 배포판 목록(`wsl --list --online`과 같은 목록)에 있는 Ubuntu와 Debian, 그리고 Alpine Linux 최신 안정판. Ubuntu · Debian · Alpine 계열의 루트 파일시스템을 직접 지정할 수도 있습니다
3. BoxForge 전용 WSL 배포판 만들기 (기존 배포판은 건드리지 않음)
4. Docker 공식 저장소에서 Docker Engine · Compose · Buildx 설치
5. 엔진을 시작하고 BoxForge를 그 엔진에 연결

중간에 실패하거나 취소해도 "설치 계속"을 누르면 끝난 단계는 건너뜁니다. 같은 창의 "제거"로 통째로 지울 수 있습니다.
설치하는 것은 모두 무료이며 Docker Desktop은 쓰지 않습니다. 회사 프록시나 사내 인증서 설정은 아직 지원하지 않습니다.

**Linux**: 터미널에서 직접 설치합니다.

```bash
curl -fsSL https://get.docker.com | sudo sh
```

```bash
sudo systemctl enable --now docker
```

**macOS**: 자동 설치는 아직 없습니다. colima 같은 무료 엔진을 설치하면 Docker context로 잡힙니다.

이미 쓰는 WSL 배포판에 Docker Engine을 직접 설치했다면, 엔진 카드에서 "WSL: (배포판) 안의 Docker"를 고르면 됩니다.
Compose와 빌드도 고른 엔진의 `docker` 명령으로 실행됩니다.
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
