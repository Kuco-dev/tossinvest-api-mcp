import { ACCOUNT_HEADER } from '../config/constants.js';
import { AppError } from '../errors/app-error.js';
import type { OperationInfo } from '../openapi/operation-index.js';
import { assertHeadersAllowed, buildPath, resolveRequestUrl } from '../security/url-policy.js';
import { isPlainObject, stripDangerousKeys } from '../utils/json.js';

export interface BuildRequestInput {
  readonly operation: OperationInfo;
  readonly baseUrl: string;
  readonly path?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly account?: string;
  readonly defaultAccount?: string;
}

export interface BuiltRequest {
  readonly url: URL;
  readonly method: string;
  /** Authorization 은 포함하지 않는다. 전송 직전에 클라이언트가 주입한다. */
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly contentType?: string;
  readonly accountUsed?: string;
}

/**
 * 계좌 값을 결정한다.
 * 1) 도구 입력 account -> 2) TOSSINVEST_DEFAULT_ACCOUNT -> 3) 오류
 * 임의로 첫 번째 계좌를 선택하지 않는다.
 */
export function resolveAccount(
  operation: OperationInfo,
  explicit: string | undefined,
  fallback: string | undefined
): string | undefined {
  if (!operation.requiresAccount) return undefined;

  const chosen = normalizeAccount(explicit) ?? normalizeAccount(fallback);
  if (!chosen) {
    throw new AppError({
      code: 'account-header-required',
      message:
        `${operation.operationId} 는 계좌 지정이 필요합니다. ` +
        'account 인자를 전달하거나 TOSSINVEST_DEFAULT_ACCOUNT 를 설정하세요. ' +
        '사용 가능한 계좌는 getAccounts 도구로 먼저 조회하세요. (임의의 계좌를 자동 선택하지 않습니다.)',
      httpStatus: 400,
      retryable: false,
    });
  }
  return chosen;
}

function normalizeAccount(value: string | number | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  if (text === '') return undefined;
  // 계좌는 accountSeq(int64) 이므로 숫자 형식만 허용한다. 헤더 인젝션도 함께 차단된다.
  if (!/^\d{1,19}$/.test(text)) {
    throw new AppError({
      code: 'invalid-input',
      message: 'account 는 getAccounts 응답의 accountSeq(숫자) 여야 합니다.',
      httpStatus: 400,
      retryable: false,
    });
  }
  return text;
}

/** query parameter 를 OpenAPI style 규칙에 맞게 직렬화한다. */
export function serializeQuery(
  operation: OperationInfo,
  query: Record<string, unknown> | undefined
): URLSearchParams {
  const params = new URLSearchParams();
  if (!query) return params;

  const known = new Map(operation.queryParameters.map((param) => [param.name, param]));

  for (const [name, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;

    const definition = known.get(name);
    if (!definition) {
      throw new AppError({
        code: 'invalid-input',
        message: `${operation.operationId} 에 정의되지 않은 query parameter 입니다: ${name}`,
        httpStatus: 400,
        retryable: false,
      });
    }

    if (Array.isArray(value)) {
      // 기본 style=form. explode=false 면 콤마 결합, 아니면 반복 키.
      if (definition.explode === false) {
        params.append(name, value.map((item) => stringifyScalar(item)).join(','));
      } else {
        for (const item of value) {
          if (item === undefined || item === null) continue;
          params.append(name, stringifyScalar(item));
        }
      }
      continue;
    }

    if (isPlainObject(value)) {
      throw new AppError({
        code: 'invalid-input',
        message: `query parameter ${name} 에 객체 값을 사용할 수 없습니다.`,
        httpStatus: 400,
        retryable: false,
      });
    }

    params.append(name, stringifyScalar(value));
  }

  return params;
}

/**
 * 스칼라 값을 문자열로 변환한다.
 * decimal string 은 그대로 유지되어 정밀도가 손실되지 않는다.
 */
function stringifyScalar(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new AppError({
        code: 'invalid-input',
        message: '유한하지 않은 숫자는 파라미터로 사용할 수 없습니다.',
        httpStatus: 400,
        retryable: false,
      });
    }
    return String(value);
  }
  throw new AppError({
    code: 'invalid-input',
    message: `지원하지 않는 파라미터 값 타입입니다: ${typeof value}`,
    httpStatus: 400,
    retryable: false,
  });
}

/** 최종 HTTP 요청을 구성한다. Authorization 헤더는 여기서 만들지 않는다. */
export function buildRequest(input: BuildRequestInput): BuiltRequest {
  const { operation } = input;

  assertHeadersAllowed(input.query);

  const requestPath = buildPath(operation.path, input.path ?? {});
  const url = resolveRequestUrl(input.baseUrl, requestPath);

  const search = serializeQuery(operation, input.query);
  const searchString = search.toString();
  if (searchString) url.search = searchString;

  const headers: Record<string, string> = { accept: 'application/json' };

  const accountUsed = resolveAccount(operation, input.account, input.defaultAccount);
  if (accountUsed !== undefined) {
    headers[ACCOUNT_HEADER] = accountUsed;
  }

  let body: string | undefined;
  let contentType: string | undefined;

  if (operation.requestBody) {
    const hasBody = input.body !== undefined && input.body !== null;
    if (!hasBody && operation.requestBody.required) {
      throw new AppError({
        code: 'invalid-input',
        message: `${operation.operationId} 는 요청 본문이 필요합니다.`,
        httpStatus: 400,
        retryable: false,
      });
    }
    if (hasBody) {
      const safeBody = stripDangerousKeys(input.body);
      if (operation.requestBody.contentType.includes('x-www-form-urlencoded')) {
        if (!isPlainObject(safeBody)) {
          throw new AppError({
            code: 'invalid-input',
            message: 'form-urlencoded 본문은 객체여야 합니다.',
            httpStatus: 400,
            retryable: false,
          });
        }
        const form = new URLSearchParams();
        for (const [key, value] of Object.entries(safeBody)) {
          if (value === undefined || value === null) continue;
          form.append(key, stringifyScalar(value));
        }
        body = form.toString();
        contentType = 'application/x-www-form-urlencoded';
      } else {
        // JSON.stringify 는 string 으로 들어온 decimal 값을 그대로 유지한다.
        body = JSON.stringify(safeBody);
        contentType = 'application/json';
      }
      headers['content-type'] = contentType;
    }
  }

  return {
    url,
    method: operation.method,
    headers,
    ...(body !== undefined ? { body } : {}),
    ...(contentType !== undefined ? { contentType } : {}),
    ...(accountUsed !== undefined ? { accountUsed } : {}),
  };
}
