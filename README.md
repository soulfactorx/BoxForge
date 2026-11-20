<p align="center"><img src="build/appicon.png" width="120" alt="BoxForge"></p>

# BoxForge

Docker를 쉽게, 눈으로 보면서 쓰기 위한 데스크톱 앱입니다 (Windows · Linux).

- **무료 엔진만 씁니다.** Docker Desktop이 필요 없습니다. Docker Engine이 없으면 BoxForge가 설치해 줍니다.
- **쉬운 말로 안내합니다.** 버튼마다 무슨 일이 생기는지, 왜 멈췄는지 알려 줍니다.
- **명령도 함께 보여 줍니다.** 화면에서 한 모든 일은 같은 일을 하는 `docker` 명령으로 하단에 나옵니다.

## 설치

[릴리스 페이지](https://github.com/soulfactorx/BoxForge/releases/latest)에서 내려받습니다.

| | 파일 |
|---|---|
| Windows 10 · 11 | `BoxForge-windows-amd64.exe` |
| Linux (Ubuntu 24.04 등) | `BoxForge-linux-amd64` |

설치 과정은 없습니다. 받은 파일을 원하는 폴더(예: `문서\BoxForge`)에 두고 실행하면 됩니다. 이후에는 새 버전이 나오면 앱이 알아서 받아 두고, 다음에 켤 때 적용합니다.

**Windows에서 처음 실행할 때** "Windows의 PC 보호" 창이 뜰 수 있습니다. 프로그램에 유료 코드 서명이 없어서 그렇습니다. "추가 정보" → "실행"을 누르면 됩니다.

**Linux**에서는 실행 권한을 주고, WebKitGTK 4.1이 있어야 합니다.

```bash
chmod +x BoxForge-linux-amd64
```

```bash
sudo apt install libwebkit2gtk-4.1-0
```

## 처음 켜면

1. 홈 화면이 뜹니다. 엔진에 연결되어 있지 않으면 **"엔진 설치 · 선택"** 버튼이 보입니다.
2. Docker Engine이 없다면 "Docker Engine 설치"를 누릅니다(Windows). WSL 2 준비 → Linux 내려받기 → Docker 설치까지 알아서 합니다. 관리자 권한을 한 번 묻고, Windows를 다시 시작해야 할 수 있습니다.
3. 홈의 "바로 실행하기"에서 PostgreSQL이나 nginx를 눌러 첫 컨테이너를 실행해 보세요.

이미 Docker Engine이나 다른 엔진(Kiri, Rancher Desktop, colima 등)을 쓰고 있다면 그대로 연결됩니다. 여러 엔진이 있으면 왼쪽 아래 엔진 카드에서 고릅니다.

## 할 수 있는 일

| 화면 | 내용 |
|---|---|
| 홈 | 실행 중인 것, 자주 쓰는 프로그램 바로 실행, 실패한 컨테이너와 이유, 디스크 정리 |
| 컨테이너 | 시작 · 중지 · 재시작 · 이름 변경 · 삭제, 실시간 로그, 터미널(앱 안 · 외부), CPU · 메모리 그래프, 다른 엔진으로 복사 |
| Compose | 프로젝트 올리기 · 내리기, 구조 그림, 서비스별 조작, 파일 편집과 적용 미리 보기, 로그 |
| 관계도 | 포트 · 컨테이너 · 네트워크 · 볼륨의 관계를 한 그림으로 |
| 이미지 | 받기, 태그, 삭제, 정리, 다른 엔진으로 복사 |
| 볼륨 | 만들기, 삭제, 정리, 안에 든 파일 보기와 내려받기 |
| 네트워크 | 만들기, 컨테이너 연결 · 해제, 삭제 |
| 빌드 | Dockerfile로 이미지 만들기, 단계별 진행, 설정 저장 |
| Kubernetes | 컨테이너 하나로 도는 연습용 클러스터(k3s), 파드 · 워크로드 · 서비스, YAML 적용 |
| 설정 | 테마, 자동 업데이트, 엔진, 회사 네트워크(프록시 · 인증서), 레지스트리 로그인 |

`Ctrl+K`를 누르면 어디서든 화면 · 컨테이너 · 이미지를 찾아 이동할 수 있습니다. 인터넷에서 본 `docker run …` 명령을 붙여넣으면 실행 창에 풀어서 채워 줍니다.

## 알아 둘 것

- **회사 PC**: BIOS에서 가상화가 꺼져 있거나 WSL이 정책으로 막혀 있으면 엔진을 설치할 수 없습니다. IT 부서에 "WSL 2 사용"을 요청해야 합니다.
- **회사 프록시 · 사내 인증서**: 설정 → 회사 네트워크에서 프록시 주소와 사내 루트 인증서를 넣습니다(BoxForge가 설치한 WSL 엔진에 적용). Kubernetes 클러스터 안에는 아직 적용되지 않습니다.
- **비공개 레지스트리**: 설정 → 레지스트리 로그인에서 로그인하면 받을 수 있습니다. PC에 `docker` 명령이 있어야 합니다.
- **Compose · 빌드**: PC(또는 엔진이 있는 WSL 배포판)의 `docker` 명령으로 실행합니다. BoxForge가 설치한 엔진에는 들어 있습니다.
- **엔진 유지**: BoxForge가 설치한 엔진(WSL)은 앱이 켜져 있는 동안 돕니다. 앱을 닫으면 잠시 뒤 컨테이너도 멈춥니다. 설정 → "앱을 닫아도 엔진 유지"를 켜면 계속 돕니다.
- **다른 PC의 엔진 · Podman**: 엔진 선택 창에서 SSH 주소(user@host)를 추가하면 다른 PC나 서버의 Docker Engine을 다룰 수 있습니다(키로 로그인되어 있어야 함). Linux의 Podman 소켓은 자동으로 목록에 나옵니다. containerd 단독 지원은 아직 없습니다.
- **개인 정보**: 사용 정보를 어디에도 보내지 않습니다. 업데이트 확인 때만 GitHub에 접속합니다.
- **macOS**: `BoxForge-macos.zip`을 받아 풀고 응용 프로그램 폴더로 옮깁니다. Apple에 등록된 서명이 없어 처음에는 열리지 않습니다: 앱을 우클릭 → "열기"를 누르거나, 터미널에서 `xattr -dr com.apple.quarantine /Applications/BoxForge.app`을 한 번 실행하세요. 엔진은 자동 설치되지 않으므로 [Colima](https://github.com/abiosoft/colima)를 씁니다(`brew install colima docker && colima start`). macOS 판은 아직 실제 Mac에서 충분히 써 보지 못했습니다.
- **트레이**: 창을 닫아도 트레이 아이콘으로 남아 계속 실행됩니다(설정 → 화면에서 끌 수 있음). GNOME은 "AppIndicator" 확장이 있어야 트레이가 보이며, 없으면 닫을 때 그냥 꺼집니다.
- **Linux의 아이콘**: 처음 실행할 때 앱 메뉴에 BoxForge를 등록합니다(`~/.local/share/applications/boxforge.desktop`). 창과 작업 표시줄의 아이콘이 여기서 나옵니다. 실행 파일을 다른 곳으로 옮겼다면 한 번 다시 실행하면 됩니다.

문제가 있으면 [이슈](https://github.com/soulfactorx/BoxForge/issues)로 알려 주세요. 하단의 "기록"에 나오는 명령과 오류 문구를 함께 적어 주시면 빨리 찾을 수 있습니다.

## 개발

필요한 것: Go, Node.js 22, [Wails](https://wails.io) v2 (`go install github.com/wailsapp/wails/v2/cmd/wails@v2.17.1`). Linux는 `libgtk-3-dev`, `libwebkit2gtk-4.1-dev`.

```bash
wails build                    # Windows
```

```bash
wails build -tags webkit2_41   # Linux
```

데스크톱 창 없이 브라우저로 화면을 띄우려면(개발용, 127.0.0.1에만 열림):

```bash
cd frontend && npm install && npm run build && cd ..
```

```bash
go run ./cmd/devserver
```

Docker가 없는 PC에서는 `BOXFORGE_ENGINE=fake go run ./cmd/devserver`.

- 설계: [docs/DESIGN.md](docs/DESIGN.md)
- 릴리스 내는 법: [docs/RELEASING.md](docs/RELEASING.md)
- 바뀐 내용: [CHANGELOG.md](CHANGELOG.md)

## 라이선스

[Apache License 2.0](LICENSE).

제품 아이콘은 [Simple Icons](https://simpleicons.org)(CC0)의 것이며, 각 상표는 해당 소유자의 것입니다.
