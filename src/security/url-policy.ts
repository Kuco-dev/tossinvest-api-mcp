import { ALLOWED_METHODS, FORBIDDEN_HEADERS } from '../config/constants.js';
import { AppError } from '../errors/app-error.js';

/**
 * OpenAPI path 템플릿에 파라미터를 채워 최종 경로를 만든다.
 * 값은 encodeURIComponent 로 인코딩하므로 `/` 나 `..` 를 주입할 수 없다.
 */
export function buildPath(pathTemplate: string, pathParams: Record<string, unknown>): string {
  const missing: string[] = [];
  const filled = pathTemplate.replace(/\{([^}]+)\}/g, (_match, rawName: string) => {
    const name = rawName.trim();
    const value = Object.prototype.hasOwnProperty.call(pathParams, name)
      ? pathParams[name]
      : undefined;
    if (value === undefined || value === null || value === '') {
      missing.push(name);
      return '';
    }
    return encodeURIComponent(String(value));
  });

  if (missing.length > 0) {
    throw new AppError({
      code: 'invalid-input',
      message: `path parameter 가 누락되었습니다: ${missing.join(', ')}`,
      httpStatus: 400,
      retryable: false,
    });
  }

  assertNoTraversal(filled);
  return filled;
}

/** 인코딩 이후에도 traversal 이 남아 있는지 최종 확인한다. */
export function assertNoTraversal(pathname: string): void {
  const decoded = safeDecode(pathname);
  if (decoded.includes('..') || decoded.includes('\\') || decoded.includes('\0')) {
    throw new AppError({
      code: 'invalid-input',
      message: '허용되지 않는 경로 문자가 포함되어 있습니다.',
      httpStatus: 400,
      retryable: false,
    });
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * 최종 요청 URL 을 조립한다. 결과 URL 이 base URL 밖으로 벗어나면 차단한다.
 */
export function resolveRequestUrl(baseUrl: string, requestPath: string): URL {
  if (!requestPath.startsWith('/')) {
    throw new AppError({
      code: 'invalid-input',
      message: 'API 경로는 "/" 로 시작해야 합니다.',
      httpStatus: 400,
      retryable: false,
    });
  }

  const base = new URL(baseUrl);
  const url = new URL(`${base.origin}${requestPath}`);

  if (url.origin !== base.origin) {
    throw new AppError({
      code: 'forbidden-target',
      message: '요청 대상이 허용된 API 서버를 벗어났습니다.',
      httpStatus: 400,
      retryable: false,
    });
  }

  assertNoTraversal(url.pathname);
  return url;
}

export function assertMethodAllowed(method: string): string {
  const normalized = method.toLowerCase();
  if (!ALLOWED_METHODS.includes(normalized)) {
    throw new AppError({
      code: 'invalid-input',
      message: `지원하지 않는 HTTP method 입니다: ${method}`,
      httpStatus: 400,
      retryable: false,
    });
  }
  return normalized.toUpperCase();
}

/** 사용자 제공 헤더 중 금지 헤더가 있으면 차단한다. */
export function assertHeadersAllowed(headers: Record<string, unknown> | undefined): void {
  if (!headers) return;
  const violations = Object.keys(headers).filter((key) =>
    FORBIDDEN_HEADERS.includes(key.toLowerCase())
  );
  if (violations.length > 0) {
    throw new AppError({
      code: 'forbidden-header',
      message: `직접 지정할 수 없는 헤더입니다: ${violations.join(', ')}. 계좌는 account 입력을 사용하세요.`,
      httpStatus: 400,
      retryable: false,
    });
  }
}
