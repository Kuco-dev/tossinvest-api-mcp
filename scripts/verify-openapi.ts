#!/usr/bin/env tsx
/**
 * 번들된 snapshot 의 유효성을 검증한다.
 * - 필수 필드 / 버전
 * - operationId 존재 및 중복
 * - 전체 operation 의 스키마 변환 가능 여부
 * - MCP 도구 이름 충돌
 *
 *   pnpm openapi:verify
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSpec } from '../src/openapi/loader.js';
import { buildOperationIndex } from '../src/openapi/operation-index.js';
import { generateTool } from '../src/openapi/tool-generator.js';
import { safeJsonParse } from '../src/utils/json.js';

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(here, '../src/openapi/openapi.snapshot.json');

function main(): void {
  console.error(`[openapi:verify] snapshot 검증: ${SNAPSHOT_PATH}`);

  const raw = readFileSync(SNAPSHOT_PATH, 'utf8');
  const document = safeJsonParse(raw);
  validateSpec(document);

  const { operations, excluded } = buildOperationIndex(document, { strict: true });

  if (operations.length === 0) {
    throw new Error('등록 가능한 operation 이 하나도 없습니다.');
  }

  const toolNames = new Set<string>();
  for (const operation of operations) {
    const tool = generateTool(operation);
    if (toolNames.has(tool.name)) {
      throw new Error(`MCP 도구 이름이 충돌합니다: ${tool.name}`);
    }
    toolNames.add(tool.name);

    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) {
      throw new Error(`MCP 도구 이름 규칙 위반: ${tool.name}`);
    }
    if (tool.inputSchema.type !== 'object') {
      throw new Error(`inputSchema 가 object 가 아닙니다: ${tool.name}`);
    }
    // 직렬화 가능한지 확인 (순환 참조 등)
    JSON.stringify(tool.inputSchema);
  }

  const readCount = operations.filter((operation) => operation.readOnly).length;
  const mutationCount = operations.filter((operation) => operation.mutation !== 'none').length;
  const unclassified = operations.filter((operation) => operation.mutation === 'unclassified');

  console.error('[openapi:verify] 검증 성공');
  console.error(`  OpenAPI 버전      : ${document.openapi}`);
  console.error(`  API 문서 버전     : ${document.info.version}`);
  console.error(`  API 서버          : ${document.servers?.[0]?.url ?? '(없음)'}`);
  console.error(`  path 수           : ${Object.keys(document.paths).length}`);
  console.error(`  등록 operation    : ${operations.length}`);
  console.error(`  읽기 전용         : ${readCount}`);
  console.error(`  mutation          : ${mutationCount}`);
  console.error(`  분류 불가 mutation: ${unclassified.length}`);
  console.error(`  제외 operation    : ${excluded.length}`);

  for (const entry of excluded) {
    console.error(`    - ${entry.method} ${entry.path} (${entry.operationId}): ${entry.reason}`);
  }
  for (const operation of unclassified) {
    console.error(
      `    ! ${operation.method} ${operation.path} (${operation.operationId}) 은 실행이 차단됩니다.`
    );
  }
}

try {
  main();
} catch (error) {
  console.error(`[openapi:verify] 실패: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
