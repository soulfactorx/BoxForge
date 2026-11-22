# 웹 서버로 쓰기 (boxforge-server)

창 없이 도는 BoxForge입니다. 컨테이너 엔진이 있는 기기(집 서버, NAS, 개발 PC)에서 켜 두고, 휴대폰이나 다른 PC의 웹 브라우저로 접속해 관리합니다.

> **먼저 알아 둘 것.** 여기에 로그인한 사람은 그 기기의 컨테이너 엔진을 마음대로 다룹니다. 컨테이너는 기기의 어떤 폴더든 연결할 수 있으므로, 사실상 그 기기의 관리자 권한과 같습니다. 인터넷에 그대로 내놓지 마세요.

## 시작

릴리스에서 기기에 맞는 파일을 받습니다.

| 기기 | 파일 |
|---|---|
| Linux (Intel · AMD) | `BoxForge-server-linux-amd64` |
| Linux (ARM: 라즈베리 파이 등) | `BoxForge-server-linux-arm64` |
| Windows | `BoxForge-server-windows-amd64.exe` |

```bash
chmod +x BoxForge-server-linux-amd64
```

같은 네트워크의 휴대폰에서 쓰려면:

```bash
./BoxForge-server-linux-amd64 -listen :8088 -tls
```

처음 켜면 접속 주소, **비밀번호**(한 번만 보여 줍니다), 인증서 지문이 나옵니다. 휴대폰 브라우저에서 `https://<기기 주소>:8088`을 엽니다.

- 브라우저가 "안전하지 않은 사이트"라고 경고합니다. 서버가 직접 만든 인증서라서 그렇습니다. 인증서 보기에서 SHA-256 지문이 서버가 보여 준 것과 같은지 확인한 뒤 계속하세요. 지문이 같다면 연결은 암호화되어 있고 상대는 내 서버가 맞습니다.
- Docker 엔진을 다룰 수 있는 사용자로 실행해야 합니다(Linux에서는 보통 `docker` 그룹).
- 그 기기에 Podman이나 containerd(nerdctl)가 있으면 화면의 엔진 카드에서 바꿔 쓸 수 있습니다. 엔진 종류는 [README](../README.md#쓸-수-있는-엔진) 참고.

이 기기에서만 쓸 때(브라우저도 같은 기기):

```bash
./BoxForge-server-linux-amd64
```

`http://localhost:8088`로 엽니다. 이때도 비밀번호는 묻습니다.

## 옵션

| 옵션 | 뜻 |
|---|---|
| `-listen 주소:포트` | 듣는 곳. 기본 `127.0.0.1:8088`(이 기기에서만). `:8088`은 이 기기의 모든 네트워크. |
| `-tls` | 서버가 직접 만든 인증서로 암호화합니다. 네트워크에 열 때는 필요합니다. |
| `-cert 파일 -key 파일` | 직접 만든 것 대신 가지고 있는 인증서를 씁니다(경고 없는 접속). |
| `-set-password` | 비밀번호를 직접 정합니다. |
| `-new-password` | 비밀번호를 새로 만들어 보여 줍니다(잊었을 때). |
| `-set-viewer-password` | 보기 전용 비밀번호를 정합니다(비워 두면 없앰). |
| `-insecure-network` | 암호화 없이 네트워크에 엽니다. 앞단의 프록시나 VPN이 암호화를 맡을 때만. |
| `-daemon` | 지금 바로 백그라운드에서 실행합니다(함께 준 옵션으로). 터미널을 닫아도 계속 돕니다. 출력은 `~/.config/BoxForge/server.log`. |
| `-stop` · `-status` | `-daemon`으로 실행한 서버를 끕니다 · 실행 중인지 봅니다(서비스로 설치했으면 그 상태도). |
| `-install` | 관리자 권한(sudo)으로: 서비스로 설치하고 바로 켭니다. 컴퓨터를 다시 켜도 저절로 시작합니다. 아래 "한 번에 설치". |
| `-uninstall` | 관리자 권한으로: 서비스를 끄고 지웁니다(프로그램과 비밀번호 · 설정은 남음). |
| `-user 이름` | `-install`과 함께: 서비스를 실행할 사용자(기본은 sudo를 실행한 사용자). |

환경변수 `BOXFORGE_PASSWORD`로도 비밀번호를 정할 수 있습니다(8자 이상).

## 들어 있는 보호 장치

- **비밀번호**: 로그인 없이는 화면 파일 말고 아무것도 주지 않습니다. 비밀번호는 원문이 아니라 느린 해시(PBKDF2)로 저장합니다.
- **틀린 비밀번호 제한**: 한 주소에서 5번 틀리면 1분 동안 로그인을 받지 않습니다.
- **암호화**: 암호화 없이는 네트워크에 열리지 않습니다(`-tls` 또는 명시적인 `-insecure-network`).
- **다른 사이트의 요청 차단**: 로그인한 브라우저로 다른 웹 페이지가 몰래 명령을 보내는 것을 막습니다.
- **로그인 유지**: 30일. 설정 → 웹 서버 → 로그아웃으로 끝냅니다. 서버를 다시 켜면 모든 로그인이 끝납니다.

## 그래도 권하는 것

- 집이나 회사 **안쪽 네트워크에서만** 쓰세요. 공유기에서 포트를 밖으로 열지 마세요.
- 밖에서 써야 한다면 포트를 여는 대신 **VPN**(Tailscale, WireGuard 등)으로 그 네트워크에 들어가서 쓰세요.
- 도메인이 있다면 Caddy 같은 **리버스 프록시**를 앞에 두면 정식 인증서로 경고 없이 쓸 수 있습니다. 이때 서버는 `-listen 127.0.0.1:8088`로 두고 프록시만 밖을 보게 합니다.
- 사용자 계정은 없고 비밀번호가 둘 있을 뿐입니다: 모든 것을 할 수 있는 관리용과, 보기만 하는 보기 전용.

## 보기 전용 비밀번호

```bash
./BoxForge-server-linux-amd64 -set-viewer-password
```

이 비밀번호로 로그인하면 목록 · 상태 · 로그 · 그래프를 볼 수 있고, 시작 · 중지 · 삭제 같은 바꾸는 일은 서버가 거절합니다. 터미널, 컨테이너 · 볼륨 안의 파일 보기, 내보내기 · 가져오기, Kubernetes 접속 정보도 막혀 있습니다. 서버를 다시 켜야 적용됩니다. 환경변수 `BOXFORGE_VIEWER_PASSWORD`로도 정할 수 있습니다.

주의: 보기 전용이라도 컨테이너의 설정(환경변수 값 포함)과 로그는 볼 수 있습니다. 비밀번호가 환경변수에 들어 있는 컨테이너가 있다면 믿을 수 있는 사람에게만 주세요.

## 데스크톱 앱과 다른 점

- "내 PC로 저장", "내보내기"는 **브라우저가 내려받습니다**. "가져오기"는 브라우저에서 파일을 올립니다.
- 빌드할 폴더, Compose 파일처럼 경로를 적는 칸은 **서버 쪽 경로**입니다. "찾아보기"를 누르면 서버의 폴더를 둘러보는 창이 뜹니다.
- 외부 터미널 열기, 트레이, 엔진 자동 설치는 없습니다.

## 업데이트

서버는 새 버전이 나오면 스스로 받아 둡니다(설정 → 업데이트에서 끌 수 있음). 받아 둔 뒤 설정 → 업데이트의 "다시 시작"을 누르면 서버가 같은 주소 · 같은 옵션으로 새 버전을 켭니다.

- 다시 켜지면 로그인이 풀리므로 비밀번호를 한 번 다시 넣습니다. 컨테이너는 영향받지 않습니다.
- 서버 파일이 있는 폴더에 쓸 수 있어야 합니다. `/usr/local/bin`처럼 관리자만 쓸 수 있는 곳에 두고 일반 사용자로 실행하면 받지 못합니다. 그럴 때는 파일을 직접 바꿉니다: 서버를 끄고, 릴리스에서 같은 이름의 파일을 받아 덮어쓰고(`chmod +x`), 다시 켭니다.
- 받는 파일은 릴리스의 체크섬과 맞는지 확인한 뒤에만 바꿉니다.

## 한 번에 설치 (Linux: systemd · OpenRC)

```bash
sudo ./BoxForge-server-linux-amd64 -install
```

이것 하나로:

- 프로그램을 `/opt/boxforge/boxforge-server`에 두고, 서비스를 실행할 사용자의 것으로 합니다(자동 업데이트가 파일을 바꿀 수 있게).
- 그 사용자를 `docker` 그룹에 넣습니다.
- 비밀번호(처음이면 새로 만들어 보여 줌)와 TLS 인증서를 준비하고 지문을 보여 줍니다.
- systemd가 있으면 `/etc/systemd/system/boxforge.service`, OpenRC(Alpine)면 `/etc/init.d/boxforge`를 만들어 등록하고 켭니다. 서버가 죽으면 5초 뒤 다시 켜집니다.
- 접속할 주소를 보여 줍니다.

`-listen`을 주지 않으면 모든 네트워크에 TLS로 엽니다(`-listen :8088 -tls`). 다른 주소나 인증서를 쓰려면 `-install`과 함께 주세요: `sudo ./boxforge-server -install -listen :9443 -cert c.pem -key k.pem`. 서비스를 실행할 사용자는 sudo를 실행한 사용자이고, `-user 이름`으로 바꿀 수 있습니다(root로 로그인한 Alpine이라면 root).

지우기: `sudo /opt/boxforge/boxforge-server -uninstall`

설치 없이 지금만 켜 두려면 `-daemon`을 씁니다: `./boxforge-server -daemon -listen :8088 -tls`, 끄기는 `-stop`.

아래는 손으로 등록하는 방법입니다(`-install`이 하는 일과 같음).

## 계속 켜 두기 (Linux, systemd)

```ini
# /etc/systemd/system/boxforge.service
[Unit]
Description=BoxForge server
After=docker.service

[Service]
User=내사용자
ExecStart=/usr/local/bin/boxforge-server -listen :8088 -tls
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now boxforge
```

비밀번호는 서비스로 등록하기 전에, 같은 사용자로 `boxforge-server -set-password`를 한 번 실행해 정해 두세요.

## 계속 켜 두기 (Alpine 등 OpenRC)

Alpine은 systemd 대신 OpenRC를 씁니다. 아래는 사용자 `me`, 서버 파일 `/opt/boxforge/boxforge-server`인 경우입니다. 자동 업데이트를 쓰려면 서버 파일이 있는 폴더가 그 사용자의 것이어야 합니다.

```bash
sudo mkdir -p /opt/boxforge
sudo mv boxforge-server /opt/boxforge/
sudo chown -R me:me /opt/boxforge
sudo addgroup me docker
```

`/etc/init.d/boxforge` 파일을 만듭니다.

```sh
#!/sbin/openrc-run
name="BoxForge server"
command="/opt/boxforge/boxforge-server"
command_args="-listen :8088 -tls"
command_user="me:me"
supervisor="supervise-daemon"
respawn_delay=5
output_log="/var/log/boxforge.log"
error_log="/var/log/boxforge.log"
# 비밀번호와 설정은 이 사용자의 ~/.config/BoxForge 에 있습니다.
export HOME="/home/me"

depend() {
	need net
	after docker
}

start_pre() {
	checkpath -f -o me:me /var/log/boxforge.log
}
```

```bash
sudo chmod +x /etc/init.d/boxforge
sudo rc-update add docker default
sudo rc-update add boxforge default
sudo rc-service boxforge start
```

- 상태 보기: `rc-service boxforge status`, 로그: `tail -f /var/log/boxforge.log`
- 끄기 · 다시 켜기: `rc-service boxforge stop`, `rc-service boxforge restart`
- `supervise-daemon`이 서버가 죽으면 5초 뒤 다시 켭니다. 설정 → 업데이트의 "다시 시작"은 같은 프로세스가 새 파일로 바뀌는 방식이라 그대로 동작합니다.
- 비밀번호는 등록 전에 같은 사용자로 한 번 정해 둡니다: `su me -c '/opt/boxforge/boxforge-server -set-password'`
