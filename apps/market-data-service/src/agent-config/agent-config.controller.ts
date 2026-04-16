import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { Public } from '@alpha-mind/common';
import { AgentConfigService } from './agent-config.service';
import type { AiMeetingProvider } from '../ai-scoring/types/ai-scoring.types';

@Controller('agents')
export class AgentConfigController {
  constructor(private readonly configService: AgentConfigService) {}

  @Public()
  @Get('status')
  getStatus() {
    return this.configService.getStatus();
  }

  @Post('config')
  async saveConfig(
    @Body()
    body: {
      provider?: AiMeetingProvider;
      authMode?: string;
      anthropicApiKey?: string;
      openaiApiKey?: string;
    },
  ) {
    const provider = body.provider ?? 'claude';

    if (provider === 'gpt') {
      if (body.authMode === 'subscription') {
        const login = await this.configService.checkGptCliAuth();
        if (!login.loggedIn) {
          return {
            success: false,
            message: 'GPT 구독 인증이 없습니다. 로컬에서 로그인한 Codex auth.json 을 가져오거나 GPT API 키를 사용하세요.',
          };
        }
        this.configService.saveGptConfig({ authMode: 'subscription' });
        this.configService.clearGptAuthError();
        return { success: true, status: this.configService.getStatus() };
      }

      if (!body.openaiApiKey) {
        return { success: false, message: 'OpenAI API 키를 입력하세요.' };
      }
      const valid = await this.configService.verifyGptApiKey(body.openaiApiKey);
      if (!valid) {
        return { success: false, message: 'OpenAI API 키가 유효하지 않습니다.' };
      }
      this.configService.saveGptConfig({
        authMode: 'api_key',
        openaiApiKey: body.openaiApiKey,
      });
      this.configService.clearGptAuthError();
      return { success: true, status: this.configService.getStatus() };
    }

    if (body.authMode === 'subscription') {
      const config = this.configService.readConfig();
      config.claude.authMode = 'subscription';
      this.configService.saveConfig(config);
      return { success: true, status: this.configService.getStatus() };
    }

    if (!body.anthropicApiKey) {
      return { success: false, message: 'API 키를 입력하세요.' };
    }
    const valid = await this.configService.verifyClaudeApiKey(body.anthropicApiKey);
    if (!valid) {
      return { success: false, message: 'API 키가 유효하지 않습니다.' };
    }
    this.configService.saveClaudeConfig({
      authMode: 'api_key',
      anthropicApiKey: body.anthropicApiKey,
    });
    return { success: true, status: this.configService.getStatus() };
  }

  @Post('verify')
  async verify(
    @Body()
    body: {
      provider?: AiMeetingProvider;
      anthropicApiKey?: string;
      openaiApiKey?: string;
    },
  ) {
    const provider = body.provider ?? 'claude';
    const valid = provider === 'gpt'
      ? await this.configService.verifyGptApiKey(body.openaiApiKey || '')
      : await this.configService.verifyClaudeApiKey(body.anthropicApiKey || '');
    return { valid };
  }

  @Post('gpt/auth/import')
  importGptAuth(@Body() body: { authJson: string }) {
    if (!body.authJson?.trim()) {
      return { success: false, error: 'auth.json 내용을 입력하세요.' };
    }

    const result = this.configService.importGptAuthJson(body.authJson);
    if (!result.success) {
      return result;
    }

    return {
      success: true,
      status: this.configService.getStatus(),
    };
  }

  /** OAuth PKCE 로그인 URL 생성 (Claude 전용) */
  @Post('login')
  startLogin() {
    return this.configService.startOAuthLogin();
  }

  /** 인증 코드 → 토큰 교환 (Claude 전용) */
  @Post('login/code')
  async submitCode(@Body() body: { code: string }) {
    return this.configService.submitOAuthCode(body.code);
  }

  /** CLI 로그인 상태 확인 */
  @Public()
  @Get('login/status')
  async checkLogin(
    @Query('provider') provider?: AiMeetingProvider,
  ) {
    if (provider === 'gpt') {
      return this.configService.checkGptCliAuth();
    }
    return this.configService.checkCliAuth();
  }
}
