import { AppError } from '../errors/app-error.js';
import type { RefResolver } from './resolver.js';
import type { JsonSchemaLike } from './types.js';

/** MCP inputSchema 로 넘길 JSON Schema. */
export type JsonSchema = Record<string, unknown>;

const SUPPORTED_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

const KEPT_KEYWORDS = [
  'title',
  'description',
  'default',
  'enum',
  'const',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'format',
] as const;

/**
 * OpenAPI 3.1 스키마를 MCP 도구 inputSchema 용 JSON Schema 로 변환한다.
 *
 * 3.1 은 이미 JSON Schema 2020-12 기반이지만, MCP 클라이언트 호환성을 위해
 * - `type: [..., 'null']` 배열을 anyOf 로 풀고
 * - OpenAPI 3.0 스타일 `nullable` 도 처리하며
 * - 지원하지 않는 키워드는 제거한다.
 */
export function convertSchema(schema: JsonSchemaLike, resolver: RefResolver): JsonSchema {
  const expanded = resolver.expandSchema(schema);
  return convertExpanded(expanded, 0);
}

function convertExpanded(schema: JsonSchemaLike, depth: number): JsonSchema {
  if (depth > 32) {
    return { type: 'object', description: '중첩 깊이 제한으로 축약된 스키마' };
  }

  const output: JsonSchema = {};

  for (const keyword of KEPT_KEYWORDS) {
    const value = schema[keyword];
    if (value !== undefined) {
      output[keyword] = value;
    }
  }

  // OpenAPI example / examples -> JSON Schema examples 배열
  if (schema.examples !== undefined && Array.isArray(schema.examples)) {
    output.examples = schema.examples;
  } else if (schema.example !== undefined) {
    output.examples = [schema.example];
  }

  const nullable = schema.nullable === true;
  const types = normalizeTypes(schema.type);
  const hasNullType = types.includes('null');
  const nonNullTypes = types.filter((type) => type !== 'null');

  if (nonNullTypes.length === 1) {
    output.type = nonNullTypes[0];
  } else if (nonNullTypes.length > 1) {
    output.type = nonNullTypes;
  }

  if (nonNullTypes.includes('object') || schema.properties) {
    if (schema.properties) {
      const properties: JsonSchema = {};
      for (const [name, propSchema] of Object.entries(schema.properties)) {
        properties[name] = convertExpanded(propSchema, depth + 1);
      }
      output.properties = properties;
      output.type ??= 'object';
    }
    if (Array.isArray(schema.required) && schema.required.length > 0) {
      output.required = [...schema.required];
    }
    if (schema.additionalProperties === false) {
      output.additionalProperties = false;
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      output.additionalProperties = convertExpanded(
        schema.additionalProperties as JsonSchemaLike,
        depth + 1
      );
    }
  }

  if (nonNullTypes.includes('array') || schema.items) {
    output.type ??= 'array';
    if (Array.isArray(schema.items)) {
      // tuple 형태는 MCP 클라이언트 호환성을 위해 첫 항목 기준으로 완화한다.
      const first = schema.items[0];
      output.items = first ? convertExpanded(first, depth + 1) : {};
    } else if (schema.items) {
      output.items = convertExpanded(schema.items, depth + 1);
    } else {
      output.items = {};
    }
  }

  for (const combinator of ['oneOf', 'anyOf'] as const) {
    const branches = schema[combinator];
    if (Array.isArray(branches) && branches.length > 0) {
      output[combinator] = branches.map((branch) => convertExpanded(branch, depth + 1));
    }
  }

  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    const merged = mergeAllOf(schema.allOf, depth);
    Object.assign(output, mergeObjects(output, merged));
  }

  if (nullable || hasNullType) {
    return makeNullable(output);
  }

  return output;
}

/**
 * allOf 를 하나의 object 스키마로 병합한다.
 * 병합할 수 없는 분기가 있으면 allOf 를 그대로 유지한다.
 */
function mergeAllOf(branches: JsonSchemaLike[], depth: number): JsonSchema {
  const converted = branches.map((branch) => convertExpanded(branch, depth + 1));
  const mergeable = converted.every(
    (branch) =>
      branch.type === undefined ||
      branch.type === 'object' ||
      (branch.properties !== undefined && branch.type === undefined)
  );

  if (!mergeable) {
    return { allOf: converted };
  }

  const properties: JsonSchema = {};
  const required = new Set<string>();
  let description: string | undefined;

  for (const branch of converted) {
    if (branch.properties && typeof branch.properties === 'object') {
      Object.assign(properties, branch.properties);
    }
    if (Array.isArray(branch.required)) {
      for (const name of branch.required as string[]) required.add(name);
    }
    if (!description && typeof branch.description === 'string') {
      description = branch.description;
    }
  }

  const merged: JsonSchema = { type: 'object' };
  if (description) merged.description = description;
  if (Object.keys(properties).length > 0) merged.properties = properties;
  if (required.size > 0) merged.required = [...required];
  return merged;
}

function mergeObjects(base: JsonSchema, extra: JsonSchema): JsonSchema {
  const output: JsonSchema = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (key === 'properties' && base.properties && typeof value === 'object' && value !== null) {
      output.properties = { ...(base.properties as JsonSchema), ...(value as JsonSchema) };
      continue;
    }
    if (key === 'required' && Array.isArray(base.required) && Array.isArray(value)) {
      output.required = [...new Set([...(base.required as string[]), ...(value as string[])])];
      continue;
    }
    if (output[key] === undefined) {
      output[key] = value;
    }
  }
  return output;
}

function makeNullable(schema: JsonSchema): JsonSchema {
  if (schema.type === undefined && !schema.oneOf && !schema.anyOf) {
    return schema;
  }
  if (Array.isArray(schema.type)) {
    return { ...schema, type: [...new Set([...(schema.type as string[]), 'null'])] };
  }
  if (typeof schema.type === 'string') {
    return { ...schema, type: [schema.type, 'null'] };
  }
  const { description, title, ...rest } = schema;
  return {
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
    anyOf: [rest, { type: 'null' }],
  };
}

function normalizeTypes(type: string | string[] | undefined): string[] {
  if (type === undefined) return [];
  const list = Array.isArray(type) ? type : [type];
  for (const entry of list) {
    if (!SUPPORTED_TYPES.has(entry)) {
      throw new AppError({
        code: 'openapi-invalid',
        message: `지원하지 않는 스키마 type 입니다: ${entry}`,
        retryable: false,
      });
    }
  }
  return list;
}

/**
 * 스키마가 문자열 기반 decimal 인지 판별한다.
 * 금액/수량/가격은 반드시 string 으로 유지되어야 하므로 number 로 강제 변환하지 않는다.
 */
export function isDecimalString(schema: JsonSchemaLike): boolean {
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  return types.includes('string') && (schema.format === 'decimal' || schema.format === 'int64');
}
