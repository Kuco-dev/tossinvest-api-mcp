/** 프로젝트 전역 상수. 여기 값은 런타임 환경변수로 덮어쓰지 않는다. */

export const SERVER_NAME = 'tossinvest-api-mcp';
export const SERVER_VERSION = '0.1.0';

/** 공식 OpenAPI 명세 기본 URL. */
export const DEFAULT_OPENAPI_URL = 'https://openapi.tossinvest.com/openapi-docs/latest/openapi.json';

/** 공식 API 기본 서버. */
export const DEFAULT_BASE_URL = 'https://openapi.tossinvest.com';

/** custom base URL이 꺼져 있을 때 허용되는 호스트. */
export const OFFICIAL_HOSTS = Object.freeze(['openapi.tossinvest.com']);

/** custom base URL이 켜졌을 때 http를 예외적으로 허용하는 로컬 테스트 호스트. */
export const ALLOWED_LOCAL_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]']);

/** OAuth 2.0 토큰 엔드포인트 경로. */
export const TOKEN_ENDPOINT_PATH = '/oauth2/token';

/** 토큰 발급 operationId. 직접 MCP 도구로 노출하지 않는다. */
export const TOKEN_OPERATION_ID = 'issueOAuth2Token';

/** 계좌 지정용 공식 헤더 이름. */
export const ACCOUNT_HEADER = 'X-Tossinvest-Account';

/** 요청 식별 헤더. */
export const REQUEST_ID_HEADER = 'X-Request-Id';

/** 사용자가 도구 인자로 직접 지정할 수 없는 헤더 (소문자 비교). */
export const FORBIDDEN_HEADERS = Object.freeze([
  'authorization',
  'cookie',
  'set-cookie',
  'host',
  'content-length',
  'proxy-authorization',
  'transfer-encoding',
  'connection',
  'upgrade',
  ACCOUNT_HEADER.toLowerCase(),
]);

/** 허용되는 HTTP method. 명세에 없는 method는 호출하지 않는다. */
export const ALLOWED_METHODS = Object.freeze(['get', 'post', 'put', 'patch', 'delete']);

/** MCP 도구 이름 최대 길이. */
export const MAX_TOOL_NAME_LENGTH = 64;

/** 기본 응답 크기 상한 (8MiB). */
export const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** 재시도 backoff 기본값. */
export const RETRY_BASE_DELAY_MS = 250;
export const RETRY_MAX_DELAY_MS = 8_000;

/** `Retry-After`를 신뢰하는 최대 대기 시간. 그 이상이면 재시도하지 않는다. */
export const MAX_RETRY_AFTER_SECONDS = 30;

/** 관리용 도구 이름. */
export const MANAGEMENT_TOOL_NAMES = Object.freeze({
  overview: 'tossinvest_api_overview',
  listOperations: 'tossinvest_list_operations',
  searchOperations: 'tossinvest_search_operations',
  getOperation: 'tossinvest_get_operation',
  callOperation: 'tossinvest_call_operation',
  authStatus: 'tossinvest_auth_status',
  refreshAuth: 'tossinvest_refresh_auth',
  rawRequest: 'tossinvest_raw_request',
});

/**
 * 자산에 영향을 주는 mutation 분류 정책 테이블.
 *
 * 단순히 "모든 POST"를 주문으로 간주하지 않는다. tag / operationId / method / path 를
 * 함께 사용해 판정하며, 명세가 바뀌어 분류가 불확실한 mutation이 등장하면
 * fail-closed 로 차단한다 (mutation-guard.ts 참고).
 */
export const ORDER_TAGS = Object.freeze(['Order']);
export const CONDITIONAL_ORDER_TAGS = Object.freeze(['Conditional Order']);

/** 읽기 전용임이 명확한 tag. 조회성 mutation-like operation 오탐을 줄인다. */
export const READ_ONLY_TAGS = Object.freeze([
  'Market Data',
  'Stock Info',
  'Market Info',
  'Ranking',
  'Market Indicators',
  'Account',
  'Asset',
  'Order History',
  'Conditional Order History',
  'Order Info',
]);

/** operationId 기반 명시 정책. 명세 변경에도 안정적으로 동작하도록 우선 적용한다. */
export const ORDER_MUTATION_OPERATION_IDS = Object.freeze([
  'createOrder',
  'modifyOrder',
  'cancelOrder',
]);

export const CONDITIONAL_MUTATION_OPERATION_IDS = Object.freeze([
  'createConditionalOrder',
  'modifyConditionalOrder',
  'cancelConditionalOrder',
]);

/** path 기반 보조 판정 패턴. */
export const ORDER_PATH_PREFIX = '/api/v1/orders';
export const CONDITIONAL_ORDER_PATH_PREFIX = '/api/v1/conditional-orders';
