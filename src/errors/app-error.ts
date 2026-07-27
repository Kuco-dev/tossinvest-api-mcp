/**
 * 정규화된 오류 코드.
 * 토스증권 API 가 내려주는 flat string code 는 별도로 `upstreamCode` 에 보존한다.
 */
export type AppErrorCode =
  | 'invalid-input'
  | 'schema-validation-failed'
  | 'openapi-load-failed'
  | 'openapi-invalid'
  | 'operation-not-found'
  | 'credentials-missing'
  | 'auth-failed'
  | 'ip-not-allowed'
  | 'account-header-required'
  | 'account-not-found'
  | 'not-found'
  | 'invalid-order-request'
  | 'order-hours-violation'
  | 'forbidden'
  | 'forbidden-header'
  | 'forbidden-target'
  | 'rate-limit-exceeded'
  | 'request-timeout'
  | 'network-error'
  | 'dns-error'
  | 'tls-error'
  | 'response-too-large'
  | 'invalid-response'
  | 'upstream-error'
  | 'mutation-blocked'
  | 'mutation-result-unknown'
  | 'trading-disabled'
  | 'feature-disabled'
  | 'internal-error';

export interface AppErrorInit {
  readonly code: AppErrorCode;
  readonly message: string;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
  readonly details?: Record<string, unknown>;
  readonly upstreamCode?: string;
  readonly cause?: unknown;
}

/** MCP 응답으로 안전하게 직렬화 가능한 오류. */
export class AppError extends Error {
  public override readonly name = 'AppError';
  public readonly code: AppErrorCode;
  public readonly httpStatus?: number;
  public readonly requestId?: string;
  public readonly retryable: boolean;
  public readonly retryAfterSeconds?: number;
  public readonly details?: Record<string, unknown>;
  public readonly upstreamCode?: string;

  constructor(init: AppErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.code = init.code;
    this.httpStatus = init.httpStatus;
    this.requestId = init.requestId;
    this.retryable = init.retryable ?? false;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.details = init.details;
    this.upstreamCode = init.upstreamCode;
  }

  static isAppError(value: unknown): value is AppError {
    return value instanceof AppError;
  }
}
