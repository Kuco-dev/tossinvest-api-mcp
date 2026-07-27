import type { TokenManager } from '../auth/token-manager.js';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { toAppError } from '../errors/error-normalizer.js';
import type { OperationInfo } from '../openapi/operation-index.js';
import { maskIdentifier, redactHeaders } from '../security/redaction.js';
import type { Logger } from '../utils/logger.js';
import type { RateLimitInfo } from './rate-limit.js';
import { buildRequest, type BuiltRequest } from './request-builder.js';
import { parseResponse, unwrapResult } from './response-parser.js';
import { decideRetry, sleep } from './retry-policy.js';

export interface CallOptions {
  readonly path?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly account?: string;
}

export interface CallSuccess {
  readonly ok: true;
  readonly operationId: string;
  readonly httpStatus: number;
  readonly requestId?: string;
  readonly rateLimit?: RateLimitInfo;
  readonly result: unknown;
}

export interface TossClientOptions {
  readonly config: AppConfig;
  readonly tokenManager: TokenManager;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

/**
 * 토스증권 API 호출 클라이언트.
 *
 * 안전정책:
 * - mutation 은 어떤 경우에도 자동 재시도하지 않는다.
 * - 읽기 전용 GET 만 제한적으로 재시도한다.
 * - 401 은 읽기 요청에 한해 토큰을 1회 갱신하고 1회만 재시도한다.
 */
export class TossClient {
  private readonly config: AppConfig;
  private readonly tokenManager: TokenManager;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;

  constructor(options: TossClientOptions) {
    this.config = options.config;
    this.tokenManager = options.tokenManager;
    this.logger = options.logger.child('client');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleepImpl = options.sleepImpl ?? sleep;
  }

  async call(operation: OperationInfo, options: CallOptions): Promise<CallSuccess> {
    const isMutation = operation.mutation !== 'none';

    const request = buildRequest({
      operation,
      baseUrl: this.config.baseUrl,
      ...(options.path ? { path: options.path } : {}),
      ...(options.query ? { query: options.query } : {}),
      ...(options.body !== undefined ? { body: options.body } : {}),
      ...(options.account !== undefined ? { account: options.account } : {}),
      ...(this.config.defaultAccount !== undefined
        ? { defaultAccount: this.config.defaultAccount }
        : {}),
    });

    this.logger.debug('API 요청을 준비했습니다.', {
      operationId: operation.operationId,
      method: request.method,
      path: operation.path,
      account: request.accountUsed ? maskIdentifier(request.accountUsed) : undefined,
      headers: redactHeaders(request.headers),
    });

    let attempt = 0;
    let tokenRefreshed = false;

    for (;;) {
      try {
        const parsed = await this.executeOnce(operation, request, isMutation);
        return {
          ok: true,
          operationId: operation.operationId,
          httpStatus: parsed.httpStatus,
          ...(parsed.requestId ? { requestId: parsed.requestId } : {}),
          ...(parsed.rateLimit ? { rateLimit: parsed.rateLimit } : {}),
          result: unwrapResult(parsed.body),
        };
      } catch (rawError) {
        const error = toAppError(rawError);

        // 401: 읽기 전용 요청에 한해 토큰을 1회 갱신하고 1회만 재시도한다.
        // mutation 은 중복 주문 위험이 있으므로 재시도하지 않는다.
        if (
          error.httpStatus === 401 &&
          !isMutation &&
          operation.method === 'GET' &&
          !tokenRefreshed &&
          error.code !== 'credentials-missing' &&
          error.upstreamCode !== 'invalid_client'
        ) {
          tokenRefreshed = true;
          this.tokenManager.invalidate();
          this.logger.info('401 응답으로 access token 을 1회 갱신하고 재시도합니다.', {
            operationId: operation.operationId,
          });
          continue;
        }

        const decision = decideRetry({
          isMutation,
          method: request.method,
          attempt,
          maxRetries: this.config.maxReadRetries,
          ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
          errorCode: error.code,
          ...(error.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: error.retryAfterSeconds }
            : {}),
        });

        if (decision.shouldRetry) {
          attempt += 1;
          this.logger.warn('읽기 요청을 재시도합니다.', {
            operationId: operation.operationId,
            attempt,
            delayMs: decision.delayMs,
            reason: decision.reason,
            code: error.code,
          });
          await this.sleepImpl(decision.delayMs);
          continue;
        }

        throw this.decorateError(error, operation, isMutation, request);
      }
    }
  }

  private async executeOnce(operation: OperationInfo, request: BuiltRequest, isMutation: boolean) {
    const headers: Record<string, string> = { ...request.headers };

    if (operation.requiresAuth) {
      // Authorization 은 전송 직전에만 생성하며 어디에도 저장/로깅하지 않는다.
      headers.authorization = await this.tokenManager.getAuthorizationHeader();
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await this.fetchImpl(request.url.toString(), {
        method: request.method,
        headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        signal: controller.signal,
      });

      return await parseResponse(response, {
        maxBytes: this.config.maxResponseBytes,
        isMutation,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  /** mutation 이 불확실한 상태로 끝났으면 사용자에게 경고를 추가한다. */
  private decorateError(
    error: AppError,
    operation: OperationInfo,
    isMutation: boolean,
    request: BuiltRequest
  ): AppError {
    const uncertain =
      isMutation &&
      (error.code === 'request-timeout' ||
        error.code === 'network-error' ||
        error.code === 'dns-error' ||
        (error.httpStatus !== undefined && error.httpStatus >= 500));

    if (!uncertain) return error;

    const clientOrderId = extractClientOrderId(request.body);

    return new AppError({
      code: 'mutation-result-unknown',
      message:
        `${operation.operationId} 요청의 결과가 불확실합니다. 자동 재시도하지 않았습니다. ` +
        '주문이 접수되었을 수 있으므로 반드시 getOrders / getOrder (조건주문은 getConditionalOrders) 로 상태를 확인한 뒤 재요청하세요.',
      ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
      retryable: false,
      details: {
        originalErrorCode: error.code,
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
        account: request.accountUsed ? maskIdentifier(request.accountUsed) : undefined,
        ...(clientOrderId ? { clientOrderId } : {}),
        nextStep: '주문내역 조회 API 로 접수 여부를 확인하세요.',
      },
      cause: error,
    });
  }
}

function extractClientOrderId(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const value = parsed.clientOrderId;
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}
