import { REQUEST_ID_HEADER, TOKEN_ENDPOINT_PATH } from '../config/constants.js';
import type { AppConfig } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { extractUpstreamError, toAppError } from '../errors/error-normalizer.js';
import { maskIdentifier, registerSecret } from '../security/redaction.js';
import { safeJsonParse } from '../utils/json.js';
import type { Logger } from '../utils/logger.js';
import { SingleFlight } from '../utils/single-flight.js';
import { authFailureError, credentialsMissingError } from './auth-errors.js';

interface CachedToken {
  readonly accessToken: string;
  readonly tokenType: string;
  /** epoch ms. safety skew 가 이미 반영된 값. */
  readonly effectiveExpiresAt: number;
  /** epoch ms. 서버가 알려준 실제 만료 시각. */
  readonly actualExpiresAt: number;
  readonly issuedAt: number;
  readonly expiresIn: number;
}

export interface AuthStatus {
  readonly clientIdConfigured: boolean;
  readonly clientIdMasked?: string;
  readonly clientSecretConfigured: boolean;
  readonly hasAccessToken: boolean;
  readonly tokenExpiringSoon: boolean;
  readonly tokenExpiresAt?: string;
  readonly ready: boolean;
  readonly defaultAccountConfigured: boolean;
  readonly defaultAccountMasked?: string;
  readonly lastAuthError?: { code: string; message: string; at: string };
  readonly possibleIpAllowlistIssue: boolean;
  readonly hint: string;
}

export interface RefreshResult {
  readonly ok: true;
  readonly expiresIn: number;
  readonly expiresAt: string;
}

export interface TokenManagerOptions {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
}

/**
 * OAuth 2.0 client credentials 토큰 관리자.
 *
 * - access token 은 메모리에만 보관하며 어떤 경로로도 외부에 노출하지 않는다.
 * - 토스증권은 client 당 유효 토큰이 1 개이고 재발급 시 이전 토큰이 즉시 무효화되므로
 *   single-flight 로 동시 발급을 방지한다.
 */
export class TokenManager {
  private readonly config: AppConfig;
  private readonly logger: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly singleFlight = new SingleFlight<CachedToken>();

  private cached: CachedToken | null = null;
  private lastAuthError: { code: string; message: string; at: string } | null = null;

  constructor(options: TokenManagerOptions) {
    this.config = options.config;
    this.logger = options.logger.child('auth');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;

    registerSecret(this.config.clientSecret);
    registerSecret(this.config.clientId);
  }

  get hasCredentials(): boolean {
    return Boolean(this.config.clientId && this.config.clientSecret);
  }

  private assertCredentials(): { clientId: string; clientSecret: string } {
    const missing: string[] = [];
    if (!this.config.clientId) missing.push('TOSSINVEST_CLIENT_ID');
    if (!this.config.clientSecret) missing.push('TOSSINVEST_CLIENT_SECRET');
    if (missing.length > 0) {
      throw credentialsMissingError(missing);
    }
    return { clientId: this.config.clientId as string, clientSecret: this.config.clientSecret as string };
  }

  private isFresh(token: CachedToken | null): token is CachedToken {
    return token !== null && token.effectiveExpiresAt > this.now();
  }

  /** 유효한 access token 을 반환한다. 필요하면 발급한다. */
  async getAccessToken(): Promise<string> {
    if (this.isFresh(this.cached)) {
      return this.cached.accessToken;
    }
    const token = await this.issueToken();
    return token.accessToken;
  }

  /** `Authorization` 헤더 값을 만든다. 이 값은 로그에 남기지 않는다. */
  async getAuthorizationHeader(): Promise<string> {
    const token = await this.getAccessToken();
    const type = this.cached?.tokenType ?? 'Bearer';
    return `${type} ${token}`;
  }

  /** 캐시를 버린다. 401 후 1회 갱신 시 사용. */
  invalidate(): void {
    this.cached = null;
  }

  /** 명시적 갱신. access token 문자열은 반환하지 않는다. */
  async refresh(): Promise<RefreshResult> {
    this.invalidate();
    const token = await this.issueToken();
    return {
      ok: true,
      expiresIn: token.expiresIn,
      expiresAt: new Date(token.actualExpiresAt).toISOString(),
    };
  }

  private async issueToken(): Promise<CachedToken> {
    return this.singleFlight.run(async () => {
      // single-flight 대기 중 다른 요청이 이미 발급했을 수 있다.
      if (this.isFresh(this.cached)) return this.cached;

      const { clientId, clientSecret } = this.assertCredentials();
      const token = await this.requestToken(clientId, clientSecret);
      this.cached = token;
      this.lastAuthError = null;
      this.logger.info('access token 을 발급했습니다.', {
        expiresIn: token.expiresIn,
        expiresAt: new Date(token.actualExpiresAt).toISOString(),
      });
      return token;
    });
  }

  private async requestToken(clientId: string, clientSecret: string): Promise<CachedToken> {
    const url = `${this.config.baseUrl}${TOKEN_ENDPOINT_PATH}`;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: body.toString(),
        signal: controller.signal,
      });

      const requestId = response.headers.get(REQUEST_ID_HEADER) ?? undefined;
      const text = await response.text();
      let payload: unknown = undefined;
      if (text) {
        try {
          payload = safeJsonParse(text);
        } catch {
          payload = undefined;
        }
      }

      if (!response.ok) {
        const upstream = extractUpstreamError(payload);
        const error = authFailureError(response.status, upstream.code, requestId ?? upstream.requestId);
        this.recordAuthError(error);
        throw error;
      }

      const parsed = this.parseTokenResponse(payload);
      registerSecret(parsed.accessToken);
      return parsed;
    } catch (error) {
      const appError = toAppError(error, '토큰 발급 중 오류가 발생했습니다.');
      this.recordAuthError(appError);
      throw appError;
    } finally {
      clearTimeout(timer);
    }
  }

  private parseTokenResponse(payload: unknown): CachedToken {
    if (typeof payload !== 'object' || payload === null) {
      throw new AppError({
        code: 'invalid-response',
        message: '토큰 응답 형식이 올바르지 않습니다.',
        retryable: false,
      });
    }

    const data = payload as Record<string, unknown>;
    const accessToken = data.access_token;
    const expiresIn = data.expires_in;

    if (typeof accessToken !== 'string' || accessToken === '') {
      throw new AppError({
        code: 'invalid-response',
        message: '토큰 응답에 access_token 이 없습니다.',
        retryable: false,
      });
    }

    const expiresInSeconds =
      typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
        ? Math.floor(expiresIn)
        : 3600;

    const issuedAt = this.now();
    const actualExpiresAt = issuedAt + expiresInSeconds * 1000;
    const skewMs = this.config.tokenExpirySkewSeconds * 1000;
    // skew 가 만료시간보다 크면 즉시 만료 처리되지 않도록 최소 1초는 남긴다.
    const effectiveExpiresAt = Math.max(actualExpiresAt - skewMs, issuedAt + 1000);

    return {
      accessToken,
      tokenType: typeof data.token_type === 'string' && data.token_type ? data.token_type : 'Bearer',
      effectiveExpiresAt,
      actualExpiresAt,
      issuedAt,
      expiresIn: expiresInSeconds,
    };
  }

  private recordAuthError(error: AppError): void {
    this.lastAuthError = {
      code: error.code,
      message: error.message,
      at: new Date(this.now()).toISOString(),
    };
    this.logger.warn('인증 처리 중 오류가 발생했습니다.', { code: error.code });
  }

  /** MCP 로 반환해도 안전한 인증 상태 요약. */
  getStatus(): AuthStatus {
    const clientIdConfigured = Boolean(this.config.clientId);
    const clientSecretConfigured = Boolean(this.config.clientSecret);
    const hasAccessToken = this.cached !== null;
    const tokenExpiringSoon = this.cached !== null && this.cached.effectiveExpiresAt <= this.now();
    const possibleIpAllowlistIssue = this.lastAuthError?.code === 'ip-not-allowed';

    let hint: string;
    if (!clientIdConfigured || !clientSecretConfigured) {
      hint =
        'TOSSINVEST_CLIENT_ID / TOSSINVEST_CLIENT_SECRET 를 설정하세요. 토스증권 WTS > 설정 > Open API 에서 발급합니다.';
    } else if (possibleIpAllowlistIssue) {
      hint = '허용 IP 문제로 보입니다. WTS > 설정 > Open API > 허용 IP 관리에서 현재 공인 IP 를 등록하세요.';
    } else if (this.lastAuthError) {
      hint = '최근 인증 오류가 있습니다. tossinvest_refresh_auth 로 재시도하거나 인증 정보를 확인하세요.';
    } else if (!hasAccessToken) {
      hint = '아직 토큰을 발급하지 않았습니다. 첫 API 호출 시 자동으로 발급됩니다.';
    } else {
      hint = '인증 준비 완료.';
    }

    return {
      clientIdConfigured,
      ...(clientIdConfigured ? { clientIdMasked: maskIdentifier(this.config.clientId) } : {}),
      clientSecretConfigured,
      hasAccessToken,
      tokenExpiringSoon,
      ...(this.cached ? { tokenExpiresAt: new Date(this.cached.actualExpiresAt).toISOString() } : {}),
      ready: clientIdConfigured && clientSecretConfigured,
      defaultAccountConfigured: Boolean(this.config.defaultAccount),
      ...(this.config.defaultAccount
        ? { defaultAccountMasked: maskIdentifier(this.config.defaultAccount) }
        : {}),
      ...(this.lastAuthError ? { lastAuthError: this.lastAuthError } : {}),
      possibleIpAllowlistIssue,
      hint,
    };
  }
}
