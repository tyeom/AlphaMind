import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AiMeetingProvider } from '../ai-scoring/types/ai-scoring.types';

export type AuthMode = 'api_key' | 'subscription';

export interface ClaudeAgentConfig {
  authMode?: AuthMode;
  anthropicApiKey?: string;
  /** OAuth access token (subscription mode) */
  oauthAccessToken?: string;
  /** OAuth refresh token (subscription mode) */
  oauthRefreshToken?: string;
  /** ISO 문자열 — 만료 시각 */
  oauthExpiresAt?: string;
}

export interface GptAgentConfig {
  authMode?: AuthMode;
  openaiApiKey?: string;
  authError?: string;
  authErrorAt?: string;
}

export interface AgentsConfig {
  claude: ClaudeAgentConfig;
  gpt: GptAgentConfig;
}

interface RawAgentConfig extends ClaudeAgentConfig {
  claude?: ClaudeAgentConfig;
  gpt?: GptAgentConfig;
}

export interface ProviderStatus {
  configured: boolean;
  authMode: AuthMode | 'none';
  keySet: boolean;
  keyPreview: string | null;
  errorMessage?: string;
}

export interface AgentStatus {
  claude: ProviderStatus;
  gpt: ProviderStatus;
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

  private getCodexHomeDir(): string {
    return process.env.CODEX_HOME || path.join('/root', '.codex');
  }

  private readGptAuthFile():
    | {
        authMode: 'chatgpt' | 'api_key' | 'none';
        hasAccessToken: boolean;
        hasRefreshToken: boolean;
      }
    | undefined {
    try {
      const authPath = path.join(this.getCodexHomeDir(), 'auth.json');
      if (!fs.existsSync(authPath)) return undefined;
      const raw = JSON.parse(fs.readFileSync(authPath, 'utf-8')) as {
        auth_mode?: string;
        OPENAI_API_KEY?: string | null;
        tokens?: {
          access_token?: string;
          refresh_token?: string;
        };
      };
      return {
        authMode:
          raw.auth_mode === 'chatgpt'
            ? 'chatgpt'
            : raw.auth_mode === 'api_key'
              ? 'api_key'
              : 'none',
        hasAccessToken: !!raw.tokens?.access_token,
        hasRefreshToken: !!raw.tokens?.refresh_token,
      };
    } catch (err: any) {
      this.logger.warn(`GPT auth.json 읽기 실패: ${err.message}`);
      return undefined;
    }
  }

  private readRawConfig(): RawAgentConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        return JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
      }
    } catch (err) {
      this.logger.warn(`Failed to read config: ${err}`);
    }
    return {};
  }

  /* ── Config CRUD ── */

  readConfig(): AgentsConfig {
    const raw = this.readRawConfig();
    return {
      claude: {
        authMode: raw.claude?.authMode ?? raw.authMode,
        anthropicApiKey: raw.claude?.anthropicApiKey ?? raw.anthropicApiKey,
        oauthAccessToken: raw.claude?.oauthAccessToken ?? raw.oauthAccessToken,
        oauthRefreshToken: raw.claude?.oauthRefreshToken ?? raw.oauthRefreshToken,
        oauthExpiresAt: raw.claude?.oauthExpiresAt ?? raw.oauthExpiresAt,
      },
      gpt: {
        authMode: raw.gpt?.authMode,
        openaiApiKey: raw.gpt?.openaiApiKey,
        authError: raw.gpt?.authError,
        authErrorAt: raw.gpt?.authErrorAt,
      },
    };
  }

  saveConfig(config: AgentsConfig): void {
    this.ensureDir();
    const payload: RawAgentConfig = {
      authMode: config.claude.authMode,
      anthropicApiKey: config.claude.anthropicApiKey,
      oauthAccessToken: config.claude.oauthAccessToken,
      oauthRefreshToken: config.claude.oauthRefreshToken,
      oauthExpiresAt: config.claude.oauthExpiresAt,
      claude: { ...config.claude },
      gpt: { ...config.gpt },
    };
    fs.writeFileSync(
      this.configPath,
      JSON.stringify(payload, null, 2),
      'utf-8',
    );
    this.logger.log('Agent config saved');
  }

  saveClaudeConfig(config: ClaudeAgentConfig): void {
    const current = this.readConfig();
    current.claude = { ...config };
    this.saveConfig(current);
  }

  saveGptConfig(config: GptAgentConfig): void {
    const current = this.readConfig();
    current.gpt = { ...config };
    this.saveConfig(current);
  }

  clearGptAuthError(): void {
    const current = this.readConfig();
    if (!current.gpt.authError && !current.gpt.authErrorAt) return;
    delete current.gpt.authError;
    delete current.gpt.authErrorAt;
    this.saveConfig(current);
  }

  markGptSubscriptionExpired(reason: string): void {
    const current = this.readConfig();
    if (current.gpt.authMode !== 'subscription') return;
    current.gpt.authError = reason;
    current.gpt.authErrorAt = new Date().toISOString();
    this.saveConfig(current);
    this.logger.warn(`GPT 구독 인증 만료 처리: ${reason}`);
  }

  /* ── Status ── */

  getStatus(): AgentStatus {
    const config = this.readConfig();
    return {
      claude: this.getClaudeStatus(config.claude),
      gpt: this.getGptStatus(config.gpt),
    };
  }

  getProviderStatus(provider: AiMeetingProvider): ProviderStatus {
    const status = this.getStatus();
    return provider === 'gpt' ? status.gpt : status.claude;
  }

  getAuthMode(provider: AiMeetingProvider = 'claude'): AuthMode | 'none' {
    const status = this.getProviderStatus(provider);
    return status.authMode;
  }

  getClaudeApiKey(): string | undefined {
    if (this.getAuthMode('claude') === 'subscription') return undefined;
    return process.env.ANTHROPIC_API_KEY || this.readConfig().claude.anthropicApiKey;
  }

  getGptApiKey(): string | undefined {
    if (this.getAuthMode('gpt') === 'subscription') return undefined;
    return process.env.OPENAI_API_KEY || this.readConfig().gpt.openaiApiKey;
  }

  private getClaudeStatus(config: ClaudeAgentConfig): ProviderStatus {
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

  private getGptStatus(config: GptAgentConfig): ProviderStatus {
    const key = config.openaiApiKey || '';
    const authFile = this.readGptAuthFile();
    if (config.authMode === 'subscription') {
      const authBroken = !!config.authError;
      return {
        configured: !authBroken && authFile?.authMode === 'chatgpt' && authFile.hasAccessToken,
        authMode: authBroken ? 'none' : 'subscription',
        keySet: false,
        keyPreview: null,
        errorMessage: config.authError,
      };
    }
    return {
      configured: key.length > 0,
      authMode: key.length > 0 ? 'api_key' : 'none',
      keySet: key.length > 0,
      keyPreview:
        key.length > 8 ? `${key.slice(0, 7)}..${key.slice(-4)}` : null,
      errorMessage: config.authError,
    };
  }

  /**
   * 구독 모드의 OAuth access token을 반환합니다.
   * claude -p 호출 시 ANTHROPIC_AUTH_TOKEN 환경변수로 전달되지 않고
   * Claude CLI가 ~/.claude/.credentials.json 에서 직접 읽습니다.
   */
  getOAuthToken(): string | undefined {
    const config = this.readConfig().claude;
    if (config.authMode !== 'subscription') return undefined;
    return config.oauthAccessToken || undefined;
  }

  async ensureProviderReady(provider: AiMeetingProvider): Promise<void> {
    if (provider === 'gpt') {
      const config = this.readConfig().gpt;
      if (config.authMode === 'subscription') {
        const login = await this.checkGptCliAuth();
        if (!login.loggedIn) {
          throw new Error(
            config.authError
              || 'GPT 구독 인증이 없습니다. AI 에이전트 설정에서 GPT 연동을 먼저 완료하세요.',
          );
        }
        return;
      }
      if (this.getGptApiKey()) return;
      throw new Error('GPT API 키가 없습니다. AI 에이전트 설정에서 GPT 연동을 먼저 완료하세요.');
    }

    const valid = await this.ensureValidOAuthToken();
    if (!valid) {
      const status = this.getProviderStatus('claude');
      if (status.authMode === 'none') {
        throw new Error('Claude 연동 설정이 없습니다. AI 에이전트 설정에서 Claude 연동을 먼저 완료하세요.');
      }
      if (status.authMode === 'api_key' && !this.getClaudeApiKey()) {
        throw new Error('Claude API 키가 없습니다. AI 에이전트 설정에서 Claude 연동을 먼저 완료하세요.');
      }
      throw new Error('Claude OAuth 토큰이 만료되었습니다. 재로그인이 필요합니다.');
    }
  }

  /**
   * OAuth 토큰이 만료되었거나 곧 만료될 경우(5분 이내) refresh_token으로 갱신합니다.
   * AI 스코어링 호출 전에 호출하여 만료 에러를 방지합니다.
   * @returns true=유효/갱신 성공, false=갱신 실패(재로그인 필요)
   */
  async ensureValidOAuthToken(): Promise<boolean> {
    const config = this.readConfig().claude;
    if (config.authMode !== 'subscription') {
      return !!this.getClaudeApiKey();
    }
    if (!config.oauthAccessToken) return false;

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
    const allConfig = this.readConfig();
    const config = allConfig.claude;
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

      allConfig.claude.oauthAccessToken = data.access_token;
      if (data.refresh_token) {
        allConfig.claude.oauthRefreshToken = data.refresh_token;
      }
      allConfig.claude.oauthExpiresAt = expiresAt;
      this.saveConfig(allConfig);

      this.writeCliCredentials({
        access_token: data.access_token,
        refresh_token: data.refresh_token || allConfig.claude.oauthRefreshToken,
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

  startOAuthLogin(): { url: string } {
    this.pkceVerifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto
      .createHash('sha256')
      .update(this.pkceVerifier)
      .digest('base64url');
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

      const expiresAt = data.expires_in
        ? new Date(Date.now() + data.expires_in * 1000).toISOString()
        : new Date(Date.now() + 3600 * 1000).toISOString();

      const config = this.readConfig();
      config.claude.authMode = 'subscription';
      config.claude.oauthAccessToken = data.access_token;
      config.claude.oauthRefreshToken = data.refresh_token || undefined;
      config.claude.oauthExpiresAt = expiresAt;
      delete config.claude.anthropicApiKey;
      this.saveConfig(config);

      this.writeCliCredentials(data);

      this.pkceVerifier = null;
      this.pkceState = null;

      return { success: true };
    } catch (err: any) {
      this.logger.error(`토큰 교환 에러: ${err.message}`);
      return { success: false, error: `토큰 교환 실패: ${err.message}` };
    }
  }

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
    const config = this.readConfig().claude;
    if (config.authMode !== 'subscription') {
      return { loggedIn: false };
    }
    if (!config.oauthAccessToken) {
      return { loggedIn: false };
    }
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

  async checkGptCliAuth(): Promise<{ loggedIn: boolean; authMode: 'chatgpt' | 'api_key' | 'none' }> {
    try {
      const config = this.readConfig().gpt;
      if (config.authError) {
        return { loggedIn: false, authMode: 'none' };
      }
      const authFile = this.readGptAuthFile();
      if (!authFile) {
        return { loggedIn: false, authMode: 'none' };
      }
      if (authFile.authMode === 'chatgpt' && authFile.hasAccessToken) {
        return { loggedIn: true, authMode: 'chatgpt' };
      }
      if (authFile.authMode === 'api_key') {
        return { loggedIn: true, authMode: 'api_key' };
      }
      return { loggedIn: false, authMode: 'none' };
    } catch (err: any) {
      this.logger.warn(`GPT 로그인 상태 확인 실패: ${err.message}`);
      return { loggedIn: false, authMode: 'none' };
    }
  }

  importGptAuthJson(authJson: string): { success: boolean; error?: string } {
    try {
      const parsed = JSON.parse(authJson) as {
        auth_mode?: string;
        tokens?: {
          access_token?: string;
          refresh_token?: string;
          account_id?: string;
        };
      };

      if (parsed.auth_mode !== 'chatgpt') {
        return {
          success: false,
          error: 'GPT 구독용 auth.json 이 아닙니다. 로컬에서 ChatGPT로 로그인한 Codex auth.json 이 필요합니다.',
        };
      }
      if (!parsed.tokens?.access_token || !parsed.tokens?.refresh_token) {
        return {
          success: false,
          error: 'auth.json 에 access_token 또는 refresh_token 이 없습니다.',
        };
      }

      const codexHome = this.getCodexHomeDir();
      if (!fs.existsSync(codexHome)) {
        fs.mkdirSync(codexHome, { recursive: true });
      }
      const authPath = path.join(codexHome, 'auth.json');
      fs.writeFileSync(authPath, JSON.stringify(parsed, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      this.clearGptAuthError();
      this.logger.log(`GPT auth.json 저장: ${authPath}`);
      return { success: true };
    } catch (err: any) {
      return { success: false, error: `auth.json 파싱 실패: ${err.message}` };
    }
  }

  /* ── API 키 검증 ── */

  async verifyClaudeApiKey(apiKey: string): Promise<boolean> {
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

  async verifyGptApiKey(apiKey: string): Promise<boolean> {
    try {
      const res = await fetch('https://api.openai.com/v1/models', {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
