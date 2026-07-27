import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import { TokenManager } from './auth/token-manager.js';
import { TossClient } from './client/toss-client.js';
import { SERVER_NAME, SERVER_VERSION } from './config/constants.js';
import { loadConfig, type AppConfig } from './config/env.js';
import { normalizeError } from './errors/error-normalizer.js';
import { loadOpenApiSpec, type LoadedSpec } from './openapi/loader.js';
import { buildOperationIndex, OperationRegistry } from './openapi/operation-index.js';
import { ManagementTools } from './tools/management-tools.js';
import { OperationExecutor } from './tools/operation-tools.js';
import { safeJsonStringify } from './utils/json.js';
import { createLogger, type Logger } from './utils/logger.js';

export interface BuiltServer {
  readonly server: Server;
  readonly config: AppConfig;
  readonly spec: LoadedSpec;
  readonly registry: OperationRegistry;
  readonly logger: Logger;
  connect(): Promise<void>;
  close(): Promise<void>;
}

export interface CreateServerOptions {
  readonly config?: AppConfig;
  readonly logger?: Logger;
  readonly fetchImpl?: typeof fetch;
  /** 테스트에서 in-memory transport 를 주입하기 위한 옵션. 기본은 stdio. */
  readonly transport?: Transport;
}

export async function createServer(options: CreateServerOptions = {}): Promise<BuiltServer> {
  const config = options.config ?? loadConfig();
  const logger = options.logger ?? createLogger(config.logLevel);

  const spec = await loadOpenApiSpec({
    url: config.openapiUrl,
    timeoutMs: config.requestTimeoutMs,
    useRemote: config.specCacheEnabled,
    logger,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const { operations, excluded } = buildOperationIndex(spec.document, {
    strict: config.openapiStrict,
  });
  const registry = new OperationRegistry(operations, excluded);

  logger.info('OpenAPI operation 인덱싱을 완료했습니다.', {
    total: registry.size,
    readOnly: registry.all.filter((operation) => operation.readOnly).length,
    mutations: registry.all.filter((operation) => operation.mutation !== 'none').length,
    excluded: excluded.length,
  });

  const tokenManager = new TokenManager({
    config,
    logger,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const client = new TossClient({
    config,
    tokenManager,
    logger,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });

  const executor = new OperationExecutor({ registry, client, config, logger });
  const managementTools = new ManagementTools({
    registry,
    spec,
    config,
    tokenManager,
    executor,
  });

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        '토스증권 Open API MCP 서버입니다. 공식 OpenAPI 명세의 모든 operation 이 도구로 등록되어 있습니다.\n' +
        '- 계좌가 필요한 도구는 account(accountSeq) 를 지정하거나 TOSSINVEST_DEFAULT_ACCOUNT 를 설정하세요. 계좌 목록은 getAccounts 로 조회합니다.\n' +
        '- 주문/조건주문 도구는 기본적으로 dryRun=true 이며 실제 주문을 내지 않습니다.\n' +
        '- 이 서버는 투자 조언을 제공하지 않습니다.',
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const managementDefinitions: Tool[] = managementTools.definitions.map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema as Tool['inputSchema'],
      annotations: definition.annotations,
    }));

    const operationDefinitions: Tool[] = executor.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as Tool['inputSchema'],
      annotations: tool.annotations,
    }));

    return { tools: [...managementDefinitions, ...operationDefinitions] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const { name, arguments: rawArgs } = request.params;

    try {
      const result = managementTools.handles(name)
        ? await managementTools.call(name, rawArgs)
        : await executor.executeByToolName(name, rawArgs);

      return toCallToolResult(result, false);
    } catch (error) {
      const operation = registry.getByToolName(name);
      const normalized = normalizeError(error, operation?.operationId);
      logger.warn('도구 호출이 실패했습니다.', {
        tool: name,
        code: normalized.error.code,
        httpStatus: normalized.httpStatus,
      });
      return toCallToolResult(normalized, true);
    }
  });

  const transport = options.transport ?? new StdioServerTransport();

  return {
    server,
    config,
    spec,
    registry,
    logger,
    async connect() {
      await server.connect(transport);
      logger.info('MCP stdio 서버가 시작되었습니다.', {
        tools: registry.size + managementTools.definitions.length,
        tradingEnabled: config.enableTrading,
        conditionalOrdersEnabled: config.enableConditionalOrders,
      });
    },
    async close() {
      await server.close();
    },
  };
}

/** 사람이 읽는 text 와 기계가 처리하는 structuredContent 를 함께 반환한다. */
function toCallToolResult(payload: unknown, isError: boolean): CallToolResult {
  const text = safeJsonStringify(payload);
  const structured =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : { value: payload };

  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  };
}
