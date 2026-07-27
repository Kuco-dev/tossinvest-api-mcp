<div align="center">

# tossinvest-api-mcp

**토스증권 Open API를 실제로 호출하는 로컬 실행형 MCP 서버**

공식 OpenAPI 명세의 모든 operation을 읽어 MCP 도구를 자동 생성합니다.

[![CI](https://github.com/YOUR_GITHUB_ID/tossinvest-api-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_GITHUB_ID/tossinvest-api-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.10-brightgreen.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6.svg)](https://www.typescriptlang.org/)
[![MCP SDK](https://img.shields.io/badge/MCP%20SDK-1.29.0-purple.svg)](https://github.com/modelcontextprotocol/typescript-sdk)

</div>

<!--
  📌 리포지토리 생성 후 아래 두 곳의 YOUR_GITHUB_ID 를 실제 GitHub 계정명으로 바꾸세요.
     1) 위 CI 뱃지 URL 2개
     2) "설치" 섹션의 git clone URL
  그 전까지 CI 뱃지는 깨진 이미지로 표시됩니다.
-->



> [!WARNING]
> **비공식 프로젝트입니다.** 토스증권의 지원·보증·후원을 받지 않습니다.
>
> **투자 조언 도구가 아닙니다.** 투자 판단과 그 결과에 대한 모든 책임은 사용자에게 있습니다.
>
> **실제 자산에 영향을 주는 주문 API를 포함합니다.** 기본값은 비활성화 + dry-run이며, 활성화 시 발생하는 손실에 대해 프로젝트는 책임지지 않습니다.

## 주요 기능

- **OpenAPI 기반 도구 자동 생성** — 엔드포인트를 하드코딩하지 않습니다. 공식 명세에 API가 추가되면 코드 수정 없이 다음 실행 시 도구가 생깁니다.
- **실제 API 호출** — OAuth 2.0 Client Credentials 자동 발급·만료 관리·동시 발급 방지(single-flight)
- **다층 주문 안전장치** — 실주문 기본 비활성화, `dryRun` 기본 `true`, 8개 조건 충족 시에만 실행, mutation 자동 재시도 전면 금지
- **금융 데이터 정밀도 보존** — 금액·수량·가격을 문자열로 유지해 부동소수점 손실을 방지
- **보안 기본값** — 토큰 메모리 보관, 로그·오류 redaction, 공식 도메인 외 차단(SSRF 방지), path traversal·prototype pollution 방어
- **Docker 지원** — 하드닝된 멀티스테이지 이미지 + Compose 제공

현재 명세(v1.2.5) 기준 **29개 operation**(읽기 23 / mutation 6)과 **관리 도구 7개**를 제공합니다.

## 빠른 시작

```bash
pnpm install
pnpm build

cp .env.example .env    # TOSSINVEST_CLIENT_ID / SECRET 입력
pnpm inspect            # MCP Inspector로 도구 목록 확인
```

MCP 클라이언트 등록은 [MCP 클라이언트 설정](#mcp-클라이언트-설정)을, 컨테이너 실행은 [Docker로 실행](#docker로-실행)을 참고하세요.

## 공식 문서

- 개발자 문서: <https://developers.tossinvest.com/docs>
- OpenAPI JSON: <https://openapi.tossinvest.com/openapi-docs/latest/openapi.json>
- MCP TypeScript SDK: <https://github.com/modelcontextprotocol/typescript-sdk>

---

## 목차

1. [요구사항](#요구사항)
2. [설치](#설치)
3. [API 키 발급 및 설정](#api-키-발급-및-설정)
4. [허용 IP 등록](#허용-ip-등록)
5. [환경변수](#환경변수)
6. [빌드 및 실행](#빌드-및-실행)
7. [Docker로 실행](#docker로-실행)
8. [MCP 클라이언트 설정](#mcp-클라이언트-설정)
9. [제공 도구](#제공-도구)
10. [계좌 선택 방법](#계좌-선택-방법)
11. [사용 예시](#사용-예시)
12. [실주문 활성화 절차](#실주문-활성화-절차)
13. [조건주문 활성화 절차](#조건주문-활성화-절차)
14. [mutation 자동 재시도 금지 정책](#mutation-자동-재시도-금지-정책)
15. [Rate limit 처리](#rate-limit-처리)
16. [문제 해결](#문제-해결)
17. [보안 주의사항](#보안-주의사항)
18. [테스트](#테스트)
19. [OpenAPI snapshot 갱신](#openapi-snapshot-갱신)
20. [MCP SDK 버전 선택](#mcp-sdk-버전-선택)
21. [프로젝트 구조](#프로젝트-구조)
22. [기여](#기여)
23. [라이선스](#라이선스)

---

## 요구사항

| 항목 | 버전 |
| --- | --- |
| Node.js | 20.10.0 이상 (권장 22 LTS 이상) |
| pnpm | 9 이상 |
| 토스증권 계좌 | Open API 사용 신청 완료 |

## 설치

```bash
git clone https://github.com/YOUR_GITHUB_ID/tossinvest-api-mcp.git
cd tossinvest-api-mcp
pnpm install
pnpm build
```

## API 키 발급 및 설정

1. 토스증권 WTS(웹 트레이딩) 접속
2. **설정 → Open API** 메뉴 진입
3. API 사용 신청 후 `client_id`, `client_secret` 발급
4. `client_secret`은 발급 시점에만 확인 가능하므로 안전한 곳에 보관
5. 프로젝트 루트에 `.env` 생성

```bash
cp .env.example .env
```

```env
TOSSINVEST_CLIENT_ID=발급받은_client_id
TOSSINVEST_CLIENT_SECRET=발급받은_client_secret
```

> `.env`는 `.gitignore`에 등록되어 있습니다. 절대 커밋하지 마세요.

## 허용 IP 등록

토스증권 Open API는 **등록된 IP에서만 호출**할 수 있습니다.

1. WTS → **설정 → Open API → 허용 IP 관리**
2. 현재 사용 중인 **공인 IP**를 등록

등록하지 않으면 토큰 발급 단계에서 `403 access_denied` (`IP address not allowed`)를 받습니다.
이 서버는 해당 오류를 `ip-not-allowed` 코드로 정규화하고 `tossinvest_auth_status`의 `possibleIpAllowlistIssue`를 `true`로 표시합니다.

가정/사무실 회선은 공인 IP가 변경될 수 있으므로, 인증이 갑자기 실패하면 IP부터 확인하세요.

## 환경변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `TOSSINVEST_CLIENT_ID` | (없음) | OAuth client ID |
| `TOSSINVEST_CLIENT_SECRET` | (없음) | OAuth client secret |
| `TOSSINVEST_DEFAULT_ACCOUNT` | (없음) | 기본 계좌 `accountSeq` |
| `TOSSINVEST_OPENAPI_URL` | 공식 명세 URL | OpenAPI JSON 위치 |
| `TOSSINVEST_BASE_URL` | `https://openapi.tossinvest.com` | API 서버 |
| `TOSSINVEST_ALLOW_CUSTOM_BASE_URL` | `false` | 비공식 base URL 허용 여부 |
| `TOSSINVEST_OPENAPI_STRICT` | `true` | 명세 변환 실패 시 fail-closed |
| `TOSSINVEST_SPEC_CACHE_ENABLED` | `true` | `true`면 원격 명세 우선, 실패 시 snapshot |
| `TOSSINVEST_ENABLE_TRADING` | `false` | 일반 주문 mutation 실행 허용 |
| `TOSSINVEST_ENABLE_CONDITIONAL_ORDERS` | `false` | 조건주문 mutation 실행 허용 |
| `TOSSINVEST_MUTATION_CONFIRMATION` | `I_UNDERSTAND_THIS_PLACES_A_REAL_ORDER` | 실주문 확인 문자열 |
| `TOSSINVEST_TOKEN_EXPIRY_SKEW_SECONDS` | `60` | 토큰 만료 safety skew |
| `TOSSINVEST_REQUEST_TIMEOUT_MS` | `30000` | 요청 타임아웃 |
| `TOSSINVEST_MAX_READ_RETRIES` | `2` | 읽기 요청 최대 재시도 |
| `TOSSINVEST_MAX_RESPONSE_BYTES` | `8388608` | 응답 크기 상한 |
| `TOSSINVEST_LOG_LEVEL` | `info` | `silent`/`error`/`warn`/`info`/`debug` |
| `TOSSINVEST_ENABLE_RAW_REQUESTS` | `false` | raw request 도구 노출 여부 |

인증 정보가 없어도 서버는 정상 기동합니다. 명세 조회·검색·상세 조회·인증 상태 조회는 인증 없이 동작하며,
실제 API 호출 시점에만 `credentials-missing` 오류를 반환합니다.

## 빌드 및 실행

```bash
pnpm install          # 의존성 설치
pnpm dev              # 개발 모드 (tsx watch)
pnpm build            # dist/ 로 컴파일
pnpm start            # 빌드 결과 실행 (stdio)
pnpm test             # 테스트
pnpm test:coverage    # 커버리지 포함 테스트
pnpm lint             # ESLint
pnpm typecheck        # 타입 검사
pnpm openapi:update   # 공식 명세로 snapshot 갱신
pnpm openapi:verify   # snapshot 검증
pnpm inspect          # MCP Inspector 로 도구 목록 확인
```

`pnpm inspect`를 실행하면 MCP Inspector가 열리며 등록된 전체 도구 목록과 입력 스키마를 확인할 수 있습니다. (`pnpm build` 선행 필요)

## Docker로 실행

Node/pnpm을 설치하지 않고 컨테이너로 실행할 수 있습니다.

> **중요**: 이 서버는 **stdio MCP 서버**입니다. 컨테이너의 stdin/stdout이 곧 MCP 통신 채널이므로
> 반드시 `-i`(interactive) 옵션이 필요하며, `-t`(TTY)는 **주면 안 됩니다.** TTY는 JSON-RPC 프레이밍을 깨뜨립니다.
> 같은 이유로 `docker compose up`은 실사용에 적합하지 않습니다 (stdin이 MCP 클라이언트에 연결되지 않음).

### 1. 이미지 빌드

```bash
docker compose build
# 또는
docker build -t tossinvest-api-mcp:latest .
```

멀티스테이지 빌드로 최종 이미지에는 `dist/`와 **런타임 의존성 3개**(`@modelcontextprotocol/sdk`, `zod`, `dotenv`)만 포함됩니다.
`node` 사용자로 실행되며 root 권한을 사용하지 않습니다.

### 2. 환경변수 설정

인증 정보는 **이미지에 굽지 않고** 실행 시점에 주입합니다. `.dockerignore`가 `.env`를 빌드 컨텍스트에서 제외합니다.

```bash
cp .env.example .env   # 값 입력
```

### 3. 실행

```bash
# 대화형 실행 (직접 JSON-RPC를 보내 확인할 때)
docker compose run --rm tossinvest-mcp

# 컨테이너 안의 도구 목록을 Inspector로 확인
docker compose --profile tools run --rm --service-ports inspector
# → http://127.0.0.1:6274 접속
```

package.json 단축 스크립트도 제공합니다.

```bash
pnpm docker:build
pnpm docker:run
pnpm docker:inspect
```

### 4. MCP 클라이언트에 Docker로 등록

MCP 클라이언트는 컨테이너를 직접 띄워야 하므로 `docker compose`가 아니라 `docker run -i`를 사용합니다.

**Claude Desktop / Cursor (Linux · macOS)**

```json
{
  "mcpServers": {
    "tossinvest": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "/absolute/path/tossinvest-api-mcp/.env",
        "tossinvest-api-mcp:latest"
      ]
    }
  }
}
```

**Windows**

```json
{
  "mcpServers": {
    "tossinvest": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "--env-file", "C:/absolute/path/tossinvest-api-mcp/.env",
        "tossinvest-api-mcp:latest"
      ]
    }
  }
}
```

`--env-file` 대신 개별 주입도 가능합니다.

```json
"args": [
  "run", "--rm", "-i",
  "-e", "TOSSINVEST_CLIENT_ID",
  "-e", "TOSSINVEST_CLIENT_SECRET",
  "-e", "TOSSINVEST_DEFAULT_ACCOUNT",
  "tossinvest-api-mcp:latest"
]
```

> `-e KEY`(값 없이)는 호스트의 동일 이름 환경변수를 전달합니다. 설정 파일에 secret을 적지 않아도 됩니다.

### 컨테이너 보안 설정

`docker-compose.yml`에는 다음 하드닝이 적용되어 있습니다.

| 설정 | 이유 |
| --- | --- |
| `user: node` | root 실행 금지 |
| `read_only: true` | 서버는 파일 쓰기가 없음 (토큰은 메모리 보관) |
| `tmpfs: /tmp`, `HOME=/tmp` | 읽기 전용 루트에서 필요한 최소 쓰기 공간만 허용 |
| `cap_drop: ALL` | 모든 리눅스 capability 제거 |
| `no-new-privileges:true` | 권한 상승 차단 |
| `mem_limit`, `pids_limit` | 자원 남용 방지 |
| `stdin_open: true`, `tty: false` | stdio MCP 채널 보장 |
| `tini` (ENTRYPOINT) | SIGTERM 전달 → graceful shutdown |
| 실주문 env 기본 `false` | Dockerfile ENV에서도 안전 기본값 강제 |

Inspector 서비스는 `npx`로 패키지를 내려받아야 해서 `read_only: false`이며, 포트는 `127.0.0.1`에만 게시되어 외부에 노출되지 않습니다.

### 오프라인 동작

이미지에는 OpenAPI snapshot이 포함되어 있어, 원격 명세를 받지 못해도 서버가 기동됩니다.

```bash
# 원격 명세 조회를 끄고 snapshot만 사용
docker run --rm -i -e TOSSINVEST_SPEC_CACHE_ENABLED=false tossinvest-api-mcp:latest
```

다만 **실제 API 호출에는 인터넷 연결과 허용 IP 등록이 필요**합니다.
컨테이너의 아웃바운드 IP가 호스트 공인 IP와 다를 수 있으니(NAT/VPN 환경) 인증 실패 시 IP를 먼저 확인하세요.

## MCP 클라이언트 설정

빌드 후 `dist/index.js`의 **절대 경로**를 사용합니다.

### Claude Desktop

설정 파일 위치
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

**Windows**

```json
{
  "mcpServers": {
    "tossinvest": {
      "command": "node",
      "args": ["C:/absolute/path/tossinvest-api-mcp/dist/index.js"],
      "env": {
        "TOSSINVEST_CLIENT_ID": "사용자 값",
        "TOSSINVEST_CLIENT_SECRET": "사용자 값",
        "TOSSINVEST_DEFAULT_ACCOUNT": "사용자 값",
        "TOSSINVEST_ENABLE_TRADING": "false"
      }
    }
  }
}
```

**Linux / macOS**

```json
{
  "mcpServers": {
    "tossinvest": {
      "command": "node",
      "args": ["/absolute/path/tossinvest-api-mcp/dist/index.js"],
      "env": {
        "TOSSINVEST_CLIENT_ID": "사용자 값",
        "TOSSINVEST_CLIENT_SECRET": "사용자 값",
        "TOSSINVEST_DEFAULT_ACCOUNT": "사용자 값",
        "TOSSINVEST_ENABLE_TRADING": "false"
      }
    }
  }
}
```

### Claude Code

```bash
# Linux / macOS
claude mcp add tossinvest \
  --env TOSSINVEST_CLIENT_ID=사용자값 \
  --env TOSSINVEST_CLIENT_SECRET=사용자값 \
  --env TOSSINVEST_DEFAULT_ACCOUNT=사용자값 \
  -- node /absolute/path/tossinvest-api-mcp/dist/index.js
```

```powershell
# Windows PowerShell
claude mcp add tossinvest `
  --env TOSSINVEST_CLIENT_ID=사용자값 `
  --env TOSSINVEST_CLIENT_SECRET=사용자값 `
  --env TOSSINVEST_DEFAULT_ACCOUNT=사용자값 `
  -- node C:/absolute/path/tossinvest-api-mcp/dist/index.js
```

또는 프로젝트 루트 `.mcp.json`:

```json
{
  "mcpServers": {
    "tossinvest": {
      "command": "node",
      "args": ["/absolute/path/tossinvest-api-mcp/dist/index.js"],
      "env": {
        "TOSSINVEST_CLIENT_ID": "사용자 값",
        "TOSSINVEST_CLIENT_SECRET": "사용자 값"
      }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` 또는 프로젝트의 `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "tossinvest": {
      "command": "node",
      "args": ["C:/absolute/path/tossinvest-api-mcp/dist/index.js"],
      "env": {
        "TOSSINVEST_CLIENT_ID": "사용자 값",
        "TOSSINVEST_CLIENT_SECRET": "사용자 값",
        "TOSSINVEST_DEFAULT_ACCOUNT": "사용자 값"
      }
    }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.tossinvest]
command = "node"
args = ["/absolute/path/tossinvest-api-mcp/dist/index.js"]

[mcp_servers.tossinvest.env]
TOSSINVEST_CLIENT_ID = "사용자 값"
TOSSINVEST_CLIENT_SECRET = "사용자 값"
TOSSINVEST_DEFAULT_ACCOUNT = "사용자 값"
TOSSINVEST_ENABLE_TRADING = "false"
```

Windows에서는 `args`를 `["C:/absolute/path/tossinvest-api-mcp/dist/index.js"]`로 지정합니다.

### 일반 MCP stdio 클라이언트

```
command: node
args:    <절대경로>/dist/index.js
transport: stdio
env:     TOSSINVEST_CLIENT_ID, TOSSINVEST_CLIENT_SECRET, ...
```

stdout은 JSON-RPC 전용이며 모든 로그는 stderr로만 출력됩니다.

## 제공 도구

### 관리용 wrapper 도구

| 도구 | 설명 |
| --- | --- |
| `tossinvest_api_overview` | OpenAPI 버전, 문서 버전, 서버 URL, tag, operation 수, 읽기/mutation 수, 실주문 활성화 상태, snapshot/원격 사용 여부 |
| `tossinvest_list_operations` | `tag`/`method`/`path`/`readOnly`/`destructive`/`keyword` 필터로 operation 목록 조회 |
| `tossinvest_search_operations` | operationId·summary·description·path·tag 검색 |
| `tossinvest_get_operation` | 특정 operation 상세 (필수/선택 입력, requestBody, 응답 스키마, 계좌 헤더 필요 여부, mutation 여부, rate limit 그룹, MCP 도구 이름) |
| `tossinvest_call_operation` | operationId 기반 호출 wrapper (mutation guard 동일 적용) |
| `tossinvest_auth_status` | 인증 설정·토큰 준비 상태 (secret/token 미노출) |
| `tossinvest_refresh_auth` | 토큰 명시적 갱신 (`{ ok, expiresIn, expiresAt }`만 반환) |
| `tossinvest_raw_request` | `TOSSINVEST_ENABLE_RAW_REQUESTS=true`일 때만 노출. 공식 명세에 정의된 method+path만 허용 |

### OpenAPI 기반 직접 도구 자동 생성

서버는 시작 시 공식 OpenAPI 명세를 로드하여 **모든 operation을 MCP 도구로 자동 등록**합니다.
엔드포인트 목록을 코드에 하드코딩하지 않으므로, 공식 명세에 새 API가 추가되면 **서버 코드 수정 없이** 다음 시작 시 자동으로 도구가 생깁니다.

- 도구 이름 = OpenAPI `operationId` (MCP 규칙에 맞게 정규화, 충돌 시 서버 시작 실패)
- 설명 = `summary` + `description` + method/path + tag 조합
- 입력 스키마 = parameters와 requestBody에서 생성
- annotation = `readOnlyHint` / `destructiveHint` / `idempotentHint` / `openWorldHint`

입력 형식:

```json
{
  "path": {},
  "query": {},
  "body": {},
  "account": "1",
  "dryRun": true,
  "confirmation": ""
}
```

해당 operation에 필요 없는 필드는 스키마에서 제거됩니다. 예를 들어 `getAccounts`는 입력이 없고,
`getPrices`에는 `account`/`dryRun`/`confirmation`이 없습니다. 임의 헤더 입력은 허용되지 않습니다.

현재 명세(문서 버전 1.2.5) 기준으로 등록되는 도구:

| 분류 | 개수 |
| --- | --- |
| 전체 operation | 29 |
| 읽기 전용 | 23 |
| mutation (주문 3 + 조건주문 3) | 6 |
| 제외 | 1 (`issueOAuth2Token`) |

`issueOAuth2Token`(`POST /oauth2/token`)은 client secret과 access token이 MCP 경계를 넘지 않도록 **의도적으로 도구 등록에서 제외**하고, 서버 내부 인증 계층이 전담합니다. 대신 `tossinvest_auth_status` / `tossinvest_refresh_auth`를 사용하세요.

## 계좌 선택 방법

계좌가 필요한 API는 다음 순서로 계좌를 결정합니다.

1. 도구 입력의 `account`
2. `TOSSINVEST_DEFAULT_ACCOUNT`
3. 둘 다 없으면 **호출하지 않고** 오류 반환

임의로 첫 번째 계좌를 자동 선택하지 않습니다. 먼저 계좌 목록을 조회하세요.

```
getAccounts 도구를 호출해 accountSeq를 확인해줘
```

확인한 `accountSeq`를 `account`에 전달하거나 `.env`에 넣습니다.

```env
TOSSINVEST_DEFAULT_ACCOUNT=1
```

## 사용 예시

### 시세 조회

```
삼성전자와 애플 현재가를 알려줘
```

내부적으로 `getPrices`가 호출됩니다.

```json
{
  "name": "getPrices",
  "arguments": { "query": { "symbols": "005930,AAPL" } }
}
```

응답:

```json
{
  "ok": true,
  "operationId": "getPrices",
  "httpStatus": 200,
  "requestId": "01HXYZ...",
  "rateLimit": { "limit": 10, "remaining": 9, "resetSeconds": 1 },
  "result": [ { "symbol": "005930", "close": "70000" } ]
}
```

호가, 체결, 캔들도 같은 방식입니다.

```json
{ "name": "getOrderbook", "arguments": { "query": { "symbol": "005930" } } }
{ "name": "getTrades",    "arguments": { "query": { "symbol": "005930", "count": 20 } } }
{ "name": "getCandles",   "arguments": { "query": { "symbol": "005930", "interval": "1d", "count": 30 } } }
```

### 계좌 조회

```json
{ "name": "getAccounts",  "arguments": {} }
{ "name": "getHoldings",  "arguments": { "account": "1" } }
{ "name": "getBuyingPower", "arguments": { "account": "1", "query": { "currency": "KRW" } } }
{ "name": "getSellableQuantity", "arguments": { "account": "1", "query": { "symbol": "005930" } } }
{ "name": "getCommissions", "arguments": { "account": "1" } }
```

### 주문 조회

```json
{ "name": "getOrders", "arguments": { "account": "1", "query": { "symbol": "005930", "limit": 20 } } }
{ "name": "getOrder",  "arguments": { "account": "1", "path": { "orderId": "0d5QIH..." } } }
{ "name": "getConditionalOrders", "arguments": { "account": "1" } }
```

### dry-run 주문 (기본 동작)

```json
{
  "name": "createOrder",
  "arguments": {
    "account": "1",
    "body": {
      "symbol": "005930",
      "side": "BUY",
      "orderType": "LIMIT",
      "quantity": "10",
      "price": "70000"
    }
  }
}
```

`dryRun`을 생략하면 **기본값 true**이므로 토스증권 서버로 **어떤 네트워크 요청도 보내지 않고** 실행 계획만 반환합니다.

```json
{
  "ok": true,
  "dryRun": true,
  "operationId": "createOrder",
  "executed": false,
  "summary": {
    "operationId": "createOrder",
    "method": "POST",
    "path": "/api/v1/orders",
    "mutationType": "일반 주문 mutation (실제 자산 영향)",
    "account": "*",
    "symbol": "005930",
    "side": "BUY",
    "orderType": "LIMIT",
    "quantity": "10",
    "price": "70000"
  },
  "missingRequiredFields": [],
  "blockers": [
    "실주문이 비활성화되어 있습니다 (TOSSINVEST_ENABLE_TRADING=false).",
    "dryRun=true 이므로 네트워크 요청을 보내지 않습니다.",
    "confirmation 문자열이 비어 있습니다."
  ],
  "requirementsToExecute": [
    "TOSSINVEST_ENABLE_TRADING=true",
    "도구 입력에 dryRun=false 를 명시",
    "confirmation 에 TOSSINVEST_MUTATION_CONFIRMATION 과 동일한 값을 전달"
  ],
  "note": "실제 주문은 전송되지 않았습니다. ..."
}
```

> 가격·수량·금액은 **문자열**로 전달하세요. 부동소수점 변환으로 인한 정밀도 손실을 막기 위해 서버는 이 값을 문자열 그대로 유지합니다.

## 실주문 활성화 절차

실제 주문은 아래 **8가지 조건이 모두** 충족될 때만 실행됩니다. 하나라도 어긋나면 네트워크 요청 자체를 보내지 않습니다.

1. `TOSSINVEST_ENABLE_TRADING=true`
2. 도구 입력 `dryRun=false`
3. `confirmation`이 `TOSSINVEST_MUTATION_CONFIRMATION`과 정확히 일치
4. 인증 정보(`CLIENT_ID`/`CLIENT_SECRET`) 정상
5. 계좌 명시(`account` 또는 `TOSSINVEST_DEFAULT_ACCOUNT`)
6. OpenAPI 스키마 필수값 충족
7. 요청 대상이 공식 API 서버
8. mutation 종류가 명확히 분류됨

절차:

```env
# 1) .env 수정
TOSSINVEST_ENABLE_TRADING=true
TOSSINVEST_MUTATION_CONFIRMATION=I_UNDERSTAND_THIS_PLACES_A_REAL_ORDER
TOSSINVEST_DEFAULT_ACCOUNT=1
```

```bash
# 2) MCP 클라이언트 재시작 (env 반영)
```

```json
// 3) 반드시 먼저 dry-run 으로 내용 확인 후, 실제 실행
{
  "name": "createOrder",
  "arguments": {
    "account": "1",
    "body": {
      "symbol": "005930",
      "side": "BUY",
      "orderType": "LIMIT",
      "quantity": "10",
      "price": "70000",
      "clientOrderId": "my-order-001"
    },
    "dryRun": false,
    "confirmation": "I_UNDERSTAND_THIS_PLACES_A_REAL_ORDER"
  }
}
```

`clientOrderId`는 토스증권의 멱등성 키(10분 유효)입니다. 중복 주문 위험을 줄이려면 지정을 권장합니다.

## 조건주문 활성화 절차

조건주문은 위 조건에 더해 별도 플래그가 필요합니다.

```env
TOSSINVEST_ENABLE_TRADING=true
TOSSINVEST_ENABLE_CONDITIONAL_ORDERS=true
```

`TOSSINVEST_ENABLE_TRADING`만 켜고 조건주문을 실행하면 차단됩니다.

## mutation 자동 재시도 금지 정책

다음 operation은 **어떤 경우에도 자동 재시도하지 않습니다.**

- `createOrder`, `modifyOrder`, `cancelOrder`
- `createConditionalOrder`, `modifyConditionalOrder`, `cancelConditionalOrder`
- 향후 명세에 추가되는 주문 관련 mutation

timeout, connection reset, 500/502/503처럼 **결과가 불확실한** 경우에도 재시도하지 않습니다.
주문이 이미 접수되었을 수 있기 때문입니다. 대신 다음을 반환합니다.

```json
{
  "ok": false,
  "operationId": "createOrder",
  "httpStatus": 503,
  "error": {
    "code": "mutation-result-unknown",
    "message": "createOrder 요청의 결과가 불확실합니다. 자동 재시도하지 않았습니다. ...",
    "requestId": "01HXYZ...",
    "retryable": false,
    "details": {
      "originalErrorCode": "upstream-error",
      "clientOrderId": "my-order-001",
      "account": "*",
      "nextStep": "주문내역 조회 API 로 접수 여부를 확인하세요."
    }
  }
}
```

이 경우 **재요청하기 전에 반드시** `getOrders` / `getOrder`(조건주문은 `getConditionalOrders`)로 접수 여부를 확인하세요.

또한 401 자동 갱신도 mutation에는 적용되지 않습니다. 읽기 전용 GET 요청만 토큰을 1회 갱신하고 1회 재시도합니다.

## Rate limit 처리

응답 헤더 `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`, `Retry-After`를 파싱해
성공 응답의 `rateLimit` 필드로 반환합니다.

```json
"rateLimit": { "limit": 10, "remaining": 9, "resetSeconds": 1 }
```

재시도 정책:

- GET 등 명확한 읽기 전용 요청만 재시도
- mutation 재시도 금지
- `Retry-After`가 있으면 우선 사용 (30초 초과 시 재시도하지 않음)
- 없으면 exponential backoff + jitter
- 최대 횟수는 `TOSSINVEST_MAX_READ_RETRIES` (기본 2)
- 인증 실패·입력 오류·권한 오류는 재시도하지 않음
- 타임아웃은 `AbortController`로 구현 (`TOSSINVEST_REQUEST_TIMEOUT_MS`)

## 문제 해결

| 증상 | 원인 / 해결 |
| --- | --- |
| `credentials-missing` | `TOSSINVEST_CLIENT_ID` / `TOSSINVEST_CLIENT_SECRET` 미설정. MCP 클라이언트 `env`에 넣었는지 확인 후 클라이언트 재시작 |
| `auth-failed` (`invalid_client`) | client ID/secret 오타 또는 클라이언트 비활성. 자동 재시도하지 않으므로 값을 직접 확인 |
| `ip-not-allowed` | WTS → 설정 → Open API → 허용 IP 관리에 현재 공인 IP 등록 |
| `account-header-required` | `account` 인자 또는 `TOSSINVEST_DEFAULT_ACCOUNT` 설정. `getAccounts`로 `accountSeq` 확인 |
| `rate-limit-exceeded` | 호출 빈도 조절. 응답의 `retryAfterSeconds` 참고 |
| `trading-disabled` | 실주문 8조건 미충족. 응답의 `details.requirementsToExecute` 확인 |
| `mutation-blocked` | 명세 변경으로 mutation 분류 불가. `src/config/constants.ts`의 정책 테이블 갱신 필요 |
| `mutation-result-unknown` | 주문 결과 불확실. `getOrders`로 확인 후 판단 |
| `openapi-load-failed` | 네트워크 문제. `pnpm openapi:update`로 snapshot 갱신 |
| 도구 목록이 안 보임 | `pnpm build` 후 절대 경로 확인. `pnpm inspect`로 직접 점검 |
| 클라이언트가 JSON 파싱 오류 | stdout 오염. 이 서버는 stdout에 JSON-RPC만 출력하므로, 다른 래퍼 스크립트가 출력하는지 확인 |
| Docker에서 즉시 종료됨 | `-i` 옵션 누락. stdin이 닫히면 stdio 서버는 종료됩니다 |
| Docker에서 JSON-RPC 깨짐 | `-t`(TTY)를 준 경우. `docker run --rm -i`만 사용하세요 |
| Docker에서 `credentials-missing` | `--env-file` 경로가 절대 경로인지, `.env`에 값이 들어있는지 확인 |
| Docker에서 `ip-not-allowed` | 컨테이너 아웃바운드 IP가 호스트와 다를 수 있음. 허용 IP 재확인 |
| `docker compose up`에서 동작 안 함 | 정상입니다. stdio 서버이므로 `docker compose run --rm` 또는 MCP 클라이언트에서 `docker run -i`로 실행하세요 |

로그 레벨을 높이면 stderr에서 더 자세한 정보를 볼 수 있습니다. 비밀값은 debug 모드에서도 redaction됩니다.

```env
TOSSINVEST_LOG_LEVEL=debug
```

## 보안 주의사항

- `.env`와 인증 파일은 `.gitignore` 처리되어 있습니다. 절대 커밋하지 마세요.
- access token은 **메모리에만** 보관하며 파일·DB·로그·MCP 응답에 저장하거나 출력하지 않습니다.
- client secret과 Authorization 헤더는 로그와 오류 객체에서 redaction됩니다.
- 계좌 식별값은 로그·dry-run 요약에서 마스킹됩니다.
- 사용자는 `Authorization`, `Cookie`, `Host`, `Content-Length`, `Proxy-Authorization`, `X-Tossinvest-Account` 헤더를 직접 지정할 수 없습니다.
- 기본적으로 공식 도메인(`openapi.tossinvest.com`)만 호출할 수 있습니다 (SSRF 방지).
- 공식 OpenAPI에 정의되지 않은 path는 호출할 수 없습니다.
- path traversal, prototype pollution, 과대 응답, JSON 파싱 오류를 방어합니다.
- 실주문은 기본 비활성화이며 dry-run이 기본값입니다.

자세한 내용은 [SECURITY.md](./SECURITY.md)를 참고하세요.

## 테스트

```bash
pnpm test
pnpm test:coverage
```

모든 테스트는 HTTP mock을 사용하며 실제 토스증권 API를 호출하지 않습니다.
**실제 주문 API를 호출하는 테스트는 존재하지 않습니다.**

테스트 범위:

- OpenAPI: snapshot 파싱, operationId 인덱싱/중복 검출, `$ref` 해석, 순환 참조, requestBody/parameter 변환, required·enum·oneOf/anyOf/allOf·nullable 처리, 도구 이름 충돌, 신규 operation 자동 등록
- 인증: 인증 정보 누락, 최초 발급, 캐시, safety skew, single-flight 동시 발급 방지, 401 처리, secret redaction
- 계좌: 명시 account, 기본 account, 누락 시 차단, 필요한 API에만 헤더 추가, 마스킹
- 요청: path 인코딩, query 직렬화, 다중 symbol, JSON/form body, timeout, 429, `Retry-After`, 4xx/5xx 정규화, requestId 추출, decimal 정밀도 유지
- 주문 안전성: 기본 비활성, dryRun 기본 true, dry-run 무통신, confirmation 검증, 조건주문 별도 플래그, mutation 무재시도, wrapper·raw로 우회 불가
- MCP: initialize, tools/list, 관리 도구, 직접 도구, 오류 응답, **stdout 무오염**, stderr 로그, graceful shutdown

## OpenAPI snapshot 갱신

원격 명세를 우선 사용하지만, 네트워크 장애 시 번들 snapshot으로 폴백합니다.

```bash
pnpm openapi:update   # 공식 JSON 다운로드 → src/openapi/openapi.snapshot.json 갱신
pnpm openapi:verify   # operation 수, operationId 중복, 스키마 변환 가능 여부 검증
```

`openapi:verify` 출력 예:

```
[openapi:verify] 검증 성공
  OpenAPI 버전      : 3.1.0
  API 문서 버전     : 1.2.5
  API 서버          : https://openapi.tossinvest.com
  path 수           : 27
  등록 operation    : 29
  읽기 전용         : 23
  mutation          : 6
  분류 불가 mutation: 0
  제외 operation    : 1
```

## MCP SDK 버전 선택

- 선택 버전: **`@modelcontextprotocol/sdk` 1.29.0** (`package.json`에 정확한 버전으로 고정)
- 선택 이유:
  - 구현 시점 기준 npm `latest` 태그가 가리키는 **안정(stable) 릴리스**입니다. beta/rc 태그를 사용하지 않았습니다.
  - 저수준 `Server` + `StdioServerTransport` + `setRequestHandler` API는 안정 API이며 deprecated되지 않았습니다.
  - `structuredContent`가 안정 버전에서 지원되므로, 사람이 읽는 text와 기계가 처리하는 구조화 결과를 함께 반환합니다.
  - `experimental/*` 경로의 API는 사용하지 않았습니다.

## 프로젝트 구조

```text
tossinvest-api-mcp/
├─ src/
│  ├─ index.ts                  # stdio 진입점, 시그널 처리
│  ├─ server.ts                 # MCP 서버 구성, 도구 등록
│  ├─ config/                   # 환경변수 검증(Zod), 상수·정책 테이블
│  ├─ auth/                     # OAuth 토큰 관리, 인증 오류
│  ├─ openapi/                  # 명세 로더·$ref 해석·스키마 변환·도구 생성
│  │  └─ openapi.snapshot.json  # 오프라인 폴백용 번들 명세
│  ├─ client/                   # 요청 조립, 응답 파싱, 재시도, rate limit
│  ├─ tools/                    # mutation 분류·guard, operation/관리 도구
│  ├─ security/                 # redaction, URL 정책, 민감 필드 정의
│  ├─ errors/                   # AppError, 오류 정규화
│  └─ utils/                    # logger(stderr), single-flight, JSON
├─ tests/                       # Vitest (실제 API 호출 없음)
├─ scripts/                     # snapshot 갱신·검증, 빌드 자산 복사
├─ Dockerfile
└─ docker-compose.yml
```

## 기여

이슈와 PR을 환영합니다. [CONTRIBUTING.md](./CONTRIBUTING.md)를 먼저 읽어주세요.

PR 전 아래가 모두 통과해야 합니다.

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm openapi:verify
```

> **실제 주문 API를 호출하는 코드나 테스트는 절대 추가하지 마세요.**
> 보안 취약점은 공개 이슈 대신 [SECURITY.md](./SECURITY.md)의 절차를 따라주세요.

## 라이선스

[MIT](./LICENSE)

이 프로젝트는 토스증권과 무관한 비공식 프로젝트이며, 금융·투자 조언 소프트웨어가 아닙니다.
사용에 따른 모든 책임은 사용자에게 있습니다.
