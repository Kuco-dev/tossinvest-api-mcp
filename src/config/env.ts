import { z } from 'zod';
import {
  ALLOWED_LOCAL_HOSTS,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_OPENAPI_URL,
  OFFICIAL_HOSTS,
} from './constants.js';

const booleanish = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw.trim() === '') return defaultValue;
      const normalized = raw.trim().toLowerCase();
      if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
      if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
      return defaultValue;
    });

const intish = (defaultValue: number, min: number, max: number) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw.trim() === '') return defaultValue;
      const parsed = Number.parseInt(raw.trim(), 10);
      if (!Number.isFinite(parsed)) return defaultValue;
      return Math.min(Math.max(parsed, min), max);
    });

const trimmedOptional = z
  .string()
  .optional()
  .transform((raw) => {
    const value = raw?.trim();
    return value === undefined || value === '' ? undefined : value;
  });

const envSchema = z.object({
  TOSSINVEST_CLIENT_ID: trimmedOptional,
  TOSSINVEST_CLIENT_SECRET: trimmedOptional,
  TOSSINVEST_DEFAULT_ACCOUNT: trimmedOptional,

  TOSSINVEST_OPENAPI_URL: z
    .string()
    .optional()
    .transform((raw) => (raw?.trim() ? raw.trim() : DEFAULT_OPENAPI_URL)),
  TOSSINVEST_BASE_URL: z
    .string()
    .optional()
    .transform((raw) => (raw?.trim() ? raw.trim().replace(/\/+$/, '') : DEFAULT_BASE_URL)),
  TOSSINVEST_ALLOW_CUSTOM_BASE_URL: booleanish(false),
  TOSSINVEST_OPENAPI_STRICT: booleanish(true),
  TOSSINVEST_SPEC_CACHE_ENABLED: booleanish(true),

  TOSSINVEST_ENABLE_TRADING: booleanish(false),
  TOSSINVEST_ENABLE_CONDITIONAL_ORDERS: booleanish(false),
  TOSSINVEST_MUTATION_CONFIRMATION: z
    .string()
    .optional()
    .transform((raw) =>
      raw?.trim() ? raw.trim() : 'I_UNDERSTAND_THIS_PLACES_A_REAL_ORDER'
    ),

  TOSSINVEST_TOKEN_EXPIRY_SKEW_SECONDS: intish(60, 0, 3600),
  TOSSINVEST_REQUEST_TIMEOUT_MS: intish(30_000, 1_000, 300_000),
  TOSSINVEST_MAX_READ_RETRIES: intish(2, 0, 5),
  TOSSINVEST_MAX_RESPONSE_BYTES: intish(DEFAULT_MAX_RESPONSE_BYTES, 64 * 1024, 64 * 1024 * 1024),

  TOSSINVEST_LOG_LEVEL: z
    .enum(['silent', 'error', 'warn', 'info', 'debug'])
    .optional()
    .transform((raw) => raw ?? 'info'),
  TOSSINVEST_ENABLE_RAW_REQUESTS: booleanish(false),
});

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface AppConfig {
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly defaultAccount?: string;

  readonly openapiUrl: string;
  readonly baseUrl: string;
  readonly allowCustomBaseUrl: boolean;
  readonly openapiStrict: boolean;
  readonly specCacheEnabled: boolean;

  readonly enableTrading: boolean;
  readonly enableConditionalOrders: boolean;
  readonly mutationConfirmation: string;

  readonly tokenExpirySkewSeconds: number;
  readonly requestTimeoutMs: number;
  readonly maxReadRetries: number;
  readonly maxResponseBytes: number;

  readonly logLevel: LogLevel;
  readonly enableRawRequests: boolean;
}

export class ConfigError extends Error {
  public override readonly name = 'ConfigError';
}

/** base URL 검증. SSRF 프록시로 악용되지 않도록 기본은 공식 도메인만 허용한다. */
export function assertBaseUrlAllowed(baseUrl: string, allowCustom: boolean): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError(`TOSSINVEST_BASE_URL 이 올바른 URL 이 아닙니다: ${baseUrl}`);
  }

  const host = url.hostname.toLowerCase();

  if (!allowCustom) {
    if (url.protocol !== 'https:' || !OFFICIAL_HOSTS.includes(host)) {
      throw new ConfigError(
        `기본 설정에서는 공식 토스증권 도메인(${OFFICIAL_HOSTS.join(', ')})만 허용합니다. ` +
          `custom base URL 을 사용하려면 TOSSINVEST_ALLOW_CUSTOM_BASE_URL=true 로 설정하세요.`
      );
    }
    return url;
  }

  const isLocal = ALLOWED_LOCAL_HOSTS.includes(host) || host === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new ConfigError(
      'custom base URL 은 HTTPS 이거나 명시적으로 허용된 로컬 주소(localhost, 127.0.0.1, ::1)여야 합니다.'
    );
  }
  return url;
}

/** OpenAPI 명세 URL 검증. 로컬 file: 등 임의 스킴을 막는다. */
export function assertSpecUrlAllowed(specUrl: string, allowCustom: boolean): URL {
  let url: URL;
  try {
    url = new URL(specUrl);
  } catch {
    throw new ConfigError(`TOSSINVEST_OPENAPI_URL 이 올바른 URL 이 아닙니다: ${specUrl}`);
  }

  const host = url.hostname.toLowerCase();
  if (!allowCustom) {
    if (url.protocol !== 'https:' || !OFFICIAL_HOSTS.includes(host)) {
      throw new ConfigError(
        `기본 설정에서는 공식 OpenAPI 명세 URL 만 허용합니다. 현재 값: ${redactUrl(url)}`
      );
    }
    return url;
  }

  const isLocal = ALLOWED_LOCAL_HOSTS.includes(host) || host === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocal)) {
    throw new ConfigError('custom OpenAPI 명세 URL 은 HTTPS 이거나 허용된 로컬 주소여야 합니다.');
  }
  return url;
}

function redactUrl(url: URL): string {
  return `${url.protocol}//${url.host}${url.pathname}`;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n  - ');
    throw new ConfigError(`환경변수 검증에 실패했습니다:\n  - ${issues}`);
  }

  const raw = parsed.data;
  const allowCustom = raw.TOSSINVEST_ALLOW_CUSTOM_BASE_URL;

  // 인증 정보가 없어도 서버는 기동해야 하므로 여기서는 URL 정책만 강제한다.
  assertBaseUrlAllowed(raw.TOSSINVEST_BASE_URL, allowCustom);
  assertSpecUrlAllowed(raw.TOSSINVEST_OPENAPI_URL, allowCustom);

  return {
    clientId: raw.TOSSINVEST_CLIENT_ID,
    clientSecret: raw.TOSSINVEST_CLIENT_SECRET,
    defaultAccount: raw.TOSSINVEST_DEFAULT_ACCOUNT,

    openapiUrl: raw.TOSSINVEST_OPENAPI_URL,
    baseUrl: raw.TOSSINVEST_BASE_URL,
    allowCustomBaseUrl: allowCustom,
    openapiStrict: raw.TOSSINVEST_OPENAPI_STRICT,
    specCacheEnabled: raw.TOSSINVEST_SPEC_CACHE_ENABLED,

    enableTrading: raw.TOSSINVEST_ENABLE_TRADING,
    enableConditionalOrders: raw.TOSSINVEST_ENABLE_CONDITIONAL_ORDERS,
    mutationConfirmation: raw.TOSSINVEST_MUTATION_CONFIRMATION,

    tokenExpirySkewSeconds: raw.TOSSINVEST_TOKEN_EXPIRY_SKEW_SECONDS,
    requestTimeoutMs: raw.TOSSINVEST_REQUEST_TIMEOUT_MS,
    maxReadRetries: raw.TOSSINVEST_MAX_READ_RETRIES,
    maxResponseBytes: raw.TOSSINVEST_MAX_RESPONSE_BYTES,

    logLevel: raw.TOSSINVEST_LOG_LEVEL,
    enableRawRequests: raw.TOSSINVEST_ENABLE_RAW_REQUESTS,
  };
}
