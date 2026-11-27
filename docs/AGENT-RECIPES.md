# 에이전트 레시피

AI 에이전트 상자에 넣을 수 있는 에이전트는 **레시피** 파일(YAML) 하나로 정합니다. BoxForge에 들어 있는 레시피는 `internal/app/recipes/`에 있고, 내 레시피는 **에이전트 레시피 폴더**에 넣으면 목록에 바로 나옵니다(만들기 창을 다시 열면).

- 에이전트 레시피 폴더: BoxForge 설정 폴더의 `agent-recipes` (상자 폴더 `agents` 옆). 만들기 창의 에이전트 목록 아래에 실제 경로가 나옵니다. `BOXFORGE_AGENT_RECIPES`로 바꿀 수 있습니다.
- 파일 이름은 `*.yaml` 또는 `*.yml`. 들어 있는 레시피와 `id`가 같으면 그것을 대신합니다(순서는 그대로).
- 읽지 못한 파일은 만들기 창에 "읽지 못한 레시피"로 이유와 함께 나오고, 쓰이지 않습니다. 모르는 항목 이름도 오류로 봅니다(오타를 잡기 위해).

## 세 갈래

| `group` | 뜻 | 설치 |
|---|---|---|
| `ready` | 가볍고 안정적인 에이전트(Pi, Claude Code) | 이미지를 만들 때 관리자로 (`install`) |
| `hot` | 다용도 · 새로 뜨는 에이전트(OpenClaw, Hermes) | 이미지를 만들 때 **상자 사용자로, 그 홈에** (`homeInstall`) |
| `guide` | 환경을 많이 타는 에이전트(Codex, Gemini, Copilot, Cursor, Grok) | 설치하지 않음. 상자의 터미널에서 안내(`guide`)대로 |

`hot`의 홈 설치: 상자의 홈(`/home/agent`)은 볼륨이고, 상자를 처음 만들 때 이미지의 홈을 복사해 시작합니다. 그래서 에이전트가 나중에 홈에 더하는 플러그인 · 도구 · 업데이트가 남고, 상자를 다시 만들어도(이미지를 다시 빌드해도) 사라지지 않습니다. 대신 이미 있는 상자의 에이전트는 이미지를 다시 만들어도 바뀌지 않으므로, "에이전트 업데이트"는 그 에이전트의 `update` 명령을 상자 안 터미널에서 실행합니다.

## 항목

```yaml
id: hermes                 # 작은 영문자 · 숫자 · - (필수)
name: Hermes Agent         # 화면에 나오는 이름 (필수)
group: hot                 # ready | hot | guide (기본 ready)
order: 40                  # 목록 순서 (내 레시피는 기본 1000: 맨 뒤)
command: hermes            # 상자에서 에이전트를 여는 명령 (필수)
about: 한 줄 설명
docs: https://...          # 공식 안내 (설치 안내 카드에 링크)

apt: [xz-utils, ffmpeg]    # 이미지에 더할 Debian 패키지
install: RUN npm install -g some-agent        # ready: Dockerfile 줄(관리자)
homeInstall: |                                 # hot: Dockerfile 줄(상자 사용자, 홈에서)
  RUN curl -fsSL https://example.com/install.sh | bash
guide:                                         # guide: 사용자가 실행할 단계
  - title: 설치
    command: npm install -g some-agent

keys: [OPENROUTER_API_KEY]          # "API 키" 탭에 미리 나오는 설정 이름
hosts: ["@anthropic", api.example.com]   # "AI 서비스만" 네트워크에서 허용할 주소
note: 로그인하는 법 한두 줄

service: |                 # 늘 켜 둘 것, 한 줄에 하나 (하나가 꺼지면 모두 다시 켬)
  hermes dashboard --host 127.0.0.1 --port 9119 --no-open
  hermes gateway
port: 9119                 # 에이전트의 웹 화면 포트 ("웹 · 포트"에서 열기)
link: openclaw             # 화면을 여는 방법: openclaw(일회용 로그인 링크) 또는 비움(주소 그대로)
setup: hermes setup        # 처음 설정 명령 (설정이 안 됐으면 터미널이 이것부터 엶)
ready: test -s "$HOME/.agent/config"   # 설정이 끝났으면 0, 아니면 1로 끝나는 셸 검사
gate: false                # true: 늘 켜 둘 것이 설정이 끝날 때까지 기다림
doctor: hermes doctor      # 진단 명령 ("+ 이름 진단" 탭)
update: hermes update      # hot · guide: 상자 안에서 업데이트하는 명령
version: hermes --version  # 버전을 묻는 명령 (기본: command --version)

memory: 4                  # 고르면 메모리 한도를 이만큼 이상으로 (GB)
pids: 1024                 # 고르면 프로세스 한도를 이만큼 이상으로
network: full              # 고르면 네트워크를 이것으로 (ai | full | none)
```

- `hosts`의 `@anthropic` · `@openai` · `@google` · `@copilot` · `@packages`(npm · PyPI · Debian) · `@github`는 정해진 주소 묶음입니다.
- `ready`는 화면이 몇 초마다 상자 안에서 실행하므로 **가벼워야** 합니다(파일을 읽는 정도). 에이전트 명령 자체를 실행하면 메모리 · 프로세스를 많이 써서 상자가 버티지 못할 수 있습니다. 1이 아닌 실패(시간 초과 등)는 "모름"으로 보고 "설정 필요"라고 하지 않습니다. `ready: openclaw-config`는 BoxForge에 들어 있는 OpenClaw 검사입니다. `guide` 에이전트는 `ready`가 없으면 `command`가 설치됐는지로 봅니다.
- 웹 화면은 상자 안의 `127.0.0.1:port`로 열리게 두세요(밖으로 열지 않음). BoxForge가 내 PC의 127.0.0.1(웹 서버면 로그인한 브라우저만, HTTPS로)로 이어 줍니다.
- 상자 안에는 관리자 권한이 없습니다(`sudo` 없음, 권한 모두 뺌). 시스템 패키지가 필요하면 `apt`에 적으세요.

## 예: 새 에이전트 하나 더하기

```yaml
id: mybot
name: My Bot
group: hot
command: mybot
about: 새로 나온 에이전트
homeInstall: RUN npm install -g mybot@latest
keys: [OPENAI_API_KEY]
hosts: ["@openai", "@packages"]
note: mybot login 으로 로그인합니다.
setup: mybot init
ready: test -f "$HOME/.mybot/config.json"
update: npm install -g mybot@latest
network: full
```

이 파일을 에이전트 레시피 폴더에 `mybot.yaml`로 넣고 만들기 창을 다시 열면 "다용도 · 새로 뜨는 에이전트"에 "My Bot (mybot) · 내 레시피"로 나옵니다.
