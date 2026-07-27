/** OpenAPI 3.1 에서 이 프로젝트가 실제로 사용하는 부분만 정의한 최소 타입. */

export interface JsonSchemaLike {
  $ref?: string;
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  examples?: unknown[];
  example?: unknown;
  nullable?: boolean;
  properties?: Record<string, JsonSchemaLike>;
  required?: string[];
  items?: JsonSchemaLike | JsonSchemaLike[];
  additionalProperties?: boolean | JsonSchemaLike;
  oneOf?: JsonSchemaLike[];
  anyOf?: JsonSchemaLike[];
  allOf?: JsonSchemaLike[];
  not?: JsonSchemaLike;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  deprecated?: boolean;
  [key: string]: unknown;
}

export interface OpenApiParameter {
  $ref?: string;
  name?: string;
  in?: 'path' | 'query' | 'header' | 'cookie';
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: JsonSchemaLike;
  style?: string;
  explode?: boolean;
  example?: unknown;
  examples?: Record<string, unknown>;
}

export interface OpenApiMediaType {
  schema?: JsonSchemaLike;
  example?: unknown;
  examples?: Record<string, unknown>;
}

export interface OpenApiRequestBody {
  $ref?: string;
  description?: string;
  required?: boolean;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiResponse {
  $ref?: string;
  description?: string;
  headers?: Record<string, unknown>;
  content?: Record<string, OpenApiMediaType>;
}

export interface OpenApiOperation {
  tags?: string[];
  summary?: string;
  description?: string;
  operationId?: string;
  deprecated?: boolean;
  security?: Array<Record<string, string[]>>;
  parameters?: OpenApiParameter[];
  requestBody?: OpenApiRequestBody;
  responses?: Record<string, OpenApiResponse>;
}

export interface OpenApiPathItem {
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  get?: OpenApiOperation;
  put?: OpenApiOperation;
  post?: OpenApiOperation;
  delete?: OpenApiOperation;
  patch?: OpenApiOperation;
  head?: OpenApiOperation;
  options?: OpenApiOperation;
  trace?: OpenApiOperation;
  [key: string]: unknown;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  servers?: Array<{ url: string; description?: string }>;
  tags?: Array<{ name: string; description?: string }>;
  paths: Record<string, OpenApiPathItem>;
  components?: {
    schemas?: Record<string, JsonSchemaLike>;
    parameters?: Record<string, OpenApiParameter>;
    requestBodies?: Record<string, OpenApiRequestBody>;
    responses?: Record<string, OpenApiResponse>;
    headers?: Record<string, unknown>;
    securitySchemes?: Record<string, unknown>;
  };
  security?: Array<Record<string, string[]>>;
  [key: string]: unknown;
}

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];
