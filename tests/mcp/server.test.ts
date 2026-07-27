import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type BuiltServer } from '../../src/server.js';
import { clearRegisteredSecrets } from '../../src/security/redaction.js';
import { createMockFetch, loadSnapshot, makeConfig, TOKEN_RESPONSE } from '../fixtures/helpers.js';

const snapshot = loadSnapshot();

interface Harness {
  readonly client: Client;
  readonly built: BuiltServer;
  readonly stdoutWrites: string[];
  readonly stderrWrites: string[];
  close(): Promise<void>;
}

async function startHarness(configOverrides = {}, responses: any[] = []): Promise<Harness> {
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];

  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: any): boolean => {
      stdoutWrites.push(String(chunk));
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: any): boolean => {
      stderrWrites.push(String(chunk));
      return true;
    });

  const { fetch: mockFetch } = createMockFetch([
    { body: TOKEN_RESPONSE },
    ...(responses.length > 0 ? responses : [{ body: { result: { ok: true } } }]),
  ]);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const built = await createServer({
    config: makeConfig({ logLevel: 'info', specCacheEnabled: false, ...configOverrides }),
    fetchImpl: mockFetch,
    transport: serverTransport,
  });

  await built.connect();

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    built,
    stdoutWrites,
    stderrWrites,
    async close() {
      await client.close();
      await built.close();
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  };
}

let harness: Harness | undefined;

beforeEach(() => {
  clearRegisteredSecrets();
});

afterEach(async () => {
  if (harness) {
    await harness.close();
    harness = undefined;
  }
});

describe('MCP 서버', () => {
  it('initialize 후 tools/list 를 제공한다', async () => {
    harness = await startHarness();
    const { tools } = await harness.client.listTools();

    const names = tools.map((tool) => tool.name);
    expect(names).toContain('tossinvest_api_overview');
    expect(names).toContain('tossinvest_list_operations');
    expect(names).toContain('tossinvest_search_operations');
    expect(names).toContain('tossinvest_get_operation');
    expect(names).toContain('tossinvest_call_operation');
    expect(names).toContain('tossinvest_auth_status');
    expect(names).toContain('tossinvest_refresh_auth');
    expect(names).not.toContain('tossinvest_raw_request');

    // 자동 생성된 operation 도구
    expect(names).toContain('getPrices');
    expect(names).toContain('getAccounts');
    expect(names).toContain('createOrder');
    // 토큰 발급은 노출하지 않는다.
    expect(names).not.toContain('issueOAuth2Token');

    expect(tools.length).toBe(7 + 29);
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('stdout 을 오염시키지 않고 stderr 로만 로그를 남긴다', async () => {
    harness = await startHarness();
    await harness.client.listTools();

    expect(harness.stdoutWrites).toHaveLength(0);
    expect(harness.stderrWrites.join('')).toContain('MCP stdio 서버가 시작되었습니다');
  });

  it('management 도구를 호출할 수 있다', async () => {
    harness = await startHarness();
    const result = await harness.client.callTool({
      name: 'tossinvest_api_overview',
      arguments: {},
    });

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).toBe(true);
    expect(structured.openapiVersion).toBe(snapshot.openapi);
    expect(structured.apiDocumentVersion).toBe(snapshot.info.version);
    expect(structured.apiServerUrl).toBe('https://openapi.tossinvest.com');
    expect(structured.operationCount).toBe(29);
    expect(structured.readOperationCount).toBe(23);
    expect(structured.mutationOperationCount).toBe(6);
    expect(structured.trading.enabled).toBe(false);
    expect(structured.trading.dryRunDefault).toBe(true);
    expect(structured.specSource).toBe('snapshot');
    expect(structured.tags).toContain('Market Data');
  });

  it('operation 검색과 상세 조회가 동작한다', async () => {
    harness = await startHarness();

    const search = await harness.client.callTool({
      name: 'tossinvest_search_operations',
      arguments: { query: '현재가' },
    });
    expect((search.structuredContent as any).count).toBeGreaterThan(0);

    const detail = await harness.client.callTool({
      name: 'tossinvest_get_operation',
      arguments: { operationId: 'createOrder' },
    });
    const structured = detail.structuredContent as Record<string, any>;
    expect(structured.method).toBe('POST');
    expect(structured.path).toBe('/api/v1/orders');
    expect(structured.isMutation).toBe(true);
    expect(structured.requiresAccountHeader).toBe(true);
    expect(structured.rateLimitGroup).toBe('ORDER');
    expect(structured.mcpToolName).toBe('createOrder');
  });

  it('list_operations 필터가 동작한다', async () => {
    harness = await startHarness();
    const result = await harness.client.callTool({
      name: 'tossinvest_list_operations',
      arguments: { destructive: true },
    });
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.count).toBe(6);
    for (const operation of structured.operations) {
      expect(operation.isMutation).toBe(true);
    }
  });

  it('직접 operation 도구를 호출한다', async () => {
    harness = await startHarness({}, [{ body: { result: [{ symbol: '005930', close: '70000' }] } }]);
    const result = await harness.client.callTool({
      name: 'getPrices',
      arguments: { query: { symbols: '005930' } },
    });

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).toBe(true);
    expect(structured.operationId).toBe('getPrices');
    expect(structured.result).toEqual([{ symbol: '005930', close: '70000' }]);
    expect(result.isError).toBeFalsy();
  });

  it('mutation 도구는 기본적으로 dry-run 을 반환한다', async () => {
    harness = await startHarness({ defaultAccount: '1' });
    const result = await harness.client.callTool({
      name: 'createOrder',
      arguments: {
        body: { symbol: '005930', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '70000' },
      },
    });

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.dryRun).toBe(true);
    expect(structured.executed).toBe(false);
    expect(result.isError).toBeFalsy();
  });

  it('오류를 isError 와 정규화된 본문으로 반환한다', async () => {
    harness = await startHarness({}, [
      { status: 404, body: { error: { requestId: 'r-1', code: 'stock-not-found', message: '없음' } } },
    ]);

    const result = await harness.client.callTool({
      name: 'getPrices',
      arguments: { query: { symbols: 'ZZZZ' } },
    });

    expect(result.isError).toBe(true);
    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).toBe(false);
    expect(structured.error.code).toBe('not-found');
    expect(structured.error.requestId).toBe('r-1');
  });

  it('알 수 없는 도구는 오류를 반환한다', async () => {
    harness = await startHarness();
    const result = await harness.client.callTool({ name: 'getPrices_nope', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.structuredContent as any).error.code).toBe('operation-not-found');
  });

  it('auth_status 가 비밀값 없이 상태를 반환한다', async () => {
    harness = await startHarness({ defaultAccount: '1234567890' });
    const result = await harness.client.callTool({ name: 'tossinvest_auth_status', arguments: {} });

    const text = JSON.stringify(result);
    expect(text).not.toContain('s_test_client_secret_abcdefghijklmnop');
    expect(text).not.toContain('c_test_client_id_1234567890');
    expect(text).not.toContain('1234567890');
    expect((result.structuredContent as any).ready).toBe(true);
  });

  it('refresh_auth 는 토큰 문자열을 반환하지 않는다', async () => {
    harness = await startHarness();
    const result = await harness.client.callTool({ name: 'tossinvest_refresh_auth', arguments: {} });

    const structured = result.structuredContent as Record<string, any>;
    expect(structured.ok).toBe(true);
    expect(structured.expiresIn).toBe(86400);
    expect(JSON.stringify(result)).not.toContain(TOKEN_RESPONSE.access_token);
  });

  it('graceful shutdown 이 동작한다', async () => {
    harness = await startHarness();
    await expect(harness.built.close()).resolves.toBeUndefined();
  });

  it('raw request 를 활성화하면 도구가 노출된다', async () => {
    harness = await startHarness({ enableRawRequests: true });
    const { tools } = await harness.client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('tossinvest_raw_request');
  });

  it('인증 정보가 없어도 명세 조회 도구는 동작한다', async () => {
    harness = await startHarness({ clientId: undefined, clientSecret: undefined });

    const overview = await harness.client.callTool({
      name: 'tossinvest_api_overview',
      arguments: {},
    });
    expect((overview.structuredContent as any).ok).toBe(true);

    const status = await harness.client.callTool({ name: 'tossinvest_auth_status', arguments: {} });
    expect((status.structuredContent as any).ready).toBe(false);

    // 실제 호출 시점에만 인증 오류를 반환한다.
    const call = await harness.client.callTool({
      name: 'getPrices',
      arguments: { query: { symbols: '005930' } },
    });
    expect(call.isError).toBe(true);
    expect((call.structuredContent as any).error.code).toBe('credentials-missing');
  });
});
