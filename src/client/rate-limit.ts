export interface RateLimitInfo {
  readonly limit?: number;
  readonly remaining?: number;
  readonly resetSeconds?: number;
  readonly retryAfterSeconds?: number;
}

function parseIntHeader(headers: Headers, name: string): number | undefined {
  const raw = headers.get(name);
  if (raw === null) return undefined;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(value) ? value : undefined;
}

/** `Retry-After` 는 초 또는 HTTP-date 를 허용한다. */
export function parseRetryAfter(headers: Headers, now: number = Date.now()): number | undefined {
  const raw = headers.get('retry-after');
  if (raw === null) return undefined;
  const trimmed = raw.trim();

  const seconds = Number.parseInt(trimmed, 10);
  if (Number.isFinite(seconds) && String(seconds) === trimmed) {
    return Math.max(seconds, 0);
  }

  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    return Math.max(Math.ceil((date - now) / 1000), 0);
  }
  return undefined;
}

/** 응답 헤더에서 rate limit 메타데이터를 추출한다. */
export function parseRateLimit(headers: Headers, now: number = Date.now()): RateLimitInfo | undefined {
  const limit = parseIntHeader(headers, 'x-ratelimit-limit');
  const remaining = parseIntHeader(headers, 'x-ratelimit-remaining');
  const resetSeconds = parseIntHeader(headers, 'x-ratelimit-reset');
  const retryAfterSeconds = parseRetryAfter(headers, now);

  if (
    limit === undefined &&
    remaining === undefined &&
    resetSeconds === undefined &&
    retryAfterSeconds === undefined
  ) {
    return undefined;
  }

  return {
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(resetSeconds !== undefined ? { resetSeconds } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}
