import {
  MAX_RETRY_AFTER_SECONDS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
} from '../config/constants.js';
import type { AppErrorCode } from '../errors/app-error.js';

export interface RetryDecisionInput {
  /** mutation 은 결과가 불확실할 수 있으므로 절대 자동 재시도하지 않는다. */
  readonly isMutation: boolean;
  readonly method: string;
  readonly attempt: number;
  readonly maxRetries: number;
  readonly httpStatus?: number;
  readonly errorCode?: AppErrorCode;
  readonly retryAfterSeconds?: number;
}

export interface RetryDecision {
  readonly shouldRetry: boolean;
  readonly delayMs: number;
  readonly reason: string;
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_ERROR_CODES = new Set<AppErrorCode>([
  'request-timeout',
  'network-error',
  'dns-error',
]);

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** exponential backoff + full jitter. */
export function computeBackoffMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  return Math.floor(exponential / 2 + random() * (exponential / 2));
}

/**
 * 재시도 여부를 결정한다.
 *
 * - mutation: 항상 재시도하지 않음 (timeout / 5xx 포함)
 * - 읽기 전용(GET): 제한된 조건에서만 재시도
 * - `Retry-After` 가 있으면 우선 적용하되 과도한 값은 거부
 */
export function decideRetry(
  input: RetryDecisionInput,
  random: () => number = Math.random
): RetryDecision {
  if (input.isMutation) {
    return { shouldRetry: false, delayMs: 0, reason: 'mutation 은 자동 재시도하지 않습니다.' };
  }
  if (!SAFE_METHODS.has(input.method.toUpperCase())) {
    return {
      shouldRetry: false,
      delayMs: 0,
      reason: '읽기 전용 method 가 아니므로 재시도하지 않습니다.',
    };
  }
  if (input.attempt >= input.maxRetries) {
    return { shouldRetry: false, delayMs: 0, reason: '최대 재시도 횟수에 도달했습니다.' };
  }

  const statusRetryable =
    input.httpStatus !== undefined && RETRYABLE_STATUSES.has(input.httpStatus);
  const codeRetryable = input.errorCode !== undefined && RETRYABLE_ERROR_CODES.has(input.errorCode);

  if (!statusRetryable && !codeRetryable) {
    return { shouldRetry: false, delayMs: 0, reason: '재시도 대상 오류가 아닙니다.' };
  }

  if (input.retryAfterSeconds !== undefined) {
    if (input.retryAfterSeconds > MAX_RETRY_AFTER_SECONDS) {
      return {
        shouldRetry: false,
        delayMs: 0,
        reason: `Retry-After(${input.retryAfterSeconds}s) 가 너무 길어 자동 재시도하지 않습니다.`,
      };
    }
    return {
      shouldRetry: true,
      delayMs: input.retryAfterSeconds * 1000,
      reason: 'Retry-After 헤더를 따릅니다.',
    };
  }

  return {
    shouldRetry: true,
    delayMs: computeBackoffMs(input.attempt, random),
    reason: 'exponential backoff 로 재시도합니다.',
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
