import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppConfig } from '../../src/config/env.js';
import type { OpenApiDocument } from '../../src/openapi/types.js';
import type { Logger } from '../../src/utils/logger.js';

const here = dirname(fileURLToPath(import.meta.url));

export function loadSnapshot(): OpenApiDocument {
  const path = resolve(here, '../../src/openapi/openapi.snapshot.json');
  return JSON.parse(readFileSync(path, 'utf8')) as OpenApiDocument;
}

export const silentLogger: Logger = {
  level: 'silent',
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  child: () => silentLogger,
};

export function makeConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    clientId: 'c_test_client_id_1234567890',
    clientSecret: 's_test_client_secret_abcdefghijklmnop',
    defaultAccount: undefined,
    openapiUrl: 'https://openapi.tossinvest.com/openapi-docs/latest/openapi.json',
    baseUrl: 'https://openapi.tossinvest.com',
    allowCustomBaseUrl: false,
    openapiStrict: true,
    specCacheEnabled: false,
    enableTrading: false,
    enableConditionalOrders: false,
    mutationConfirmation: 'I_UNDERSTAND_THIS_PLACES_A_REAL_ORDER',
    tokenExpirySkewSeconds: 60,
    requestTimeoutMs: 5_000,
    maxReadRetries: 2,
    maxResponseBytes: 8 * 1024 * 1024,
    logLevel: 'silent',
    enableRawRequests: false,
    ...overrides,
  };
}

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
}

export interface MockResponseSpec {
  readonly status?: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
  readonly rawBody?: string;
  readonly throws?: Error;
}

export interface MockFetch {
  readonly fetch: typeof fetch;
  readonly calls: RecordedRequest[];
}

/** 순차적으로 응답을 돌려주는 fetch mock. 마지막 응답은 반복 사용된다. */
export function createMockFetch(specs: MockResponseSpec[]): MockFetch {
  const calls: RecordedRequest[] = [];
  let index = 0;

  const mock = (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const headers: Record<string, string> = {};
    const rawHeaders = init?.headers;
    if (rawHeaders) {
      for (const [key, value] of Object.entries(rawHeaders as Record<string, string>)) {
        headers[key.toLowerCase()] = value;
      }
    }
    calls.push({
      url,
      method: (init?.method ?? 'GET').toUpperCase(),
      headers,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    });

    const spec = specs[Math.min(index, specs.length - 1)] ?? { status: 200, body: {} };
    index += 1;

    if (spec.throws) throw spec.throws;

    const status = spec.status ?? 200;
    const bodyText = spec.rawBody ?? (spec.body === undefined ? '' : JSON.stringify(spec.body));
    return new Response(bodyText, {
      status,
      headers: {
        'content-type': 'application/json',
        ...(spec.headers ?? {}),
      },
    });
  }) as unknown as typeof fetch;

  return { fetch: mock, calls };
}

export const TOKEN_RESPONSE = {
  access_token: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.testpayloadvalue.testsignaturevalue',
  token_type: 'Bearer',
  expires_in: 86400,
};
