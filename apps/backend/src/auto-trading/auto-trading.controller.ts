import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  ParseIntPipe,
  Req,
} from '@nestjs/common';
import { AutoTradingService } from './auto-trading.service';
import { StartSessionDto, StartSessionsDto } from './dto/start-session.dto';
import { AutoTradingSessionEntity } from './entities/auto-trading-session.entity';

@Controller('auto-trading')
export class AutoTradingController {
  constructor(private readonly autoTradingService: AutoTradingService) {}

  /** 단일 세션 시작 */
  @Post('sessions')
  startSession(@Req() req: any, @Body() dto: StartSessionDto) {
    return this.autoTradingService.startSession(req.user.userId, dto);
  }

  /** 복수 세션 일괄 시작 */
  @Post('sessions/batch')
  async startSessions(@Req() req: any, @Body() dto: StartSessionsDto) {
    const results: AutoTradingSessionEntity[] = [];
    for (const sessionDto of dto.sessions) {
      const session = await this.autoTradingService.startSession(
        req.user.userId,
        sessionDto,
      );
      results.push(session);
    }
    return results;
  }

  /** 세션 목록 */
  @Get('sessions')
  getSessions(@Req() req: any) {
    return this.autoTradingService.getSessions(req.user.userId);
  }

  /** 세션 상세 */
  @Get('sessions/:id')
  getSession(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.autoTradingService.getSession(id, req.user.userId);
  }

  /** 일시정지 */
  @Patch('sessions/:id/pause')
  pauseSession(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.autoTradingService.pauseSession(id, req.user.userId);
  }

  /** 재개 */
  @Patch('sessions/:id/resume')
  resumeSession(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.autoTradingService.resumeSession(id, req.user.userId);
  }

  /** 종료 */
  @Delete('sessions/:id')
  stopSession(@Req() req: any, @Param('id', ParseIntPipe) id: number) {
    return this.autoTradingService.stopSession(id, req.user.userId);
  }
}
