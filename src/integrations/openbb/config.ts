/**
 * OpenBB Platform API 연동 설정과 URL 정책.
 *
 * OpenBB 는 사용자가 직접 실행하는 별도 서버(`openbb-api`, 기본 127.0.0.1:6900)이다.
 * 토스증권 공식 도메인 정책(OFFICIAL_HOSTS)과 섞지 않고 독립된 정책을 적용한다.
 * - 기본: loopback(localhost / 127.0.0.1 / [::1]) 만 허용, http 또는 https
 * - TOSSINVEST_OPENBB_ALLOW_REMOTE=true: 원격 호스트 허용, 단 https 필수
 * - URL 에 userinfo / query / fragment / 하위 경로를 넣을 수 없다 (자격증명은 별도 환경변수)
 */

export const DEFAULT_OPENBB_BASE_URL = 'http://127.0.0.1:6900';
export const DEFAULT_OPENBB_PROVIDER = 'yfinance';

/** OpenBB REST 라우트 prefix. `openbb-api` 기본값. */
export const OPENBB_API_PREFIX = '/api/v1';

const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1', '[::1]', '::1']);

const PROVIDER_PATTERN = /^[a-z0-9_]{1,32}$/;

export interface OpenBbConfig {
  readonly enabled: boolean;
  readonly baseUrl: string;
  readonly allowRemote: boolean;
  /** OpenBB 서버를 OPENBB_API_AUTH=true 로 실행했을 때의 HTTP Basic 자격증명. */
  readonly username?: string;
  readonly password?: string;
  /** 기본 데이터 provider. 키 없이 동작하는 yfinance 가 기본. */
  readonly provider: string;
}

export const DISABLED_OPENBB_CONFIG: OpenBbConfig = Object.freeze({
  enabled: false,
  baseUrl: DEFAULT_OPENBB_BASE_URL,
  allowRemote: false,
  provider: DEFAULT_OPENBB_PROVIDER,
});

export class OpenBbConfigError extends Error {
  public override readonly name = 'ConfigError';
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.includes(hostname.toLowerCase());
}

export function assertOpenBbUrlAllowed(baseUrl: string, allowRemote: boolean): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new OpenBbConfigError('TOSSINVEST_OPENBB_BASE_URL 이 올바른 URL 이 아닙니다.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new OpenBbConfigError('TOSSINVEST_OPENBB_BASE_URL 은 http 또는 https 여야 합니다.');
  }
  if (url.username !== '' || url.password !== '') {
    throw new OpenBbConfigError(
      'TOSSINVEST_OPENBB_BASE_URL 에 자격증명을 넣지 마세요. TOSSINVEST_OPENBB_USERNAME / PASSWORD 를 사용하세요.'
    );
  }
  if (url.search !== '' || url.hash !== '' || (url.pathname !== '/' && url.pathname !== '')) {
    throw new OpenBbConfigError(
      'TOSSINVEST_OPENBB_BASE_URL 은 origin 만 지정해야 합니다 (예: http://127.0.0.1:6900).'
    );
  }

  const loopback = isLoopbackHost(url.hostname);
  if (!loopback) {
    if (!allowRemote) {
      throw new OpenBbConfigError(
        '기본 설정에서는 loopback 주소의 OpenBB 서버만 허용합니다. ' +
          '원격 서버를 쓰려면 TOSSINVEST_OPENBB_ALLOW_REMOTE=true 와 https URL 을 사용하세요.'
      );
    }
    if (url.protocol !== 'https:') {
      throw new OpenBbConfigError('원격 OpenBB 서버는 https 로만 접속할 수 있습니다.');
    }
  }
  return url;
}

export function assertProviderAllowed(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  if (!PROVIDER_PATTERN.test(normalized)) {
    throw new OpenBbConfigError(`허용되지 않는 OpenBB provider 이름입니다: ${provider}`);
  }
  return normalized;
}
