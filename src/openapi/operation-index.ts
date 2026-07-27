import {
  ACCOUNT_HEADER,
  MAX_TOOL_NAME_LENGTH,
  TOKEN_OPERATION_ID,
} from '../config/constants.js';
import { AppError } from '../errors/app-error.js';
import { classifyMutation, type MutationClass } from '../tools/mutation-classifier.js';
import { RefResolver } from './resolver.js';
import { convertSchema, type JsonSchema } from './schema-converter.js';
import {
  HTTP_METHODS,
  type HttpMethod,
  type JsonSchemaLike,
  type OpenApiDocument,
  type OpenApiOperation,
  type OpenApiParameter,
} from './types.js';

export interface ParameterInfo {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly description?: string;
  readonly schema: JsonSchema;
  readonly explode?: boolean;
  readonly style?: string;
}

export interface RequestBodyInfo {
  readonly required: boolean;
  readonly contentType: string;
  readonly schema: JsonSchema;
  readonly description?: string;
}

export interface OperationInfo {
  readonly operationId: string;
  readonly toolName: string;
  readonly method: Uppercase<HttpMethod>;
  readonly path: string;
  readonly tags: readonly string[];
  readonly summary?: string;
  readonly description?: string;
  readonly deprecated: boolean;
  readonly pathParameters: readonly ParameterInfo[];
  readonly queryParameters: readonly ParameterInfo[];
  /** 사용자에게 노출하지 않는 헤더(계좌 헤더 등)를 제외한 헤더 파라미터. */
  readonly headerParameters: readonly ParameterInfo[];
  readonly requiresAccount: boolean;
  readonly requestBody?: RequestBodyInfo;
  readonly responseSchema?: JsonSchema;
  readonly rateLimitGroup?: string;
  readonly mutation: MutationClass;
  readonly readOnly: boolean;
  readonly requiresAuth: boolean;
}

export interface ExcludedOperation {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly reason: string;
}

export interface OperationIndexResult {
  readonly operations: readonly OperationInfo[];
  readonly excluded: readonly ExcludedOperation[];
}

/** operationId 를 MCP 도구 이름 규칙(`[A-Za-z0-9_-]{1,64}`)에 맞게 정규화한다. */
export function normalizeToolName(operationId: string): string {
  const normalized = operationId
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_{2,}/g, '_')
    .replace(/^[_-]+/, '');
  const truncated = normalized.slice(0, MAX_TOOL_NAME_LENGTH);
  if (truncated.length === 0) {
    throw new AppError({
      code: 'openapi-invalid',
      message: `operationId 를 MCP 도구 이름으로 변환할 수 없습니다: ${operationId}`,
      retryable: false,
    });
  }
  return truncated;
}

function extractRateLimitGroup(description: string | undefined): string | undefined {
  if (!description) return undefined;
  const match = description.match(/Rate Limits? Group\*{0,2}\s*[:：]\s*`?([A-Z0-9_]+)`?/i);
  return match?.[1];
}

function buildToolDescription(
  operation: OpenApiOperation,
  method: string,
  path: string,
  mutation: MutationClass
): string {
  const parts: string[] = [];
  if (operation.summary) parts.push(operation.summary);
  if (operation.description) {
    const trimmed = operation.description.trim();
    if (trimmed && trimmed !== operation.summary) parts.push(trimmed);
  }
  parts.push(`[${method.toUpperCase()} ${path}]`);
  if (operation.tags?.length) parts.push(`tags: ${operation.tags.join(', ')}`);
  if (mutation !== 'none') {
    parts.push(
      mutation === 'order'
        ? '⚠️ 실제 자산에 영향을 주는 주문 API 입니다. 기본값은 dryRun=true 이며 실행하려면 TOSSINVEST_ENABLE_TRADING=true 와 confirmation 이 필요합니다.'
        : '⚠️ 실제 자산에 영향을 주는 조건주문 API 입니다. 기본값은 dryRun=true 이며 실행하려면 TOSSINVEST_ENABLE_CONDITIONAL_ORDERS=true 와 confirmation 이 필요합니다.'
    );
  }
  return parts.join('\n\n');
}

function toParameterInfo(param: OpenApiParameter, resolver: RefResolver): ParameterInfo | null {
  const resolved = resolver.deref(param);
  const name = resolved.name;
  const location = resolved.in;
  if (!name || !location) return null;
  if (location === 'cookie') return null;
  if (location !== 'path' && location !== 'query' && location !== 'header') return null;

  const schema = resolved.schema ? convertSchema(resolved.schema, resolver) : { type: 'string' };
  return {
    name,
    in: location,
    required: resolved.required === true || location === 'path',
    ...(resolved.description ? { description: resolved.description.trim() } : {}),
    schema,
    ...(resolved.explode !== undefined ? { explode: resolved.explode } : {}),
    ...(resolved.style ? { style: resolved.style } : {}),
  };
}

function pickRequestBody(
  operation: OpenApiOperation,
  resolver: RefResolver
): RequestBodyInfo | undefined {
  if (!operation.requestBody) return undefined;
  const body = resolver.deref(operation.requestBody);
  const content = body.content ?? {};
  const contentTypes = Object.keys(content);
  if (contentTypes.length === 0) return undefined;

  const preferred =
    contentTypes.find((type) => type.includes('application/json')) ??
    contentTypes.find((type) => type.includes('x-www-form-urlencoded')) ??
    contentTypes[0];

  if (!preferred) return undefined;
  const media = content[preferred];
  if (!media?.schema) {
    throw new AppError({
      code: 'openapi-invalid',
      message: `requestBody 에 schema 가 정의되어 있지 않습니다: ${operation.operationId ?? '(unknown)'}`,
      retryable: false,
    });
  }

  return {
    required: body.required === true,
    contentType: preferred,
    schema: convertSchema(media.schema, resolver),
    ...(body.description ? { description: body.description.trim() } : {}),
  };
}

function pickResponseSchema(
  operation: OpenApiOperation,
  resolver: RefResolver
): JsonSchema | undefined {
  const responses = operation.responses ?? {};
  const successKey = Object.keys(responses).find((key) => key.startsWith('2'));
  if (!successKey) return undefined;
  const rawResponse = responses[successKey];
  if (!rawResponse) return undefined;

  try {
    const response = resolver.deref(rawResponse);
    const media = response.content?.['application/json'];
    if (!media?.schema) return undefined;
    return convertSchema(media.schema as JsonSchemaLike, resolver);
  } catch {
    // 응답 스키마는 호출에 필수적이지 않으므로 실패해도 operation 자체를 버리지 않는다.
    return undefined;
  }
}

/**
 * OpenAPI 문서 전체를 순회하여 MCP 도구로 등록할 operation 인덱스를 만든다.
 *
 * @param strict true 면 변환 실패 operation 하나라도 있으면 전체 실패(fail-closed).
 *               false 면 해당 operation 만 제외하고 사유를 기록한다.
 */
export function buildOperationIndex(
  document: OpenApiDocument,
  options: { strict: boolean }
): OperationIndexResult {
  const resolver = new RefResolver(document);
  const operations: OperationInfo[] = [];
  const excluded: ExcludedOperation[] = [];
  const seenOperationIds = new Map<string, string>();
  const seenToolNames = new Map<string, string>();

  const paths = document.paths ?? {};
  for (const path of Object.keys(paths).sort()) {
    const pathItem = paths[path];
    if (!pathItem || typeof pathItem !== 'object') continue;

    const sharedParameters = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as OpenApiOperation | undefined;
      if (!operation || typeof operation !== 'object') continue;

      const operationId = operation.operationId;
      if (!operationId || typeof operationId !== 'string' || operationId.trim() === '') {
        const reason = `operationId 가 없습니다 (${method.toUpperCase()} ${path}).`;
        if (options.strict) {
          throw new AppError({ code: 'openapi-invalid', message: reason, retryable: false });
        }
        excluded.push({ operationId: '(none)', method: method.toUpperCase(), path, reason });
        continue;
      }

      const previousPath = seenOperationIds.get(operationId);
      if (previousPath) {
        throw new AppError({
          code: 'openapi-invalid',
          message: `중복된 operationId 를 발견했습니다: "${operationId}" (${previousPath} 와 ${method.toUpperCase()} ${path}).`,
          retryable: false,
        });
      }
      seenOperationIds.set(operationId, `${method.toUpperCase()} ${path}`);

      // 토큰 발급은 인증 계층이 내부적으로만 수행한다. 도구로 노출하면 secret 이 오갈 수 있다.
      if (operationId === TOKEN_OPERATION_ID) {
        excluded.push({
          operationId,
          method: method.toUpperCase(),
          path,
          reason:
            'OAuth 토큰 발급은 서버 내부 인증 계층이 전담합니다. client secret / access token 노출을 막기 위해 도구로 등록하지 않습니다.',
        });
        continue;
      }

      try {
        const info = buildOperationInfo(operation, method, path, sharedParameters, resolver);

        const previousTool = seenToolNames.get(info.toolName);
        if (previousTool) {
          throw new AppError({
            code: 'openapi-invalid',
            message: `MCP 도구 이름이 충돌합니다: "${info.toolName}" (operationId "${previousTool}" 와 "${operationId}").`,
            retryable: false,
          });
        }
        seenToolNames.set(info.toolName, operationId);
        operations.push(info);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        if (options.strict) {
          throw AppError.isAppError(error)
            ? error
            : new AppError({
                code: 'openapi-invalid',
                message: `operation 변환에 실패했습니다 (${operationId}): ${reason}`,
                retryable: false,
                cause: error,
              });
        }
        excluded.push({ operationId, method: method.toUpperCase(), path, reason });
      }
    }
  }

  return { operations, excluded };
}

function buildOperationInfo(
  operation: OpenApiOperation,
  method: HttpMethod,
  path: string,
  sharedParameters: OpenApiParameter[],
  resolver: RefResolver
): OperationInfo {
  const rawParameters = [...sharedParameters, ...(operation.parameters ?? [])];
  const parameters = rawParameters
    .map((param) => toParameterInfo(param, resolver))
    .filter((param): param is ParameterInfo => param !== null);

  const pathParameters = parameters.filter((param) => param.in === 'path');
  const queryParameters = parameters.filter((param) => param.in === 'query');
  const allHeaderParameters = parameters.filter((param) => param.in === 'header');

  const requiresAccount = allHeaderParameters.some(
    (param) => param.name.toLowerCase() === ACCOUNT_HEADER.toLowerCase()
  );
  // 계좌 헤더는 account 입력으로만 지정하므로 일반 헤더 목록에서 제외한다.
  const headerParameters = allHeaderParameters.filter(
    (param) => param.name.toLowerCase() !== ACCOUNT_HEADER.toLowerCase()
  );

  // path 템플릿의 모든 변수는 반드시 파라미터로 정의되어 있어야 한다.
  const templateVars = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]?.trim() ?? '');
  const declared = new Set(pathParameters.map((param) => param.name));
  const missing = templateVars.filter((name) => name !== '' && !declared.has(name));
  if (missing.length > 0) {
    throw new AppError({
      code: 'openapi-invalid',
      message: `path parameter 정의가 누락되었습니다: ${missing.join(', ')}`,
      retryable: false,
    });
  }

  const upperMethod = method.toUpperCase() as Uppercase<HttpMethod>;
  const mutation = classifyMutation({
    operationId: operation.operationId as string,
    method: upperMethod,
    path,
    tags: operation.tags ?? [],
    summary: operation.summary,
    description: operation.description,
  });

  const requiresAuth = !(Array.isArray(operation.security) && operation.security.length === 0);

  return {
    operationId: operation.operationId as string,
    toolName: normalizeToolName(operation.operationId as string),
    method: upperMethod,
    path,
    tags: operation.tags ?? [],
    ...(operation.summary ? { summary: operation.summary.trim() } : {}),
    description: buildToolDescription(operation, method, path, mutation),
    deprecated: operation.deprecated === true,
    pathParameters,
    queryParameters,
    headerParameters,
    requiresAccount,
    ...(pickRequestBody(operation, resolver) ? { requestBody: pickRequestBody(operation, resolver) } : {}),
    ...(pickResponseSchema(operation, resolver)
      ? { responseSchema: pickResponseSchema(operation, resolver) }
      : {}),
    ...(extractRateLimitGroup(operation.description)
      ? { rateLimitGroup: extractRateLimitGroup(operation.description) }
      : {}),
    mutation,
    readOnly: upperMethod === 'GET' && mutation === 'none',
    requiresAuth,
  };
}

/** operationId -> OperationInfo, toolName -> OperationInfo 조회를 제공한다. */
export class OperationRegistry {
  private readonly byOperationId = new Map<string, OperationInfo>();
  private readonly byToolName = new Map<string, OperationInfo>();

  constructor(
    operations: readonly OperationInfo[],
    public readonly excluded: readonly ExcludedOperation[] = []
  ) {
    for (const operation of operations) {
      this.byOperationId.set(operation.operationId, operation);
      this.byToolName.set(operation.toolName, operation);
    }
  }

  get all(): readonly OperationInfo[] {
    return [...this.byOperationId.values()];
  }

  get size(): number {
    return this.byOperationId.size;
  }

  get(operationId: string): OperationInfo | undefined {
    return this.byOperationId.get(operationId);
  }

  getByToolName(toolName: string): OperationInfo | undefined {
    return this.byToolName.get(toolName);
  }

  require(operationId: string): OperationInfo {
    const operation = this.byOperationId.get(operationId);
    if (!operation) {
      throw new AppError({
        code: 'operation-not-found',
        message: `알 수 없는 operationId 입니다: ${operationId}. tossinvest_list_operations 로 사용 가능한 목록을 확인하세요.`,
        httpStatus: 404,
        retryable: false,
      });
    }
    return operation;
  }

  /** 공식 명세에 정의된 method + path 조합인지 확인한다. */
  findByRoute(method: string, path: string): OperationInfo | undefined {
    const upper = method.toUpperCase();
    return this.all.find((operation) => operation.method === upper && operation.path === path);
  }

  get tags(): readonly string[] {
    const tags = new Set<string>();
    for (const operation of this.byOperationId.values()) {
      for (const tag of operation.tags) tags.add(tag);
    }
    return [...tags].sort();
  }
}
