import { beforeEach, describe, expect, it } from 'vitest';
import { TokenManager } from '../../src/auth/token-manager.js';
import { clearRegisteredSecrets, scrubString } from '../../src/security/redaction.js';
import { createMockFetch, makeConfig, silentLogger, TOKEN_RESPONSE } from '../fixtures/helpers.js';

beforeEach(() => {
  clearRegisteredSecrets();
});

describe('TokenManager', () => {
  it('인증 정보가 없으면 credentials-missing 오류를 반환한다', async () => {
    const { fetch: mockFetch, calls } = createMockFetch([{ body: TOKEN_RESPONSE }]);
    const manager = new TokenManager({
      config: makeConfig({ clientId: undefined, clientSecret: undefined }),
      logger: silentLogger,
      fetchImpl: mockFetch,
    });

    await expect(manager.getAccessToken()).rejects.toMatchObject({ code: 'credentials-missing' });
    // 네트워크 요청 자체를 하지 않는다.
    expect(calls).toHaveLength(0);
  });

  it('최초 토큰을 발급하고 form-urlencoded 로 전송한다', async () => {
    const { fetch: mockFetch, calls } = createMockFetch([{ body: TOKEN_RESPONSE }]);
    const manager = new TokenManager({
      config: makeConfig(),
      logger: silentLogger,
      fetchImpl: mockFetch,
    });

    const token = await manager.getAccessToken();
    expect(token).toBe(TOKEN_RESPONSE.access_token);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://openapi.tossinvest.com/oauth2/token');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(calls[0]!.body).toContain('grant_type=client_credentials');
    expect(calls[0]!.body).toContain('client_id=');
    expect(calls[0]!.body).toContain('client_secret=');
  });

  it('유효한 토큰은 캐시해 재발급하지 않는다', async () => {
    const { fetch: mockFetch, calls } = createMockFetch([{ body: TOKEN_RESPONSE }]);
    const manager = new TokenManager({
      config: makeConfig(),
      logger: silentLogger,
      fetchImpl: mockFetch,
    });

    await manager.getAccessToken();
    await manager.getAccessToken();
    await manager.getAccessToken();
    expect(calls).toHaveLength(1);
  });

  it('safety skew 를 적용해 만료 전에 갱신한다', async () => {
    let now = 1_000_000;
    const { fetch: mockFetch, calls } = createMockFetch([{ body: { ...TOKEN_RESPONSE, expires_in: 100 } }]);
    const manager = new TokenManager({
      config: makeConfig({ tokenExpirySkewSeconds: 60 }),
      logger: silentLogger,
      fetchImpl: mockFetch,
      now: () => now,
    });

    await manager.getAccessToken();
    expect(calls).toHaveLength(1);

    // 만료 100초 - skew 60초 = 40초 뒤 갱신 대상.
    now += 39_000;
    await manager.getAccessToken();
    expect(calls).toHaveLength(1);

    now += 2_000;
    await manager.getAccessToken();
    expect(calls).toHaveLength(2);
  });

  it('동시 요청에서도 토큰을 한 번만 발급한다 (single-flight)', async () => {
    let resolveResponse: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      resolveResponse = resolve;
    });

    let callCount = 0;
    const gatedFetch = (async () => {
      callCount += 1;
      await gate;
      return new Response(JSON.stringify(TOKEN_RESPONSE), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const manager = new TokenManager({
      config: makeConfig(),
      logger: silentLogger,
      fetchImpl: gatedFetch,
    });

    const pending = Promise.all([
      manager.getAccessToken(),
      manager.getAccessToken(),
      manager.getAccessToken(),
      manager.getAccessToken(),
      manager.getAccessToken(),
    ]);

    resolveResponse!();
    const tokens = await pending;

    expect(callCount).toBe(1);
    expect(new Set(tokens).size).toBe(1);
  });

  it('invalid_client 응답을 재시도 없이 auth-failed 로 정규화한다', async () => {
    const { fetch: mockFetch, calls } = createMockFetch([
      { status: 401, body: { error: 'invalid_client', error_description: 'Client authentication failed.' } },
    ]);
    const manager = new TokenManager({
      config: makeConfig(),
      logger: silentLogger,
      fetchImpl: mockFetch,
    });

    await expect(manager.getAccessToken()).rejects.toMatchObject({
      code: 'auth-failed',
      retryable: false,
    });
    expect(calls).toHaveLength(1);
  });

  it('403 은 허용 IP 문제로 안내한다', async () => {
    const { fetch: mockFetch } = createMockFetch([
      { status: 403, body: { error: 'access_denied', error_description: 'IP address not allowed' } },
    ]);
    const manager = new TokenManager({
      config: makeConfig(),
      logger: silentLogger,
      fetchImpl: mockFetch,
    });

    await expect(manager.getAccessToken()).rejects.toMatchObject({ code: 'ip-not-allowed' });
    const status = manager.getStatus();
    expect(status.possibleIpAllowlistIssue).toBe(true);
    expect(status.hint).toContain('허용 IP');
  });

  it('refresh 는 만료 정보만 반환하고 토큰 문자열을 노출하지 않는다', async () => {
    const { fetch: mockFetch } = createMockFetch([{ body: TOKEN_RESPONSE }]);
    const manager = new TokenManager({
      config: makeConfig(),
      logger: silentLogger,
      fetchImpl: mockFetch,
    });

    const result = await manager.refresh();
    expect(result).toEqual({
      ok: true,
      expiresIn: 86400,
      expiresAt: expect.any(String),
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN_RESPONSE.access_token);
  });

  it('auth status 는 비밀값을 노출하지 않는다', async () => {
    const { fetch: mockFetch } = createMockFetch([{ body: TOKEN_RESPONSE }]);
    const config = makeConfig({ defaultAccount: '1234567890' });
    const manager = new TokenManager({ config, logger: silentLogger, fetchImpl: mockFetch });

    await manager.getAccessToken();
    const status = manager.getStatus();
    const serialized = JSON.stringify(status);

    expect(status.clientIdConfigured).toBe(true);
    expect(status.clientSecretConfigured).toBe(true);
    expect(status.hasAccessToken).toBe(true);
    expect(status.ready).toBe(true);
    expect(serialized).not.toContain(config.clientId!);
    expect(serialized).not.toContain(config.clientSecret!);
    expect(serialized).not.toContain(TOKEN_RESPONSE.access_token);
    expect(serialized).not.toContain('1234567890');
    expect(status.clientIdMasked).toMatch(/\*/);
  });

  it('발급된 access token 은 로그 redaction 대상으로 등록된다', async () => {
    const { fetch: mockFetch } = createMockFetch([{ body: TOKEN_RESPONSE }]);
    const manager = new TokenManager({
      config: makeConfig(),
      logger: silentLogger,
      fetchImpl: mockFetch,
    });

    await manager.getAccessToken();
    expect(scrubString(`token=${TOKEN_RESPONSE.access_token}`)).not.toContain(
      TOKEN_RESPONSE.access_token
    );
  });

  it('Authorization 헤더를 Bearer 형식으로 만든다', async () => {
    const { fetch: mockFetch } = createMockFetch([{ body: TOKEN_RESPONSE }]);
    const manager = new TokenManager({
      config: makeConfig(),
      logger: silentLogger,
      fetchImpl: mockFetch,
    });

    expect(await manager.getAuthorizationHeader()).toBe(`Bearer ${TOKEN_RESPONSE.access_token}`);
  });

  it('토큰 응답에 access_token 이 없으면 실패한다', async () => {
    const { fetch: mockFetch } = createMockFetch([{ body: { token_type: 'Bearer' } }]);
    const manager = new TokenManager({
      config: makeConfig(),
      logger: silentLogger,
      fetchImpl: mockFetch,
    });

    await expect(manager.getAccessToken()).rejects.toMatchObject({ code: 'invalid-response' });
  });
});
