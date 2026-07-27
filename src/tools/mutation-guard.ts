import type { AppConfig } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import type { OperationInfo } from '../openapi/operation-index.js';
import { maskIdentifier } from '../security/redaction.js';
import { isPlainObject } from '../utils/json.js';
import { describeMutationClass } from './mutation-classifier.js';

export interface MutationRequestSummary {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly mutationType: string;
  readonly account?: string;
  readonly symbol?: string;
  readonly side?: string;
  readonly orderType?: string;
  readonly timeInForce?: string;
  readonly quantity?: string;
  readonly orderAmount?: string;
  readonly price?: string;
  readonly clientOrderId?: string;
  readonly condition?: Record<string, unknown>;
  readonly targetOrderId?: string;
}

export interface DryRunReport {
  readonly ok: true;
  readonly dryRun: true;
  readonly operationId: string;
  readonly executed: false;
  readonly summary: MutationRequestSummary;
  readonly missingRequiredFields: readonly string[];
  readonly blockers: readonly string[];
  readonly requirementsToExecute: readonly string[];
  readonly note: string;
}

export interface GuardInput {
  readonly operation: OperationInfo;
  readonly config: AppConfig;
  readonly dryRun: boolean;
  readonly confirmation: string;
  readonly account?: string;
  readonly path?: Record<string, unknown>;
  readonly query?: Record<string, unknown>;
  readonly body?: unknown;
}

export type GuardDecision =
  | { readonly kind: 'not-mutation' }
  | { readonly kind: 'dry-run'; readonly report: DryRunReport }
  | { readonly kind: 'execute' };

/**
 * mutation 실행 여부를 결정한다.
 *
 * 실제 실행은 다음 조건이 모두 참일 때만 허용된다.
 * 1. mutation 종류가 명확히 분류됨 (`order` | `conditional-order`)
 * 2. 해당 종류의 기능 플래그가 켜짐
 * 3. dryRun === false
 * 4. confirmation 이 환경변수 값과 정확히 일치
 * 5. 인증 정보 존재
 * 6. 계좌 지정 (계좌 필요 operation 인 경우)
 *
 * 하나라도 어긋나면 네트워크 요청을 보내지 않는다.
 */
export function evaluateMutation(input: GuardInput): GuardDecision {
  const { operation, config } = input;

  if (operation.mutation === 'none') {
    return { kind: 'not-mutation' };
  }

  const blockers: string[] = [];
  const requirements: string[] = [];

  if (operation.mutation === 'unclassified') {
    blockers.push(
      'OpenAPI 명세가 변경되어 이 operation 의 자산 영향 여부를 안전하게 분류할 수 없습니다. 안전을 위해 실행을 차단합니다.'
    );
    requirements.push(
      'src/config/constants.ts 의 mutation 정책 테이블에 이 operationId 를 명시적으로 등록해야 합니다.'
    );
  }

  if (operation.mutation === 'order' && !config.enableTrading) {
    blockers.push('실주문이 비활성화되어 있습니다 (TOSSINVEST_ENABLE_TRADING=false).');
    requirements.push('TOSSINVEST_ENABLE_TRADING=true');
  }

  if (operation.mutation === 'conditional-order') {
    if (!config.enableTrading) {
      blockers.push('실주문이 비활성화되어 있습니다 (TOSSINVEST_ENABLE_TRADING=false).');
      requirements.push('TOSSINVEST_ENABLE_TRADING=true');
    }
    if (!config.enableConditionalOrders) {
      blockers.push('조건주문이 비활성화되어 있습니다 (TOSSINVEST_ENABLE_CONDITIONAL_ORDERS=false).');
      requirements.push('TOSSINVEST_ENABLE_CONDITIONAL_ORDERS=true');
    }
  }

  if (input.dryRun) {
    blockers.push('dryRun=true 이므로 네트워크 요청을 보내지 않습니다.');
    requirements.push('도구 입력에 dryRun=false 를 명시');
  }

  if (input.confirmation !== config.mutationConfirmation) {
    blockers.push(
      input.confirmation === ''
        ? 'confirmation 문자열이 비어 있습니다.'
        : 'confirmation 문자열이 TOSSINVEST_MUTATION_CONFIRMATION 값과 일치하지 않습니다.'
    );
    requirements.push('confirmation 에 TOSSINVEST_MUTATION_CONFIRMATION 과 동일한 값을 전달');
  }

  if (!config.clientId || !config.clientSecret) {
    blockers.push('인증 정보(TOSSINVEST_CLIENT_ID / TOSSINVEST_CLIENT_SECRET)가 설정되지 않았습니다.');
    requirements.push('인증 정보 설정');
  }

  const accountValue = input.account ?? config.defaultAccount;
  if (operation.requiresAccount && !accountValue) {
    blockers.push('계좌가 지정되지 않았습니다.');
    requirements.push('account 인자 전달 또는 TOSSINVEST_DEFAULT_ACCOUNT 설정');
  }

  const summary = buildSummary(operation, input, accountValue);
  const missing = findMissingRequiredFields(operation, input);

  if (blockers.length === 0 && missing.length === 0) {
    return { kind: 'execute' };
  }

  // dryRun=false 인데 안전조건을 못 채운 경우도 네트워크 요청 없이 차단한다.
  if (!input.dryRun) {
    throw new AppError({
      code: operation.mutation === 'unclassified' ? 'mutation-blocked' : 'trading-disabled',
      message:
        `${operation.operationId} 실행이 차단되었습니다. 네트워크 요청을 보내지 않았습니다.\n` +
        `차단 사유:\n- ${blockers.concat(missing.map((field) => `필수값 누락: ${field}`)).join('\n- ')}`,
      httpStatus: 400,
      retryable: false,
      details: {
        requirementsToExecute: [...new Set(requirements)],
        summary,
        missingRequiredFields: missing,
      },
    });
  }

  return {
    kind: 'dry-run',
    report: {
      ok: true,
      dryRun: true,
      operationId: operation.operationId,
      executed: false,
      summary,
      missingRequiredFields: missing,
      blockers,
      requirementsToExecute: [...new Set(requirements)],
      note:
        '실제 주문은 전송되지 않았습니다. 토스증권 서버로 어떤 네트워크 요청도 보내지 않았습니다. ' +
        '실행하려면 위 requirementsToExecute 를 모두 충족해야 합니다.',
    },
  };
}

function buildSummary(
  operation: OperationInfo,
  input: GuardInput,
  accountValue: string | undefined
): MutationRequestSummary {
  const body = isPlainObject(input.body) ? input.body : {};
  const pathParams = isPlainObject(input.path) ? input.path : {};

  const condition = isPlainObject(body.condition) ? body.condition : undefined;
  const targetOrderId = pathParams.orderId ?? pathParams.conditionalOrderId;

  return {
    operationId: operation.operationId,
    method: operation.method,
    path: operation.path,
    mutationType: describeMutationClass(operation.mutation),
    ...(accountValue ? { account: maskIdentifier(accountValue) } : {}),
    ...(asString(body.symbol) ? { symbol: asString(body.symbol) } : {}),
    ...(asString(body.side) ? { side: asString(body.side) } : {}),
    ...(asString(body.orderType) ? { orderType: asString(body.orderType) } : {}),
    ...(asString(body.timeInForce) ? { timeInForce: asString(body.timeInForce) } : {}),
    ...(asString(body.quantity) ? { quantity: asString(body.quantity) } : {}),
    ...(asString(body.orderAmount) ? { orderAmount: asString(body.orderAmount) } : {}),
    ...(asString(body.price) ? { price: asString(body.price) } : {}),
    ...(asString(body.clientOrderId) ? { clientOrderId: asString(body.clientOrderId) } : {}),
    ...(condition ? { condition } : {}),
    ...(asString(targetOrderId) ? { targetOrderId: maskIdentifier(asString(targetOrderId)) } : {}),
  };
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** 스키마의 required 필드 중 실제로 빠진 항목을 찾는다. */
function findMissingRequiredFields(operation: OperationInfo, input: GuardInput): string[] {
  const missing: string[] = [];

  for (const param of operation.pathParameters) {
    if (!param.required) continue;
    const value = isPlainObject(input.path) ? input.path[param.name] : undefined;
    if (value === undefined || value === null || value === '') missing.push(`path.${param.name}`);
  }

  for (const param of operation.queryParameters) {
    if (!param.required) continue;
    const value = isPlainObject(input.query) ? input.query[param.name] : undefined;
    if (value === undefined || value === null || value === '') missing.push(`query.${param.name}`);
  }

  if (operation.requestBody?.required) {
    if (!isPlainObject(input.body)) {
      missing.push('body');
    } else {
      missing.push(...findMissingBodyFields(operation.requestBody.schema, input.body));
    }
  }

  return missing;
}

function findMissingBodyFields(schema: Record<string, unknown>, body: Record<string, unknown>): string[] {
  const branches = collectBranches(schema);

  // oneOf/anyOf 는 하나라도 충족하면 통과로 본다.
  const perBranchMissing = branches.map((branch) => {
    const required = Array.isArray(branch.required) ? (branch.required as string[]) : [];
    return required
      .filter((field) => {
        const value = body[field];
        return value === undefined || value === null || value === '';
      })
      .map((field) => `body.${field}`);
  });

  if (perBranchMissing.length === 0) return [];

  const satisfied = perBranchMissing.some((entries) => entries.length === 0);
  if (satisfied) return [];

  // 가장 적게 빠진 분기를 안내한다.
  return perBranchMissing.reduce((best, current) => (current.length < best.length ? current : best));
}

function collectBranches(schema: Record<string, unknown>): Array<Record<string, unknown>> {
  const branches: Array<Record<string, unknown>> = [];
  const oneOf = schema.oneOf;
  const anyOf = schema.anyOf;

  if (Array.isArray(oneOf) && oneOf.length > 0) {
    branches.push(...(oneOf as Array<Record<string, unknown>>));
  }
  if (Array.isArray(anyOf) && anyOf.length > 0) {
    branches.push(...(anyOf as Array<Record<string, unknown>>));
  }
  if (branches.length === 0) branches.push(schema);
  return branches;
}
