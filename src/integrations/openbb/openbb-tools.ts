import { AppError } from '../../errors/app-error.js';
import { toAppError } from '../../errors/error-normalizer.js';
import type { JsonSchema } from '../../openapi/schema-converter.js';
import type { ManagementToolDefinition } from '../../tools/management-tools.js';
import type { OperationExecutor } from '../../tools/operation-tools.js';
import { isPlainObject, stripDangerousKeys } from '../../utils/json.js';
import type { Logger } from '../../utils/logger.js';
import { assertProviderAllowed, type OpenBbConfig } from './config.js';
import type { OpenBbClient, OpenBbQueryValue, OpenBbResponse } from './openbb-client.js';
import {
  assertTossSymbol,
  isKrxCode,
  isTossMarket,
  TOSS_MARKETS,
  toOpenBbSymbol,
  type ResolvedSymbol,
  type TossMarket,
} from './symbol-mapper.js';

export const OPENBB_TOOL_NAMES = Object.freeze({
  status: 'openbb_status',
  resolveSymbols: 'openbb_resolve_symbols',
  quote: 'openbb_equity_quote',
  historical: 'openbb_equity_historical',
  profile: 'openbb_equity_profile',
  fundamentals: 'openbb_equity_fundamentals',
  news: 'openbb_company_news',
  holdingsInsight: 'openbb_holdings_insight',
});

const MAX_SYMBOLS = 20;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const INTERVALS = ['1m', '5m', '15m', '30m', '1h', '1d', '1W', '1M', '1Q'] as const;
const STATEMENTS = ['income', 'balance', 'cash', 'metrics', 'dividends'] as const;

/** OpenBB 값은 JSON number 라서 토스증권 decimal string 과 정밀도 보장이 다르다. */
export const OPENBB_PRECISION_NOTE =
  'OpenBB 값은 JSON number(부동소수점)이며 외부 provider 기준 참고용 분석 데이터입니다. ' +
  '주문 가격·수량 산정에는 토스증권 시세 API(getPrices 등)의 decimal string 값을 사용하세요.';

export interface OpenBbToolsOptions {
  readonly config: OpenBbConfig;
  readonly client: OpenBbClient;
  /** 토스증권 getStocks / getHoldings 를 읽기 전용으로 호출하기 위한 실행기. */
  readonly executor: OperationExecutor;
  readonly logger: Logger;
}

const readOnly = (title: string) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
});

const symbolsSchema: JsonSchema = {
  type: 'array',
  items: { type: 'string', pattern: '^[A-Za-z0-9.\\-]+$' },
  minItems: 1,
  maxItems: MAX_SYMBOLS,
  description: '토스증권 심볼 목록. KRX: 6자리 코드(예: 005930), US: 티커(예: AAPL).',
};

const marketSchema: JsonSchema = {
  type: 'string',
  enum: [...TOSS_MARKETS],
  description:
    '시장을 직접 지정합니다 (모든 심볼에 적용). 생략하면 토스증권 getStocks 로 시장을 조회합니다.',
};

const providerSchema: JsonSchema = {
  type: 'string',
  description: 'OpenBB 데이터 provider. 생략 시 TOSSINVEST_OPENBB_PROVIDER (기본 yfinance).',
};

const commonProps = { market: marketSchema, provider: providerSchema };

/**
 * OpenBB Platform 연동 도구.
 *
 * 단순 프록시가 아니라 "토스증권 심볼 → OpenBB 심볼" 해석을 담당한다.
 * 시장 suffix(.KS/.KQ)는 토스증권 getStocks 응답의 market 필드로 결정한다.
 * 모든 도구는 읽기 전용이며 mutation guard 경로와 무관하다.
 */
export class OpenBbTools {
  private readonly logger: Logger;

  constructor(private readonly options: OpenBbToolsOptions) {
    this.logger = options.logger.child('openbb-tools');
  }

  get definitions(): ManagementToolDefinition[] {
    if (!this.options.config.enabled) return [];

    return [
      {
        name: OPENBB_TOOL_NAMES.status,
        description:
          'OpenBB Platform API 연동 상태를 확인합니다. 설정된 서버 주소, 인증 설정 여부, 기본 provider, 서버 연결 결과(라우트 수)를 반환합니다.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: readOnly('OpenBB 연결 상태'),
      },
      {
        name: OPENBB_TOOL_NAMES.resolveSymbols,
        description:
          '토스증권 심볼을 OpenBB(Yahoo Finance 표기) 심볼로 변환합니다. 예: 005930(KOSPI) → 005930.KS, 247540(KOSDAQ) → 247540.KQ, BRK.B → BRK-B.',
        inputSchema: {
          type: 'object',
          properties: { symbols: symbolsSchema, market: marketSchema },
          required: ['symbols'],
          additionalProperties: false,
        },
        annotations: readOnly('심볼 변환'),
      },
      {
        name: OPENBB_TOOL_NAMES.quote,
        description:
          'OpenBB 로 종목 시세 요약(52주 고저, 50/200일 이동평균, 평균 거래량 등)을 조회합니다. 토스증권 심볼을 그대로 넣으면 됩니다.',
        inputSchema: {
          type: 'object',
          properties: { symbols: symbolsSchema, ...commonProps },
          required: ['symbols'],
          additionalProperties: false,
        },
        annotations: readOnly('OpenBB 시세 요약'),
      },
      {
        name: OPENBB_TOOL_NAMES.historical,
        description:
          'OpenBB 로 장기 과거 가격(OHLCV)을 조회합니다. 토스증권 getCandles 보다 긴 기간(수년)이 필요할 때 사용합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: '토스증권 심볼 (예: 005930, AAPL)' },
            startDate: { type: 'string', description: '시작일 YYYY-MM-DD' },
            endDate: { type: 'string', description: '종료일 YYYY-MM-DD' },
            interval: { type: 'string', enum: [...INTERVALS], default: '1d' },
            ...commonProps,
          },
          required: ['symbol'],
          additionalProperties: false,
        },
        annotations: readOnly('OpenBB 과거 가격'),
      },
      {
        name: OPENBB_TOOL_NAMES.profile,
        description: 'OpenBB 로 기업 개요(업종, 산업, 임직원 수, 사업 설명, 홈페이지 등)를 조회합니다.',
        inputSchema: {
          type: 'object',
          properties: { symbols: symbolsSchema, ...commonProps },
          required: ['symbols'],
          additionalProperties: false,
        },
        annotations: readOnly('OpenBB 기업 개요'),
      },
      {
        name: OPENBB_TOOL_NAMES.fundamentals,
        description:
          'OpenBB 로 재무 데이터를 조회합니다. statement: income(손익계산서), balance(재무상태표), cash(현금흐름표), metrics(PER·ROE·부채비율 등 주요 지표), dividends(배당 이력).',
        inputSchema: {
          type: 'object',
          properties: {
            symbol: { type: 'string', description: '토스증권 심볼 (예: 005930, AAPL)' },
            statement: { type: 'string', enum: [...STATEMENTS] },
            period: {
              type: 'string',
              enum: ['annual', 'quarter'],
              default: 'annual',
              description: 'income/balance/cash 에만 적용',
            },
            limit: {
              type: 'integer',
              minimum: 1,
              maximum: 20,
              default: 4,
              description: 'income/balance/cash 에만 적용',
            },
            ...commonProps,
          },
          required: ['symbol', 'statement'],
          additionalProperties: false,
        },
        annotations: readOnly('OpenBB 재무 데이터'),
      },
      {
        name: OPENBB_TOOL_NAMES.news,
        description: 'OpenBB 로 종목 관련 뉴스를 조회합니다 (provider 에 따라 영문 기사 위주).',
        inputSchema: {
          type: 'object',
          properties: {
            symbols: symbolsSchema,
            limit: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
            ...commonProps,
          },
          required: ['symbols'],
          additionalProperties: false,
        },
        annotations: readOnly('OpenBB 종목 뉴스'),
      },
      {
        name: OPENBB_TOOL_NAMES.holdingsInsight,
        description:
          '토스증권 보유 종목(getHoldings)과 OpenBB 주요 지표(metrics)를 종목별로 결합해 반환합니다. ' +
          '보유 수량·평가금액은 토스증권 값(decimal string), 밸류에이션·수익성 지표는 OpenBB 값입니다. 투자 조언이 아닙니다.',
        inputSchema: {
          type: 'object',
          properties: {
            account: {
              type: 'string',
              description: '계좌 accountSeq. 미지정 시 TOSSINVEST_DEFAULT_ACCOUNT 사용.',
            },
            provider: providerSchema,
          },
          additionalProperties: false,
        },
        annotations: readOnly('보유 종목 + OpenBB 지표'),
      },
    ];
  }

  handles(name: string): boolean {
    return this.options.config.enabled && (Object.values(OPENBB_TOOL_NAMES) as string[]).includes(name);
  }

  async call(name: string, rawArgs: unknown): Promise<unknown> {
    if (!this.options.config.enabled) {
      throw new AppError({
        code: 'feature-disabled',
        message: 'OpenBB 연동이 비활성화되어 있습니다 (TOSSINVEST_OPENBB_ENABLED=false).',
        httpStatus: 403,
        retryable: false,
      });
    }
    const args = isPlainObject(rawArgs) ? stripDangerousKeys(rawArgs) : {};

    switch (name) {
      case OPENBB_TOOL_NAMES.status:
        return this.status();
      case OPENBB_TOOL_NAMES.resolveSymbols: {
        const resolved = await this.resolveSymbols(readSymbols(args.symbols), readMarket(args.market));
        return { ok: true, symbols: resolved };
      }
      case OPENBB_TOOL_NAMES.quote:
        return this.multiSymbolCall('/equity/price/quote', args);
      case OPENBB_TOOL_NAMES.profile:
        return this.multiSymbolCall('/equity/profile', args);
      case OPENBB_TOOL_NAMES.news: {
        const limit = readInteger(args.limit, 'limit', 1, 50) ?? 10;
        const output = await this.multiSymbolCall('/news/company', args, { limit });
        // yfinance provider 는 limit 을 무시하므로(실측: limit=1 → 10건) 여기서 한 번 더 자른다.
        if (Array.isArray(output.results) && output.results.length > limit) {
          return { ...output, count: limit, results: output.results.slice(0, limit) };
        }
        return output;
      }
      case OPENBB_TOOL_NAMES.historical:
        return this.historical(args);
      case OPENBB_TOOL_NAMES.fundamentals:
        return this.fundamentals(args);
      case OPENBB_TOOL_NAMES.holdingsInsight:
        return this.holdingsInsight(args);
      default:
        throw new AppError({
          code: 'operation-not-found',
          message: `알 수 없는 OpenBB 도구입니다: ${name}`,
          httpStatus: 404,
          retryable: false,
        });
    }
  }

  private async status(): Promise<Record<string, unknown>> {
    const { client, config } = this.options;
    const base = {
      enabled: config.enabled,
      baseUrl: client.baseUrl,
      allowRemote: config.allowRemote,
      authConfigured: client.authConfigured,
      defaultProvider: config.provider,
    };
    try {
      const server = await client.ping();
      return { ok: true, ...base, reachable: true, server };
    } catch (error) {
      const appError = toAppError(error);
      return {
        ok: true,
        ...base,
        reachable: false,
        error: { code: appError.code, message: appError.message },
      };
    }
  }

  private async multiSymbolCall(
    route: string,
    args: Record<string, unknown>,
    extraQuery: Record<string, OpenBbQueryValue> = {}
  ): Promise<Record<string, unknown>> {
    const symbols = readSymbols(args.symbols);
    const resolved = await this.resolveSymbols(symbols, readMarket(args.market));
    const provider = this.readProvider(args.provider);
    const response = await this.options.client.get(route, {
      symbol: resolved.map((entry) => entry.openbbSymbol).join(','),
      provider,
      ...extraQuery,
    });
    return this.wrap(route, resolved, response);
  }

  private async historical(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = assertTossSymbol(args.symbol);
    const [resolved] = await this.resolveSymbols([symbol], readMarket(args.market));
    const startDate = readDate(args.startDate, 'startDate');
    const endDate = readDate(args.endDate, 'endDate');
    const interval = readEnum(args.interval, 'interval', INTERVALS) ?? '1d';
    const route = '/equity/price/historical';
    const response = await this.options.client.get(route, {
      symbol: resolved!.openbbSymbol,
      provider: this.readProvider(args.provider),
      start_date: startDate,
      end_date: endDate,
      interval,
    });
    return this.wrap(route, [resolved!], response);
  }

  private async fundamentals(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const symbol = assertTossSymbol(args.symbol);
    const statement = readEnum(args.statement, 'statement', STATEMENTS);
    if (!statement) {
      throw invalidInput(`statement 는 필수입니다 (${STATEMENTS.join(', ')}).`);
    }
    const [resolved] = await this.resolveSymbols([symbol], readMarket(args.market));
    const route = `/equity/fundamental/${statement}`;
    const isStatement = statement === 'income' || statement === 'balance' || statement === 'cash';
    const response = await this.options.client.get(route, {
      symbol: resolved!.openbbSymbol,
      provider: this.readProvider(args.provider),
      ...(isStatement
        ? {
            period: readEnum(args.period, 'period', ['annual', 'quarter'] as const) ?? 'annual',
            limit: readInteger(args.limit, 'limit', 1, 20) ?? 4,
          }
        : {}),
    });
    return this.wrap(route, [resolved!], response);
  }

  private async holdingsInsight(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const account =
      typeof args.account === 'string' || typeof args.account === 'number'
        ? String(args.account)
        : undefined;
    const holdingsResult = await this.callToss('getHoldings', {
      ...(account !== undefined ? { account } : {}),
    });
    const items = extractHoldingItems(holdingsResult);
    if (items.length === 0) {
      return { ok: true, count: 0, holdings: [], note: '보유 종목이 없습니다.' };
    }

    const symbols = [...new Set(items.map((item) => String(item.symbol)))].slice(0, 200);
    const resolvedList: ResolvedSymbol[] = [];
    const unresolved: Array<{ symbol: string; reason: string }> = [];
    const markets = await this.lookupTossMarkets(symbols);

    for (const symbol of symbols) {
      const info = markets.get(symbol);
      if (!info) {
        unresolved.push({ symbol, reason: '토스증권 getStocks 에서 시장 정보를 찾지 못했습니다.' });
        continue;
      }
      try {
        resolvedList.push({
          tossSymbol: symbol,
          market: info.market,
          openbbSymbol: toOpenBbSymbol(symbol, info.market),
          ...(info.name ? { name: info.name } : {}),
          marketSource: 'toss-getStocks',
        });
      } catch (error) {
        unresolved.push({ symbol, reason: toAppError(error).message });
      }
    }

    const metricsBySymbol = new Map<string, unknown>();
    let provider: string | undefined;
    let warnings: unknown;
    if (resolvedList.length > 0) {
      const response = await this.options.client.get('/equity/fundamental/metrics', {
        symbol: resolvedList.map((entry) => entry.openbbSymbol).join(','),
        provider: this.readProvider(args.provider),
      });
      provider = response.provider;
      warnings = response.warnings;
      for (const row of Array.isArray(response.results) ? response.results : []) {
        if (isPlainObject(row) && typeof row.symbol === 'string') {
          metricsBySymbol.set(row.symbol.toUpperCase(), row);
        }
      }
    }

    // provider 가 일부 종목 지표를 조용히 빼는 경우를 드러낸다.
    const missingMetrics = resolvedList
      .filter((entry) => !metricsBySymbol.has(entry.openbbSymbol.toUpperCase()))
      .map((entry) => entry.tossSymbol);

    const holdings = items.map((item) => {
      const symbol = String(item.symbol);
      const resolved = resolvedList.find((entry) => entry.tossSymbol === symbol);
      const metrics = resolved ? metricsBySymbol.get(resolved.openbbSymbol.toUpperCase()) : undefined;
      return {
        symbol,
        name: item.name,
        market: resolved?.market ?? null,
        openbbSymbol: resolved?.openbbSymbol ?? null,
        toss: {
          quantity: item.quantity,
          currency: item.currency,
          lastPrice: item.lastPrice,
          averagePurchasePrice: item.averagePurchasePrice,
          marketValue: item.marketValue,
          profitLoss: item.profitLoss,
        },
        openbbMetrics: metrics ?? null,
      };
    });

    return {
      ok: true,
      source: { toss: 'getHoldings + getStocks', openbb: '/equity/fundamental/metrics' },
      ...(provider ? { provider } : {}),
      count: holdings.length,
      holdings,
      ...(unresolved.length > 0 ? { unresolved } : {}),
      ...(missingMetrics.length > 0 ? { missingMetrics } : {}),
      ...(warnings !== undefined ? { warnings } : {}),
      note: OPENBB_PRECISION_NOTE,
      disclaimer: '이 결과는 데이터 결합일 뿐 투자 조언이 아닙니다.',
    };
  }

  /**
   * 토스증권 심볼 → OpenBB 심볼.
   * market 을 주면 그대로 쓰고, 아니면 getStocks 로 시장을 조회한다.
   * getStocks 를 쓸 수 없을 때(인증 미설정 등) 미국 티커만 추론하고 KRX 코드는 오류로 처리한다.
   */
  async resolveSymbols(symbols: string[], market?: TossMarket): Promise<ResolvedSymbol[]> {
    if (market) {
      return symbols.map((symbol) => ({
        tossSymbol: symbol,
        market,
        openbbSymbol: toOpenBbSymbol(symbol, market),
        marketSource: 'user-input' as const,
      }));
    }

    let markets = new Map<string, { market: TossMarket; name?: string }>();
    let lookupError: AppError | undefined;
    try {
      markets = await this.lookupTossMarkets(symbols);
    } catch (error) {
      lookupError = toAppError(error);
      this.logger.warn('토스증권 getStocks 조회에 실패해 심볼 시장을 추론합니다.', {
        code: lookupError.code,
      });
    }

    return symbols.map((symbol) => {
      const info = markets.get(symbol);
      if (info) {
        return {
          tossSymbol: symbol,
          market: info.market,
          openbbSymbol: toOpenBbSymbol(symbol, info.market),
          ...(info.name ? { name: info.name } : {}),
          marketSource: 'toss-getStocks' as const,
        };
      }
      if (!isKrxCode(symbol)) {
        return {
          tossSymbol: symbol,
          market: 'US_ETC' as const,
          openbbSymbol: toOpenBbSymbol(symbol, 'US_ETC'),
          marketSource: 'inferred' as const,
        };
      }
      throw new AppError({
        code: 'invalid-input',
        message:
          `${symbol} 의 시장(KOSPI/KOSDAQ)을 확인하지 못했습니다. ` +
          (lookupError
            ? `토스증권 getStocks 호출 실패(${lookupError.code}). market 인자를 직접 지정하세요.`
            : '토스증권에서 해당 종목을 찾지 못했습니다.'),
        httpStatus: 400,
        retryable: false,
      });
    });
  }

  private async lookupTossMarkets(
    symbols: string[]
  ): Promise<Map<string, { market: TossMarket; name?: string }>> {
    const result = await this.callToss('getStocks', { query: { symbols: symbols.join(',') } });
    const map = new Map<string, { market: TossMarket; name?: string }>();
    const rows = Array.isArray(result) ? result : [];
    for (const row of rows) {
      if (!isPlainObject(row) || typeof row.symbol !== 'string' || !isTossMarket(row.market)) continue;
      map.set(row.symbol.toUpperCase(), {
        market: row.market,
        ...(typeof row.name === 'string' ? { name: row.name } : {}),
      });
    }
    return map;
  }

  /** 토스증권 읽기 operation 만 호출한다. 동일 executor 를 거치므로 기존 정책이 그대로 적용된다. */
  private async callToss(operationId: 'getStocks' | 'getHoldings', args: Record<string, unknown>) {
    const response = await this.options.executor.executeByOperationId(operationId, args);
    if (!('result' in response)) {
      throw new AppError({
        code: 'internal-error',
        message: `${operationId} 가 예상과 다르게 실행되지 않았습니다.`,
        retryable: false,
      });
    }
    return response.result;
  }

  private readProvider(value: unknown): string {
    if (value === undefined || value === null || value === '') return this.options.config.provider;
    if (typeof value !== 'string') throw invalidInput('provider 는 문자열이어야 합니다.');
    try {
      return assertProviderAllowed(value);
    } catch (error) {
      throw invalidInput(toAppError(error).message);
    }
  }

  private wrap(
    route: string,
    symbols: ResolvedSymbol[],
    response: OpenBbResponse
  ): Record<string, unknown> {
    const results = response.results;
    const empty = Array.isArray(results) && results.length === 0;
    const missingSymbols = findMissingSymbols(symbols, results);
    return {
      ok: true,
      source: 'openbb',
      route,
      ...(response.provider ? { provider: response.provider } : {}),
      symbols,
      ...(Array.isArray(results) ? { count: results.length } : {}),
      results,
      ...(response.warnings !== undefined ? { warnings: response.warnings } : {}),
      ...(missingSymbols.length > 0 ? { missingSymbols } : {}),
      ...(empty || missingSymbols.length > 0
        ? {
            hint: 'provider 가 일부 또는 전체 심볼의 결과를 반환하지 않았습니다 (OpenBB 는 이 경우 오류 없이 결과에서 뺍니다). 심볼/시장 또는 provider 지원 범위를 확인하세요.',
          }
        : {}),
      note: OPENBB_PRECISION_NOTE,
    };
  }
}

/**
 * 요청한 심볼 중 결과에 없는 심볼을 찾는다.
 * 결과 행에 symbol 필드가 없는 라우트(단일 심볼 historical 등)는 결과가 비었을 때만 누락으로 본다.
 */
export function findMissingSymbols(symbols: ResolvedSymbol[], results: unknown): string[] {
  if (!Array.isArray(results)) return [];
  if (results.length === 0) return symbols.map((entry) => entry.tossSymbol);
  const returned = new Set(
    results
      .filter((row): row is Record<string, unknown> => isPlainObject(row) && typeof row.symbol === 'string')
      .map((row) => String(row.symbol).toUpperCase())
  );
  if (returned.size === 0) return [];
  return symbols
    .filter((entry) => !returned.has(entry.openbbSymbol.toUpperCase()))
    .map((entry) => entry.tossSymbol);
}

function extractHoldingItems(result: unknown): Array<Record<string, unknown>> {
  if (!isPlainObject(result) || !Array.isArray(result.items)) return [];
  return result.items.filter(
    (item): item is Record<string, unknown> => isPlainObject(item) && typeof item.symbol === 'string'
  );
}

function invalidInput(message: string): AppError {
  return new AppError({ code: 'invalid-input', message, httpStatus: 400, retryable: false });
}

function readSymbols(value: unknown): string[] {
  const list =
    typeof value === 'string' ? value.split(',') : Array.isArray(value) ? value : undefined;
  if (!list || list.length === 0) throw invalidInput('symbols 는 1개 이상의 심볼 배열이어야 합니다.');
  if (list.length > MAX_SYMBOLS) {
    throw invalidInput(`symbols 는 최대 ${MAX_SYMBOLS}개까지 지정할 수 있습니다.`);
  }
  return [...new Set(list.map((entry) => assertTossSymbol(entry)))];
}

function readMarket(value: unknown): TossMarket | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (!isTossMarket(value)) throw invalidInput(`market 은 ${TOSS_MARKETS.join(', ')} 중 하나여야 합니다.`);
  return value;
}

function readDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) {
    throw invalidInput(`${field} 는 YYYY-MM-DD 형식이어야 합니다.`);
  }
  return value;
}

function readEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw invalidInput(`${field} 는 ${allowed.join(', ')} 중 하나여야 합니다.`);
  }
  return value as T;
}

function readInteger(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw invalidInput(`${field} 는 ${min}~${max} 사이 정수여야 합니다.`);
  }
  return value;
}
