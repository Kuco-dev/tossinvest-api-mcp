# 보안 정책

이 문서는 `tossinvest-api-mcp`의 보안 설계와 사용자가 지켜야 할 수칙을 설명합니다.
이 프로젝트는 **실제 금융 자산에 영향을 줄 수 있는 API**를 다룹니다. 반드시 끝까지 읽어주세요.

## 1. 인증정보 보관 원칙

- `client_id`와 `client_secret`은 **환경변수 또는 `.env`로만** 주입합니다.
- `.env`, `*.pem`, `*.key`, `credentials.json` 등은 `.gitignore`에 등록되어 있습니다.
- 소스 코드, 테스트 픽스처, 로그, 문서 어디에도 실제 키를 넣지 마세요.
- MCP 클라이언트 설정 파일(`claude_desktop_config.json`, `.cursor/mcp.json` 등)에 키를 넣는 경우,
  해당 파일도 버전 관리에서 제외하고 파일 권한을 제한하세요.
- 서버는 `client_secret`을 **어떤 응답에도 포함하지 않습니다.** `tossinvest_auth_status`는 설정 여부(boolean)만 반환합니다.

## 2. 토큰 메모리 보관

- access token은 **프로세스 메모리에만** 저장됩니다.
- 파일, 데이터베이스, 캐시 디렉터리에 기록하지 않습니다.
- 프로세스 종료 시 영구 토큰 파일을 남기지 않습니다.
- 토큰 문자열은 MCP 응답으로 **절대 반환되지 않습니다.** `tossinvest_refresh_auth`는 `{ ok, expiresIn, expiresAt }`만 반환합니다.
- `Authorization` 헤더는 전송 직전에만 생성되며 어디에도 저장·로깅되지 않습니다.
- 토스증권은 client당 유효 토큰이 1개이며 재발급 시 이전 토큰이 즉시 무효화되므로,
  동시 발급을 막기 위해 single-flight를 적용했습니다.

## 3. 로그 redaction

모든 로그는 stderr로만 출력되며 다음 값은 원문으로 출력되지 않습니다.

- client secret, access token, refresh token
- `Authorization` / `Cookie` / `Set-Cookie` 헤더
- 계좌 식별값 (`accountSeq`, `X-Tossinvest-Account`) — 마스킹 처리
- client ID — 앞뒤 일부만 남기고 마스킹
- 전체 주문 요청 body, 보유 수량 전체 응답 등 개인 자산 정보

`TOSSINVEST_LOG_LEVEL=debug`에서도 동일하게 redaction됩니다.
추가로 문자열 스크러버가 등록된 비밀값, `Bearer`/`Basic` 토큰 패턴, JWT 형태,
`client_secret=`/`access_token=` 쿼리 형태를 자동으로 제거합니다.

오류 객체도 동일하게 정규화·redaction되며, 원본 HTML 오류 페이지나 stack trace는 MCP 응답에 포함되지 않습니다.

## 4. 실주문 위험성

이 서버는 실제 매수·매도·정정·취소 및 조건주문을 실행할 수 있습니다.

- 잘못된 종목·수량·가격 입력은 **즉시 실제 손실**로 이어질 수 있습니다.
- LLM은 심볼·수량·가격을 잘못 해석할 수 있습니다. 실행 전 항상 사람이 dry-run 결과를 검토하세요.
- 자동화된 반복 호출은 의도치 않은 대량 주문을 만들 수 있습니다.
- 네트워크 오류로 결과가 불확실할 때 재요청하면 **중복 주문**이 발생할 수 있습니다.

## 5. dry-run 정책

- 모든 mutation 도구는 `dryRun` 기본값이 **`true`** 입니다.
- dry-run 상태에서는 토스증권 주문 엔드포인트로 **어떤 네트워크 요청도 보내지 않습니다.**
- 실제 실행은 다음 조건이 **모두** 참일 때만 허용됩니다.
  1. `TOSSINVEST_ENABLE_TRADING=true` (조건주문은 `TOSSINVEST_ENABLE_CONDITIONAL_ORDERS=true` 추가)
  2. 도구 입력 `dryRun=false`
  3. `confirmation`이 `TOSSINVEST_MUTATION_CONFIRMATION`과 정확히 일치
  4. 인증 정보 정상
  5. 계좌 명시
  6. OpenAPI 스키마 필수값 충족
  7. 요청 대상이 공식 API 서버
  8. mutation 종류가 명확히 분류됨
- 하나라도 어긋나면 네트워크 요청을 보내지 않고 차단 사유를 반환합니다.
- 명세 변경으로 새 mutation을 안전하게 분류할 수 없으면 **fail-closed**로 실행을 차단합니다.
- `tossinvest_call_operation`과 `tossinvest_raw_request`도 동일한 guard를 통과하므로 우회할 수 없습니다.

### mutation 자동 재시도 금지

주문 생성·정정·취소 및 조건주문 mutation은 timeout, connection reset, 5xx를 포함해
**어떤 상황에서도 자동 재시도하지 않습니다.** 결과가 불확실한 경우 경고와 함께
`requestId`, `clientOrderId`, 마스킹된 요청 요약, 주문내역 조회 안내를 반환합니다.

## 6. custom base URL 정책

- 기본적으로 `https://openapi.tossinvest.com`만 호출할 수 있습니다.
- `TOSSINVEST_ALLOW_CUSTOM_BASE_URL=true`로 명시하지 않으면 다른 도메인은 거부됩니다.
- 허용하더라도 HTTPS이거나 명시적으로 허용된 로컬 주소(`localhost`, `127.0.0.1`, `::1`)여야 합니다.
- 이 제약은 서버가 임의 URL을 호출하는 **SSRF 프록시로 악용되는 것**을 막기 위한 것입니다.
- OpenAPI 명세 URL에도 동일한 정책이 적용됩니다.
- 공식 OpenAPI에 정의되지 않은 path는 호출할 수 없으며, path traversal(`..`, 백슬래시, 널바이트)은 차단됩니다.
- `tossinvest_raw_request`는 기본 비활성이며, 활성화해도 **명세에 정의된 method+path 조합만** 허용합니다.

## 7. 실제 계좌로 테스트하지 말아야 하는 이유

- 토스증권 Open API는 **모의투자 환경을 제공하지 않습니다.** 모든 주문은 실거래입니다.
- 테스트 코드가 실수로 실주문을 내면 되돌릴 수 없습니다.
- 이 저장소의 테스트는 전부 HTTP mock 기반이며 **실제 주문 API를 호출하는 테스트는 존재하지 않습니다.**
- 읽기 전용 live smoke test조차 기본 비활성(`TOSSINVEST_RUN_LIVE_READONLY_TESTS=false`)입니다.
- 기능 검증이 필요하면 dry-run과 조회 API만 사용하고, 실주문은 최소 수량으로 사람이 직접 수행하세요.

## 8. API 키가 유출됐을 때 조치

1. **즉시** 토스증권 WTS → 설정 → Open API에서 해당 client를 **비활성화 또는 삭제**합니다.
2. 새 `client_id` / `client_secret`을 발급합니다.
3. 허용 IP 목록을 점검하고 불필요한 IP를 제거합니다.
4. 주문내역(`getOrders`, `getConditionalOrders`)과 보유 자산을 확인해 비정상 거래가 없는지 검사합니다.
5. 유출 경로(로그 파일, 커밋 히스토리, 공유된 설정 파일, 스크린샷)를 찾아 제거합니다.
   - git 히스토리에 커밋되었다면 키 폐기가 최우선이며, 히스토리 재작성만으로는 충분하지 않습니다.
6. 이상 거래가 있으면 토스증권 고객센터에 `requestId`와 함께 문의합니다.

## 9. 허용 IP 관리

- 토스증권 Open API는 등록된 IP에서만 호출할 수 있습니다.
- **필요한 IP만 최소한으로 등록**하세요. 광범위한 대역 등록은 키 유출 시 피해를 키웁니다.
- 공용 Wi-Fi, VPN, 클라우드 공유 인스턴스에서 사용하지 마세요.
- 사용하지 않는 IP는 즉시 삭제합니다.
- 갑작스러운 `ip-not-allowed` 오류는 공인 IP 변경 또는 **제3자의 무단 사용 시도**일 수 있습니다.

## 10. 계좌 식별정보 취급

- 계좌 값은 `account` 입력 또는 `TOSSINVEST_DEFAULT_ACCOUNT`로만 지정할 수 있습니다.
  `X-Tossinvest-Account` 헤더를 직접 넣는 것은 차단됩니다.
- 계좌 값은 숫자(`accountSeq`) 형식만 허용되어 헤더 인젝션이 불가능합니다.
- 계좌를 지정하지 않으면 **임의의 첫 번째 계좌를 자동 선택하지 않고** 오류를 반환합니다.
- 로그와 dry-run 요약에서 계좌 값은 마스킹됩니다.
- 계좌번호 전체값은 어떤 관리 도구에서도 반환하지 않습니다.

## 11. 의존성 보안 업데이트 정책

- 런타임 의존성을 최소로 유지합니다 (`@modelcontextprotocol/sdk`, `zod`, `dotenv`).
- 모든 의존성은 `package.json`에 **정확한 버전으로 고정**하고 `pnpm-lock.yaml`을 커밋합니다.
- 정기적으로 취약점을 점검하세요.

```bash
pnpm audit
pnpm outdated
```

- 보안 패치는 신속히 적용하되, 업그레이드 후 반드시 `pnpm typecheck && pnpm lint && pnpm test && pnpm build`를 통과시킵니다.
- MCP SDK는 안정 릴리스만 채택하며 beta/rc는 사용하지 않습니다.
- 최소 권한 원칙에 따라 서버는 파일 쓰기·셸 실행·임의 네트워크 접근 기능을 제공하지 않습니다.

## 12. 지원 버전

이 프로젝트는 아직 초기 단계(0.x)로, 보안 수정은 **기본 브랜치(main)에만** 적용됩니다.
과거 태그에 대한 백포트는 제공하지 않으므로 항상 최신 커밋을 사용하세요.

| 버전 | 지원 |
| --- | --- |
| `main` (최신) | ✅ |
| 그 외 | ❌ |

## 13. 취약점 제보

보안 취약점을 발견하면 **공개 이슈로 올리지 마세요.**

- GitHub의 **Private vulnerability reporting**(Security → Report a vulnerability)을 사용하거나,
  저장소 관리자에게 비공개로 연락해주세요.
- 제보 시 재현 절차, 영향 범위, 가능한 완화책을 포함해주세요.
- **실제 API 키, access token, 계좌번호를 제보 내용에 포함하지 마세요.** 재현에 필요하면 마스킹된 값이나 mock을 사용하세요.
- 접수 후 확인까지 보통 며칠이 걸릴 수 있습니다. 수정 전까지 공개를 미뤄주시면 감사하겠습니다.
- 토스증권 API 자체의 취약점은 이 저장소가 아니라 **토스증권에 직접** 신고해야 합니다.
