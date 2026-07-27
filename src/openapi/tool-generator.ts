import type { OperationInfo } from './operation-index.js';
import type { JsonSchema } from './schema-converter.js';

export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface GeneratedTool {
  readonly name: string;
  readonly operationId: string;
  readonly description: string;
  readonly inputSchema: JsonSchema;
  readonly annotations: ToolAnnotations;
}

const ACCOUNT_PROPERTY: JsonSchema = {
  type: 'string',
  description:
    '요청에 사용할 계좌의 accountSeq. getAccounts 응답의 accountSeq 값을 사용합니다. ' +
    '미지정 시 TOSSINVEST_DEFAULT_ACCOUNT 환경변수를 사용하며, 둘 다 없으면 호출하지 않고 오류를 반환합니다.',
};

const DRY_RUN_PROPERTY: JsonSchema = {
  type: 'boolean',
  default: true,
  description:
    '기본값 true. true 이면 토스증권 서버로 어떤 네트워크 요청도 보내지 않고 실행 계획만 반환합니다. ' +
    '실제 주문을 내려면 false 로 명시해야 합니다.',
};

const CONFIRMATION_PROPERTY: JsonSchema = {
  type: 'string',
  default: '',
  description:
    '실주문 확인 문자열. TOSSINVEST_MUTATION_CONFIRMATION 환경변수 값과 정확히 일치해야 실제 주문이 실행됩니다.',
};

/**
 * operation 하나를 MCP 도구 정의로 변환한다.
 * 필요 없는 필드(path/query/body/account)는 스키마에서 제거한다.
 */
export function generateTool(operation: OperationInfo): GeneratedTool {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  if (operation.pathParameters.length > 0) {
    const pathProperties: Record<string, JsonSchema> = {};
    const pathRequired: string[] = [];
    for (const param of operation.pathParameters) {
      pathProperties[param.name] = withDescription(param.schema, param.description);
      if (param.required) pathRequired.push(param.name);
    }
    properties.path = {
      type: 'object',
      description: 'URL 경로 파라미터',
      properties: pathProperties,
      ...(pathRequired.length > 0 ? { required: pathRequired } : {}),
      additionalProperties: false,
    };
    if (pathRequired.length > 0) required.push('path');
  }

  if (operation.queryParameters.length > 0) {
    const queryProperties: Record<string, JsonSchema> = {};
    const queryRequired: string[] = [];
    for (const param of operation.queryParameters) {
      queryProperties[param.name] = withDescription(param.schema, param.description);
      if (param.required) queryRequired.push(param.name);
    }
    properties.query = {
      type: 'object',
      description: '쿼리 파라미터',
      properties: queryProperties,
      ...(queryRequired.length > 0 ? { required: queryRequired } : {}),
      additionalProperties: false,
    };
    if (queryRequired.length > 0) required.push('query');
  }

  if (operation.requestBody) {
    properties.body = withDescription(
      operation.requestBody.schema,
      operation.requestBody.description ??
        `요청 본문 (${operation.requestBody.contentType}). 금액·수량·가격은 정밀도 보존을 위해 문자열로 전달합니다.`
    );
    if (operation.requestBody.required) required.push('body');
  }

  if (operation.requiresAccount) {
    properties.account = ACCOUNT_PROPERTY;
  }

  const isMutation = operation.mutation !== 'none';
  if (isMutation) {
    properties.dryRun = DRY_RUN_PROPERTY;
    properties.confirmation = CONFIRMATION_PROPERTY;
  }

  const inputSchema: JsonSchema = {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };

  return {
    name: operation.toolName,
    operationId: operation.operationId,
    description: operation.description ?? operation.summary ?? operation.operationId,
    inputSchema,
    annotations: buildAnnotations(operation),
  };
}

function buildAnnotations(operation: OperationInfo): ToolAnnotations {
  const isDelete = operation.method === 'DELETE';
  const isCancelOrModify = /cancel|modify|delete|amend/i.test(operation.operationId);
  const destructive =
    operation.mutation !== 'none' && (isDelete || isCancelOrModify || /create/i.test(operation.operationId));

  return {
    ...(operation.summary ? { title: operation.summary } : {}),
    readOnlyHint: operation.readOnly,
    destructiveHint: destructive,
    // 주문 생성은 clientOrderId 멱등성 키가 있을 때만 멱등하므로 기본은 false 로 둔다.
    idempotentHint: operation.method === 'GET' || operation.method === 'PUT',
    openWorldHint: true,
  };
}

function withDescription(schema: JsonSchema, description: string | undefined): JsonSchema {
  if (!description || schema.description) return schema;
  return { ...schema, description };
}
