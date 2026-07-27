import { beforeEach, describe, expect, it } from 'vitest';
import { TokenManager } from '../../src/auth/token-manager.js';
import { buildRequest, serializeQuery } from '../../src/client/request-builder.js';
import { parseRateLimit, parseRetryAfter } from '../../src/client/rate-limit.js';
import { computeBackoffMs, decideRetry } from '../../src/client/retry-policy.js';
import { TossClient } from '../../src/client/toss-client.js';
import { buildOperationIndex, OperationRegistry } from '../../src/openapi/operation-index.js';
import { clearRegisteredSecrets } from '../../src/security/redaction.js';
import { createMockFetch, loadSnapshot, makeConfig, silentLogger, TOKEN_RESPONSE } from '../fixtures/helpers.js';

const snapshot = loadSnapshot();
const { operations } = buildOperationIndex(snapshot, { strict: true });
const registry = new OperationRegistry(operations);

const BASE = 'https://openapi.tossinvest.com';

function makeClient(specs: Parameters<typeof createMockFetch>[0], configOverrides = {}) {
  const config = makeConfig(configOverrides);
  const mock = createMockFetch(specs);
  const tokenManager = new TokenManager({ config, logger: silentLogger, fetchImpl: mock.fetch });
  const client = new TossClient({
    config,
    tokenManager,
    logger: silentLogger,
    fetchImpl: mock.fetch,
    sleepImpl: async () => {},
  });
  return { client, mock, config, tokenManager };
}

beforeEach(() => {
  clearRegisteredSecrets();
});

describe('요청 구성', () => {
  it('path parameter 를 인코딩한다', () => {
    const request = buildRequest({
      operation: registry.require('getStockWarnings'),
      baseUrl: BASE,
      path: { symbol: 'BRK.B' },
    });
    expect(request.url.pathname).toBe('/api/v1/stocks/BRK.B/warnings');
  });

  it('path traversal 시도를 차단한다', () => {
    expect(() =>
      buildRequest({
        operation: registry.require('getStockWarnings'),
        baseUrl: BASE,
        path: { symbol: '../../admin' },
      })
    ).toThrowError(/허용되지 않는 경로/);
  });

  it('path parameter 누락을 차단한다', () => {
    expect(() =>
      buildRequest({ operation: registry.require('getStockWarnings'), baseUrl: BASE, path: {} })
    ).toThrowError(/path parameter 가 누락/);
  });

  it('다중 symbol 쿼리를 직렬화한다', () => {
    const request = buildRequest({
      operation: registry.require('getPrices'),
      baseUrl: BASE,
      query: { symbols: '005930,AAPL' },
    });
    expect(request.url.searchParams.get('symbols')).toBe('005930,AAPL');
  });

  it('배열 쿼리를 반복 키로 직렬화한다', () => {
    const params = serializeQuery(registry.require('getOrders'), { status: ['FILLED', 'PENDING'] });
    expect(params.getAll('status')).toEqual(['FILLED', 'PENDING']);
  });

  it('명세에 없는 query parameter 를 거부한다', () => {
    expect(() =>
      buildRequest({
        operation: registry.require('getPrices'),
        baseUrl: BASE,
        query: { evil: '1' },
      })
    ).toThrowError(/정의되지 않은 query parameter/);
  });

  it('금지 헤더 이름을 인자로 넘기면 차단한다', () => {
    expect(() =>
      buildRequest({
        operation: registry.require('getPrices'),
        baseUrl: BASE,
        query: { Authorization: 'Bearer x' },
      })
    ).toThrowError(/직접 지정할 수 없는 헤더/);
  });

  it('JSON body 를 직렬화하며 decimal string 을 유지한다', () => {
    const request = buildRequest({
      operation: registry.require('createOrder'),
      baseUrl: BASE,
      account: '1',
      body: { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '10', price: '70000.55' },
    });
    expect(request.headers['content-type']).toBe('application/json');
    expect(request.body).toContain('"price":"70000.55"');
    expect(request.body).not.toContain('70000.55,');
  });

  it('prototype pollution 키를 body 에서 제거한다', () => {
    const request = buildRequest({
      operation: registry.require('createOrder'),
      baseUrl: BASE,
      account: '1',
      body: JSON.parse('{"symbol":"005930","__proto__":{"polluted":true}}'),
    });
    expect(request.body).not.toContain('__proto__');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('계좌 선택', () => {
  it('명시적 account 를 사용한다', () => {
    const request = buildRequest({
      operation: registry.require('getHoldings'),
      baseUrl: BASE,
      account: '7',
      defaultAccount: '9',
    });
    expect(request.headers['X-Tossinvest-Account']).toBe('7');
  });

  it('account 가 없으면 기본 account 를 사용한다', () => {
    const request = buildRequest({
      operation: registry.require('getHoldings'),
      baseUrl: BASE,
      defaultAccount: '9',
    });
    expect(request.headers['X-Tossinvest-Account']).toBe('9');
  });

  it('둘 다 없으면 요청을 만들지 않는다', () => {
    expect(() =>
      buildRequest({ operation: registry.require('getHoldings'), baseUrl: BASE })
    ).toThrowError(/계좌 지정이 필요합니다/);
  });

  it('계좌가 필요 없는 API 에는 계좌 헤더를 붙이지 않는다', () => {
    const request = buildRequest({
      operation: registry.require('getPrices'),
      baseUrl: BASE,
      query: { symbols: '005930' },
      defaultAccount: '9',
    });
    expect(request.headers['X-Tossinvest-Account']).toBeUndefined();
  });

  it('숫자가 아닌 account 를 거부한다 (헤더 인젝션 방지)', () => {
    expect(() =>
      buildRequest({
        operation: registry.require('getHoldings'),
        baseUrl: BASE,
        account: '1\r\nX-Evil: 1',
      })
    ).toThrowError(/accountSeq/);
  });
});

describe('rate limit 파싱', () => {
  it('rate limit 헤더를 추출한다', () => {
    const headers = new Headers({
      'x-ratelimit-limit': '10',
      'x-ratelimit-remaining': '9',
      'x-ratelimit-reset': '1',
    });
    expect(parseRateLimit(headers)).toEqual({ limit: 10, remaining: 9, resetSeconds: 1 });
  });

  it('Retry-After 를 초 단위로 파싱한다', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '3' }))).toBe(3);
  });

  it('Retry-After 를 HTTP-date 로도 파싱한다', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const headers = new Headers({ 'retry-after': 'Thu, 01 Jan 2026 00:00:05 GMT' });
    expect(parseRetryAfter(headers, now)).toBe(5);
  });

  it('헤더가 없으면 undefined 를 반환한다', () => {
    expect(parseRateLimit(new Headers())).toBeUndefined();
  });
});

describe('재시도 정책', () => {
  it('mutation 은 절대 재시도하지 않는다', () => {
    for (const status of [408, 429, 500, 502, 503, 504]) {
      expect(
        decideRetry({ isMutation: true, method: 'POST', attempt: 0, maxRetries: 3, httpStatus: status })
          .shouldRetry
      ).toBe(false);
    }
    expect(
      decideRetry({
        isMutation: true,
        method: 'POST',
        attempt: 0,
        maxRetries: 3,
        errorCode: 'request-timeout',
      }).shouldRetry
    ).toBe(false);
  });

  it('읽기 GET 의 429 는 재시도한다', () => {
    const decision = decideRetry({
      isMutation: false,
      method: 'GET',
      attempt: 0,
      maxRetries: 2,
      httpStatus: 429,
      retryAfterSeconds: 1,
    });
    expect(decision.shouldRetry).toBe(true);
    expect(decision.delayMs).toBe(1000);
  });

  it('과도한 Retry-After 는 재시도하지 않는다', () => {
    expect(
      decideRetry({
        isMutation: false,
        method: 'GET',
        attempt: 0,
        maxRetries: 2,
        httpStatus: 429,
        retryAfterSeconds: 600,
      }).shouldRetry
    ).toBe(false);
  });

  it('입력 오류와 인증 실패는 재시도하지 않는다', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(
        decideRetry({ isMutation: false, method: 'GET', attempt: 0, maxRetries: 2, httpStatus: status })
          .shouldRetry
      ).toBe(false);
    }
  });

  it('최대 재시도 횟수를 넘지 않는다', () => {
    expect(
      decideRetry({ isMutation: false, method: 'GET', attempt: 2, maxRetries: 2, httpStatus: 500 })
        .shouldRetry
    ).toBe(false);
  });

  it('backoff 에 jitter 를 적용한다', () => {
    expect(computeBackoffMs(0, () => 0)).toBe(125);
    expect(computeBackoffMs(0, () => 1)).toBe(250);
    expect(computeBackoffMs(5, () => 0)).toBeLessThanOrEqual(8000);
  });
});

describe('TossClient 통합', () => {
  it('읽기 요청에 토큰을 붙이고 result 를 언랩한다', async () => {
    const { client, mock } = makeClient([
      { body: TOKEN_RESPONSE },
      {
        body: { result: [{ symbol: '005930', close: '70000' }] },
        headers: { 'x-request-id': 'req-1', 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '9' },
      },
    ]);

    const response = await client.call(registry.require('getPrices'), {
      query: { symbols: '005930' },
    });

    expect(response.ok).toBe(true);
    expect(response.httpStatus).toBe(200);
    expect(response.requestId).toBe('req-1');
    expect(response.rateLimit).toEqual({ limit: 10, remaining: 9 });
    expect(response.result).toEqual([{ symbol: '005930', close: '70000' }]);
    expect(mock.calls[1]!.headers.authorization).toBe(`Bearer ${TOKEN_RESPONSE.access_token}`);
  });

  it('decimal string 정밀도를 유지한다', async () => {
    const { client } = makeClient([
      { body: TOKEN_RESPONSE },
      { body: { result: { price: '12345678901234567890.123456' } } },
    ]);

    const response = await client.call(registry.require('getPrices'), {
      query: { symbols: '005930' },
    });
    expect((response.result as { price: string }).price).toBe('12345678901234567890.123456');
  });

  it('4xx 를 정규화한다', async () => {
    const { client } = makeClient([
      { body: TOKEN_RESPONSE },
      {
        status: 404,
        body: { error: { requestId: 'req-2', code: 'stock-not-found', message: '종목을 찾을 수 없습니다.' } },
      },
    ]);

    await expect(
      client.call(registry.require('getPrices'), { query: { symbols: 'ZZZZ' } })
    ).rejects.toMatchObject({
      code: 'not-found',
      httpStatus: 404,
      requestId: 'req-2',
      upstreamCode: 'stock-not-found',
    });
  });

  it('429 를 Retry-After 만큼 기다렸다가 재시도한다', async () => {
    const { client, mock } = makeClient([
      { body: TOKEN_RESPONSE },
      {
        status: 429,
        body: { error: { requestId: 'r', code: 'rate-limit-exceeded', message: '초과' } },
        headers: { 'retry-after': '1' },
      },
      { body: { result: { ok: true } } },
    ]);

    const response = await client.call(registry.require('getPrices'), {
      query: { symbols: '005930' },
    });
    expect(response.ok).toBe(true);
    expect(mock.calls).toHaveLength(3);
  });

  it('HTML 오류 페이지를 그대로 노출하지 않는다', async () => {
    const { client } = makeClient([
      { body: TOKEN_RESPONSE },
      {
        status: 502,
        rawBody: '<html><body>Gateway Error<br/>stack trace here</body></html>',
        headers: { 'content-type': 'text/html' },
      },
    ]);

    await expect(
      client.call(registry.require('getPrices'), { query: { symbols: '005930' } })
    ).rejects.toMatchObject({ code: 'upstream-error' });
  });

  it('응답 크기 제한을 적용한다', async () => {
    const { client } = makeClient(
      [{ body: TOKEN_RESPONSE }, { body: { result: 'x'.repeat(5000) } }],
      { maxResponseBytes: 1024 }
    );

    await expect(
      client.call(registry.require('getPrices'), { query: { symbols: '005930' } })
    ).rejects.toMatchObject({ code: 'response-too-large' });
  });

  it('읽기 요청의 401 은 토큰을 1회 갱신하고 1회만 재시도한다', async () => {
    const { client, mock } = makeClient([
      { body: TOKEN_RESPONSE },
      { status: 401, body: { error: { requestId: 'r', code: 'invalid-token', message: '만료' } } },
      { body: TOKEN_RESPONSE },
      { body: { result: { ok: true } } },
    ]);

    const response = await client.call(registry.require('getPrices'), {
      query: { symbols: '005930' },
    });

    expect(response.ok).toBe(true);
    // token, 401, token 재발급, 성공
    expect(mock.calls).toHaveLength(4);
    expect(mock.calls[2]!.url).toContain('/oauth2/token');
  });

  it('401 이 반복되면 무한 재시도하지 않는다', async () => {
    const { client, mock } = makeClient([
      { body: TOKEN_RESPONSE },
      { status: 401, body: { error: { requestId: 'r', code: 'invalid-token', message: '만료' } } },
      { body: TOKEN_RESPONSE },
      { status: 401, body: { error: { requestId: 'r', code: 'invalid-token', message: '만료' } } },
    ]);

    await expect(
      client.call(registry.require('getPrices'), { query: { symbols: '005930' } })
    ).rejects.toMatchObject({ code: 'auth-failed' });
    expect(mock.calls).toHaveLength(4);
  });

  it('mutation 의 500 은 자동 재시도하지 않고 결과 불확실로 보고한다', async () => {
    const { client, mock } = makeClient(
      [{ body: TOKEN_RESPONSE }, { status: 500, body: { error: { requestId: 'r', code: 'internal-error', message: '오류' } } }],
      { enableTrading: true }
    );

    await expect(
      client.call(registry.require('createOrder'), {
        account: '1',
        body: { symbol: '005930', side: 'BUY', orderType: 'MARKET', quantity: '1', clientOrderId: 'abc-1' },
      })
    ).rejects.toMatchObject({
      code: 'mutation-result-unknown',
      retryable: false,
    });

    // token + 실제 요청 1회. 재시도 없음.
    expect(mock.calls).toHaveLength(2);
  });

  it('mutation timeout 도 자동 재시도하지 않는다', async () => {
    const abortError = new Error('The operation was aborted');
    abortError.name = 'AbortError';
    const { client, mock } = makeClient(
      [{ body: TOKEN_RESPONSE }, { throws: abortError }],
      { enableTrading: true }
    );

    await expect(
      client.call(registry.require('cancelOrder'), {
        account: '1',
        path: { orderId: 'order-token-1' },
        body: {},
      })
    ).rejects.toMatchObject({ code: 'mutation-result-unknown' });
    expect(mock.calls).toHaveLength(2);
  });

  it('mutation 불확실 오류에 clientOrderId 와 후속 안내를 포함한다', async () => {
    const { client } = makeClient(
      [{ body: TOKEN_RESPONSE }, { status: 503, body: { error: { requestId: 'r', code: 'maintenance', message: '점검' } } }],
      { enableTrading: true, defaultAccount: '1234567890' }
    );

    await expect(
      client.call(registry.require('createOrder'), {
        body: { symbol: '005930', side: 'BUY', orderType: 'MARKET', quantity: '1', clientOrderId: 'my-order-9' },
      })
    ).rejects.toMatchObject({
      code: 'mutation-result-unknown',
      details: expect.objectContaining({
        clientOrderId: 'my-order-9',
        nextStep: expect.stringContaining('주문내역'),
      }),
    });
  });
});
