import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export type AuthMode = 'api_key' | 'subscription';

export interface AgentConfig {
  authMode?: AuthMode;
  anthropicApiKey?: string;
  /** OAuth access token (subscription mode) */
  oauthAccessToken?: string;
  /** OAuth refresh token (subscription mode) */
  oauthRefreshToken?: string;
  /** ISO 문자열 — 만료 시각 */
  oauthExpiresAt?: string;
}

export interface AgentStatus {
  configured: boolean;
  authMode: AuthMode | 'none';
  keySet: boolean;
  keyPreview: string | null;
}

/* ── OAuth 상수 ── */
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_REDIRECT_URI =
  'https://platform.claude.com/oauth/code/callback';
const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';
const OAUTH_SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
].join(' ');

@Injectable()
export class AgentConfigService {
  private readonly logger = new Logger(AgentConfigService.name);
  private readonly configDir: string;
  private readonly configPath: string;

  /** PKCE 세션: startOAuthLogin() → submitOAuthCode() 사이에 유지 */
  private pkceVerifier: string | null = null;
  private pkceState: string | null = null;

  constructor() {
    this.configDir =
      process.env.AGENTS_CONFIG_DIR ||
      path.resolve(process.cwd(), '../../.agents');
    this.configPath = path.join(this.configDir, 'config.json');
    this.ensureDir();
  }

  private ensureDir() {
    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
      this.logger.log(`Created agents config dir: ${this.configDir}`);
    }
  }

  /* ── Config CRUD ── */

  readConfig(): AgentConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      }
    } catch (err) {
      this.logger.warn(`Failed to read config: ${err}`);
    }
    return {};
  }

  saveConfig(config: AgentConfig): void {
    this.ensureDir();
    fs.writeFileSync(
      this.configPath,
      JSON.stringify(config, null, 2),
      'utf-8',
    );
    this.logger.log('Agent config saved');
  }

  /* ── Status ── */

  getStatus(): AgentStatus {
    const config = this.readConfig();
    const mode = config.authMode;
    const key = config.anthropicApiKey || '';

    if (mode === 'subscription') {
      const hasToken = !!config.oauthAccessToken;
      return {
        configured: hasToken,
        authMode: 'subscription',
        keySet: false,
        keyPreview: null,
      };
    }

    return {
      configured: key.length > 0,
      authMode: key.length > 0 ? 'api_key' : 'none',
      keySet: key.length > 0,
      keyPreview:
        key.length > 8 ? `${key.slice(0, 7)}..${key.slice(-4)}` : null,
    };
  }

  getAuthMode(): AuthMode | 'none' {
    const config = this.readConfig();
    if (config.authMode === 'subscription') return 'subscription';
    const key = config.anthropicApiKey || '';
    return key.length > 0 ? 'api_key' : 'none';
  }

  getApiKey(): string | undefined {
    if (this.getAuthMode() === 'subscription') return undefined;
    return process.env.ANTHROPIC_API_KEY || this.readConfig().anthropicApiKey;
  }

  /**
   * 구독 모드의 OAuth access token을 반환합니다.
   * claude -p 호출 시 ANTHROPIC_AUTH_TOKEN 환경변수로 전달됩니다.
   */
  getOAuthToken(): string | undefined {
    const config = this.readConfig();
    if (config.authMode !== 'subscription') return undefined;
    return config.oauthAccessToken || undefined;
  }

  /**
   * OAuth 토큰이 만료되었거나 곧 만료될 경우(5분 이내) refresh_token으로 갱신합니다.
   * AI 스코어링 호출 전에 호출하여 만료 에러를 방지합니다.
   * @returns true=유효/갱신 성공, false=갱신 실패(재로그인 필요)
   */
  async ensureValidOAuthToken(): Promise<boolean> {
    const config = this.readConfig();
    if (config.authMode !== 'subscription') return true; // API 키 모드
    if (!config.oauthAccessToken) return false;

    // 만료까지 5분 이상 남았으면 그대로 사용
    if (config.oauthExpiresAt) {
      const expiresAt = new Date(config.oauthExpiresAt).getTime();
      const fiveMinutes = 5 * 60 * 1000;
      if (Date.now() + fiveMinutes < expiresAt) {
        return true;
      }
      this.logger.log('OAuth 토큰 만료 임박 → 갱신 시도');
    }

    return this.refreshOAuthToken();
  }

  /**
   * refresh_token으로 access_token을 갱신합니다.
   * 성공 시 config.json과 ~/.claude/.credentials.json 둘 다 업데이트합니다.
   */
  async refreshOAuthToken(): Promise<boolean> {
    const config = this.readConfig();
    if (!config.oauthRefreshToken) {
      this.logger.warn('refresh_token 없음 → 재로그인 필요');
      return false;
    }

    try {
      this.logger.log('OAuth 토큰 갱신 요청 중...');
      const res = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'refresh_token',
          refresh_token: config.oauthRefreshToken,
          client_id: OAUTH_CLIENT_ID,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        this.logger.error(
          `토큰 갱신 실패 (${res.status}): ${body.slice(0, 300)}`,
        );
        return false;
      }

      const data = await res.json();
      const expiresAt = data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : new Date(Date.now() + 3600 * 1000).toISOString();

      config.oauthAccessToken = data.access_token;
      if (data.refresh_token) config.oauthRefreshToken = data.refresh_token;
      config.oauthExpiresAt = expiresAt;
      this.saveConfig(config);

      // Claude CLI용 .credentials.json도 갱신
      this.writeCliCredentials({
        access_token: data.access_token,
        refresh_token: data.refresh_token || config.oauthRefreshToken,
        expires_in: data.expires_in,
      });

      this.logger.log(`OAuth 토큰 갱신 성공 (만료: ${expiresAt})`);
      return true;
    } catch (err: any) {
      this.logger.error(`OAuth 토큰 갱신 에러: ${err.message}`);
      return false;
    }
  }

  /* ──────────────────────────────────────────────
     OAuth PKCE 플로우 (CLI 없이 순수 HTTP)
     ────────────────────────────────────────────── */

  /**
   * 1단계: PKCE code_verifier/challenge를 생성하고 OAuth 인증 URL을 반환합니다.
   */
  startOAuthLogin(): { url: string } {
    // PKCE code_verifier (43-128자, base64url-safe)
    this.pkceVerifier = crypto.randomBytes(32).toString('base64url');
    // code_challenge = BASE64URL(SHA256(code_verifier))
    const challenge = crypto
      .createHash('sha256')
      .update(this.pkceVerifier)
      .digest('base64url');
    // state — CSRF 방지
    this.pkceState = crypto.randomBytes(32).toString('base64url');

    const params = new URLSearchParams({
      code: 'true',
      client_id: OAUTH_CLIENT_ID,
      response_type: 'code',
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: this.pkceState,
    });

    const url = `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
    this.logger.log('OAuth PKCE 로그인 URL 생성 완료');
    return { url };
  }

  /**
   * 2단계: 인증 코드를 토큰으로 교환합니다.
   * 브라우저의 callback 페이지에서 받은 authorization code를 전달합니다.
   */
  async submitOAuthCode(
    code: string,
  ): Promise<{ success: boolean; error?: string }> {
    if (!this.pkceVerifier) {
      return {
        success: false,
        error: '로그인 세션이 없습니다. 로그인을 다시 시작하세요.',
      };
    }

    try {
      // Anthropic은 code#state 형식을 사용할 수 있음 → code만 추출
      let authCode = code.trim();
      if (authCode.includes('#')) {
        authCode = authCode.split('#')[0];
      }

      this.logger.log(
        `OAuth 토큰 교환 요청 중... (code: ${authCode.length}자, verifier: ${this.pkceVerifier.length}자)`,
      );

      const res = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          code: authCode,
          redirect_uri: OAUTH_REDIRECT_URI,
          client_id: OAUTH_CLIENT_ID,
          code_verifier: this.pkceVerifier,
          state: this.pkceState,
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        this.logger.error(
          `토큰 교환 실패 (${res.status}): ${body.slice(0, 500)}`,
        );
        return {
          success: false,
          error: `토큰 교환 실패 (HTTP ${res.status}): ${body.slice(0, 200)}`,
        };
      }

      const data = await res.json();
      this.logger.log('OAuth 토큰 교환 성공');

      // 토큰 저장
      const expiresAt = data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : new Date(Date.now() + 3600 * 1000).toISOString();

      const config = this.readConfig();
      config.authMode = 'subscription';
      config.oauthAccessToken = data.access_token;
      config.oauthRefreshToken = data.refresh_token || undefined;
      config.oauthExpiresAt = expiresAt;
      // API 키가 있었다면 제거
      delete config.anthropicApiKey;
      this.saveConfig(config);

      // Claude CLI용 .credentials.json도 생성 시도
      this.writeCliCredentials(data);

      // PKCE 세션 정리
      this.pkceVerifier = null;
      this.pkceState = null;

      return { success: true };
    } catch (err: any) {
      this.logger.error(`토큰 교환 에러: ${err.message}`);
      return { success: false, error: `토큰 교환 실패: ${err.message}` };
    }
  }

  /**
   * Claude CLI가 인식하는 .credentials.json 파일도 생성합니다.
   * 형식이 맞지 않아도 ANTHROPIC_AUTH_TOKEN 환경변수로 동작하므로 문제없습니다.
   */
  private writeCliCredentials(tokenData: any): void {
    try {
      const configDir =
        process.env.CLAUDE_CONFIG_DIR || path.join('/root', '.claude');
      if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
      }
      const credPath = path.join(configDir, '.credentials.json');
      const cred = {
        claudeAiOauth: {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token || '',
          expiresAt: tokenData.expires_in
            ? new Date(
                Date.now() + tokenData.expires_in * 1000,
              ).toISOString()
            : new Date(Date.now() + 3600_000).toISOString(),
          scopes: OAUTH_SCOPES.split(' '),
        },
      };
      fs.writeFileSync(credPath, JSON.stringify(cred, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      this.logger.log(`CLI credentials 저장: ${credPath}`);
    } catch (err: any) {
      this.logger.warn(
        `CLI credentials 저장 실패 (무시 가능): ${err.message}`,
      );
    }
  }

  /* ── 로그인 상태 확인 ── */

  async checkCliAuth(): Promise<{ loggedIn: boolean }> {
    const config = this.readConfig();
    if (config.authMode !== 'subscription') {
      return { loggedIn: false };
    }
    if (!config.oauthAccessToken) {
      return { loggedIn: false };
    }
    // 만료 확인 → 만료되었으면 refresh_token으로 갱신 시도
    if (config.oauthExpiresAt) {
      const expiresAt = new Date(config.oauthExpiresAt).getTime();
      if (Date.now() > expiresAt) {
        this.logger.warn('OAuth 토큰 만료됨 → 갱신 시도');
        const refreshed = await this.refreshOAuthToken();
        return { loggedIn: refreshed };
      }
    }
    return { loggedIn: true };
  }

  /* ── API 키 검증 ── */

  async verifyApiKey(apiKey: string): Promise<boolean> {
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
      });
      return res.status !== 401;
    } catch {
      return false;
    }
  }
}
