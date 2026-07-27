import { createRequire } from 'node:module';
import { AppError } from '../errors/app-error.js';
import { safeJsonParse } from '../utils/json.js';
import type { Logger } from '../utils/logger.js';
import { HTTP_METHODS, type OpenApiDocument } from './types.js';

const require = createRequire(import.meta.url);

export type SpecSource = 'remote' | 'snapshot';

export interface LoadedSpec {
  readonly document: OpenApiDocument;
  readonly source: SpecSource;
  readonly url?: string;
  readonly loadedAt: string;
  /** 원격 로드가 실패해 snapshot 으로 대체된 경우의 안전한 사유. */
  readonly fallbackReason?: string;
}

export interface LoadSpecOptions {
  readonly url: string;
  readonly timeoutMs: number;
  readonly useRemote: boolean;
  readonly logger: Logger;
  /** 테스트 주입용. 기본은 global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** 테스트 주입용. 기본은 번들 snapshot 로더. */
  readonly loadSnapshot?: () => OpenApiDocument;
}

const MAX_SPEC_BYTES = 16 * 1024 * 1024;

/** 번들된 snapshot 을 읽는다. */
export function loadBundledSnapshot(): OpenApiDocument {
  try {
    return require('./openapi.snapshot.json') as OpenApiDocument;
  } catch (error) {
    throw new AppError({
      code: 'openapi-load-failed',
      message:
        '번들된 OpenAPI snapshot 을 읽지 못했습니다. `pnpm openapi:update` 로 snapshot 을 생성하세요.',
      retryable: false,
      cause: error,
    });
  }
}

/**
 * 명세를 확보한다.
 * 1) 원격 공식 JSON -> 2) 실패 시 번들 snapshot -> 3) 둘 다 실패하면 오류.
 */
export async function loadOpenApiSpec(options: LoadSpecOptions): Promise<LoadedSpec> {
  const { logger } = options;

  if (options.useRemote) {
    try {
      const document = await fetchRemoteSpec(options);
      validateSpec(document);
      logger.info('공식 OpenAPI 명세를 원격에서 로드했습니다.', {
        version: document.info?.version,
        openapi: document.openapi,
        paths: Object.keys(document.paths ?? {}).length,
      });
      return {
        document,
        source: 'remote',
        url: options.url,
        loadedAt: new Date().toISOString(),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn('원격 OpenAPI 명세 로드에 실패했습니다. 번들 snapshot 으로 대체합니다.', {
        reason,
      });
      return loadFromSnapshot(options, reason);
    }
  }

  return loadFromSnapshot(options, '원격 로드가 비활성화되어 있습니다 (TOSSINVEST_SPEC_CACHE_ENABLED).');
}

function loadFromSnapshot(options: LoadSpecOptions, reason: string): LoadedSpec {
  const loader = options.loadSnapshot ?? loadBundledSnapshot;
  let document: OpenApiDocument;
  try {
    document = loader();
  } catch (error) {
    throw new AppError({
      code: 'openapi-load-failed',
      message:
        '원격 OpenAPI 명세와 번들 snapshot 을 모두 사용할 수 없어 서버를 시작할 수 없습니다. ' +
        '네트워크 상태를 확인하거나 `pnpm openapi:update` 를 실행하세요.',
      retryable: false,
      details: { remoteFailureReason: reason },
      cause: error,
    });
  }

  validateSpec(document);
  options.logger.info('번들 OpenAPI snapshot 을 사용합니다.', {
    version: document.info?.version,
    openapi: document.openapi,
  });

  return {
    document,
    source: 'snapshot',
    loadedAt: new Date().toISOString(),
    fallbackReason: reason,
  };
}

async function fetchRemoteSpec(options: LoadSpecOptions): Promise<OpenApiDocument> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetchImpl(options.url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new AppError({
        code: 'openapi-load-failed',
        message: `OpenAPI 명세 요청이 실패했습니다 (HTTP ${response.status}).`,
        httpStatus: response.status,
        retryable: true,
      });
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType && !contentType.toLowerCase().includes('json')) {
      throw new AppError({
        code: 'openapi-load-failed',
        message: `OpenAPI 명세 응답이 JSON 이 아닙니다 (content-type: ${contentType}).`,
        retryable: true,
      });
    }

    const text = await response.text();
    if (text.length > MAX_SPEC_BYTES) {
      throw new AppError({
        code: 'response-too-large',
        message: 'OpenAPI 명세 응답이 허용 크기를 초과했습니다.',
        retryable: false,
      });
    }

    let parsed: unknown;
    try {
      parsed = safeJsonParse(text);
    } catch (error) {
      throw new AppError({
        code: 'openapi-load-failed',
        message: 'OpenAPI 명세 JSON 파싱에 실패했습니다.',
        retryable: true,
        cause: error,
      });
    }

    return parsed as OpenApiDocument;
  } finally {
    clearTimeout(timer);
  }
}

/** 명세 필수 필드와 구조를 검증한다. */
export function validateSpec(document: unknown): asserts document is OpenApiDocument {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    throw new AppError({
      code: 'openapi-invalid',
      message: 'OpenAPI 문서가 객체가 아닙니다.',
      retryable: false,
    });
  }

  const doc = document as Record<string, unknown>;

  if (typeof doc.openapi !== 'string' || !/^3\.\d+\.\d+$/.test(doc.openapi)) {
    throw new AppError({
      code: 'openapi-invalid',
      message: `지원하지 않는 OpenAPI 버전입니다: ${String(doc.openapi)}. 3.x 명세가 필요합니다.`,
      retryable: false,
    });
  }

  const info = doc.info as Record<string, unknown> | undefined;
  if (!info || typeof info.title !== 'string' || typeof info.version !== 'string') {
    throw new AppError({
      code: 'openapi-invalid',
      message: 'OpenAPI 문서의 info.title / info.version 이 올바르지 않습니다.',
      retryable: false,
    });
  }

  if (!Array.isArray(doc.servers) || doc.servers.length === 0) {
    throw new AppError({
      code: 'openapi-invalid',
      message: 'OpenAPI 문서에 servers 정의가 없습니다.',
      retryable: false,
    });
  }

  const firstServer = doc.servers[0] as Record<string, unknown> | undefined;
  if (!firstServer || typeof firstServer.url !== 'string') {
    throw new AppError({
      code: 'openapi-invalid',
      message: 'OpenAPI 문서의 servers[0].url 이 올바르지 않습니다.',
      retryable: false,
    });
  }

  const paths = doc.paths as Record<string, unknown> | undefined;
  if (!paths || typeof paths !== 'object' || Array.isArray(paths)) {
    throw new AppError({
      code: 'openapi-invalid',
      message: 'OpenAPI 문서에 paths 정의가 없습니다.',
      retryable: false,
    });
  }
  if (Object.keys(paths).length === 0) {
    throw new AppError({
      code: 'openapi-invalid',
      message: 'OpenAPI 문서의 paths 가 비어 있습니다.',
      retryable: false,
    });
  }

  if (doc.components !== undefined && (typeof doc.components !== 'object' || doc.components === null)) {
    throw new AppError({
      code: 'openapi-invalid',
      message: 'OpenAPI 문서의 components 정의가 올바르지 않습니다.',
      retryable: false,
    });
  }

  // path item 별 method 검증 + operationId 중복 검사
  const seen = new Map<string, string>();
  for (const [path, rawItem] of Object.entries(paths)) {
    if (!path.startsWith('/')) {
      throw new AppError({
        code: 'openapi-invalid',
        message: `path 는 "/" 로 시작해야 합니다: ${path}`,
        retryable: false,
      });
    }
    if (typeof rawItem !== 'object' || rawItem === null) {
      throw new AppError({
        code: 'openapi-invalid',
        message: `path item 이 객체가 아닙니다: ${path}`,
        retryable: false,
      });
    }

    for (const method of HTTP_METHODS) {
      const operation = (rawItem as Record<string, unknown>)[method];
      if (operation === undefined) continue;
      if (typeof operation !== 'object' || operation === null) {
        throw new AppError({
          code: 'openapi-invalid',
          message: `operation 정의가 올바르지 않습니다: ${method.toUpperCase()} ${path}`,
          retryable: false,
        });
      }
      const operationId = (operation as Record<string, unknown>).operationId;
      if (typeof operationId === 'string' && operationId !== '') {
        const previous = seen.get(operationId);
        if (previous) {
          throw new AppError({
            code: 'openapi-invalid',
            message: `중복된 operationId 를 발견했습니다: "${operationId}" (${previous}, ${method.toUpperCase()} ${path}).`,
            retryable: false,
          });
        }
        seen.set(operationId, `${method.toUpperCase()} ${path}`);
      }
    }
  }
}
