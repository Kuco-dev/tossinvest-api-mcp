import { REQUEST_ID_HEADER } from '../config/constants.js';
import { AppError } from '../errors/app-error.js';
import { extractUpstreamError, mapUpstreamError } from '../errors/error-normalizer.js';
import { safeJsonParse } from '../utils/json.js';
import { parseRateLimit, type RateLimitInfo } from './rate-limit.js';

export interface ParsedResponse {
  readonly httpStatus: number;
  readonly requestId?: string;
  readonly rateLimit?: RateLimitInfo;
  readonly body: unknown;
}

/** 응답 본문을 크기 제한과 함께 읽는다. */
export async function readBodyText(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number.parseInt(declaredLength, 10);
    if (Number.isFinite(length) && length > maxBytes) {
      throw new AppError({
        code: 'response-too-large',
        message: `응답 크기가 허용 한도(${maxBytes} bytes)를 초과했습니다.`,
        httpStatus: response.status,
        retryable: false,
      });
    }
  }

  const text = await response.text();
  // UTF-8 기준 바이트 길이로 재확인 (content-length 가 없거나 잘못된 경우 대비).
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new AppError({
      code: 'response-too-large',
      message: `응답 크기가 허용 한도(${maxBytes} bytes)를 초과했습니다.`,
      httpStatus: response.status,
      retryable: false,
    });
  }
  return text;
}

/**
 * HTTP 응답을 파싱한다.
 * 실패 응답은 AppError 로 던지고, HTML 오류 페이지는 본문을 노출하지 않는다.
 */
export async function parseResponse(
  response: Response,
  options: { maxBytes: number; isMutation: boolean; now?: number }
): Promise<ParsedResponse> {
  const now = options.now ?? Date.now();
  const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
  const rateLimit = parseRateLimit(response.headers, now);

  const text = await readBodyText(response, options.maxBytes);
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

  let body: unknown = undefined;
  let parseFailed = false;
  if (text.trim() !== '') {
    if (contentType.includes('json') || text.trimStart().startsWith('{') || text.trimStart().startsWith('[')) {
      try {
        body = safeJsonParse(text);
      } catch {
        parseFailed = true;
      }
    } else {
      parseFailed = true;
    }
  }

  if (!response.ok) {
    const upstream = parseFailed ? {} : extractUpstreamError(body);
    const mapped = mapUpstreamError(response.status, upstream.code, options.isMutation);
    const resolvedRequestId = requestId ?? upstream.requestId;

    throw new AppError({
      code: mapped.code,
      // 원본 HTML 오류 페이지나 stack trace 를 그대로 노출하지 않는다.
      message:
        upstream.message ??
        defaultMessageFor(response.status, mapped.code === 'rate-limit-exceeded'),
      httpStatus: response.status,
      ...(resolvedRequestId ? { requestId: resolvedRequestId } : {}),
      retryable: mapped.retryable,
      ...(rateLimit?.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: rateLimit.retryAfterSeconds }
        : rateLimit?.resetSeconds !== undefined
          ? { retryAfterSeconds: rateLimit.resetSeconds }
          : {}),
      ...(upstream.code ? { upstreamCode: upstream.code } : {}),
      ...(upstream.data ? { details: upstream.data } : {}),
    });
  }

  if (parseFailed) {
    throw new AppError({
      code: 'invalid-response',
      message: 'API 응답이 유효한 JSON 이 아닙니다.',
      httpStatus: response.status,
      ...(requestId ? { requestId } : {}),
      retryable: false,
    });
  }

  return {
    httpStatus: response.status,
    ...(requestId ? { requestId } : {}),
    ...(rateLimit ? { rateLimit } : {}),
    body,
  };
}

function defaultMessageFor(status: number, isRateLimit: boolean): string {
  if (isRateLimit) return '요청 한도를 초과했습니다. 잠시 후 다시 시도해 주세요.';
  if (status === 401) return '인증에 실패했습니다.';
  if (status === 403) return '해당 요청에 대한 권한이 없습니다.';
  if (status === 404) return '요청한 리소스를 찾을 수 없습니다.';
  if (status >= 500) return `토스증권 API 서버 오류가 발생했습니다 (HTTP ${status}).`;
  return `요청이 실패했습니다 (HTTP ${status}).`;
}

/** 성공 응답의 `result` 필드를 꺼낸다. envelope 이 아니면 본문 그대로 반환한다. */
export function unwrapResult(body: unknown): unknown {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    if ('result' in record) return record.result;
  }
  return body;
}
