import type { CallSuccess, TossClient } from '../client/toss-client.js';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import type { OperationInfo, OperationRegistry } from '../openapi/operation-index.js';
import { generateTool, type GeneratedTool } from '../openapi/tool-generator.js';
import { isPlainObject, stripDangerousKeys } from '../utils/json.js';
import type { Logger } from '../utils/logger.js';
import { evaluateMutation, type DryRunReport } from './mutation-guard.js';

export type OperationCallResult = CallSuccess | DryRunReport;

export interface OperationExecutorOptions {
  readonly registry: OperationRegistry;
  readonly client: TossClient;
  readonly config: AppConfig;
  readonly logger: Logger;
}

interface ParsedArgs {
  readonly path?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
  readonly account?: string;
  readonly dryRun: boolean;
  readonly confirmation: string;
}

/**
 * 자동 생성된 operation 도구와 wrapper 도구가 공유하는 실행기.
 * 모든 경로가 동일한 mutation guard 를 통과하므로 우회가 불가능하다.
 */
export class OperationExecutor {
  private readonly registry: OperationRegistry;
  private readonly client: TossClient;
  private readonly config: AppConfig;
  private readonly logger: Logger;

  constructor(options: OperationExecutorOptions) {
    this.registry = options.registry;
    this.client = options.client;
    this.config = options.config;
    this.logger = options.logger.child('tools');
  }

  get tools(): GeneratedTool[] {
    return this.registry.all.map((operation) => generateTool(operation));
  }

  async executeByToolName(toolName: string, rawArgs: unknown): Promise<OperationCallResult> {
    const operation = this.registry.getByToolName(toolName);
    if (!operation) {
      throw new AppError({
        code: 'operation-not-found',
        message: `알 수 없는 도구입니다: ${toolName}`,
        httpStatus: 404,
        retryable: false,
      });
    }
    return this.execute(operation, rawArgs);
  }

  async executeByOperationId(operationId: string, rawArgs: unknown): Promise<OperationCallResult> {
    const operation = this.registry.require(operationId);
    return this.execute(operation, rawArgs);
  }

  async execute(operation: OperationInfo, rawArgs: unknown): Promise<OperationCallResult> {
    const args = this.parseArgs(operation, rawArgs);

    const decision = evaluateMutation({
      operation,
      config: this.config,
      dryRun: args.dryRun,
      confirmation: args.confirmation,
      ...(args.account !== undefined ? { account: args.account } : {}),
      ...(args.path ? { path: args.path } : {}),
      ...(args.query ? { query: args.query } : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
    });

    if (decision.kind === 'dry-run') {
      this.logger.info('mutation dry-run 을 수행했습니다. 네트워크 요청은 없습니다.', {
        operationId: operation.operationId,
      });
      return decision.report;
    }

    if (operation.mutation !== 'none') {
      this.logger.warn('실제 mutation 을 실행합니다.', {
        operationId: operation.operationId,
        method: operation.method,
        path: operation.path,
      });
    }

    return this.client.call(operation, {
      ...(args.path ? { path: args.path } : {}),
      ...(args.query ? { query: args.query } : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(args.account !== undefined ? { account: args.account } : {}),
    });
  }

  private parseArgs(operation: OperationInfo, rawArgs: unknown): ParsedArgs {
    const args = isPlainObject(rawArgs) ? stripDangerousKeys(rawArgs) : {};

    const known = new Set(['path', 'query', 'body', 'account', 'dryRun', 'confirmation']);
    const unknownKeys = Object.keys(args).filter((key) => !known.has(key));
    if (unknownKeys.length > 0) {
      throw new AppError({
        code: 'invalid-input',
        message: `허용되지 않은 입력 필드입니다: ${unknownKeys.join(', ')}. 임의 헤더나 URL 은 지정할 수 없습니다.`,
        httpStatus: 400,
        retryable: false,
      });
    }

    const pathArgs = args.path;
    const queryArgs = args.query;

    if (pathArgs !== undefined && !isPlainObject(pathArgs)) {
      throw new AppError({
        code: 'invalid-input',
        message: 'path 인자는 객체여야 합니다.',
        httpStatus: 400,
        retryable: false,
      });
    }
    if (queryArgs !== undefined && !isPlainObject(queryArgs)) {
      throw new AppError({
        code: 'invalid-input',
        message: 'query 인자는 객체여야 합니다.',
        httpStatus: 400,
        retryable: false,
      });
    }

    if (args.body !== undefined && !operation.requestBody) {
      throw new AppError({
        code: 'invalid-input',
        message: `${operation.operationId} 는 요청 본문을 받지 않습니다.`,
        httpStatus: 400,
        retryable: false,
      });
    }

    let account: string | undefined;
    if (args.account !== undefined && args.account !== null && args.account !== '') {
      if (typeof args.account !== 'string' && typeof args.account !== 'number') {
        throw new AppError({
          code: 'invalid-input',
          message: 'account 는 문자열 또는 숫자여야 합니다.',
          httpStatus: 400,
          retryable: false,
        });
      }
      account = String(args.account);
    }

    // dryRun 기본값은 반드시 true. 명시적으로 false 를 준 경우에만 실행 후보가 된다.
    const dryRun = args.dryRun === false ? false : true;

    const confirmation = typeof args.confirmation === 'string' ? args.confirmation : '';

    return {
      ...(pathArgs ? { path: pathArgs as Record<string, unknown> } : {}),
      ...(queryArgs ? { query: queryArgs as Record<string, unknown> } : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
      ...(account !== undefined ? { account } : {}),
      dryRun,
      confirmation,
    };
  }
}
