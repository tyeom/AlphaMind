import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { AppService } from './app.service';
import { Public } from '@alpha-mind/common';

@ApiTags('App')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Public()
  @Get()
  @ApiOperation({ summary: '헬스체크' })
  getHello(): string {
    return this.appService.getHello();
  }

  @Public()
  @Get('time')
  @ApiOperation({ summary: '서버 현재 시간 조회' })
  getServerTime() {
    const now = new Date();
    return {
      timestamp: now.toISOString(),
      epoch: now.getTime(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }
}
