import { AppError } from '../errors/app-error.js';

export function credentialsMissingError(missing: readonly string[]): AppError {
  return new AppError({
    code: 'credentials-missing',
    message:
      `토스증권 API 인증 정보가 설정되지 않았습니다 (${missing.join(', ')}). ` +
      '토스증권 WTS > 설정 > Open API 에서 발급한 값을 .env 또는 MCP 클라이언트 env 설정에 넣어주세요.',
    httpStatus: 401,
    retryable: false,
  });
}

/** OAuth 토큰 엔드포인트 오류를 사용자에게 안전한 형태로 변환한다. */
export function authFailureError(
  httpStatus: number,
  upstreamCode: string | undefined,
  requestId: string | undefined
): AppError {
  const code = (upstreamCode ?? '').toLowerCase();

  if (httpStatus === 403 || code === 'access_denied') {
    return new AppError({
      code: 'ip-not-allowed',
      message:
        '허용되지 않은 IP 에서 호출했습니다. 토스증권 WTS > 설정 > Open API > 허용 IP 관리에서 현재 공인 IP 를 등록하세요.',
      httpStatus,
      ...(requestId ? { requestId } : {}),
      retryable: false,
      ...(upstreamCode ? { upstreamCode } : {}),
    });
  }

  if (code === 'invalid_client' || httpStatus === 401) {
    return new AppError({
      code: 'auth-failed',
      message:
        'client 인증에 실패했습니다. TOSSINVEST_CLIENT_ID / TOSSINVEST_CLIENT_SECRET 값과 클라이언트 활성 상태를 확인하세요. (자동 재시도하지 않습니다.)',
      httpStatus,
      ...(requestId ? { requestId } : {}),
      retryable: false,
      ...(upstreamCode ? { upstreamCode } : {}),
    });
  }

  if (httpStatus === 429) {
    return new AppError({
      code: 'rate-limit-exceeded',
      message: '토큰 발급 요청 한도를 초과했습니다. 잠시 후 다시 시도하세요.',
      httpStatus,
      ...(requestId ? { requestId } : {}),
      retryable: true,
      ...(upstreamCode ? { upstreamCode } : {}),
    });
  }

  return new AppError({
    code: 'auth-failed',
    message: `토큰 발급에 실패했습니다 (HTTP ${httpStatus}).`,
    httpStatus,
    ...(requestId ? { requestId } : {}),
    retryable: httpStatus >= 500,
    ...(upstreamCode ? { upstreamCode } : {}),
  });
}
