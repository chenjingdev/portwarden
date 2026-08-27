# PortWarden

로컬 개발 서버의 TCP LISTEN 포트와 남겨진 브라우저 자동화 프로세스를 한 화면에서 정리하는 CLI/TUI입니다.

`portwarden`을 터미널에서 실행하면 인터랙티브 화면이 열립니다. 파이프나 CI에서는 자동으로 일반 텍스트를 출력하고, JSON·watch·안전한 종료 명령도 제공합니다.

## 요구 사항

- Node.js 20.5 이상
- macOS 또는 Linux
- `lsof` 명령

Windows는 현재 지원하지 않습니다.

## 설치

```bash
npm install --global portwarden
```

설치 없이 한 번 실행할 수도 있습니다.

```bash
npx portwarden
```

## 빠른 사용법

```bash
# 터미널에서는 TUI, 파이프에서는 표 출력
portwarden

# 모든 LISTEN 포트
portwarden --all --plain

# 자동화에 쓰기 좋은 JSON
portwarden --all --zombies --json

# 5173 다음의 실제 빈 포트
portwarden --next-port 5173

# 2초마다 갱신
portwarden --all --watch 2
```

`--json --watch` 조합은 각 스냅샷을 한 줄에 하나씩 쓰는 NDJSON 스트림입니다.

기본 화면은 핀한 포트와 개발 서버로 판단된 포트만 보여줍니다. `a`를 누르면 시스템·앱 포트를 포함한 전체 보기로 전환됩니다. Electron 앱이나 에이전트처럼 여러 리스너를 가진 프로세스는 앱 단위로 묶입니다.

## TUI 키

| 키 | 동작 |
| --- | --- |
| `↑` / `↓` | 선택 이동 |
| `←` / `→` | 같은 구역 안에서 순서 변경, 앱 그룹 접기/펼치기 |
| `enter` | 앱 그룹 접기/펼치기, 확인 창 승인 |
| `a` | 개발 포트 / 전체 LISTEN 포트 전환 |
| `z` | 자동화 좀비를 기존 목록 아래에 표시/숨김 |
| `p` | 선택한 리스너 하나만 핀/해제 |
| `o` | 브라우저로 열기 |
| `m` | 검증된 다음 빈 포트로 이동 |
| `x` / `f` | `SIGTERM` / `SIGKILL`로 종료 |
| `g` | 무덤(Graveyard) 열기 |
| `s` | 브라우저·확인 모드·갱신 주기 설정 |
| `/` | 필터 |
| `r` | 즉시 새로고침 |
| `?` | 도움말 |
| `q` | 종료 |

한글 두벌식 입력 상태에서는 같은 물리 키 위치의 단축키도 인식합니다. 메인 목록에는 `j`/`k` 별칭을 두지 않아 검색 입력과 키 동작이 섞이지 않습니다.

## 안전 장치

PortWarden은 PID만 믿고 프로세스를 종료하지 않습니다.

- 종료 직전에 PID, 소유 사용자, 실행 파일, 시작 시각, 포트, cwd, 명령을 다시 확인합니다.
- 핀한 리스너는 `x`, `f`, `--kill-*`로 종료할 수 없습니다. 같은 PID가 여러 포트를 열었다면 그중 하나만 핀돼 있어도 PID 전체를 보호합니다.
- `m`은 새 프로세스를 셸 없이 실행하고, 새 포트·cwd·명령이 모두 일치한 뒤에만 기존 프로세스를 내립니다. 검증 실패 시 새 프로세스를 롤백합니다.
- 종료된 개발 서버는 실제로 포트가 닫힌 뒤에만 무덤에 저장됩니다.
- 토큰·비밀번호 같은 민감한 인수가 포함된 명령은 무덤에 저장하거나 재실행하지 않습니다.
- 잘못된 설정 파일은 조용히 덮어쓰지 않고 오류를 냅니다. 설정은 원자적으로 저장되며 파일 권한은 `0600`입니다.

기본 설정은 확인 창 없이 바로 동작합니다. 실수를 줄이고 싶다면 `s` 화면에서 **Confirm actions**를 켜세요.

## 포트 이동과 무덤

`m`은 확인된 개발 서버 명령의 포트 표현만 안전하게 바꿉니다. 예: `--port 3000`, `--port=3000`, `PORT=3000`, `python -m http.server 3000`, Next.js의 `-p 3000`. 다른 프로그램에서 의미가 달라질 수 있는 `-p`나 단순히 인수에 `vite`라는 단어가 들어간 명령은 추측해서 바꾸지 않습니다. 명령을 안전하게 해석하거나 포트를 바꿀 수 없으면 원본 프로세스를 그대로 두고 중단합니다.

`x` 또는 `f`로 종료한 재실행 가능한 개발 서버는 무덤에 저장됩니다.

- `g` → `r`: 원래 cwd와 인수로 detached 재실행
- `g` → `d`: 저장된 재실행 정보만 삭제
- 로그: `~/.portwarden/logs/<project>-<port>.log`

재실행한 서버가 예상 포트와 명령으로 실제 LISTEN 상태가 되어야 무덤 기록이 제거됩니다.

## 브라우저 자동화 좀비

`z` 또는 `--zombies`는 현재 사용자 소유의 Playwright, Puppeteer, headless Chrome 계열 고아 프로세스를 찾습니다. 일반 Chrome, 살아 있는 컨트롤러의 하위 프로세스, 리스너, 서버 모드, 포트 인수를 가진 프로세스는 제외합니다.

```bash
# 후보 확인
portwarden --zombies --plain

# 60초 이상 된 안전한 후보만 미리보기
portwarden --reap --dry-run

# 종료 직전에 실행 파일·명령·시작 시각을 다시 검증하고 SIGTERM
portwarden --reap

# 같은 검증 후 SIGKILL
portwarden --reap --force
```

프로세스나 `lsof` 정보를 확실히 읽지 못하면 자동 정리는 실패-닫힘(fail closed)으로 중단됩니다.

## CLI 옵션

```text
-a, --all                 모든 TCP LISTEN 포트
-j, --json                JSON 출력 (`--watch`와 함께 쓰면 NDJSON)
    --plain               일반 표 출력
-t, --tui                 TUI 강제 실행
-z, --zombies             자동화 좀비 포함
    --reap                안전 판정된 좀비 종료
    --dry-run             --reap 미리보기
-f, --force               종료 명령에서 SIGKILL 사용
-w, --watch [seconds]     일반/JSON 출력을 반복 갱신 (기본 2초)
-b, --browser <name>      이번 TUI에서 사용할 브라우저
    --next-port <port>    다음 빈 포트 출력
    --kill-port <port>    현재 LISTEN 프로세스 종료
    --kill-pid <pid>      현재 리스너 또는 감지된 좀비 PID 종료
```

숫자 옵션은 전체 문자열을 엄격하게 검사하므로 `3000abc` 같은 값은 거부합니다. 여러 종료 작업을 한 번에 섞는 것도 허용하지 않습니다.

## 설정과 이전 버전 마이그레이션

- macOS: `~/Library/Application Support/portwarden/config.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/portwarden/config.json`

이전 `dev-port-watch` 설정과 `revivablePins` 무덤 기록은 처음 실행할 때 가능한 항목만 새 형식으로 옮깁니다. 설정 파일에는 비밀 값이 포함된 재실행 명령을 저장하지 않습니다.

## 개발

```bash
git clone https://github.com/chenjingdev/portwarden.git
cd portwarden
corepack enable
pnpm install
pnpm check
pnpm dev
```

PortWarden 1.0은 TypeScript, Ink/React, Commander, Execa, Conf, Zod를 사용합니다. 직접 만든 ANSI 화면·인자 파서·설정 저장 구현은 제거했고, PortWarden 고유의 프로세스 판별과 안전 검증에 코드를 집중했습니다.

## 라이선스

[MIT](LICENSE)
