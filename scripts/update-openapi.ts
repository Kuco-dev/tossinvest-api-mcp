#!/usr/bin/env tsx
/**
 * 공식 토스증권 OpenAPI JSON 을 내려받아 번들 snapshot 을 갱신한다.
 *
 *   pnpm openapi:update
 */
import { config as loadDotenv } from 'dotenv';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OPENAPI_URL } from '../src/config/constants.js';
import { validateSpec } from '../src/openapi/loader.js';
import { buildOperationIndex } from '../src/openapi/operation-index.js';
import { safeJsonParse } from '../src/utils/json.js';

loadDotenv({ override: false });

const here = dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = resolve(here, '../src/openapi/openapi.snapshot.json');

async function main(): Promise<void> {
  const url = process.env.TOSSINVEST_OPENAPI_URL?.trim() || DEFAULT_OPENAPI_URL;
  console.error(`[openapi:update] 명세를 내려받는 중: ${url}`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  let text: string;
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    text = await response.text();
  } finally {
    clearTimeout(timer);
  }

  const document = safeJsonParse(text);
  validateSpec(document);

  const { operations, excluded } = buildOperationIndex(document, { strict: true });

  writeFileSync(SNAPSHOT_PATH, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

  console.error(`[openapi:update] snapshot 갱신 완료: ${SNAPSHOT_PATH}`);
  console.error(`[openapi:update] OpenAPI ${document.openapi} / 문서 버전 ${document.info.version}`);
  console.error(
    `[openapi:update] operation ${operations.length}개 (제외 ${excluded.length}개), tag ${document.tags?.length ?? 0}개`
  );
}

main().catch((error: unknown) => {
  console.error(
    `[openapi:update] 실패: ${error instanceof Error ? error.message : String(error)}`
  );
  process.exit(1);
});
