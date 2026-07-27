import { beforeEach, describe, expect, it } from 'vitest';
import { TokenManager } from '../../src/auth/token-manager.js';
import { TossClient } from '../../src/client/toss-client.js';
import type { AppConfig } from '../../src/config/env.js';
import { buildOperationIndex, OperationRegistry } from '../../src/openapi/operation-index.js';
import { ManagementTools } from '../../src/tools/management-tools.js';
import { classifyMutation } from '../../src/tools/mutation-classifier.js';
import { OperationExecutor } from '../../src/tools/operation-tools.js';
import { clearRegisteredSecrets } from '../../src/security/redaction.js';
import {
  createMockFetch,
  loadSnapshot,
  makeConfig,
  silentLogger,
  TOKEN_RESPONSE,
} from '../fixtures/helpers.js';

const snapshot = loadSnapshot();
const { operations, excluded } = buildOperationIndex(snapshot, { strict: true });
const registry = new OperationRegistry(operations, excluded);

const CONFIRMATION = 'I_UNDERSTAND_THIS_PLACES_A_REAL_ORDER';

const VALID_ORDER = {
  symbol: '005930',
  side: 'BUY',
  orderType: 'LIMIT',
  quantity: '10',
  price: '70000',
};

function makeHarness(configOverrides: Partial<AppConfig> = {}) {
  const config = makeConfig({ defaultAccount: '1', ...configOverrides });
  const mock = createMockFetch([
    { body: TOKEN_RESPONSE },
    { body: { result: { orderId: 'order-1', clientOrderId: 'c-1' } } },
  ]);
  const tokenManager = new TokenManager({ config, logger: silentLogger, fetchImpl: mock.fetch });
  const client = new TossClient({
    config,
    tokenManager,
    logger: silentLogger,
    fetchImpl: mock.fetch,
    sleepImpl: async () => {},
  });
  const executor = new OperationExecutor({ registry, client, config, logger: silentLogger });
  const management = new ManagementTools({
    registry,
    spec: { document: snapshot, source: 'snapshot', loadedAt: new Date().toISOString() },
    config,
    tokenManager,
    executor,
  });
  return { config, mock, executor, management };
}

beforeEach(() => {
  clearRegisteredSecrets();
});

describe('mutation 분류', () => {
  it('주문 API 를 order 로 분류한다', () => {
    for (const id of ['createOrder', 'modifyOrder', 'cancelOrder']) {
      expect(registry.require(id).mutation).toBe('order');
    }
  });

  it('조건주문 API 를 conditional-order 로 분류한다', () => {
    for (const id of ['createConditionalOrder', 'modifyConditionalOrder', 'cancelConditionalOrder']) {
      expect(registry.require(id).mutation).toBe('conditional-order');
    }
  });

  it('조회 API 는 mutation 이 아니다', () => {
    for (const id of ['getPrices', 'getOrders', 'getConditionalOrders', 'getHoldings', 'getCommissions']) {
      expect(registry.require(id).mutation).toBe('none');
      expect(registry.require(id).readOnly).toBe(true);
    }
  });

  it('모든 POST 를 주문으로 간주하지 않는다', () => {
    expect(
      classifyMutation({
        operationId: 'searchStocks',
        method: 'POST',
        path: '/api/v1/search',
        tags: ['Stock Info'],
      })
    ).toBe('unclassified');
  });

  it('분류할 수 없는 새 mutation 은 unclassified 로 fail-closed 한다', () => {
    expect(
      classifyMutation({
        operationId: 'doSomethingNew',
        method: 'POST',
        path: '/api/v1/unknown',
        tags: ['Brand New'],
      })
    ).toBe('unclassified');
  });

  it('명세에 주문 mutation 이 추가되면 tag/path 로 자동 분류한다', () => {
    expect(
      classifyMutation({
        operationId: 'createBracketOrder',
        method: 'POST',
        path: '/api/v1/orders/bracket',
        tags: ['Order'],
      })
    ).toBe('order');
  });
});

describe('주문 안전정책', () => {
  it('trading 기본값은 비활성화다', () => {
    expect(makeConfig().enableTrading).toBe(false);
    expect(makeConfig().enableConditionalOrders).toBe(false);
  });

  it('dryRun 기본값이 true 이며 네트워크 호출이 없다', async () => {
    const { executor, mock } = makeHarness();
    const result = (await executor.executeByOperationId('createOrder', {
      body: VALID_ORDER,
    })) as any;

    expect(result.dryRun).toBe(true);
    expect(result.executed).toBe(false);
    expect(mock.calls).toHaveLength(0);
  });

  it('dry-run 요약에 주문 내용과 실행 요건을 포함한다', async () => {
    const { executor } = makeHarness();
    const result = (await executor.executeByOperationId('createOrder', {
      body: VALID_ORDER,
    })) as any;

    expect(result.summary.symbol).toBe('005930');
    expect(result.summary.side).toBe('BUY');
    expect(result.summary.orderType).toBe('LIMIT');
    expect(result.summary.quantity).toBe('10');
    expect(result.summary.price).toBe('70000');
    expect(result.summary.method).toBe('POST');
    expect(result.summary.path).toBe('/api/v1/orders');
    // 계좌는 마스킹된다.
    expect(result.summary.account).not.toBe('1');
    expect(result.requirementsToExecute).toContain('TOSSINVEST_ENABLE_TRADING=true');
  });

  it('dry-run 이 누락된 필수 필드를 보고한다', async () => {
    const { executor } = makeHarness();
    const result = (await executor.executeByOperationId('createOrder', {
      body: { symbol: '005930' },
    })) as any;
    expect(result.missingRequiredFields.length).toBeGreaterThan(0);
    expect(result.missingRequiredFields.join(',')).toContain('body.side');
  });

  it('confirmation 이 없으면 호출하지 않는다', async () => {
    const { executor, mock } = makeHarness({ enableTrading: true });
    await expect(
      executor.executeByOperationId('createOrder', { body: VALID_ORDER, dryRun: false })
    ).rejects.toMatchObject({ code: 'trading-disabled' });
    expect(mock.calls).toHaveLength(0);
  });

  it('잘못된 confirmation 이면 호출하지 않는다', async () => {
    const { executor, mock } = makeHarness({ enableTrading: true });
    await expect(
      executor.executeByOperationId('createOrder', {
        body: VALID_ORDER,
        dryRun: false,
        confirmation: 'yes',
      })
    ).rejects.toMatchObject({ code: 'trading-disabled' });
    expect(mock.calls).toHaveLength(0);
  });

  it('enableTrading 만 true 이고 dryRun 이 기본이면 호출하지 않는다', async () => {
    const { executor, mock } = makeHarness({ enableTrading: true });
    const result = (await executor.executeByOperationId('createOrder', {
      body: VALID_ORDER,
      confirmation: CONFIRMATION,
    })) as any;
    expect(result.dryRun).toBe(true);
    expect(mock.calls).toHaveLength(0);
  });

  it('dryRun=false + confirmation 만 있고 trading 이 꺼져 있으면 호출하지 않는다', async () => {
    const { executor, mock } = makeHarness({ enableTrading: false });
    await expect(
      executor.executeByOperationId('createOrder', {
        body: VALID_ORDER,
        dryRun: false,
        confirmation: CONFIRMATION,
      })
    ).rejects.toMatchObject({ code: 'trading-disabled' });
    expect(mock.calls).toHaveLength(0);
  });

  it('계좌가 없으면 호출하지 않는다', async () => {
    const { executor, mock } = makeHarness({ enableTrading: true, defaultAccount: undefined });
    await expect(
      executor.executeByOperationId('createOrder', {
        body: VALID_ORDER,
        dryRun: false,
        confirmation: CONFIRMATION,
      })
    ).rejects.toMatchObject({ code: 'trading-disabled' });
    expect(mock.calls).toHaveLength(0);
  });

  it('인증 정보가 없으면 호출하지 않는다', async () => {
    const { executor, mock } = makeHarness({
      enableTrading: true,
      clientId: undefined,
      clientSecret: undefined,
    });
    await expect(
      executor.executeByOperationId('createOrder', {
        body: VALID_ORDER,
        dryRun: false,
        confirmation: CONFIRMATION,
      })
    ).rejects.toMatchObject({ code: 'trading-disabled' });
    expect(mock.calls).toHaveLength(0);
  });

  it('모든 조건을 충족하면 실제로 호출한다', async () => {
    const { executor, mock } = makeHarness({ enableTrading: true });
    const result = (await executor.executeByOperationId('createOrder', {
      body: VALID_ORDER,
      dryRun: false,
      confirmation: CONFIRMATION,
    })) as any;

    expect(result.ok).toBe(true);
    expect(result.result.orderId).toBe('order-1');
    // token + order
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]!.url).toBe('https://openapi.tossinvest.com/api/v1/orders');
    expect(mock.calls[1]!.method).toBe('POST');
    expect(mock.calls[1]!.headers['x-tossinvest-account']).toBe('1');
  });

  it('조건주문은 별도 플래그가 필요하다', async () => {
    const { executor, mock } = makeHarness({ enableTrading: true });
    await expect(
      executor.executeByOperationId('cancelConditionalOrder', {
        path: { conditionalOrderId: 'cond-1' },
        dryRun: false,
        confirmation: CONFIRMATION,
      })
    ).rejects.toMatchObject({ code: 'trading-disabled' });
    expect(mock.calls).toHaveLength(0);
  });

  it('조건주문 플래그가 켜지면 실행된다', async () => {
    const { executor, mock } = makeHarness({
      enableTrading: true,
      enableConditionalOrders: true,
    });
    const result = (await executor.executeByOperationId('cancelConditionalOrder', {
      path: { conditionalOrderId: 'cond-1' },
      dryRun: false,
      confirmation: CONFIRMATION,
    })) as any;
    expect(result.ok).toBe(true);
    expect(mock.calls[1]!.method).toBe('DELETE');
  });

  it('조건주문 dry-run 은 조건 내용을 요약한다', async () => {
    const { executor } = makeHarness();
    const result = (await executor.executeByOperationId('createConditionalOrder', {
      body: {
        symbol: '005930',
        side: 'SELL',
        quantity: '5',
        condition: { type: 'PRICE_ABOVE', price: '80000' },
      },
    })) as any;
    expect(result.summary.condition).toEqual({ type: 'PRICE_ABOVE', price: '80000' });
  });
});

describe('wrapper 도구는 mutation guard 를 우회할 수 없다', () => {
  it('tossinvest_call_operation 도 dryRun 기본 true 다', async () => {
    const { management, mock } = makeHarness({ enableTrading: true });
    const result = (await management.call('tossinvest_call_operation', {
      operationId: 'createOrder',
      body: VALID_ORDER,
      confirmation: CONFIRMATION,
    })) as Record<string, unknown>;

    expect(result.dryRun).toBe(true);
    expect(mock.calls).toHaveLength(0);
  });

  it('tossinvest_call_operation 이 trading 비활성 상태에서 실행되지 않는다', async () => {
    const { management, mock } = makeHarness();
    await expect(
      management.call('tossinvest_call_operation', {
        operationId: 'createOrder',
        body: VALID_ORDER,
        dryRun: false,
        confirmation: CONFIRMATION,
      })
    ).rejects.toMatchObject({ code: 'trading-disabled' });
    expect(mock.calls).toHaveLength(0);
  });

  it('raw request 는 기본적으로 노출되지 않는다', async () => {
    const { management } = makeHarness();
    expect(management.handles('tossinvest_raw_request')).toBe(false);
    await expect(management.call('tossinvest_raw_request', {})).rejects.toMatchObject({
      code: 'feature-disabled',
    });
  });

  it('raw request 도 mutation guard 를 우회할 수 없다', async () => {
    const { management, mock } = makeHarness({ enableRawRequests: true });
    expect(management.handles('tossinvest_raw_request')).toBe(true);

    await expect(
      management.call('tossinvest_raw_request', {
        method: 'POST',
        path: '/api/v1/orders',
        body: VALID_ORDER,
        dryRun: false,
        confirmation: CONFIRMATION,
      })
    ).rejects.toMatchObject({ code: 'trading-disabled' });
    expect(mock.calls).toHaveLength(0);
  });

  it('raw request 는 명세에 없는 path 를 거부한다', async () => {
    const { management, mock } = makeHarness({ enableRawRequests: true });
    await expect(
      management.call('tossinvest_raw_request', { method: 'GET', path: '/internal/admin' })
    ).rejects.toMatchObject({ code: 'operation-not-found' });
    expect(mock.calls).toHaveLength(0);
  });
});

describe('입력 검증', () => {
  it('알 수 없는 최상위 인자를 거부한다', async () => {
    const { executor } = makeHarness();
    await expect(
      executor.executeByOperationId('getPrices', {
        query: { symbols: '005930' },
        headers: { authorization: 'Bearer x' },
      })
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('알 수 없는 operationId 를 거부한다', async () => {
    const { executor } = makeHarness();
    await expect(executor.executeByOperationId('nopeNotReal', {})).rejects.toMatchObject({
      code: 'operation-not-found',
    });
  });

  it('본문을 받지 않는 operation 에 body 를 주면 거부한다', async () => {
    const { executor } = makeHarness();
    await expect(
      executor.executeByOperationId('getPrices', { query: { symbols: '005930' }, body: {} })
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });
});
