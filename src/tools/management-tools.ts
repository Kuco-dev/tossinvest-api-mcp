import type { TokenManager } from '../auth/token-manager.js';
import { MANAGEMENT_TOOL_NAMES, SERVER_VERSION } from '../config/constants.js';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import type { LoadedSpec } from '../openapi/loader.js';
import type { OperationInfo, OperationRegistry } from '../openapi/operation-index.js';
import type { JsonSchema } from '../openapi/schema-converter.js';
import { isPlainObject } from '../utils/json.js';
import { describeMutationClass } from './mutation-classifier.js';
import type { OperationCallResult, OperationExecutor } from './operation-tools.js';

export interface ManagementToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: {
    readonly title: string;
    readonly readOnlyHint: boolean;
    readonly destructiveHint: boolean;
    readonly idempotentHint: boolean;
    readonly openWorldHint: boolean;
  };
}

export interface ManagementToolsOptions {
  readonly registry: OperationRegistry;
  readonly spec: LoadedSpec;
  readonly config: AppConfig;
  readonly tokenManager: TokenManager;
  readonly executor: OperationExecutor;
}

const readOnlyAnnotations = (title: string) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export class ManagementTools {
  constructor(private readonly options: ManagementToolsOptions) {}

  get definitions(): ManagementToolDefinition[] {
    const definitions: ManagementToolDefinition[] = [
      {
        name: MANAGEMENT_TOOL_NAMES.overview,
        description:
          '로드된 토스증권 OpenAPI 명세의 요약 정보를 반환합니다. 버전, 서버 URL, tag 목록, operation 수, 실주문 활성화 상태, snapshot/원격 사용 여부를 포함합니다.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: readOnlyAnnotations('API 개요'),
      },
      {
        name: MANAGEMENT_TOOL_NAMES.listOperations,
        description:
          '등록된 operation 목록을 필터링해 반환합니다. tag, method, path, readOnly, destructive, keyword 로 필터링할 수 있습니다.',
        inputSchema: {
          type: 'object',
          properties: {
            tag: { type: 'string', description: 'tag 이름 (부분 일치, 대소문자 무시)' },
            method: {
              type: 'string',
              description: 'HTTP method',
              enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
            },
            path: { type: 'string', description: 'path 부분 문자열' },
            readOnly: { type: 'boolean', description: '읽기 전용 operation 만 조회' },
            destructive: { type: 'boolean', description: '자산에 영향을 주는 mutation 만 조회' },
            keyword: { type: 'string', description: 'operationId/summary/description 키워드' },
          },
          additionalProperties: false,
        },
        annotations: readOnlyAnnotations('operation 목록'),
      },
      {
        name: MANAGEMENT_TOOL_NAMES.searchOperations,
        description:
          'operationId, summary, description, path, tag 를 대상으로 operation 을 검색합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '검색어', minLength: 1 },
            limit: { type: 'integer', description: '최대 결과 수 (기본 20)', minimum: 1, maximum: 100 },
          },
          required: ['query'],
          additionalProperties: false,
        },
        annotations: readOnlyAnnotations('operation 검색'),
      },
      {
        name: MANAGEMENT_TOOL_NAMES.getOperation,
        description:
          '특정 operationId 의 상세 정보(method, path, tag, 설명, 필수/선택 입력, requestBody, 응답 스키마, 계좌 헤더 필요 여부, mutation 여부, rate limit 그룹, MCP 도구 이름)를 반환합니다.',
        inputSchema: {
          type: 'object',
          properties: {
            operationId: { type: 'string', description: 'OpenAPI operationId', minLength: 1 },
          },
          required: ['operationId'],
          additionalProperties: false,
        },
        annotations: readOnlyAnnotations('operation 상세'),
      },
      {
        name: MANAGEMENT_TOOL_NAMES.callOperation,
        description:
          'operationId 로 임의의 토스증권 API operation 을 호출합니다. 직접 도구 등록을 지원하지 않는 클라이언트를 위한 wrapper 입니다. ' +
          '이 wrapper 도 동일한 mutation guard 를 통과하므로 주문 안전정책을 우회할 수 없습니다 (dryRun 기본 true).',
        inputSchema: {
          type: 'object',
          properties: {
            operationId: { type: 'string', description: '호출할 operationId', minLength: 1 },
            account: {
              type: 'string',
              description: '계좌 accountSeq. 미지정 시 TOSSINVEST_DEFAULT_ACCOUNT 사용.',
            },
            path: { type: 'object', description: 'path parameter', additionalProperties: true },
            query: { type: 'object', description: 'query parameter', additionalProperties: true },
            body: { description: '요청 본문 (JSON)' },
            dryRun: {
              type: 'boolean',
              default: true,
              description: 'mutation 인 경우 기본 true. false 로 명시해야 실제 요청을 보냅니다.',
            },
            confirmation: {
              type: 'string',
              default: '',
              description: 'mutation 실행 확인 문자열 (TOSSINVEST_MUTATION_CONFIRMATION 과 일치해야 함).',
            },
          },
          required: ['operationId'],
          additionalProperties: false,
        },
        annotations: {
          title: 'operation 호출 wrapper',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
      {
        name: MANAGEMENT_TOOL_NAMES.authStatus,
        description:
          '인증 설정과 토큰 준비 상태를 안전하게 반환합니다. client ID 는 마스킹되며 client secret 과 access token 은 절대 반환하지 않습니다.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: readOnlyAnnotations('인증 상태'),
      },
      {
        name: MANAGEMENT_TOOL_NAMES.refreshAuth,
        description:
          'access token 을 명시적으로 재발급합니다. 토큰 문자열은 반환하지 않고 만료 정보만 반환합니다.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        annotations: {
          title: '토큰 갱신',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      },
    ];

    if (this.options.config.enableRawRequests) {
      definitions.push({
        name: MANAGEMENT_TOOL_NAMES.rawRequest,
        description:
          '공식 OpenAPI 에 정의된 method + path 조합만 직접 호출합니다 (TOSSINVEST_ENABLE_RAW_REQUESTS=true 일 때만 노출). ' +
          '명세에 없는 경로는 호출할 수 없으며, 주문 안전정책도 동일하게 적용됩니다.',
        inputSchema: {
          type: 'object',
          properties: {
            method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
            path: {
              type: 'string',
              description: '공식 명세에 정의된 path 템플릿 (예: /api/v1/orders/{orderId})',
            },
            account: { type: 'string' },
            pathParams: { type: 'object', additionalProperties: true },
            query: { type: 'object', additionalProperties: true },
            body: {},
            dryRun: { type: 'boolean', default: true },
            confirmation: { type: 'string', default: '' },
          },
          required: ['method', 'path'],
          additionalProperties: false,
        },
        annotations: {
          title: 'raw request (제한적)',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
        },
      });
    }

    return definitions;
  }

  handles(name: string): boolean {
    return this.definitions.some((definition) => definition.name === name);
  }

  async call(name: string, rawArgs: unknown): Promise<unknown> {
    const args = isPlainObject(rawArgs) ? rawArgs : {};

    switch (name) {
      case MANAGEMENT_TOOL_NAMES.overview:
        return this.overview();
      case MANAGEMENT_TOOL_NAMES.listOperations:
        return this.listOperations(args);
      case MANAGEMENT_TOOL_NAMES.searchOperations:
        return this.searchOperations(args);
      case MANAGEMENT_TOOL_NAMES.getOperation:
        return this.getOperation(args);
      case MANAGEMENT_TOOL_NAMES.callOperation:
        return this.callOperation(args);
      case MANAGEMENT_TOOL_NAMES.authStatus:
        return this.options.tokenManager.getStatus();
      case MANAGEMENT_TOOL_NAMES.refreshAuth:
        return this.options.tokenManager.refresh();
      case MANAGEMENT_TOOL_NAMES.rawRequest:
        return this.rawRequest(args);
      default:
        throw new AppError({
          code: 'operation-not-found',
          message: `알 수 없는 관리 도구입니다: ${name}`,
          httpStatus: 404,
          retryable: false,
        });
    }
  }

  private overview(): Record<string, unknown> {
    const { registry, spec, config } = this.options;
    const operations = registry.all;
    const readCount = operations.filter((operation) => operation.readOnly).length;
    const mutationCount = operations.filter((operation) => operation.mutation !== 'none').length;

    return {
      ok: true,
      serverVersion: SERVER_VERSION,
      openapiVersion: spec.document.openapi,
      apiDocumentVersion: spec.document.info.version,
      apiTitle: spec.document.info.title,
      apiServerUrl: config.baseUrl,
      specSource: spec.source,
      specLoadedAt: spec.loadedAt,
      ...(spec.fallbackReason ? { specFallbackReason: spec.fallbackReason } : {}),
      tags: registry.tags,
      operationCount: operations.length,
      readOperationCount: readCount,
      mutationOperationCount: mutationCount,
      excludedOperations: registry.excluded,
      trading: {
        enabled: config.enableTrading,
        conditionalOrdersEnabled: config.enableConditionalOrders,
        dryRunDefault: true,
        confirmationRequired: true,
        mutationAutoRetry: false,
      },
      rawRequestsEnabled: config.enableRawRequests,
      customBaseUrlAllowed: config.allowCustomBaseUrl,
      strictSpecValidation: config.openapiStrict,
    };
  }

  private listOperations(args: Record<string, unknown>): Record<string, unknown> {
    const tag = asString(args.tag)?.toLowerCase();
    const method = asString(args.method)?.toUpperCase();
    const path = asString(args.path)?.toLowerCase();
    const keyword = asString(args.keyword)?.toLowerCase();
    const readOnly = typeof args.readOnly === 'boolean' ? args.readOnly : undefined;
    const destructive = typeof args.destructive === 'boolean' ? args.destructive : undefined;

    const matched = this.options.registry.all.filter((operation) => {
      if (tag && !operation.tags.some((entry) => entry.toLowerCase().includes(tag))) return false;
      if (method && operation.method !== method) return false;
      if (path && !operation.path.toLowerCase().includes(path)) return false;
      if (readOnly !== undefined && operation.readOnly !== readOnly) return false;
      if (destructive !== undefined && (operation.mutation !== 'none') !== destructive) return false;
      if (keyword) {
        const haystack = [
          operation.operationId,
          operation.summary ?? '',
          operation.description ?? '',
          operation.path,
          operation.tags.join(' '),
        ]
          .join(' ')
          .toLowerCase();
        if (!haystack.includes(keyword)) return false;
      }
      return true;
    });

    return {
      ok: true,
      count: matched.length,
      operations: matched.map((operation) => summarizeOperation(operation)),
    };
  }

  private searchOperations(args: Record<string, unknown>): Record<string, unknown> {
    const query = asString(args.query);
    if (!query) {
      throw new AppError({
        code: 'invalid-input',
        message: 'query 는 필수입니다.',
        httpStatus: 400,
        retryable: false,
      });
    }
    const limit = typeof args.limit === 'number' ? Math.min(Math.max(args.limit, 1), 100) : 20;
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    const scored = this.options.registry.all
      .map((operation) => {
        const fields = {
          operationId: operation.operationId.toLowerCase(),
          summary: (operation.summary ?? '').toLowerCase(),
          description: (operation.description ?? '').toLowerCase(),
          path: operation.path.toLowerCase(),
          tags: operation.tags.join(' ').toLowerCase(),
        };
        let score = 0;
        for (const term of terms) {
          if (fields.operationId === term) score += 100;
          else if (fields.operationId.includes(term)) score += 40;
          if (fields.summary.includes(term)) score += 20;
          if (fields.tags.includes(term)) score += 10;
          if (fields.path.includes(term)) score += 8;
          if (fields.description.includes(term)) score += 3;
        }
        return { operation, score };
      })
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return {
      ok: true,
      query,
      count: scored.length,
      operations: scored.map((entry) => ({
        ...summarizeOperation(entry.operation),
        score: entry.score,
      })),
    };
  }

  private getOperation(args: Record<string, unknown>): Record<string, unknown> {
    const operationId = asString(args.operationId);
    if (!operationId) {
      throw new AppError({
        code: 'invalid-input',
        message: 'operationId 는 필수입니다.',
        httpStatus: 400,
        retryable: false,
      });
    }

    const operation = this.options.registry.require(operationId);
    const requiredInputs: string[] = [];
    const optionalInputs: string[] = [];

    for (const param of operation.pathParameters) {
      (param.required ? requiredInputs : optionalInputs).push(`path.${param.name}`);
    }
    for (const param of operation.queryParameters) {
      (param.required ? requiredInputs : optionalInputs).push(`query.${param.name}`);
    }
    if (operation.requestBody) {
      (operation.requestBody.required ? requiredInputs : optionalInputs).push('body');
    }
    if (operation.requiresAccount) {
      requiredInputs.push('account (또는 TOSSINVEST_DEFAULT_ACCOUNT)');
    }
    if (operation.mutation !== 'none') {
      optionalInputs.push('dryRun (기본 true)', 'confirmation');
    }

    return {
      ok: true,
      operationId: operation.operationId,
      mcpToolName: operation.toolName,
      method: operation.method,
      path: operation.path,
      tags: operation.tags,
      summary: operation.summary,
      description: operation.description,
      deprecated: operation.deprecated,
      requiredInputs,
      optionalInputs,
      parameters: {
        path: operation.pathParameters,
        query: operation.queryParameters,
        header: operation.headerParameters,
      },
      requestBody: operation.requestBody ?? null,
      responseSchema: operation.responseSchema ?? null,
      requiresAccountHeader: operation.requiresAccount,
      requiresAuth: operation.requiresAuth,
      isMutation: operation.mutation !== 'none',
      mutationType: operation.mutation,
      mutationDescription: describeMutationClass(operation.mutation),
      readOnly: operation.readOnly,
      rateLimitGroup: operation.rateLimitGroup ?? null,
    };
  }

  private async callOperation(args: Record<string, unknown>): Promise<OperationCallResult> {
    const operationId = asString(args.operationId);
    if (!operationId) {
      throw new AppError({
        code: 'invalid-input',
        message: 'operationId 는 필수입니다.',
        httpStatus: 400,
        retryable: false,
      });
    }

    const { operationId: _ignored, ...rest } = args;
    return this.options.executor.executeByOperationId(operationId, rest);
  }

  private async rawRequest(args: Record<string, unknown>): Promise<OperationCallResult> {
    if (!this.options.config.enableRawRequests) {
      throw new AppError({
        code: 'feature-disabled',
        message: 'raw request 는 비활성화되어 있습니다 (TOSSINVEST_ENABLE_RAW_REQUESTS=false).',
        httpStatus: 403,
        retryable: false,
      });
    }

    const method = asString(args.method);
    const path = asString(args.path);
    if (!method || !path) {
      throw new AppError({
        code: 'invalid-input',
        message: 'method 와 path 는 필수입니다.',
        httpStatus: 400,
        retryable: false,
      });
    }

    // 공식 OpenAPI 에 정의된 method + path 조합만 허용한다. 임의 URL 호출 불가.
    const operation = this.options.registry.findByRoute(method, path);
    if (!operation) {
      throw new AppError({
        code: 'operation-not-found',
        message: `공식 OpenAPI 명세에 정의되지 않은 요청입니다: ${method.toUpperCase()} ${path}`,
        httpStatus: 404,
        retryable: false,
      });
    }

    // raw request 도 동일한 executor 를 사용하므로 mutation guard 를 우회할 수 없다.
    return this.options.executor.execute(operation, {
      ...(args.pathParams !== undefined ? { path: args.pathParams } : {}),
      ...(args.query !== undefined ? { query: args.query } : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.account !== undefined ? { account: args.account } : {}),
      ...(args.dryRun !== undefined ? { dryRun: args.dryRun } : {}),
      ...(args.confirmation !== undefined ? { confirmation: args.confirmation } : {}),
    });
  }
}

function summarizeOperation(operation: OperationInfo): Record<string, unknown> {
  return {
    operationId: operation.operationId,
    mcpToolName: operation.toolName,
    method: operation.method,
    path: operation.path,
    tags: operation.tags,
    summary: operation.summary ?? null,
    readOnly: operation.readOnly,
    isMutation: operation.mutation !== 'none',
    mutationType: operation.mutation,
    requiresAccountHeader: operation.requiresAccount,
    rateLimitGroup: operation.rateLimitGroup ?? null,
  };
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value.trim();
  return undefined;
}
