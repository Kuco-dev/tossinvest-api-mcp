#!/usr/bin/env node
import { config as loadDotenv } from 'dotenv';
import { loadConfig } from './config/env.js';
import { normalizeError } from './errors/error-normalizer.js';
import { createServer } from './server.js';
import { createLogger } from './utils/logger.js';

// .env 는 있으면 읽고 없으면 무시한다.
// dotenv 16.x 는 stdout 에 아무것도 출력하지 않으므로 stdio transport 를 오염시키지 않는다.
loadDotenv({ override: false });

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  process.on('unhandledRejection', (reason) => {
    const normalized = normalizeError(reason);
    logger.error('처리되지 않은 Promise rejection 이 발생했습니다.', normalized.error);
  });

  process.on('uncaughtException', (error) => {
    const normalized = normalizeError(error);
    logger.error('처리되지 않은 예외가 발생했습니다.', normalized.error);
    process.exitCode = 1;
  });

  const built = await createServer({ config, logger });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} 을 수신했습니다. 서버를 종료합니다.`);
    void built
      .close()
      .catch((error: unknown) => {
        logger.error('종료 중 오류가 발생했습니다.', normalizeError(error).error);
      })
      .finally(() => {
        process.exit(0);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await built.connect();
}

main().catch((error: unknown) => {
  const normalized = normalizeError(error);
  // stdout 은 JSON-RPC 전용이므로 시작 실패도 stderr 로만 출력한다.
  process.stderr.write(
    `[tossinvest-api-mcp] 서버를 시작하지 못했습니다: ${normalized.error.code} - ${normalized.error.message}\n`
  );
  process.exit(1);
});
