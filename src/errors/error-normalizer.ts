import { redact, scrubString } from '../security/redaction.js';
import { AppError, type AppErrorCode } from './app-error.js';

export interface NormalizedErrorBody {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly upstreamCode?: string;
  readonly details?: Record<string, unknown>;
}

export interface NormalizedErrorEnvelope {
  readonly ok: false;
  readonly operationId?: string;
  readonly httpStatus?: number;
  readonly error: NormalizedErrorBody;
}

/** 토스증권 표준 에러 envelope: { error: { requestId, code, message, data? } } */
interface UpstreamErrorEnvelope {
  error?: {
    requestId?: unknown;
    code?: unknown;
    message?: unknown;
    data?: unknown;
  };
  /** OAuth2 표준 에러 형식 */
  error_description?: unknown;
}

/** HTTP status + upstream code 를 정규화 코드로 매핑한다. */
export function mapUpstreamError(
  httpStatus: number,
  upstreamCode: string | undefined,
  isMutation: boolean
): { code: AppErrorCode; retryable: boolean } {
  const code = (upstreamCode ?? '').toLowerCase();

  if (code === 'rate-limit-exceeded' || httpStatus === 429) {
    return { code: 'rate-limit-exceeded', retryable: !isMutation };
  }
  if (code === 'account-header-required') {
    return { code: 'account-header-required', retryable: false };
  }
  if (code === 'account-not-found') {
    return { code: 'account-not-found', retryable: false };
  }
  if (code === 'ip-not-allowed' || code === 'access_denied') {
    return { code: 'ip-not-allowed', retryable: false };
  }
  if (code === 'invalid_client' || code === 'invalid_grant' || code === 'invalid_token') {
    return { code: 'auth-failed', retryable: false };
  }
  if (
    code === 'outside-order-hours' ||
    code === 'amount-order-outside-regular-hours' ||
    code === 'fractional-quantity-outside-regular-hours'
  ) {
    return { code: 'order-hours-violation', retryable: false };
  }

  switch (httpStatus) {
    case 400:
      return { code: isMutation ? 'invalid-order-request' : 'invalid-input', retryable: false };
    case 401:
      return { code: 'auth-failed', retryable: false };
    case 403:
      return { code: 'forbidden', retryable: false };
    case 404:
      return { code: 'not-found', retryable: false };
    case 409:
      return { code: 'invalid-order-request', retryable: false };
    case 422:
      return { code: isMutation ? 'invalid-order-request' : 'invalid-input', retryable: false };
    default:
      break;
  }

  if (httpStatus >= 500) {
    return { code: 'upstream-error', retryable: !isMutation };
  }
  return { code: 'upstream-error', retryable: false };
}

/** HTTP 응답 본문에서 requestId / code / message 를 안전하게 추출한다. */
export function extractUpstreamError(body: unknown): {
  requestId?: string;
  code?: string;
  message?: string;
  data?: Record<string, unknown>;
} {
  if (typeof body !== 'object' || body === null) return {};
  const envelope = body as UpstreamErrorEnvelope;

  if (envelope.error && typeof envelope.error === 'object') {
    const err = envelope.error as Record<string, unknown>;
    return {
      requestId: typeof err.requestId === 'string' ? err.requestId : undefined,
      code: typeof err.code === 'string' ? err.code : undefined,
      message: typeof err.message === 'string' && err.message !== '' ? err.message : undefined,
      data:
        typeof err.data === 'object' && err.data !== null && !Array.isArray(err.data)
          ? (err.data as Record<string, unknown>)
          : undefined,
    };
  }

  // OAuth2 표준 형식: { error: "invalid_client", error_description: "..." }
  if (typeof (body as Record<string, unknown>).error === 'string') {
    return {
      code: (body as Record<string, unknown>).error as string,
      message:
        typeof envelope.error_description === 'string' ? envelope.error_description : undefined,
    };
  }

  return {};
}

const NETWORK_ERROR_HINTS: ReadonlyArray<{ pattern: RegExp; code: AppErrorCode }> = [
  { pattern: /ENOTFOUND|EAI_AGAIN|getaddrinfo/i, code: 'dns-error' },
  { pattern: /CERT_|self.signed certificate|unable to verify|ERR_TLS|EPROTO/i, code: 'tls-error' },
  { pattern: /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|ETIMEDOUT|network/i, code: 'network-error' },
];

/** 임의의 throw 값을 AppError 로 정규화한다. */
export function toAppError(error: unknown, fallbackMessage = '알 수 없는 오류가 발생했습니다.'): AppError {
  if (AppError.isAppError(error)) return error;

  if (error instanceof Error) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return new AppError({
        code: 'request-timeout',
        message: '요청이 시간 내에 완료되지 않았습니다.',
        retryable: true,
        cause: error,
      });
    }

    const haystack = `${error.name}: ${error.message} ${describeCause(error)}`;
    for (const hint of NETWORK_ERROR_HINTS) {
      if (hint.pattern.test(haystack)) {
        return new AppError({
          code: hint.code,
          message: scrubString(`네트워크 오류가 발생했습니다: ${error.message}`),
          retryable: hint.code !== 'tls-error',
          cause: error,
        });
      }
    }

    if (error instanceof SyntaxError) {
      return new AppError({
        code: 'invalid-response',
        message: 'API 응답을 JSON 으로 해석하지 못했습니다.',
        retryable: false,
        cause: error,
      });
    }

    return new AppError({
      code: 'internal-error',
      message: scrubString(error.message || fallbackMessage),
      retryable: false,
      cause: error,
    });
  }

  return new AppError({ code: 'internal-error', message: fallbackMessage, retryable: false });
}

function describeCause(error: Error): string {
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const causeCode = (cause as unknown as { code?: unknown }).code;
    return `${cause.name}: ${cause.message} ${typeof causeCode === 'string' ? causeCode : ''}`;
  }
  if (typeof cause === 'string') return cause;
  const errorCode = (error as unknown as { code?: unknown }).code;
  return typeof errorCode === 'string' ? errorCode : '';
}

/** MCP 응답으로 반환할 정규화된 오류 envelope 을 만든다. */
export function normalizeError(error: unknown, operationId?: string): NormalizedErrorEnvelope {
  const appError = toAppError(error);
  const body: NormalizedErrorBody = {
    code: appError.code,
    message: scrubString(appError.message),
    ...(appError.requestId ? { requestId: appError.requestId } : {}),
    retryable: appError.retryable,
    ...(appError.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: appError.retryAfterSeconds }
      : {}),
    ...(appError.upstreamCode ? { upstreamCode: appError.upstreamCode } : {}),
    ...(appError.details ? { details: redact(appError.details) as Record<string, unknown> } : {}),
  };

  return {
    ok: false,
    ...(operationId ? { operationId } : {}),
    ...(appError.httpStatus !== undefined ? { httpStatus: appError.httpStatus } : {}),
    error: body,
  };
}
