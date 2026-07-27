import {
  MASK_KEY_PATTERNS,
  PRIVATE_PAYLOAD_KEY_PATTERNS,
  REDACTED,
  SECRET_KEY_PATTERNS,
} from './sensitive-fields.js';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** 등록된 리터럴 비밀값. 문자열 어디에 등장하든 제거한다. */
const registeredSecrets = new Set<string>();

export function registerSecret(secret: string | undefined | null): void {
  if (typeof secret !== 'string') return;
  const trimmed = secret.trim();
  // 너무 짧은 값은 오탐(예: "1")을 유발하므로 등록하지 않는다.
  if (trimmed.length < 8) return;
  registeredSecrets.add(trimmed);
}

export function clearRegisteredSecrets(): void {
  registeredSecrets.clear();
}

/** 문자열에서 등록된 비밀값과 Bearer 토큰 패턴을 제거한다. */
export function scrubString(input: string): string {
  let output = input;
  for (const secret of registeredSecrets) {
    if (secret && output.includes(secret)) {
      output = output.split(secret).join(REDACTED);
    }
  }
  output = output.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/=]{8,}/gi, `$1 ${REDACTED}`);
  output = output.replace(
    /\b(client_secret|access_token|refresh_token)=([^&\s"']+)/gi,
    `$1=${REDACTED}`
  );
  // JWT 형태 (header.payload.signature)
  output = output.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, REDACTED);
  return output;
}

/**
 * 식별자 마스킹. 앞 2자와 뒤 2자만 남긴다.
 * 짧은 값(예: 계좌 seq "1")은 값 자체가 노출되지 않도록 전부 가린다.
 */
export function maskIdentifier(value: string | number | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  if (text.length === 0) return '';
  if (text.length <= 6) return '*'.repeat(text.length);
  return `${text.slice(0, 2)}${'*'.repeat(Math.max(text.length - 4, 1))}${text.slice(-2)}`;
}

function matchesAny(key: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(key));
}

export interface RedactOptions {
  /** 자산/보유 정보까지 제거할지 여부. 로그 출력 시 true. */
  readonly redactPrivatePayload?: boolean;
  /** 재귀 최대 깊이. */
  readonly maxDepth?: number;
}

/**
 * 임의 값을 로그/오류 출력에 안전한 형태로 변환한다.
 * prototype pollution 을 막기 위해 위험한 키는 제거한다.
 */
export function redact(value: unknown, options: RedactOptions = {}): unknown {
  const maxDepth = options.maxDepth ?? 8;
  return redactInternal(value, options, maxDepth, new WeakSet());
}

function redactInternal(
  value: unknown,
  options: RedactOptions,
  depth: number,
  seen: WeakSet<object>
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return value.toString();

  if (value instanceof Error) {
    return {
      name: value.name,
      message: scrubString(value.message),
      ...(value.stack ? { stack: scrubString(value.stack) } : {}),
    };
  }

  if (depth <= 0) return '[Truncated]';

  if (Array.isArray(value)) {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);
    const limit = 50;
    const items = value
      .slice(0, limit)
      .map((item) => redactInternal(item, options, depth - 1, seen));
    if (value.length > limit) items.push(`[+${value.length - limit} more]`);
    return items;
  }

  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);
    const source = value as Record<string, unknown>;
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(source)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      if (matchesAny(key, SECRET_KEY_PATTERNS)) {
        output[key] = REDACTED;
        continue;
      }
      if (matchesAny(key, MASK_KEY_PATTERNS)) {
        const raw = source[key];
        output[key] =
          typeof raw === 'string' || typeof raw === 'number' ? maskIdentifier(raw) : REDACTED;
        continue;
      }
      if (options.redactPrivatePayload && matchesAny(key, PRIVATE_PAYLOAD_KEY_PATTERNS)) {
        output[key] = REDACTED;
        continue;
      }
      output[key] = redactInternal(source[key], options, depth - 1, seen);
    }
    return { ...output };
  }

  return String(value);
}

/** 요청 헤더를 로그에 남기기 전에 안전화한다. */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (matchesAny(lower, SECRET_KEY_PATTERNS)) {
      output[key] = REDACTED;
    } else if (matchesAny(lower, MASK_KEY_PATTERNS)) {
      output[key] = maskIdentifier(value) ?? REDACTED;
    } else {
      output[key] = scrubString(value);
    }
  }
  return output;
}
