import type { LogLevel } from '../config/env.js';
import { redact, scrubString } from '../security/redaction.js';

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export interface Logger {
  error(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  info(message: string, context?: unknown): void;
  debug(message: string, context?: unknown): void;
  child(scope: string): Logger;
  readonly level: LogLevel;
}

/**
 * stdio MCP 서버이므로 stdout 은 JSON-RPC 전용이다.
 * 모든 로그는 stderr 로만 나가야 한다.
 */
function write(line: string): void {
  process.stderr.write(`${line}\n`);
}

function formatContext(context: unknown): string {
  if (context === undefined) return '';
  // 로그에는 자산 정보까지 포함해 redaction 한다.
  const safe = redact(context, { redactPrivatePayload: true });
  try {
    return ` ${JSON.stringify(safe)}`;
  } catch {
    return ' [unserializable-context]';
  }
}

export function createLogger(level: LogLevel, scope = 'tossinvest'): Logger {
  const threshold = LEVEL_WEIGHT[level];

  const log = (entryLevel: LogLevel, message: string, context?: unknown): void => {
    if (threshold === 0 || LEVEL_WEIGHT[entryLevel] > threshold) return;
    const timestamp = new Date().toISOString();
    write(
      `${timestamp} ${entryLevel.toUpperCase().padEnd(5)} [${scope}] ${scrubString(message)}${formatContext(context)}`
    );
  };

  return {
    level,
    error: (message, context) => log('error', message, context),
    warn: (message, context) => log('warn', message, context),
    info: (message, context) => log('info', message, context),
    debug: (message, context) => log('debug', message, context),
    child: (childScope: string) => createLogger(level, `${scope}:${childScope}`),
  };
}
