const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * prototype pollution 을 방지하는 JSON 파서.
 *
 * 금융 데이터의 정밀도는 토스증권 명세가 금액/수량/가격을 decimal string 으로
 * 정의하기 때문에 보존된다. 이 파서는 숫자를 임의로 문자열화하지 않지만,
 * string 으로 온 값을 number 로 바꾸지도 않는다.
 */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(text, function reviver(key, value) {
    if (DANGEROUS_KEYS.has(key)) return undefined;
    return value;
  });
}

/** 순환 참조를 안전하게 처리하는 직렬화. */
export function safeJsonStringify(value: unknown, space = 2): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(
    value,
    (_key, current) => {
      if (typeof current === 'bigint') return current.toString();
      if (typeof current === 'object' && current !== null) {
        if (seen.has(current)) return '[Circular]';
        seen.add(current);
      }
      return current;
    },
    space
  );
}

/** 평범한 객체인지 확인 (배열/null 제외). */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 위험한 키를 재귀적으로 제거한 사본을 만든다. */
export function stripDangerousKeys<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => stripDangerousKeys(item)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      output[key] = stripDangerousKeys(value[key]);
    }
    return output as T;
  }
  return value;
}
