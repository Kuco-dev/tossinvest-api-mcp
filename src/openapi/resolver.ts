import { AppError } from '../errors/app-error.js';
import type { JsonSchemaLike, OpenApiDocument } from './types.js';

/**
 * 로컬 `$ref` 해석기.
 * 외부 `$ref`(다른 문서 참조)와 순환 `$ref` 는 명시적으로 거부한다.
 */
export class RefResolver {
  private readonly cache = new Map<string, unknown>();

  constructor(private readonly document: OpenApiDocument) {}

  /** `#/components/schemas/Foo` 형태의 로컬 포인터만 허용한다. */
  resolveRef<T = unknown>(ref: string): T {
    if (!ref.startsWith('#/')) {
      throw new AppError({
        code: 'openapi-invalid',
        message: `지원하지 않는 외부 $ref 입니다: ${ref}`,
        retryable: false,
      });
    }

    const cached = this.cache.get(ref);
    if (cached !== undefined) return cached as T;

    const segments = ref
      .slice(2)
      .split('/')
      .map((segment) => segment.replace(/~1/g, '/').replace(/~0/g, '~'));

    let current: unknown = this.document;
    for (const segment of segments) {
      if (typeof current !== 'object' || current === null) {
        throw new AppError({
          code: 'openapi-invalid',
          message: `$ref 를 해석할 수 없습니다: ${ref}`,
          retryable: false,
        });
      }
      if (segment === '__proto__' || segment === 'constructor' || segment === 'prototype') {
        throw new AppError({
          code: 'openapi-invalid',
          message: `허용되지 않는 $ref 경로입니다: ${ref}`,
          retryable: false,
        });
      }
      current = (current as Record<string, unknown>)[segment];
    }

    if (current === undefined) {
      throw new AppError({
        code: 'openapi-invalid',
        message: `$ref 대상이 존재하지 않습니다: ${ref}`,
        retryable: false,
      });
    }

    this.cache.set(ref, current);
    return current as T;
  }

  /** 최상위 `$ref` 한 단계만 해석한다 (중첩 스키마는 지연 해석). */
  deref<T extends { $ref?: string }>(node: T): T {
    let current: T = node;
    const visited = new Set<string>();
    while (current && typeof current === 'object' && typeof current.$ref === 'string') {
      const ref = current.$ref;
      if (visited.has(ref)) {
        throw new AppError({
          code: 'openapi-invalid',
          message: `순환 $ref 를 감지했습니다: ${ref}`,
          retryable: false,
        });
      }
      visited.add(ref);
      current = this.resolveRef<T>(ref);
    }
    return current;
  }

  /**
   * 스키마 전체를 재귀적으로 인라인 확장한다.
   * 순환 참조가 있으면 해당 지점을 느슨한 object 로 대체해 무한 루프를 막는다.
   */
  expandSchema(schema: JsonSchemaLike, stack: readonly string[] = [], depth = 0): JsonSchemaLike {
    if (depth > 32) {
      return { type: 'object', description: '중첩 깊이 제한으로 축약된 스키마' };
    }

    if (typeof schema.$ref === 'string') {
      const ref = schema.$ref;
      if (stack.includes(ref)) {
        // 순환 참조: 스키마 변환을 실패시키지 않고 안전하게 축약한다.
        return {
          type: 'object',
          description: `순환 참조(${ref.split('/').pop() ?? ref})로 축약된 스키마`,
        };
      }
      const target = this.resolveRef<JsonSchemaLike>(ref);
      const { $ref: _ref, ...rest } = schema;
      const expanded = this.expandSchema(target, [...stack, ref], depth + 1);
      return Object.keys(rest).length > 0 ? { ...expanded, ...rest } : expanded;
    }

    const output: JsonSchemaLike = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key === 'properties' && value && typeof value === 'object') {
        const properties: Record<string, JsonSchemaLike> = {};
        for (const [propName, propSchema] of Object.entries(value as Record<string, JsonSchemaLike>)) {
          properties[propName] = this.expandSchema(propSchema, stack, depth + 1);
        }
        output.properties = properties;
        continue;
      }
      if (key === 'items') {
        output.items = Array.isArray(value)
          ? (value as JsonSchemaLike[]).map((item) => this.expandSchema(item, stack, depth + 1))
          : this.expandSchema(value as JsonSchemaLike, stack, depth + 1);
        continue;
      }
      if ((key === 'oneOf' || key === 'anyOf' || key === 'allOf') && Array.isArray(value)) {
        output[key] = (value as JsonSchemaLike[]).map((item) =>
          this.expandSchema(item, stack, depth + 1)
        );
        continue;
      }
      if (key === 'not' && value && typeof value === 'object') {
        output.not = this.expandSchema(value as JsonSchemaLike, stack, depth + 1);
        continue;
      }
      if (key === 'additionalProperties' && value && typeof value === 'object') {
        output.additionalProperties = this.expandSchema(value as JsonSchemaLike, stack, depth + 1);
        continue;
      }
      output[key] = value;
    }
    return output;
  }
}
