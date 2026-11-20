# BoxForge 설계 문서

Docker · Podman · containerd를 하나의 화면에서 다루는 크로스플랫폼(Windows / Linux / macOS) 컨테이너 GUI.

- 상태: 초안 (v0.1)
- 범위: 아키텍처, 런타임 추상화, 명령어 커버리지 전략, UI 구조, 로드맵

---

## 1. 목표와 비목표

### 목표

1. **CLI 동등성** — `docker` CLI로 할 수 있는 일은 GUI에서도 할 수 있다. GUI로 감싸지 못한 명령도 내장 터미널로 같은 창에서 실행된다.
2. **런타임 통합** — Docker, Podman, containerd를 같은 화면·같은 조작으로 다루되, 각 런타임 고유 기능(Swarm, Pod, Namespace 등)은 숨기지 않고 노출한다.
3. **멀티 호스트** — 로컬 엔진과 원격 엔진(SSH, TCP+TLS)을 동시에 여러 개 연결한다.
4. **투명성** — 모든 GUI 동작은 "동등한 CLI 명령"을 보여준다. 사용자가 복사해 스크립트로 옮길 수 있다.
5. **가벼움** — 설치 용량 30MB 이하, 유휴 메모리 150MB 이하를 목표로 한다.

### 비목표 (v1)

- 컨테이너 엔진 자체를 설치·번들하지 않는다 (Docker Desktop의 대체가 아니라 그 위의 클라이언트). VM 프로비저닝은 `podman machine` / Lima 등 기존 도구의 제어까지만 한다.
- Kubernetes 클러스터 관리 도구가 아니다. (CRI 런타임 조회는 v2 이후 어댑터로 추가 가능)
- 웹 호스팅형 멀티테넌트 서비스(Portainer 서버 모드)는 다루지 않는다.

---

## 2. 핵심 설계 결정

| # | 결정 | 이유 |
|---|------|------|
| D1 | **UI 셸: Tauri 2 + React + TypeScript** | OS 웹뷰를 써서 Electron 대비 용량·메모리가 1/5 수준. 세 OS 설치 파일·자동 업데이트·코드 서명 지원. |
| D2 | **코어: Go로 작성한 별도 프로세스 `boxforge-core` (Tauri sidecar)** | Docker·containerd·BuildKit·compose-go의 1급 클라이언트가 모두 Go. 코어가 UI와 분리되어 헤드리스 실행·테스트·CLI 재사용이 가능하다. |
| D3 | **UI ↔ 코어: Connect RPC(protobuf) + WebSocket** | proto에서 Go 서버와 TS 클라이언트를 함께 생성해 타입이 한 곳에서 정의된다. 서버 스트리밍(로그·이벤트·통계)은 Connect, 양방향(exec/attach 터미널)은 WebSocket. |
| D4 | **런타임 어댑터 + Capability 모델** | 공통 인터페이스에 없는 기능을 억지로 맞추지 않는다. 어댑터가 "할 수 있는 것"을 선언하고 UI는 그에 따라 메뉴를 켜고 끈다. |
| D5 | **API 우선, CLI 위임은 보조** | 엔진 API로 가능한 것은 API로(빠르고 구조화됨). API가 없거나 클라이언트 측 로직이 큰 영역(compose, buildx, nerdctl 네트워킹)은 해당 CLI를 구조화된 방식으로 호출한다. |

검토 후 채택하지 않은 안:

- **Electron** — 생태계는 가장 넓지만 용량·메모리 목표(목표 5)와 충돌.
- **Wails(Go 단일 바이너리)** — 구조는 더 단순하나 자동 업데이트·서명·모바일 등 패키징 성숙도가 Tauri보다 낮다. 코어가 독립 프로세스이므로 나중에 셸을 바꾸는 비용은 작다.
- **Rust 단일 코어** — Docker는 `bollard`로 충분하지만 containerd/BuildKit/compose 쪽은 직접 구현할 양이 많다.

---

## 3. 전체 아키텍처

```
┌──────────────────────────── BoxForge 앱 ────────────────────────────┐
│  UI (React/TS, Tauri WebView)                                       │
│   대시보드 · 리소스 테이블 · 로그/터미널(xterm.js) · 명령 팔레트        │
└───────────────┬─────────────────────────────────────────────────────┘
                │ Connect RPC / WebSocket  (127.0.0.1:임의포트 + 세션 토큰)
┌───────────────▼─────────────────────────────────────────────────────┐
│  boxforge-core (Go)                                                  │
│  ┌────────────┐ ┌────────────┐ ┌──────────┐ ┌─────────────────────┐ │
│  │ API 서버    │ │ 연결 관리자 │ │ 이벤트 허브│ │ 작업(Job) 관리자      │ │
│  └────────────┘ └─────┬──────┘ └────▲─────┘ └─────────────────────┘ │
│  ┌────────────────────▼─────────────┴────────────────────────────┐  │
│  │ Runtime 인터페이스 (공통 리소스 모델 + Capabilities)             │  │
│  └───┬───────────────┬────────────────┬──────────────────┬───────┘  │
│  ┌───▼────┐     ┌────▼─────┐    ┌─────▼──────┐     ┌─────▼───────┐  │
│  │ Docker │     │ Podman   │    │ containerd │     │ CLI 러너     │  │
│  │ 어댑터  │     │ 어댑터    │    │ 어댑터      │     │(compose 등)  │  │
│  └───┬────┘     └────┬─────┘    └─────┬──────┘     └─────┬───────┘  │
│  ┌───▼───────────────▼────────────────▼──────────────────▼───────┐  │
│  │ 전송 계층: unix socket · Windows named pipe · TCP+TLS · SSH     │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
        │                    │                     │
   dockerd API         podman REST API       containerd gRPC / nerdctl
   (로컬·원격·VM)      (compat + libpod)      (로컬·SSH 포워딩·VM)
```

### 프로세스 구성

- **Tauri 셸(Rust)**: 창·트레이·자동 업데이트·OS 키체인 접근, 그리고 `boxforge-core` 실행/종료 관리만 담당한다. 비즈니스 로직은 두지 않는다.
- **boxforge-core(Go)**: 모든 런타임 통신과 상태 캐시. 시작 시 임의 포트와 일회성 토큰을 stdout으로 셸에 전달하고, 셸이 이를 웹뷰에 주입한다.
- 코어는 `--headless` 로 단독 실행 가능 → 통합 테스트와 향후 `boxforge` CLI/원격 에이전트의 기반이 된다.

---

## 4. 런타임 추상화

### 4.1 공통 리소스 모델

| 리소스 | Docker | Podman | containerd |
|--------|--------|--------|------------|
| Container | container | container | container + task |
| Image | image | image | image (+ content/snapshot) |
| Volume | volume | volume | nerdctl volume |
| Network | network | network | CNI 설정 (nerdctl) |
| Build | BuildKit / buildx | Buildah | BuildKit (별도 데몬) |
| ComposeProject | compose | podman compose | nerdctl compose |
| Pod | — | pod | — |
| Namespace | — | — | namespace |
| Swarm (Service/Stack/Node/Secret/Config) | swarm | — | — |
| Machine(VM) | Desktop / context | podman machine | Lima · colima · Rancher Desktop |

모든 리소스는 `공통 필드 + native(런타임 원본 JSON)` 구조다. 공통 필드로 목록·필터·정렬을 만들고, 상세 화면의 "Inspect" 탭은 `native`를 그대로 보여주어 정보 손실이 없다.

### 4.2 인터페이스 (Go, 개략)

```go
type Runtime interface {
    Info(ctx) (EngineInfo, error)
    Capabilities() CapabilitySet          // 연결 후 버전 협상 결과 반영
    Events(ctx, filter) (<-chan Event, error)

    Containers() ContainerService         // 필수
    Images()     ImageService             // 필수
    Volumes()    VolumeService            // 선택: 없으면 nil
    Networks()   NetworkService
    Builds()     BuildService
    Pods()       PodService               // Podman
    Namespaces() NamespaceService         // containerd
    Swarm()      SwarmService             // Docker
}
```

`CapabilitySet`은 `container.checkpoint`, `image.build.multiplatform`, `pod`, `swarm`, `rootless`, `kube.play` 같은 세분화된 플래그의 집합이다. UI는 플래그가 없는 기능을 숨기거나, "이 런타임에서는 지원하지 않음" 툴팁과 함께 비활성화한다.

### 4.3 어댑터별 구현 방침

**Docker**
- 공식 Go 클라이언트로 Engine API 직접 호출, API 버전 자동 협상.
- `compose`, `buildx`, `context`, `scout`, 서드파티 플러그인은 CLI 러너로 위임.

**Podman**
- Docker 호환 API가 있으므로 Docker 어댑터의 구현을 기반 계층으로 공유한다.
- Pod, `kube play/generate`, secret, `machine`, 자동 업데이트 등 고유 기능은 libpod REST API를 얇은 자체 클라이언트로 호출한다. (공식 Go 바인딩은 의존성이 무겁고 Windows/macOS 빌드가 번거로워 직접 의존하지 않는다.)
- rootless/rootful 소켓을 별개 연결로 취급한다.

**containerd** — 가장 까다로운 부분이므로 2단 구성으로 한다.
- *조회·관찰·생명주기*: containerd gRPC 클라이언트로 직접. 네임스페이스, 이미지, 컨테이너/태스크, 스냅샷, 이벤트, 메트릭.
- *실행·네트워크·볼륨·빌드·compose*: containerd에는 "docker run"에 해당하는 고수준 API가 없고 CNI 네트워킹·볼륨·포트 매핑이 전부 클라이언트(nerdctl) 몫이다. 이를 재구현하지 않고 **nerdctl을 CLI 러너로 호출**한다. nerdctl이 없으면 해당 기능을 Capability에서 빼고, 설치 안내를 표시한다.
- macOS/Windows에서는 containerd가 VM 안에 있으므로 Lima / colima / Rancher Desktop / WSL 인스턴스를 탐지해 `limactl shell … nerdctl`, `wsl -d … nerdctl` 형태로 호출하고, gRPC는 소켓 포워딩으로 연결한다.

### 4.4 연결과 자동 탐지

지원 전송: `unix://`, `npipe://`(Windows), `tcp://`+TLS, `ssh://`.

앱 시작 시 다음을 스캔해 "발견된 엔진" 목록을 제안한다 (자동 연결은 로컬 소켓에 한함).

- `DOCKER_HOST`, `~/.docker/contexts` (Docker context)
- `podman system connection` 설정, `podman machine` 소켓/파이프
- 잘 알려진 소켓 경로: `/var/run/docker.sock`, `$XDG_RUNTIME_DIR/podman/podman.sock`, `/run/containerd/containerd.sock`, `~/.colima/*/docker.sock`, `~/.lima/*/sock/*`, `~/.rd/docker.sock`
- Windows: `\\.\pipe\docker_engine`, podman machine 파이프, WSL 배포판 목록

SSH 연결은 원격에 아무것도 설치하지 않는다: Docker는 `docker system dial-stdio`, Podman·containerd는 OpenSSH의 유닉스 소켓 포워딩을 사용한다. containerd 소켓은 보통 root 전용이므로 권한 부족 시 원인과 해결책(sudo 포워딩, rootless containerd)을 명확히 안내한다.

---

## 5. "모든 명령어" 커버리지 전략

명령어를 3개 등급으로 나누어 100%를 보장한다.

| 등급 | 방식 | 대상 예시 |
|------|------|-----------|
| **A. 네이티브 화면** | 전용 폼/테이블/위저드 | container(run, start, stop, restart, kill, pause, rm, rename, update, logs, exec, attach, cp, diff, export, commit, stats, top, port, wait, prune), image(pull, push, build, tag, rm, save, load, import, history, inspect, prune), volume, network, system(info, df, events, prune), login/logout/search, compose, swarm 일체, pod, namespace |
| **B. 반자동 화면** | CLI의 `--help`/플러그인 메타데이터에서 생성한 범용 폼 + 구조화 출력(`--format json`) 테이블 | buildx 세부 명령, context, manifest, trust, plugin, checkpoint, scout, 서드파티 CLI 플러그인 |
| **C. 내장 터미널** | 선택된 엔진의 환경변수(`DOCKER_HOST` 등)가 설정된 셸 | 그 외 전부, 신규/실험 명령 |

보조 장치:

- **커버리지 매트릭스**: `docker`/`podman`/`nerdctl`의 명령 트리를 CI에서 추출해 `coverage.yaml`(명령 → 등급 → 담당 화면)과 대조한다. CLI 새 버전에 명령이 추가되면 CI가 "미분류 명령"으로 실패시켜 누락을 막는다.
- **명령 팔레트(Ctrl/Cmd+K)**: `docker run nginx -p 8080:80`을 그대로 입력하면 파싱해 해당 GUI 폼을 채워 연다. 파싱 불가하면 터미널에서 실행.
- **CLI 미리보기**: 모든 폼 하단에 동등한 명령을 실시간 표시(선택한 런타임에 따라 `docker`/`podman`/`nerdctl`로 바뀜).
- **`run` 폼**: 플래그가 100개가 넘으므로 기본(이미지·이름·포트·볼륨·환경변수) / 리소스 / 네트워크 / 보안 / 런타임 / 고급 탭으로 나누고, 플래그 이름 검색을 제공한다. 폼 상태는 "실행 프리셋"으로 저장·내보내기(compose YAML, CLI 스크립트)할 수 있다.

---

## 6. 실시간 데이터와 성능

- **이벤트 허브**: 연결마다 엔진 이벤트 스트림을 구독해 코어의 메모리 캐시를 갱신하고, 변경분(delta)만 UI로 푸시한다. UI는 폴링하지 않는다. 이벤트 스트림이 끊기면 재연결 후 전체 재동기화.
- **통계**: 화면에 보이는 컨테이너만 구독하고 1초 간격으로 샘플링, 최근 10분치만 링 버퍼에 보관.
- **로그**: 코어에서 청크 단위로 배치 전송 + 역압(backpressure). UI는 가상 스크롤, 검색·정규식 필터·타임스탬프·다중 컨테이너 병합(compose 프로젝트 단위) 지원.
- **터미널**: exec/attach는 WebSocket ↔ 엔진 하이재킹 스트림을 바이트 그대로 중계, 리사이즈 전파.
- **장기 작업(Job)**: pull/push/build/prune은 Job으로 등록되어 진행률·취소·이력을 갖는다. 창을 닫아도 코어가 살아있는 동안 유지.
- **규모 목표**: 컨테이너 5,000개·이미지 10,000개 목록에서 60fps 스크롤(가상화 테이블), 엔진 10개 동시 연결.

---

## 7. UI 구조

```
┌─────────┬──────────────────────────────────────────────┐
│ 엔진     │ [엔진: local-docker ▾]  검색…        ⌘K      │
│ ● docker │──────────────────────────────────────────────│
│ ● podman │ 대시보드 │ 컨테이너 │ 이미지 │ 볼륨 │ 네트워크 │
│ ○ ctrd   │ 빌드 │ Compose │ (Pod / Swarm / Namespace)   │
│ + 추가   │──────────────────────────────────────────────│
│          │  리소스 테이블 (필터·그룹·일괄 작업)            │
│ 작업 (2) │──────────────────────────────────────────────│
│ 터미널   │  상세 패널: 개요 · 로그 · 터미널 · 통계 ·       │
│ 설정     │            파일 · Inspect · 환경/포트/마운트    │
└─────────┴──────────────────────────────────────────────┘
```

- **엔진 전환과 통합 보기**: 한 엔진만 보거나, "모든 엔진" 통합 테이블(엔진 열 추가)로 본다.
- **괄호 안 탭은 Capability 기반**: Podman이면 Pod, Docker Swarm 활성 시 Swarm, containerd면 Namespace 탭이 나타난다.
- **컨테이너 파일 브라우저**: `cp`/archive API 기반 탐색·업로드·다운로드·편집.
- **이미지 상세**: 레이어 히스토리, 크기 분석, 멀티 아키텍처 매니페스트.
- **엔진 간 작업**: 이미지를 엔진 A → B로 복사(save/load 스트리밍), 컨테이너 설정을 다른 런타임용 명령/compose로 변환.
- **안전장치**: 파괴적 작업(rm -f, prune, volume rm)은 영향 범위(삭제될 대상 목록·회수 용량)를 미리 계산해 보여준 뒤 확인받는다.
- 다크/라이트 테마, i18n(한국어·영어 우선), 키보드 전용 조작.

---

## 8. 보안

- 코어 API는 `127.0.0.1` 임의 포트에만 바인딩하고, 실행마다 새로 만든 토큰과 `Origin` 검사를 요구한다. (컨테이너 소켓 접근은 사실상 호스트 root 권한이므로 로컬의 다른 프로세스·웹페이지가 코어를 통해 엔진에 접근하지 못하게 한다.)
- 레지스트리 자격 증명·TLS 키·SSH 암호는 OS 키체인(Keychain / Credential Manager / Secret Service)에만 저장. 기존 `docker login` 자격 증명 헬퍼를 존중해 재사용한다.
- CLI 러너는 셸을 거치지 않고 인자 배열로 실행해 인젝션을 차단한다.
- TCP 연결은 TLS 없는 경우 경고하고 명시적 동의를 받는다.
- 텔레메트리 기본 꺼짐. 자동 업데이트는 서명 검증.
- 관리자 권한 상승을 요구하지 않는다. 소켓 권한이 없으면 원인을 설명하고 사용자가 직접 해결하도록 안내한다.

---

## 9. 저장소 구조

```
BoxForge/
├─ proto/boxforge/v1/        # API 계약 (단일 진실 공급원)
├─ core/                     # Go 모듈
│  ├─ cmd/boxforge-core/
│  ├─ api/                   # Connect 핸들러, WebSocket
│  ├─ runtime/               # Runtime 인터페이스, 공통 모델, Capability
│  │  ├─ docker/  podman/  containerd/
│  ├─ transport/             # unix, npipe, tcp/tls, ssh
│  ├─ discovery/             # 엔진 자동 탐지
│  ├─ clirunner/             # compose·buildx·nerdctl 호출, 출력 파싱
│  ├─ events/  jobs/  store/ # 이벤트 허브, 작업, 설정(SQLite)
│  └─ coverage/              # coverage.yaml + 검사 도구
├─ app/                      # Tauri 2
│  ├─ src-tauri/             # Rust 셸 (sidecar 관리, 키체인, 업데이트)
│  └─ src/                   # React UI
│     ├─ features/{containers,images,volumes,networks,builds,compose,pods,swarm,namespaces}/
│     ├─ components/  gen/(proto 생성물)  i18n/
├─ e2e/                      # 실제 엔진 대상 통합 테스트
└─ docs/
```

UI 스택: React + TypeScript, TanStack Query(스트림 연동) / TanStack Table + Virtual, xterm.js, Monaco(YAML·Dockerfile 편집).

---

## 10. 테스트와 배포

- **어댑터 적합성 테스트**: 하나의 테스트 스위트를 세 어댑터에 동일하게 돌린다. CI 매트릭스 = {Docker 최신·이전 메이저, Podman 4·5, containerd 1.7·2.x} × {Linux}. macOS·Windows는 전송 계층(named pipe, VM 소켓)과 탐지 로직 위주로 검증.
- **UI**: 코어를 가짜 런타임(인메모리 어댑터)으로 띄워 Playwright E2E. 가짜 어댑터는 데모 모드로도 쓴다.
- **배포**: Windows(MSI, winget), macOS(유니버설 DMG, 공증, Homebrew cask), Linux(AppImage, deb, rpm, Flatpak). Flatpak은 샌드박스 때문에 소켓 접근 권한 설정이 필요하다.

---

## 11. 로드맵

| 단계 | 내용 | 완료 기준 |
|------|------|-----------|
| **M0 스파이크** (2주) | Tauri+Go sidecar 골격, proto 파이프라인, Docker 연결·컨테이너 목록·이벤트 | 세 OS에서 빌드된 앱이 컨테이너 목록을 실시간 갱신 |
| **M1 Docker 핵심** | 컨테이너/이미지/볼륨/네트워크 전체, 로그·exec·stats, run 폼, Job, CLI 미리보기 | 등급 A의 Docker 단일 호스트 명령 완료 |
| **M2 Podman** | 호환 계층 공유, Pod, kube play/generate, machine 제어, rootless | 적합성 스위트 Podman 통과 |
| **M3 빌드·Compose** | BuildKit 진행 그래프, compose 프로젝트 보기/편집/실행, 내장 터미널, 명령 팔레트 | 등급 B·C 동작, 커버리지 매트릭스 CI 가동 |
| **M4 containerd** | gRPC 조회 + nerdctl 위임, Namespace, Lima/WSL 탐지 | 적합성 스위트 containerd 통과 |
| **M5 원격·고급** | SSH/TLS 멀티 호스트, Swarm, 엔진 간 이미지 복사, 파일 브라우저 | v1.0 릴리스 |
| 이후 | CRI(CRI-O) 어댑터, 원격 에이전트, 플러그인 SDK, 이미지 취약점 스캔 연동 | — |

---

## 12. 주요 리스크

| 리스크 | 대응 |
|--------|------|
| containerd의 고수준 기능 부재 → nerdctl 의존 | Capability로 명시적 축소, nerdctl 버전 감지, 출력은 `--format json`만 파싱 |
| Podman 호환 API의 미묘한 차이 | 적합성 테스트로 차이를 고정하고 Podman 어댑터에서만 오버라이드 |
| CLI 출력 형식 변경 | 구조화 출력만 사용, CLI 버전별 골든 테스트 |
| macOS/Windows에서 VM 안의 소켓 접근 | VM 도구별 탐지 모듈 분리, 실패 시 수동 소켓 경로 입력 허용 |
| OS 웹뷰 차이(WebKitGTK 등) | 최소 지원 버전 명시, 세 OS E2E, 최신 CSS/JS 기능 사용 제한 |
| "모든 명령어" 범위의 지속적 팽창 | 3등급 체계 + 커버리지 CI로 누락을 자동 검출 |

---

## 13. 열린 질문

1. **containerd 지원 수준** — nerdctl이 없는 순수 containerd(예: Kubernetes 노드)에서 "조회 전용"으로 충분한가, 아니면 실행까지 자체 구현할 것인가? (권장: v1은 조회 전용 + nerdctl 위임)
2. **라이선스·배포 모델** — 오픈소스(Apache-2.0 권장, 의존 생태계와 동일)인지, 상용 기능 분리가 있는지.
3. **팀의 언어 역량** — Go 코어 + Rust 셸(얇음) + TS UI 조합이 부담이면 Wails(Go+TS)로 Rust를 제거하는 대안이 있다.
