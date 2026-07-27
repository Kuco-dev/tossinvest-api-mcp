#!/usr/bin/env node
/**
 * tsc 는 JSON 자산을 출력 디렉터리로 복사하지 않는다.
 * 원격 명세를 사용할 수 없을 때(오프라인, 컨테이너 등) snapshot 폴백이 동작하려면
 * 빌드 산출물에 openapi.snapshot.json 이 함께 있어야 한다.
 */
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const assets = [['src/openapi/openapi.snapshot.json', 'dist/openapi/openapi.snapshot.json']];

for (const [from, to] of assets) {
  const source = resolve(root, from);
  const target = resolve(root, to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.error(`[copy-assets] ${from} -> ${to}`);
}
