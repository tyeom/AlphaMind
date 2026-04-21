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
  ManualOrderDto,
} from './dto/start-session.dto';
import { User } from '../decorator/user.decorator';

@Controller('auto-trading')
export class AutoTradingController {
  constructor(private readonly autoTradingService: AutoTradingService) {}

  /**
   * 전역 ValidationPipe/whitelist 없이도 공개 API 에서 `scheduledScan` 주입이
   * 저장 경로로 흘러가지 않도록 런타임에서 명시적으로 제거한다.
   */
  private sanitizeStartSessionDto(dto: StartSessionDto): StartSessionDto {
    const { scheduledScan: _scheduledScan, ...sanitized } = dto as StartSessionDto & {
      scheduledScan?: boolean;
    };
    return sanitized;
  }

  /** 단일 세션 시작 */
  @Post('sessions')
  startSession(@User() user: any, @Body() dto: StartSessionDto) {
    return this.autoTradingService.startSession(
      user.sub,
      this.sanitizeStartSessionDto(dto),
    );
  }

  /** 복수 세션 일괄 시작 */
  @Post('sessions/batch')
  startSessions(@User() user: any, @Body() dto: StartSessionsDto) {
    return this.autoTradingService.startSessions(user.sub, {
      ...dto,
      sessions: dto.sessions.map((sessionDto) =>
        this.sanitizeStartSessionDto(sessionDto),
      ),
    });
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

  /**
   * 설정 수정 — 전략/목표수익/손절 변경.
   * 사용자가 UI 에서 수동 수정하는 경로이므로 `scheduledScan` 플래그를 항상 false 로
   * 강제해 스케줄러 자동 등록 표식을 해제한다 (클라이언트가 보낸 값은 무시).
   */
  @Patch('sessions/:id')
  updateSession(
    @User() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateSessionDto,
  ) {
    return this.autoTradingService.updateSession(id, user.sub, {
      ...dto,
      scheduledScan: false,
    });
  }

  /** 수동 매수/매도 */
  @Post('sessions/:id/order')
  manualOrder(
    @User() user: any,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: ManualOrderDto,
  ) {
    return this.autoTradingService.executeManualOrder(id, user.sub, dto);
  }

  /** 종료 */
  @Delete('sessions/:id')
  stopSession(@User() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.autoTradingService.stopSession(id, user.sub);
  }

  /** 완전 삭제 — 종료(STOPPED) 상태 세션만 가능 */
  @Delete('sessions/:id/permanent')
  deleteSession(@User() user: any, @Param('id', ParseIntPipe) id: number) {
    return this.autoTradingService.deleteSession(id, user.sub);
  }
}
