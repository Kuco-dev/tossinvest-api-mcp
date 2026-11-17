import { AppError } from '../../errors/app-error.js';

/** 토스증권 StockInfo.market enum (명세 v1.2.5 기준). */
export const TOSS_MARKETS = Object.freeze([
  'KOSPI',
  'KOSDAQ',
  'NYSE',
  'NASDAQ',
  'AMEX',
  'KR_ETC',
  'US_ETC',
] as const);

export type TossMarket = (typeof TOSS_MARKETS)[number];

/** 토스증권 심볼 규칙: 영문 대/소문자, 숫자, '.', '-' 만 허용. */
const TOSS_SYMBOL_PATTERN = /^[A-Za-z0-9.-]{1,20}$/;

/** KRX 단축코드: 6자리. 신규 ETF/ETN 처럼 영문이 섞인 코드(예: 0091P0)도 있다. */
const KRX_CODE_PATTERN = /^[0-9][0-9A-Z]{5}$/;

export interface ResolvedSymbol {
  readonly tossSymbol: string;
  readonly market: TossMarket;
  /** OpenBB 에 전달할 심볼 (Yahoo Finance 표기). */
  readonly openbbSymbol: string;
  readonly name?: string;
  /** 시장 정보를 어디서 얻었는지. */
  readonly marketSource: 'toss-getStocks' | 'user-input' | 'inferred';
}

export function assertTossSymbol(symbol: unknown): string {
  if (typeof symbol !== 'string' || !TOSS_SYMBOL_PATTERN.test(symbol.trim())) {
    throw new AppError({
      code: 'invalid-input',
      message:
        "symbol 은 토스증권 심볼이어야 합니다. KRX: 6자리 코드(예: 005930), US: 티커(예: AAPL). 영문/숫자/'.'/'-' 만 허용됩니다.",
      httpStatus: 400,
      retryable: false,
    });
  }
  return symbol.trim().toUpperCase();
}

export function isKrxCode(symbol: string): boolean {
  return KRX_CODE_PATTERN.test(symbol);
}

export function isTossMarket(value: unknown): value is TossMarket {
  return typeof value === 'string' && (TOSS_MARKETS as readonly string[]).includes(value);
}

/**
 * 토스증권 심볼 + 시장 → OpenBB(yfinance 계열) 심볼.
 *
 * - KOSPI  → `005930.KS`
 * - KOSDAQ → `035900.KQ`
 * - 미국   → 클래스 주식의 '.' 을 '-' 로 (BRK.B → BRK-B)
 * - KR_ETC(KONEX 등)는 Yahoo 표기가 일정하지 않아 지원하지 않는다.
 *
 * 시장 suffix 를 잘못 붙이면 OpenBB 는 오류 대신 빈 결과를 돌려주므로
 * (실측: 035720.KQ → results 누락) 시장은 추측하지 않고 토스증권 getStocks 결과를 쓴다.
 */
export function toOpenBbSymbol(tossSymbol: string, market: TossMarket): string {
  switch (market) {
    case 'KOSPI':
      return `${tossSymbol}.KS`;
    case 'KOSDAQ':
      return `${tossSymbol}.KQ`;
    case 'NYSE':
    case 'NASDAQ':
    case 'AMEX':
    case 'US_ETC':
      return tossSymbol.replace(/\./g, '-');
    case 'KR_ETC':
    default:
      throw new AppError({
        code: 'invalid-input',
        message: `${tossSymbol} 은(는) ${market} 시장 종목이라 OpenBB 심볼로 변환할 수 없습니다. openbbSymbol 을 직접 지정하세요.`,
        httpStatus: 400,
        retryable: false,
      });
  }
}
