# 기여 가이드

이 프로젝트에 관심 가져주셔서 감사합니다.
이 저장소는 **실제 금융 자산에 영향을 줄 수 있는 API**를 다루므로, 일반적인 오픈소스보다 엄격한 규칙이 있습니다.

## 절대 규칙

> [!CAUTION]
> 아래 항목을 위반한 PR은 검토 없이 닫힙니다.

1. **실제 주문 API를 호출하는 코드나 테스트를 추가하지 마세요.** 모든 테스트는 HTTP mock 기반이어야 합니다.
2. **주문 안전장치를 우회하거나 약화시키지 마세요.** `dryRun` 기본값 `true`, 실주문 기본 비활성화, mutation 자동 재시도 금지는 협상 대상이 아닙니다.
3. **실제 인증정보·계좌번호·토큰을 커밋하지 마세요.** 이슈·PR 본문과 스크린샷도 포함됩니다.
4. **`stdout`에 아무것도 출력하지 마세요.** stdio MCP 채널이 깨집니다. 로그는 `src/utils/logger.ts`(stderr)만 사용합니다.
5. **엔드포인트를 하드코딩하지 마세요.** operation은 OpenAPI 명세에서 동적으로 생성됩니다.

## 개발 환경

| 항목 | 버전 |
| --- | --- |
| Node.js | 20.10 이상 (권장 22 LTS) |
| pnpm | 9 이상 (`packageManager` 필드에 고정) |

```bash
pnpm install
pnpm dev        # tsx watch
```

## PR 전 체크리스트

아래 명령이 **모두** 통과해야 합니다.

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm openapi:verify
```

- [ ] TypeScript strict 통과, `any` 남용 없음
- [ ] 새 동작에 대한 테스트 추가
- [ ] 실제 API를 호출하지 않음
- [ ] 비밀값이 로그·응답·테스트 픽스처에 노출되지 않음
- [ ] 사용자에게 보이는 변경이면 README 갱신

## 코드 규칙

- **언어**: TypeScript strict. 주석과 사용자 노출 메시지는 한국어.
- **주석**: 자명한 코드에는 달지 않습니다. *왜* 그렇게 했는지만 남깁니다.
- **오류**: `AppError`(`src/errors/app-error.ts`)를 사용하고 정규화된 코드를 붙입니다. 원본 HTML·stack trace를 MCP 응답에 넣지 않습니다.
- **정밀도**: 금액·수량·가격은 **문자열**로 유지합니다. `Number()` 변환 금지.
- **비밀값**: 새 민감 필드가 생기면 `src/security/sensitive-fields.ts`에 등록합니다.

## 자주 하는 작업

### 토스증권이 API를 추가했을 때

대부분 **코드 변경이 필요 없습니다.** 서버가 명세를 읽어 도구를 자동 생성합니다.

```bash
pnpm openapi:update    # snapshot 갱신
pnpm openapi:verify    # 변환 가능 여부 확인
pnpm test
```

단, **새 주문(mutation) API가 추가된 경우**에는 분류가 필요합니다.
`openapi:verify`가 `분류 불가 mutation`을 0이 아닌 값으로 보고하면,
`src/config/constants.ts`의 정책 테이블에 operationId를 명시적으로 등록하세요.
등록 전까지 해당 API는 **fail-closed로 실행이 차단**됩니다. 이는 의도된 동작입니다.

### 새 관리 도구 추가

`src/tools/management-tools.ts`의 `definitions`와 `call()`에 함께 추가하고,
`src/config/constants.ts`의 `MANAGEMENT_TOOL_NAMES`에 이름을 등록합니다.

## 커밋 메시지

[Conventional Commits](https://www.conventionalcommits.org/)를 권장합니다.

```
feat: 조건주문 dry-run 요약에 트리거 가격 추가
fix: 429 응답에서 Retry-After 파싱 오류 수정
docs: Docker 실행 가이드 보강
test: 토큰 single-flight 경쟁 조건 테스트 추가
chore: OpenAPI snapshot 1.2.6 갱신
```

## 보안 취약점

**공개 이슈로 올리지 마세요.** [SECURITY.md](./SECURITY.md)의 비공개 제보 절차를 따라주세요.

## 라이선스

기여하신 코드는 [MIT 라이선스](./LICENSE)로 배포되는 데 동의하는 것으로 간주합니다.
