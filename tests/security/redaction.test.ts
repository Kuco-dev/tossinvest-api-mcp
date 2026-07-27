import { beforeEach, describe, expect, it } from 'vitest';
import { assertBaseUrlAllowed, assertSpecUrlAllowed, loadConfig } from '../../src/config/env.js';
import { normalizeError } from '../../src/errors/error-normalizer.js';
import {
  clearRegisteredSecrets,
  maskIdentifier,
  redact,
  redactHeaders,
  registerSecret,
  scrubString,
} from '../../src/security/redaction.js';
import { assertMethodAllowed, buildPath } from '../../src/security/url-policy.js';
import { safeJsonParse, stripDangerousKeys } from '../../src/utils/json.js';

beforeEach(() => {
  clearRegisteredSecrets();
});

describe('redaction', () => {
  it('등록된 비밀값을 문자열에서 제거한다', () => {
    registerSecret('s_supersecretvalue_1234');
    expect(scrubString('secret is s_supersecretvalue_1234 here')).not.toContain(
      's_supersecretvalue_1234'
    );
  });

  it('너무 짧은 값은 오탐 방지를 위해 등록하지 않는다', () => {
    registerSecret('1');
    expect(scrubString('account 1')).toBe('account 1');
  });

  it('Bearer 토큰을 마스킹한다', () => {
    expect(scrubString('Authorization: Bearer abcdefghijklmnop')).not.toContain('abcdefghijklmnop');
  });

  it('JWT 형태를 마스킹한다', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abcdefghijk';
    expect(scrubString(`token=${jwt}`)).not.toContain(jwt);
  });

  it('form-urlencoded 비밀값을 마스킹한다', () => {
    expect(scrubString('grant_type=client_credentials&client_secret=abc123xyz')).not.toContain(
      'abc123xyz'
    );
  });

  it('민감 키 값을 REDACTED 로 치환한다', () => {
    const result = redact({
      clientSecret: 'super-secret',
      accessToken: 'tok',
      authorization: 'Bearer x',
      symbol: '005930',
    }) as Record<string, string>;

    expect(result.clientSecret).toBe('[REDACTED]');
    expect(result.accessToken).toBe('[REDACTED]');
    expect(result.authorization).toBe('[REDACTED]');
    expect(result.symbol).toBe('005930');
  });

  it('식별자를 마스킹한다', () => {
    const result = redact({ clientId: 'c_01HXYZABCDEFG123456789', account: '1' }) as Record<
      string,
      string
    >;
    expect(result.clientId).not.toBe('c_01HXYZABCDEFG123456789');
    expect(result.clientId).toContain('*');
    expect(result.account).toBe('*');
  });

  it('자산 정보를 옵션에 따라 제거한다', () => {
    const payload = { holdings: [{ symbol: '005930' }], quantity: '100' };
    expect(redact(payload)).toMatchObject({ quantity: '100' });
    expect(redact(payload, { redactPrivatePayload: true })).toMatchObject({
      holdings: '[REDACTED]',
      quantity: '[REDACTED]',
    });
  });

  it('순환 참조를 안전하게 처리한다', () => {
    const node: Record<string, unknown> = { name: 'a' };
    node.self = node;
    expect(() => JSON.stringify(redact(node))).not.toThrow();
  });

  it('prototype pollution 키를 제거한다', () => {
    const payload = safeJsonParse('{"a":1,"__proto__":{"polluted":true}}');
    const result = redact(payload) as Record<string, unknown>;
    expect(Object.keys(result)).toEqual(['a']);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('짧은 식별자는 전체를 가린다', () => {
    expect(maskIdentifier('1')).toBe('*');
    expect(maskIdentifier('123456')).toBe('******');
    expect(maskIdentifier('12345678901')).toBe('12*******01');
  });

  it('헤더에서 Authorization 을 제거한다', () => {
    const result = redactHeaders({
      authorization: 'Bearer secrettokenvalue',
      'X-Tossinvest-Account': '1234567890',
      accept: 'application/json',
    });
    expect(result.authorization).toBe('[REDACTED]');
    expect(result['X-Tossinvest-Account']).not.toBe('1234567890');
    expect(result.accept).toBe('application/json');
  });
});

describe('오류 정규화', () => {
  it('stack trace 를 MCP 응답에 노출하지 않는다', () => {
    const error = new Error('boom');
    const normalized = normalizeError(error, 'getPrices');
    expect(JSON.stringify(normalized)).not.toContain('at ');
    expect(normalized).toMatchObject({ ok: false, operationId: 'getPrices' });
  });

  it('오류 메시지에서 비밀값을 제거한다', () => {
    registerSecret('s_leaked_secret_value');
    const normalized = normalizeError(new Error('failed with s_leaked_secret_value'));
    expect(JSON.stringify(normalized)).not.toContain('s_leaked_secret_value');
  });

  it('AbortError 를 timeout 으로 분류한다', () => {
    const error = new Error('aborted');
    error.name = 'AbortError';
    expect(normalizeError(error).error.code).toBe('request-timeout');
  });

  it('DNS / TLS 오류를 구분한다', () => {
    expect(normalizeError(new Error('getaddrinfo ENOTFOUND example')).error.code).toBe('dns-error');
    expect(normalizeError(new Error('CERT_HAS_EXPIRED')).error.code).toBe('tls-error');
    expect(normalizeError(new Error('socket hang up')).error.code).toBe('network-error');
  });
});

describe('URL 정책', () => {
  it('기본 설정에서 공식 도메인만 허용한다', () => {
    expect(() => assertBaseUrlAllowed('https://openapi.tossinvest.com', false)).not.toThrow();
    expect(() => assertBaseUrlAllowed('https://evil.example.com', false)).toThrowError(
      /공식 토스증권 도메인/
    );
    expect(() => assertBaseUrlAllowed('http://openapi.tossinvest.com', false)).toThrow();
  });

  it('custom base URL 을 허용해도 HTTPS 또는 로컬만 가능하다', () => {
    expect(() => assertBaseUrlAllowed('https://staging.example.com', true)).not.toThrow();
    expect(() => assertBaseUrlAllowed('http://localhost:8080', true)).not.toThrow();
    expect(() => assertBaseUrlAllowed('http://evil.example.com', true)).toThrowError(/HTTPS/);
    expect(() => assertBaseUrlAllowed('file:///etc/passwd', true)).toThrow();
  });

  it('명세 URL 도 동일한 정책을 적용한다', () => {
    expect(() =>
      assertSpecUrlAllowed('https://openapi.tossinvest.com/openapi-docs/latest/openapi.json', false)
    ).not.toThrow();
    expect(() => assertSpecUrlAllowed('http://evil.example.com/spec.json', false)).toThrow();
  });

  it('허용되지 않는 method 를 거부한다', () => {
    expect(assertMethodAllowed('get')).toBe('GET');
    expect(() => assertMethodAllowed('TRACE')).toThrowError(/지원하지 않는 HTTP method/);
  });

  it('path traversal 을 차단한다', () => {
    expect(() => buildPath('/api/v1/stocks/{symbol}', { symbol: '../../secret' })).toThrow();
    expect(buildPath('/api/v1/stocks/{symbol}', { symbol: 'AAPL' })).toBe('/api/v1/stocks/AAPL');
  });
});

describe('환경변수 검증', () => {
  it('빈 환경에서도 기본값으로 동작한다', () => {
    const config = loadConfig({});
    expect(config.baseUrl).toBe('https://openapi.tossinvest.com');
    expect(config.enableTrading).toBe(false);
    expect(config.enableConditionalOrders).toBe(false);
    expect(config.enableRawRequests).toBe(false);
    expect(config.openapiStrict).toBe(true);
    expect(config.clientId).toBeUndefined();
  });

  it('boolean 문자열을 파싱한다', () => {
    expect(loadConfig({ TOSSINVEST_ENABLE_TRADING: 'true' }).enableTrading).toBe(true);
    expect(loadConfig({ TOSSINVEST_ENABLE_TRADING: '1' }).enableTrading).toBe(true);
    expect(loadConfig({ TOSSINVEST_ENABLE_TRADING: 'no' }).enableTrading).toBe(false);
    expect(loadConfig({ TOSSINVEST_ENABLE_TRADING: 'garbage' }).enableTrading).toBe(false);
  });

  it('숫자 범위를 강제한다', () => {
    expect(loadConfig({ TOSSINVEST_MAX_READ_RETRIES: '999' }).maxReadRetries).toBe(5);
    expect(loadConfig({ TOSSINVEST_REQUEST_TIMEOUT_MS: '10' }).requestTimeoutMs).toBe(1000);
  });

  it('custom base URL 이 꺼진 상태에서 비공식 URL 을 거부한다', () => {
    expect(() => loadConfig({ TOSSINVEST_BASE_URL: 'https://evil.example.com' })).toThrow();
  });

  it('인증 정보 없이도 설정 로드에 성공한다', () => {
    expect(() => loadConfig({ TOSSINVEST_CLIENT_ID: '', TOSSINVEST_CLIENT_SECRET: '' })).not.toThrow();
  });
});

describe('JSON 유틸', () => {
  it('prototype pollution 을 방지한다', () => {
    const parsed = safeJsonParse('{"__proto__":{"polluted":true},"ok":1}') as Record<string, unknown>;
    expect(parsed.ok).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('중첩된 위험 키를 제거한다', () => {
    const stripped = stripDangerousKeys(
      JSON.parse('{"a":{"__proto__":{"x":1},"b":2},"c":[{"constructor":1,"d":3}]}')
    ) as any;
    expect(stripped.a).toEqual({ b: 2 });
    expect(stripped.c[0]).toEqual({ d: 3 });
  });
});
