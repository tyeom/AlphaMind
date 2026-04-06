import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  ParseIntPipe,
} from '@nestjs/common';
import { AutoTradingService } from './auto-trading.service';
import {
  StartSessionDto,
  StartSessionsDto,
  UpdateSessionDto,
} from './dto/start-session.dto';
import { User } from '../decorator/user.decorator';

@Controller('auto-trading')
export class AutoTradingController {
  constructor(private readonly autoTradingService: AutoTradingService) {}

  /** 단일 세션 시작 */
  @Post('sessions')
  startSession(@User() user: any, @Body() dto: StartSessionDto) {
    return this.autoTradingService.startSession(user.sub, dto);
  }

  /** 복수 세션 일괄 시작 */
  @Post('sessions/batch')
  startSessions(@User() user: any, @Body() dto: StartSessionsDto) {
    return this.autoTradingService.startSessions(user.sub, dto);
  }

  /** 세션 목록 */
  @Get('sessions')
  getSessions(@User() user: any) {
    return this.autoTradingService.getSessions(user.sub);
  }

  /** 세션 상세 */
  @Get('sessions/:id')
  getSession(@User() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.autoTradingService.getSession(id, user.sub);
  }

  /** 일시정지 */
  @Patch('sessions/:id/pause')
  pauseSession(@User() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.autoTradingService.pauseSession(id, user.sub);
  }

  /** 재개 */
  @Patch('sessions/:id/resume')
  resumeSession(@User() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.autoTradingService.resumeSession(id, user.sub);
  }

  /** 설정 수정 — 전략/목표수익/손절 변경 */
  @Patch('sessions/:id')
  updateSession(
    @User() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSessionDto,
  ) {
    return this.autoTradingService.updateSession(id, user.sub, dto);
  }

  /** 종료 */
  @Delete('sessions/:id')
  stopSession(@User() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.autoTradingService.stopSession(id, user.sub);
  }
}
