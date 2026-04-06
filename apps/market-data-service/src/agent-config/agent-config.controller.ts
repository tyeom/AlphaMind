import { Controller, Get, Post, Body } from '@nestjs/common';
import { Public } from '@alpha-mind/common';
import { AgentConfigService } from './agent-config.service';

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
    @Body() body: { authMode?: string; anthropicApiKey?: string },
  ) {
    if (body.authMode === 'subscription') {
      this.configService.saveConfig({ authMode: 'subscription' });
      return { success: true, status: this.configService.getStatus() };
    }

    if (!body.anthropicApiKey) {
      return { success: false, message: 'API 키를 입력하세요.' };
    }
    const valid = await this.configService.verifyApiKey(body.anthropicApiKey);
    if (!valid) {
      return { success: false, message: 'API 키가 유효하지 않습니다.' };
    }
    this.configService.saveConfig({
      authMode: 'api_key',
      anthropicApiKey: body.anthropicApiKey,
    });
    return { success: true, status: this.configService.getStatus() };
  }

  @Post('verify')
  async verify(@Body() body: { anthropicApiKey: string }) {
    const valid = await this.configService.verifyApiKey(body.anthropicApiKey);
    return { valid };
  }

  /** OAuth PKCE 로그인 URL 생성 (CLI 사용 안 함) */
  @Post('login')
  startLogin() {
    return this.configService.startOAuthLogin();
  }

  /** 인증 코드 → 토큰 교환 (HTTP 직접 교환, CLI 사용 안 함) */
  @Post('login/code')
  async submitCode(@Body() body: { code: string }) {
    return this.configService.submitOAuthCode(body.code);
  }

  /** OAuth 토큰 유효 여부 확인 */
  @Public()
  @Get('login/status')
  async checkLogin() {
    return this.configService.checkCliAuth();
  }
}
