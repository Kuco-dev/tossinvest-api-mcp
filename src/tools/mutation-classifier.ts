import {
  CONDITIONAL_MUTATION_OPERATION_IDS,
  CONDITIONAL_ORDER_PATH_PREFIX,
  CONDITIONAL_ORDER_TAGS,
  ORDER_MUTATION_OPERATION_IDS,
  ORDER_PATH_PREFIX,
  ORDER_TAGS,
  READ_ONLY_TAGS,
} from '../config/constants.js';

/**
 * mutation 분류 결과.
 * - `none`: 자산에 영향이 없는 operation (조회 등)
 * - `order`: 일반 주문 mutation
 * - `conditional-order`: 조건주문 mutation
 * - `unclassified`: 자산 영향 가능성이 있으나 안전하게 분류할 수 없음 -> 실행 차단
 */
export type MutationClass = 'none' | 'order' | 'conditional-order' | 'unclassified';

export interface ClassifierInput {
  readonly operationId: string;
  readonly method: string;
  readonly path: string;
  readonly tags: readonly string[];
  readonly summary?: string;
  readonly description?: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * 자산에 영향을 주는 mutation 인지 분류한다.
 *
 * 정책:
 * 1. GET 등 안전 method 는 mutation 이 아니다.
 * 2. operationId 명시 정책 테이블이 최우선.
 * 3. tag + path 조합으로 주문/조건주문 도메인을 판정.
 * 4. 위 어디에도 걸리지 않는 상태 변경 method 는 `unclassified` 로 두고 실행을 차단한다.
 *    (명세에 새 주문 API 가 추가되어도 조용히 실행되지 않도록 fail-closed)
 */
export function classifyMutation(input: ClassifierInput): MutationClass {
  const method = input.method.toUpperCase();

  if (SAFE_METHODS.has(method)) {
    return 'none';
  }

  if (ORDER_MUTATION_OPERATION_IDS.includes(input.operationId)) {
    return 'order';
  }
  if (CONDITIONAL_MUTATION_OPERATION_IDS.includes(input.operationId)) {
    return 'conditional-order';
  }

  const hasConditionalTag = input.tags.some((tag) => CONDITIONAL_ORDER_TAGS.includes(tag));
  const hasOrderTag = input.tags.some((tag) => ORDER_TAGS.includes(tag));
  const path = input.path.toLowerCase();

  if (hasConditionalTag || path.startsWith(CONDITIONAL_ORDER_PATH_PREFIX)) {
    return 'conditional-order';
  }
  if (hasOrderTag || path.startsWith(ORDER_PATH_PREFIX)) {
    return 'order';
  }

  // 읽기 전용 tag 인데 상태 변경 method 를 쓰는 경우는 명세 오류 가능성이 있으므로
  // 자동 실행을 허용하지 않는다.
  if (input.tags.every((tag) => READ_ONLY_TAGS.includes(tag)) && input.tags.length > 0) {
    return 'unclassified';
  }

  return 'unclassified';
}

/** 사람이 읽을 수 있는 분류 설명. */
export function describeMutationClass(mutation: MutationClass): string {
  switch (mutation) {
    case 'none':
      return '자산에 영향을 주지 않는 조회성 operation';
    case 'order':
      return '일반 주문 mutation (실제 자산 영향)';
    case 'conditional-order':
      return '조건주문 mutation (실제 자산 영향)';
    case 'unclassified':
      return '자산 영향 여부를 안전하게 분류할 수 없는 상태 변경 operation (실행 차단)';
    default:
      return '알 수 없음';
  }
}
