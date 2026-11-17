import { readBodyText } from '../../client/response-parser.js';
import { decideRetry, sleep } from '../../client/retry-policy.js';
import { assertNoTraversal } from '../../security/url-policy.js';
import { AppError } from '../../errors/app-error.js';
import { toAppError } from '../../errors/error-normalizer.js';
import { registerSecret } from '../../security/redaction.js';
import { isPlainObject, safeJsonParse } from '../../utils/json.js';
import type { Logger } from '../../utils/logger.js';
import { assertOpenBbUrlAllowed, OPENBB_API_PREFIX, type OpenBbConfig } from './config.js';

export type OpenBbQueryValue = string | number | boolean | undefined;

/** OpenBB 표준 응답(OBBject) 중 이 서버가 사용하는 부분. */
export interface OpenBbResponse {
  readonly results: unknown;
  readonly provider?: string;
  readonly warnings?: unknown;
}

export interface OpenBbClientOptions {
  readonly config: OpenBbConfig;
  readonly requestTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly maxReadRetries: number;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

/** `/equity/price/historical` 형태만 허용한다. 소문자·숫자·밑줄 세그먼트. */
const ROUTE_PATTERN = /^(\/[a-z0-9_]+){1,6}$/;

/**
 * OpenBB Platform REST API 전용 읽기 클라이언트.
 *
 * - GET 만 보낸다. OpenBB 쪽에는 자산에 영향을 주는 호출이 없다.
 * - 토스증권 access token 은 절대 붙이지 않는다 (TossClient 와 완전히 분리).
 * - 토스증권 클라이언트와 같은 timeout / 응답 크기 상한 / GET 재시도 정책을 쓴다.
 */
export class OpenBbClient {
  private readonly config: OpenBbConfig;
  private readonly origin: string;
  private readonly authorization?: string;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(private readonly options: OpenBbClientOptions) {
    this.config = options.config;
    this.origin = assertOpenBbUrlAllowed(options.config.baseUrl, options.config.allowRemote).origin;
    this.logger = options.logger.child('openbb');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? sleep;

    const { username, password } = options.config;
    if (username !== undefined && password !== undefined) {
      registerSecret(password);
      const encoded = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
      registerSecret(encoded);
      this.authorization = `Basic ${encoded}`;
    }
  }

  get baseUrl(): string {
    return this.origin;
  }

  get authConfigured(): boolean {
    return this.authorization !== undefined;
  }

  async get(route: string, query: Record<string, OpenBbQueryValue> = {}): Promise<OpenBbResponse> {
    const url = this.buildUrl(route, query);
    let attempt = 0;

    for (;;) {
      try {
        return await this.executeOnce(url, route);
      } catch (rawError) {
        const error = this.describeConnectionError(toAppError(rawError));
        const decision = decideRetry({
          isMutation: false,
          method: 'GET',
          attempt,
          maxRetries: this.options.maxReadRetries,
          ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
          errorCode: error.code,
          ...(error.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: error.retryAfterSeconds }
            : {}),
        });
        // 서버가 꺼져 있는 경우(ECONNREFUSED)는 재시도해도 의미가 없다.
        if (decision.shouldRetry && error.details?.hint === undefined) {
          attempt += 1;
          this.logger.warn('OpenBB 읽기 요청을 재시도합니다.', {
            route,
            attempt,
            delayMs: decision.delayMs,
            code: error.code,
          });
          await this.sleepImpl(decision.delayMs);
          continue;
        }
        throw error;
      }
    }
  }

  /** 서버 연결 확인. `/openapi.json` 의 info 만 읽는다. */
  async ping(): Promise<{ title?: string; version?: string; routeCount: number }> {
    const url = new URL('/openapi.json', this.origin);
    const body = await this.request(url);
    if (!isPlainObject(body)) {
      throw invalidResponse();
    }
    const info = isPlainObject(body.info) ? body.info : {};
    const paths = isPlainObject(body.paths) ? Object.keys(body.paths) : [];
    return {
      ...(typeof info.title === 'string' ? { title: info.title } : {}),
      ...(typeof info.version === 'string' ? { version: info.version } : {}),
      routeCount: paths.filter((path) => path.startsWith(`${OPENBB_API_PREFIX}/`)).length,
    };
  }

  private buildUrl(route: string, query: Record<string, OpenBbQueryValue>): URL {
    if (!ROUTE_PATTERN.test(route)) {
      throw new AppError({
        code: 'invalid-input',
        message: `허용되지 않는 OpenBB 경로입니다: ${route}`,
        httpStatus: 400,
        retryable: false,
      });
    }
    const url = new URL(`${OPENBB_API_PREFIX}${route}`, this.origin);
    if (url.origin !== this.origin) {
      throw new AppError({
        code: 'forbidden-target',
        message: '요청 대상이 설정된 OpenBB 서버를 벗어났습니다.',
        httpStatus: 400,
        retryable: false,
      });
    }
    assertNoTraversal(url.pathname);

    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    return url;
  }

  private async executeOnce(url: URL, route: string): Promise<OpenBbResponse> {
    this.logger.debug('OpenBB 요청을 보냅니다.', { route, query: url.searchParams.toString() });
    const body = await this.request(url);

    if (!isPlainObject(body) || !('results' in body)) {
      throw invalidResponse();
    }
    return {
      results: body.results,
      ...(typeof body.provider === 'string' ? { provider: body.provider } : {}),
      ...(body.warnings !== undefined && body.warnings !== null ? { warnings: body.warnings } : {}),
    };
  }

  private async request(url: URL): Promise<unknown> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.authorization) headers.authorization = this.authorization;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
    try {
      const response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers,
        signal: controller.signal,
        redirect: 'error',
      });
      const text = await readBodyText(response, this.options.maxResponseBytes);

      let body: unknown;
      let parseFailed = false;
      if (text.trim() !== '') {
        try {
          body = safeJsonParse(text);
        } catch {
          parseFailed = true;
        }
      }

      if (!response.ok) {
        throw mapHttpError(response.status, parseFailed ? undefined : body, response.headers);
      }
      // 실측: 결과가 없으면 OpenBB 는 오류 대신 204 No Content 를 돌려준다 (예: 단일 심볼 metrics).
      if (response.status === 204 && text.trim() === '') {
        return { results: [] };
      }
      if (parseFailed) throw invalidResponse(response.status);
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  private describeConnectionError(error: AppError): AppError {
    if (error.code !== 'network-error' || error.httpStatus !== undefined) return error;
    // 서버 미실행(ECONNREFUSED)만 골라낸다. 그 외 일시적 네트워크 오류는 일반 재시도 대상으로 남긴다.
    if (!causeChainMatches(error, /ECONNREFUSED/)) return error;
    return new AppError({
      code: 'network-error',
      message:
        `OpenBB API 서버(${this.origin})에 연결할 수 없습니다. ` +
        '`openbb-api` 가 실행 중인지, TOSSINVEST_OPENBB_BASE_URL 이 맞는지 확인하세요.',
      retryable: false,
      details: { hint: 'pip install openbb && openbb-api' },
      cause: error,
    });
  }
}

function causeChainMatches(error: unknown, pattern: RegExp): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      const code = (current as { code?: unknown }).code;
      if (pattern.test(current.message) || (typeof code === 'string' && pattern.test(code))) {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      return typeof current === 'string' && pattern.test(current);
    }
  }
  return false;
}

function invalidResponse(httpStatus?: number): AppError {
  return new AppError({
    code: 'invalid-response',
    message: 'OpenBB 응답이 예상한 형식(OBBject JSON)이 아닙니다.',
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    retryable: false,
  });
}

/** FastAPI/OpenBB 오류 본문({ detail })을 정규화한다. HTML 오류 페이지는 노출하지 않는다. */
function mapHttpError(status: number, body: unknown, headers: Headers): AppError {
  const detail = summarizeDetail(isPlainObject(body) ? body.detail : undefined);
  const retryAfterRaw = headers.get('retry-after');
  const retryAfter = retryAfterRaw !== null ? Number.parseInt(retryAfterRaw, 10) : Number.NaN;

  const base = {
    httpStatus: status,
    ...(Number.isFinite(retryAfter) ? { retryAfterSeconds: retryAfter } : {}),
  };

  if (status === 401 || status === 403) {
    return new AppError({
      ...base,
      code: 'auth-failed',
      message:
        'OpenBB 서버 인증에 실패했습니다. 서버의 OPENBB_API_USERNAME/PASSWORD 와 ' +
        'TOSSINVEST_OPENBB_USERNAME/PASSWORD 가 일치하는지 확인하세요.',
      retryable: false,
    });
  }
  if (status === 404) {
    return new AppError({
      ...base,
      code: 'not-found',
      message:
        'OpenBB 서버에 해당 라우트가 없습니다. 필요한 확장(openbb-equity, openbb-news 등)이 설치되어 있는지 확인하세요.',
      retryable: false,
    });
  }
  if (status === 400 || status === 422) {
    return new AppError({
      ...base,
      code: 'invalid-input',
      message: `OpenBB 가 요청 값을 거부했습니다${detail ? `: ${detail}` : '.'}`,
      retryable: false,
    });
  }
  if (status === 429) {
    return new AppError({
      ...base,
      code: 'rate-limit-exceeded',
      message: 'OpenBB 데이터 provider 요청 한도를 초과했습니다.',
      retryable: true,
    });
  }
  return new AppError({
    ...base,
    code: 'upstream-error',
    message: `OpenBB 서버 오류가 발생했습니다 (HTTP ${status})${detail ? `: ${detail}` : '.'}`,
    retryable: status >= 500,
  });
}

function summarizeDetail(detail: unknown): string | undefined {
  if (typeof detail === 'string') return detail.slice(0, 300);
  if (Array.isArray(detail)) {
    const parts = detail.slice(0, 3).map((item) => {
      if (!isPlainObject(item)) return String(item);
      const loc = Array.isArray(item.loc) ? item.loc.filter((x) => x !== 'query').join('.') : '';
      const msg = typeof item.msg === 'string' ? item.msg : '';
      return loc ? `${loc}: ${msg}` : msg;
    });
    return parts.join('; ').slice(0, 300);
  }
  return undefined;
}
