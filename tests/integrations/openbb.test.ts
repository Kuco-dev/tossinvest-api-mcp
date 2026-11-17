import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import {
  assertOpenBbUrlAllowed,
  DISABLED_OPENBB_CONFIG,
  type OpenBbConfig,
} from '../../src/integrations/openbb/config.js';
import { OpenBbClient } from '../../src/integrations/openbb/openbb-client.js';
import { findMissingSymbols } from '../../src/integrations/openbb/openbb-tools.js';
import { toOpenBbSymbol } from '../../src/integrations/openbb/symbol-mapper.js';
import { clearRegisteredSecrets, scrubString } from '../../src/security/redaction.js';
import { createServer, type BuiltServer } from '../../src/server.js';
import {
  createMockFetch,
  makeConfig,
  silentLogger,
  TOKEN_RESPONSE,
  type MockResponseSpec,
} from '../fixtures/helpers.js';

const OPENBB: OpenBbConfig = {
  enabled: true,
  baseUrl: 'http://127.0.0.1:6900',
  allowRemote: false,
  provider: 'yfinance',
};

const obb = (results: unknown) => ({
  id: 'x',
  results,
  provider: 'yfinance',
  warnings: null,
  chart: null,
  extra: {},
});

interface Harness {
  readonly client: Client;
  readonly built: BuiltServer;
  readonly calls: ReturnType<typeof createMockFetch>['calls'];
  readonly stdout: string[];
  close(): Promise<void>;
}

async function start(
  responses: MockResponseSpec[],
  openbb: OpenBbConfig = OPENBB,
  overrides = {}
): Promise<Harness> {
  const stdout: string[] = [];
  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

  const { fetch, calls } = createMockFetch(responses);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const built = await createServer({
    config: makeConfig({ openbb, maxReadRetries: 0, ...overrides }),
    fetchImpl: fetch,
    transport: serverTransport,
  });
  await built.connect();
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    built,
    calls,
    stdout,
    async close() {
      await client.close();
      await built.close();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

function parse(result: any): any {
  return JSON.parse(result.content[0].text);
}

let harness: Harness | undefined;
beforeEach(() => clearRegisteredSecrets());
afterEach(async () => {
  await harness?.close();
  harness = undefined;
});

describe('OpenBB 설정/URL 정책', () => {
  it('기본값은 비활성화이며 환경변수가 없어도 서버 설정이 로드된다', () => {
    const config = loadConfig({});
    expect(config.openbb.enabled).toBe(false);
    expect(config.openbb.baseUrl).toBe('http://127.0.0.1:6900');
    expect(config.openbb.provider).toBe('yfinance');
  });

  it('loopback 은 http 허용, 원격은 기본 차단', () => {
    expect(() => assertOpenBbUrlAllowed('http://localhost:6900', false)).not.toThrow();
    expect(() => assertOpenBbUrlAllowed('http://[::1]:6900', false)).not.toThrow();
    expect(() => assertOpenBbUrlAllowed('https://obb.example.com', false)).toThrow(/loopback/);
  });

  it('원격 허용 시에도 https 만 허용한다', () => {
    expect(() => assertOpenBbUrlAllowed('http://obb.example.com', true)).toThrow(/https/);
    expect(() => assertOpenBbUrlAllowed('https://obb.example.com', true)).not.toThrow();
  });

  it('URL 에 자격증명·경로·쿼리를 넣을 수 없다', () => {
    expect(() => assertOpenBbUrlAllowed('http://u:p@127.0.0.1:6900', false)).toThrow(/자격증명/);
    expect(() => assertOpenBbUrlAllowed('http://127.0.0.1:6900/x', false)).toThrow(/origin/);
    expect(() => assertOpenBbUrlAllowed('file:///etc/passwd', false)).toThrow();
  });

  it('활성화 시 잘못된 URL/provider 는 기동 시점에 거부한다', () => {
    expect(() =>
      loadConfig({ TOSSINVEST_OPENBB_ENABLED: 'true', TOSSINVEST_OPENBB_BASE_URL: 'http://10.0.0.5:6900' })
    ).toThrow();
    expect(() =>
      loadConfig({ TOSSINVEST_OPENBB_ENABLED: 'true', TOSSINVEST_OPENBB_PROVIDER: '../x' })
    ).toThrow();
  });
});

describe('심볼 변환', () => {
  it('토스증권 market 기준으로 Yahoo 표기 suffix 를 붙인다', () => {
    expect(toOpenBbSymbol('005930', 'KOSPI')).toBe('005930.KS');
    expect(toOpenBbSymbol('247540', 'KOSDAQ')).toBe('247540.KQ');
    expect(toOpenBbSymbol('BRK.B', 'NYSE')).toBe('BRK-B');
    expect(() => toOpenBbSymbol('123456', 'KR_ETC')).toThrow();
  });
});

describe('OpenBbClient', () => {
  it('토스증권 토큰을 보내지 않고, Basic 인증 비밀값은 redaction 에 등록한다', async () => {
    const { fetch, calls } = createMockFetch([{ body: obb([]) }]);
    const client = new OpenBbClient({
      config: { ...OPENBB, username: 'analyst', password: 'super-secret-pass' },
      requestTimeoutMs: 1000,
      maxResponseBytes: 1024 * 1024,
      maxReadRetries: 0,
      logger: silentLogger,
      fetchImpl: fetch,
    });
    await client.get('/equity/price/quote', { symbol: '005930.KS', provider: 'yfinance' });

    expect(calls[0]!.url).toBe(
      'http://127.0.0.1:6900/api/v1/equity/price/quote?symbol=005930.KS&provider=yfinance'
    );
    expect(calls[0]!.method).toBe('GET');
    expect(calls[0]!.headers.authorization).toMatch(/^Basic /);
    expect(calls[0]!.headers.authorization).not.toContain('Bearer');
    expect(scrubString('pw=super-secret-pass')).not.toContain('super-secret-pass');
  });

  it('허용되지 않는 경로는 네트워크 요청 전에 차단한다', async () => {
    const { fetch, calls } = createMockFetch([{ body: obb([]) }]);
    const client = new OpenBbClient({
      config: OPENBB,
      requestTimeoutMs: 1000,
      maxResponseBytes: 1024,
      maxReadRetries: 0,
      logger: silentLogger,
      fetchImpl: fetch,
    });
    for (const route of ['/../admin', '//evil.com/x', 'equity', '/Equity/X', '/a?b=1']) {
      await expect(client.get(route)).rejects.toMatchObject({ code: 'invalid-input' });
    }
    expect(calls).toHaveLength(0);
  });

  it('FastAPI 422 detail 을 읽기 쉬운 invalid-input 으로 변환한다', async () => {
    const { fetch } = createMockFetch([
      {
        status: 422,
        body: { detail: [{ loc: ['query', 'interval'], msg: 'Input should be 1d', type: 'x' }] },
      },
    ]);
    const client = new OpenBbClient({
      config: OPENBB,
      requestTimeoutMs: 1000,
      maxResponseBytes: 1024,
      maxReadRetries: 0,
      logger: silentLogger,
      fetchImpl: fetch,
    });
    await expect(client.get('/equity/price/historical')).rejects.toMatchObject({
      code: 'invalid-input',
      message: expect.stringContaining('interval: Input should be 1d'),
    });
  });

  it('서버가 꺼져 있으면 재시도하지 않고 실행 안내를 준다', async () => {
    const refused = new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    const { fetch, calls } = createMockFetch([{ throws: refused }]);
    const client = new OpenBbClient({
      config: OPENBB,
      requestTimeoutMs: 1000,
      maxResponseBytes: 1024,
      maxReadRetries: 3,
      logger: silentLogger,
      fetchImpl: fetch,
      sleepImpl: async () => {},
    });
    await expect(client.get('/equity/profile')).rejects.toMatchObject({
      code: 'network-error',
      message: expect.stringContaining('openbb-api'),
    });
    expect(calls).toHaveLength(1);
  });

  it('응답 크기 상한을 적용한다', async () => {
    const { fetch } = createMockFetch([{ rawBody: JSON.stringify(obb('x'.repeat(5000))) }]);
    const client = new OpenBbClient({
      config: OPENBB,
      requestTimeoutMs: 1000,
      maxResponseBytes: 1024,
      maxReadRetries: 0,
      logger: silentLogger,
      fetchImpl: fetch,
    });
    await expect(client.get('/equity/profile')).rejects.toMatchObject({ code: 'response-too-large' });
  });
});

describe('MCP 서버 OpenBB 도구', () => {
  it('비활성화 시 openbb_* 도구가 노출되지 않는다', async () => {
    harness = await start([{ body: TOKEN_RESPONSE }], DISABLED_OPENBB_CONFIG);
    const { tools } = await harness.client.listTools();
    expect(tools.some((tool) => tool.name.startsWith('openbb_'))).toBe(false);

    const result: any = await harness.client.callTool({ name: 'openbb_status', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('활성화 시 8개 읽기 전용 도구가 추가된다', async () => {
    harness = await start([{ body: TOKEN_RESPONSE }]);
    const { tools } = await harness.client.listTools();
    const openbbTools = tools.filter((tool) => tool.name.startsWith('openbb_'));
    expect(openbbTools).toHaveLength(8);
    for (const tool of openbbTools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
    }
  });

  it('토스증권 getStocks 의 market 으로 KRX suffix 를 결정해 OpenBB 를 호출한다', async () => {
    harness = await start([
      { body: TOKEN_RESPONSE },
      {
        body: {
          result: [
            { symbol: '005930', name: '삼성전자', market: 'KOSPI' },
            { symbol: '247540', name: '에코프로비엠', market: 'KOSDAQ' },
            { symbol: 'AAPL', name: 'Apple', market: 'NASDAQ' },
          ],
        },
      },
      { body: obb([{ symbol: '005930.KS', last_price: 191300.0 }]) },
    ]);

    const result: any = await harness.client.callTool({
      name: 'openbb_equity_quote',
      arguments: { symbols: ['005930', '247540', 'AAPL'] },
    });
    const body = parse(result);

    expect(result.isError).toBeUndefined();
    expect(body.symbols.map((s: any) => s.openbbSymbol)).toEqual(['005930.KS', '247540.KQ', 'AAPL']);
    expect(body.note).toContain('부동소수점');

    const tossCall = harness.calls.find((call) => call.url.includes('/api/v1/stocks'))!;
    expect(tossCall.url).toContain('symbols=005930%2C247540%2CAAPL');

    const obbCall = harness.calls.find((call) => call.url.startsWith('http://127.0.0.1:6900'))!;
    expect(obbCall.url).toContain('symbol=005930.KS%2C247540.KQ%2CAAPL');
    // 토스증권 Bearer 토큰이 OpenBB 로 새지 않는다.
    expect(obbCall.headers.authorization).toBeUndefined();
    expect(harness.stdout.join('')).not.toMatch(/OpenBB 요청/);
  });

  it('market 을 직접 주면 토스증권 조회 없이 변환한다', async () => {
    harness = await start([{ body: obb([{ period_ending: '2025-12-31' }]) }]);
    const result: any = await harness.client.callTool({
      name: 'openbb_equity_fundamentals',
      arguments: { symbol: '005930', market: 'KOSPI', statement: 'income', period: 'quarter', limit: 2 },
    });
    expect(result.isError).toBeUndefined();
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]!.url).toBe(
      'http://127.0.0.1:6900/api/v1/equity/fundamental/income?symbol=005930.KS&provider=yfinance&period=quarter&limit=2'
    );
  });

  it('토스증권 인증이 없으면 미국 티커만 추론하고 KRX 코드는 market 지정을 요구한다', async () => {
    harness = await start([{ body: obb([]) }], OPENBB, { clientId: undefined, clientSecret: undefined });

    const us: any = await harness.client.callTool({
      name: 'openbb_resolve_symbols',
      arguments: { symbols: ['AAPL'] },
    });
    expect(parse(us).symbols[0]).toMatchObject({ openbbSymbol: 'AAPL', marketSource: 'inferred' });

    const kr: any = await harness.client.callTool({
      name: 'openbb_resolve_symbols',
      arguments: { symbols: ['005930'] },
    });
    expect(kr.isError).toBe(true);
    expect(parse(kr).error.message).toContain('market');
  });

  it('잘못된 입력은 네트워크 요청 없이 거부한다', async () => {
    harness = await start([{ body: obb([]) }]);
    const cases = [
      { name: 'openbb_equity_historical', arguments: { symbol: '005930', market: 'KOSPI', startDate: '2026/01/01' } },
      { name: 'openbb_equity_historical', arguments: { symbol: '../etc', market: 'KOSPI' } },
      { name: 'openbb_equity_quote', arguments: { symbols: ['AAPL'], market: 'US_ETC', provider: 'a/b' } },
      { name: 'openbb_equity_fundamentals', arguments: { symbol: 'AAPL', market: 'NASDAQ', statement: 'x' } },
    ];
    for (const call of cases) {
      const result: any = await harness.client.callTool(call);
      expect(result.isError).toBe(true);
      expect(parse(result).error.code).toBe('invalid-input');
    }
    expect(harness.calls).toHaveLength(0);
  });

  it('보유 종목과 OpenBB 지표를 종목별로 결합한다', async () => {
    harness = await start(
      [
        { body: TOKEN_RESPONSE },
        {
          body: {
            result: {
              items: [
                { symbol: '005930', name: '삼성전자', currency: 'KRW', quantity: '100', lastPrice: '72000' },
                { symbol: 'AAPL', name: 'Apple Inc.', currency: 'USD', quantity: '10', lastPrice: '178.5' },
              ],
            },
          },
        },
        {
          body: {
            result: [
              { symbol: '005930', market: 'KOSPI' },
              { symbol: 'AAPL', market: 'NASDAQ' },
            ],
          },
        },
        {
          body: obb([
            { symbol: '005930.KS', forward_pe: 2.47, return_on_equity: 0.41 },
            { symbol: 'AAPL', forward_pe: 28.1 },
          ]),
        },
      ],
      OPENBB,
      { defaultAccount: '1' }
    );

    const result: any = await harness.client.callTool({ name: 'openbb_holdings_insight', arguments: {} });
    const body = parse(result);
    expect(result.isError).toBeUndefined();
    expect(body.count).toBe(2);
    expect(body.holdings[0]).toMatchObject({
      symbol: '005930',
      openbbSymbol: '005930.KS',
      toss: { quantity: '100', lastPrice: '72000' },
      openbbMetrics: { forward_pe: 2.47 },
    });
    expect(body.holdings[1].openbbMetrics.forward_pe).toBe(28.1);
    expect(body.disclaimer).toContain('투자 조언이 아닙니다');
  });

  it('openbb_status 는 서버가 꺼져 있어도 오류 대신 reachable=false 를 반환한다', async () => {
    harness = await start([
      { throws: new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') }) },
    ]);
    const result: any = await harness.client.callTool({ name: 'openbb_status', arguments: {} });
    const body = parse(result);
    expect(result.isError).toBeUndefined();
    expect(body).toMatchObject({ reachable: false, baseUrl: 'http://127.0.0.1:6900', authConfigured: false });
  });
});

describe('provider 동작 보정', () => {
  it('provider 가 limit 을 무시해도 뉴스 결과를 limit 개로 자른다', async () => {
    harness = await start([{ body: obb([{ title: 'a' }, { title: 'b' }, { title: 'c' }]) }]);
    const result: any = await harness.client.callTool({
      name: 'openbb_company_news',
      arguments: { symbols: ['AAPL'], market: 'NASDAQ', limit: 2 },
    });
    const body = parse(result);
    expect(body.count).toBe(2);
    expect(body.results).toHaveLength(2);
  });
});

describe('부분 누락 감지', () => {
  it('provider 가 일부 심볼을 조용히 빼면 missingSymbols 로 알려준다', async () => {
    // 실측: yfinance metrics 는 086520.KQ 를 오류 없이 결과에서 뺐다.
    harness = await start([{ body: obb([{ symbol: '005930.KS', forward_pe: 2.4 }]) }]);
    const result: any = await harness.client.callTool({
      name: 'openbb_equity_quote',
      arguments: { symbols: ['005930', '086520'], market: 'KOSPI' },
    });
    const body = parse(result);
    expect(body.missingSymbols).toEqual(['086520']);
    expect(body.hint).toContain('일부');
  });

  it('symbol 필드가 없는 단일 심볼 결과는 누락으로 보지 않는다', async () => {
    harness = await start([{ body: obb([{ date: '2026-11-10', close: 1 }]) }]);
    const result: any = await harness.client.callTool({
      name: 'openbb_equity_historical',
      arguments: { symbol: 'AAPL', market: 'NASDAQ' },
    });
    expect(parse(result).missingSymbols).toBeUndefined();
  });

  it('ECONNREFUSED 가 아닌 네트워크 오류는 일반 재시도 대상으로 남긴다', async () => {
    const reset = new TypeError('fetch failed', { cause: new Error('read ECONNRESET') });
    const { fetch, calls } = createMockFetch([{ throws: reset }, { body: obb([]) }]);
    const client = new OpenBbClient({
      config: OPENBB,
      requestTimeoutMs: 1000,
      maxResponseBytes: 1024,
      maxReadRetries: 1,
      logger: silentLogger,
      fetchImpl: fetch,
      sleepImpl: async () => {},
    });
    await expect(client.get('/equity/profile')).resolves.toMatchObject({ results: [] });
    expect(calls).toHaveLength(2);
  });
});

describe('OpenBB 204 응답', () => {
  it('결과 없음(204 No Content)을 빈 결과로 처리하고 missingSymbols 를 계산한다', async () => {
    const fetch204 = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    const client = new OpenBbClient({
      config: OPENBB,
      requestTimeoutMs: 1000,
      maxResponseBytes: 1024,
      maxReadRetries: 0,
      logger: silentLogger,
      fetchImpl: fetch204,
    });
    const response = await client.get('/equity/fundamental/metrics', { symbol: '086520.KQ' });
    expect(response.results).toEqual([]);

    const resolved = [
      { tossSymbol: '086520', market: 'KOSDAQ' as const, openbbSymbol: '086520.KQ', marketSource: 'user-input' as const },
    ];
    expect(findMissingSymbols(resolved, response.results)).toEqual(['086520']);
  });
});
