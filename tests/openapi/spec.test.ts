import { describe, expect, it } from 'vitest';
import { TOKEN_OPERATION_ID } from '../../src/config/constants.js';
import { AppError } from '../../src/errors/app-error.js';
import { loadOpenApiSpec, validateSpec } from '../../src/openapi/loader.js';
import {
  buildOperationIndex,
  normalizeToolName,
  OperationRegistry,
} from '../../src/openapi/operation-index.js';
import { RefResolver } from '../../src/openapi/resolver.js';
import { convertSchema } from '../../src/openapi/schema-converter.js';
import { generateTool } from '../../src/openapi/tool-generator.js';
import type { OpenApiDocument } from '../../src/openapi/types.js';
import { createMockFetch, loadSnapshot, silentLogger } from '../fixtures/helpers.js';

const snapshot = loadSnapshot();

function minimalDoc(overrides: Partial<OpenApiDocument> = {}): OpenApiDocument {
  return {
    openapi: '3.1.0',
    info: { title: 'test', version: '1.0.0' },
    servers: [{ url: 'https://openapi.tossinvest.com' }],
    paths: {
      '/api/v1/things': {
        get: {
          operationId: 'getThings',
          tags: ['Market Data'],
          summary: '조회',
          responses: { '200': { description: 'ok' } },
        },
      },
    },
    ...overrides,
  } as OpenApiDocument;
}

describe('OpenAPI snapshot 파싱', () => {
  it('공식 snapshot 이 검증을 통과한다', () => {
    expect(() => validateSpec(snapshot)).not.toThrow();
    expect(snapshot.openapi).toBe('3.1.0');
    expect(snapshot.servers?.[0]?.url).toBe('https://openapi.tossinvest.com');
  });

  it('모든 operationId 를 인덱싱한다', () => {
    const { operations, excluded } = buildOperationIndex(snapshot, { strict: true });
    const registry = new OperationRegistry(operations, excluded);

    expect(registry.size).toBeGreaterThanOrEqual(29);
    expect(registry.get('getPrices')?.method).toBe('GET');
    expect(registry.get('createOrder')?.method).toBe('POST');
    expect(registry.get('cancelConditionalOrder')?.method).toBe('DELETE');
    // 토큰 발급은 도구로 노출하지 않는다.
    expect(registry.get(TOKEN_OPERATION_ID)).toBeUndefined();
    expect(excluded.some((entry) => entry.operationId === TOKEN_OPERATION_ID)).toBe(true);
  });

  it('rate limit 그룹을 description 에서 추출한다', () => {
    const { operations } = buildOperationIndex(snapshot, { strict: true });
    const registry = new OperationRegistry(operations);
    expect(registry.get('getPrices')?.rateLimitGroup).toBe('MARKET_DATA');
    expect(registry.get('createOrder')?.rateLimitGroup).toBe('ORDER');
  });

  it('계좌 헤더가 필요한 operation 만 requiresAccount 로 표시한다', () => {
    const { operations } = buildOperationIndex(snapshot, { strict: true });
    const registry = new OperationRegistry(operations);

    expect(registry.get('getHoldings')?.requiresAccount).toBe(true);
    expect(registry.get('createOrder')?.requiresAccount).toBe(true);
    expect(registry.get('getPrices')?.requiresAccount).toBe(false);
    expect(registry.get('getAccounts')?.requiresAccount).toBe(false);

    // 계좌 헤더는 일반 헤더 목록에서 제외되어 사용자가 직접 지정할 수 없다.
    expect(registry.get('getHoldings')?.headerParameters).toHaveLength(0);
  });

  it('중복 operationId 를 검출한다', () => {
    const doc = minimalDoc({
      paths: {
        '/a': { get: { operationId: 'dup', responses: {} } },
        '/b': { get: { operationId: 'dup', responses: {} } },
      },
    } as Partial<OpenApiDocument>);

    expect(() => validateSpec(doc)).toThrowError(/중복된 operationId/);
    expect(() => buildOperationIndex(doc, { strict: true })).toThrowError(/중복된 operationId/);
  });

  it('필수 필드가 없으면 실패한다', () => {
    expect(() => validateSpec({ info: {}, paths: {} })).toThrow(AppError);
    expect(() => validateSpec({ ...minimalDoc(), servers: [] })).toThrowError(/servers/);
    expect(() => validateSpec({ ...minimalDoc(), paths: {} })).toThrowError(/paths/);
    expect(() => validateSpec({ ...minimalDoc(), openapi: '2.0' })).toThrowError(/OpenAPI 버전/);
  });

  it('operationId 가 없으면 strict 모드에서 실패하고 완화 모드에서는 제외한다', () => {
    const doc = minimalDoc({
      paths: { '/a': { get: { responses: {} } } },
    } as Partial<OpenApiDocument>);

    expect(() => buildOperationIndex(doc, { strict: true })).toThrowError(/operationId 가 없습니다/);

    const { operations, excluded } = buildOperationIndex(doc, { strict: false });
    expect(operations).toHaveLength(0);
    expect(excluded).toHaveLength(1);
  });

  it('새 operation 이 추가되면 코드 수정 없이 자동 등록된다', () => {
    const doc = JSON.parse(JSON.stringify(snapshot)) as OpenApiDocument;
    doc.paths['/api/v1/brand-new-read'] = {
      get: {
        operationId: 'getBrandNewThing',
        tags: ['Market Data'],
        summary: '미래에 추가된 조회 API',
        responses: { '200': { description: 'ok' } },
      },
    };

    const { operations } = buildOperationIndex(doc, { strict: true });
    const registry = new OperationRegistry(operations);
    const added = registry.get('getBrandNewThing');

    expect(added).toBeDefined();
    expect(added?.readOnly).toBe(true);
    expect(generateTool(registry.require('getBrandNewThing')).name).toBe('getBrandNewThing');
  });
});

describe('$ref 해석', () => {
  const resolver = new RefResolver(snapshot);

  it('로컬 $ref 를 해석한다', () => {
    const account = resolver.resolveRef<Record<string, unknown>>(
      '#/components/parameters/AccountSeq'
    );
    expect(account.name).toBe('X-Tossinvest-Account');
  });

  it('외부 $ref 를 거부한다', () => {
    expect(() => resolver.resolveRef('https://example.com/other.json#/x')).toThrowError(
      /외부 \$ref/
    );
  });

  it('존재하지 않는 $ref 를 거부한다', () => {
    expect(() => resolver.resolveRef('#/components/schemas/DoesNotExist')).toThrowError(
      /존재하지 않습니다/
    );
  });

  it('순환 $ref 를 무한 루프 없이 축약한다', () => {
    const doc = minimalDoc({
      components: {
        schemas: {
          Node: {
            type: 'object',
            properties: { child: { $ref: '#/components/schemas/Node' } },
          },
        },
      },
    });
    const cyclicResolver = new RefResolver(doc);
    const expanded = cyclicResolver.expandSchema({ $ref: '#/components/schemas/Node' });
    expect(expanded.type).toBe('object');
    expect(JSON.stringify(expanded)).toContain('순환 참조');
  });
});

describe('스키마 변환', () => {
  const resolver = new RefResolver(snapshot);

  it('required / enum 을 유지한다', () => {
    const converted = convertSchema(
      {
        type: 'object',
        required: ['side'],
        properties: {
          side: { type: 'string', enum: ['BUY', 'SELL'] },
        },
      },
      resolver
    );
    expect(converted.required).toEqual(['side']);
    expect((converted.properties as any).side.enum).toEqual(['BUY', 'SELL']);
  });

  it('oneOf 를 보존한다 (주문 생성 본문)', () => {
    const { operations } = buildOperationIndex(snapshot, { strict: true });
    const registry = new OperationRegistry(operations);
    const createOrder = registry.require('createOrder');

    expect(createOrder.requestBody?.contentType).toBe('application/json');
    const schema = createOrder.requestBody!.schema;
    expect(Array.isArray(schema.oneOf)).toBe(true);
    expect((schema.oneOf as unknown[]).length).toBe(2);
  });

  it('allOf 를 object 로 병합한다', () => {
    const converted = convertSchema(
      {
        allOf: [
          { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
          { type: 'object', required: ['b'], properties: { b: { type: 'integer' } } },
        ],
      },
      resolver
    );
    expect(converted.type).toBe('object');
    expect(Object.keys(converted.properties as object).sort()).toEqual(['a', 'b']);
    expect((converted.required as string[]).sort()).toEqual(['a', 'b']);
  });

  it('anyOf 를 유지한다', () => {
    const converted = convertSchema(
      { anyOf: [{ type: 'string' }, { type: 'integer' }] },
      resolver
    );
    expect((converted.anyOf as unknown[]).length).toBe(2);
  });

  it('nullable 타입 배열을 처리한다', () => {
    const converted = convertSchema({ type: ['object', 'null'] }, resolver);
    expect(converted.type).toEqual(['object', 'null']);

    const legacyNullable = convertSchema({ type: 'string', nullable: true }, resolver);
    expect(legacyNullable.type).toEqual(['string', 'null']);
  });

  it('decimal string 을 number 로 바꾸지 않는다', () => {
    const converted = convertSchema(
      { type: 'string', format: 'decimal', pattern: '^\\d+(\\.\\d+)?$' },
      resolver
    );
    expect(converted.type).toBe('string');
    expect(converted.format).toBe('decimal');
  });

  it('지원하지 않는 type 을 거부한다', () => {
    expect(() => convertSchema({ type: 'weird' }, resolver)).toThrowError(/지원하지 않는 스키마 type/);
  });
});

describe('도구 이름 생성', () => {
  it('operationId 를 그대로 사용한다', () => {
    expect(normalizeToolName('getPrices')).toBe('getPrices');
  });

  it('허용되지 않는 문자를 정규화한다', () => {
    expect(normalizeToolName('get prices/v2')).toBe('get_prices_v2');
    expect(normalizeToolName('v1.getPrices')).toBe('v1_getPrices');
  });

  it('의미 있는 이름이 남지 않으면 조용히 넘어가지 않고 실패한다', () => {
    expect(() => normalizeToolName('한글오퍼레이션')).toThrowError(/변환할 수 없습니다/);
  });

  it('64자를 넘지 않는다', () => {
    expect(normalizeToolName('a'.repeat(100))).toHaveLength(64);
  });

  it('도구 이름 충돌 시 오류를 던진다', () => {
    const doc = minimalDoc({
      paths: {
        '/a': { get: { operationId: 'get prices', responses: {} } },
        '/b': { get: { operationId: 'get/prices', responses: {} } },
      },
    } as Partial<OpenApiDocument>);

    expect(() => buildOperationIndex(doc, { strict: true })).toThrowError(/도구 이름이 충돌/);
  });
});

describe('도구 inputSchema 생성', () => {
  const { operations } = buildOperationIndex(snapshot, { strict: true });
  const registry = new OperationRegistry(operations);

  it('필요 없는 필드를 스키마에서 제거한다', () => {
    const tool = generateTool(registry.require('getAccounts'));
    expect(Object.keys(tool.inputSchema.properties as object)).toHaveLength(0);
    expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it('query 파라미터를 query 객체로 노출한다', () => {
    const tool = generateTool(registry.require('getPrices'));
    const properties = tool.inputSchema.properties as Record<string, any>;
    expect(properties.query.properties.symbols).toBeDefined();
    expect(properties.query.required).toEqual(['symbols']);
    expect(properties.account).toBeUndefined();
    expect(properties.dryRun).toBeUndefined();
  });

  it('path 파라미터를 path 객체로 노출한다', () => {
    const tool = generateTool(registry.require('getStockWarnings'));
    const properties = tool.inputSchema.properties as Record<string, any>;
    expect(properties.path.properties.symbol).toBeDefined();
    expect(tool.inputSchema.required).toContain('path');
  });

  it('mutation 도구에는 dryRun/confirmation 이 추가되고 기본값이 true 다', () => {
    const tool = generateTool(registry.require('createOrder'));
    const properties = tool.inputSchema.properties as Record<string, any>;
    expect(properties.dryRun.default).toBe(true);
    expect(properties.confirmation).toBeDefined();
    expect(properties.account).toBeDefined();
    expect(tool.annotations.readOnlyHint).toBe(false);
    expect(tool.annotations.destructiveHint).toBe(true);
  });

  it('모든 도구 이름이 MCP 규칙을 만족한다', () => {
    for (const operation of registry.all) {
      const tool = generateTool(operation);
      expect(tool.name).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(tool.inputSchema.type).toBe('object');
      expect(() => JSON.stringify(tool.inputSchema)).not.toThrow();
    }
  });
});

describe('명세 로더', () => {
  it('원격 로드에 성공하면 remote 를 사용한다', async () => {
    const { fetch: mockFetch } = createMockFetch([{ status: 200, body: snapshot }]);
    const loaded = await loadOpenApiSpec({
      url: 'https://openapi.tossinvest.com/openapi-docs/latest/openapi.json',
      timeoutMs: 1000,
      useRemote: true,
      logger: silentLogger,
      fetchImpl: mockFetch,
    });
    expect(loaded.source).toBe('remote');
    expect(loaded.document.info.version).toBe(snapshot.info.version);
  });

  it('원격 실패 시 snapshot 으로 폴백한다', async () => {
    const { fetch: mockFetch } = createMockFetch([{ status: 503, body: { error: 'down' } }]);
    const loaded = await loadOpenApiSpec({
      url: 'https://openapi.tossinvest.com/openapi-docs/latest/openapi.json',
      timeoutMs: 1000,
      useRemote: true,
      logger: silentLogger,
      fetchImpl: mockFetch,
      loadSnapshot: () => snapshot,
    });
    expect(loaded.source).toBe('snapshot');
    expect(loaded.fallbackReason).toBeTruthy();
  });

  it('원격과 snapshot 이 모두 실패하면 명확한 오류로 종료한다', async () => {
    const { fetch: mockFetch } = createMockFetch([{ throws: new Error('network down') }]);
    await expect(
      loadOpenApiSpec({
        url: 'https://openapi.tossinvest.com/openapi-docs/latest/openapi.json',
        timeoutMs: 1000,
        useRemote: true,
        logger: silentLogger,
        fetchImpl: mockFetch,
        loadSnapshot: () => {
          throw new Error('snapshot missing');
        },
      })
    ).rejects.toThrowError(/모두 사용할 수 없어/);
  });

  it('JSON 이 아닌 응답은 snapshot 으로 폴백한다', async () => {
    const { fetch: mockFetch } = createMockFetch([
      { status: 200, rawBody: '<html>error</html>', headers: { 'content-type': 'text/html' } },
    ]);
    const loaded = await loadOpenApiSpec({
      url: 'https://openapi.tossinvest.com/openapi-docs/latest/openapi.json',
      timeoutMs: 1000,
      useRemote: true,
      logger: silentLogger,
      fetchImpl: mockFetch,
      loadSnapshot: () => snapshot,
    });
    expect(loaded.source).toBe('snapshot');
  });
});
