import { Controller, Post, Get, Delete, Body, Res, Param, Header, Req } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { Response, Request } from 'express';
import { AiScoringService } from './ai-scoring.service';
import { AiScoreRequest } from './types/ai-scoring.types';

@Controller('ai-scoring')
export class AiScoringController {
  constructor(private readonly aiScoringService: AiScoringService) {}

  /**
   * SSE 엔드포인트 — 종목별 분석 완료 시마다 이벤트 전송
   *
   * 이벤트 종류:
   *   - progress: 현재 분석 중인 종목 정보
   *   - score:    종목 분석 완료 (개별 점수)
   *   - done:     모든 종목 분석 완료
   *   - error:    오류 발생
   */
  @Post('score-stream')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  @Header('X-Accel-Buffering', 'no')
  async scoreStocksStream(
    @Body() body: AiScoreRequest,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    try {
      // OAuth 토큰 사전 검증 (만료 시 자동 갱신 시도)
      await this.aiScoringService.ensureAuth();

      const startTime = Date.now();

      for (let i = 0; i < body.stocks.length; i++) {
        const stock = body.stocks[i];

        send('progress', {
          current: i + 1,
          total: body.stocks.length,
          stockCode: stock.stockCode,
          stockName: stock.stockName,
          phase: 'starting',
        });

        const score = await this.aiScoringService.scoreSingleStock(stock, (phase) => {
          send('progress', {
            current: i + 1,
            total: body.stocks.length,
            stockCode: stock.stockCode,
            stockName: stock.stockName,
            phase,
          });
        });

        send('score', score);
      }

      send('done', { elapsedMs: Date.now() - startTime });
    } catch (err: any) {
      send('error', { message: err.message || 'AI 분석 중 오류 발생' });
    } finally {
      res.end();
    }
  }

  /** 백그라운드 세션 시작 — sessionId 즉시 반환 */
  @Post('session/start')
  startSession(@Req() req: Request, @Body() body: AiScoreRequest) {
    const userId = (req as any).user?.sub ?? 0;
    const sessionId = this.aiScoringService.startBackgroundSession(body.stocks, userId);
    return { sessionId };
  }

  /** 진행 중인 세션 확인 */
  @Get('session/active')
  getActiveSession(@Req() req: Request) {
    const userId = (req as any).user?.sub ?? 0;
    const session = this.aiScoringService.getActiveSession(userId);
    if (!session) return { active: false };
    return {
      active: true,
      session: {
        id: session.id,
        status: session.status,
        stocks: session.stocks,
        scores: session.scores,
        progress: session.progress,
        startedAt: session.startedAt,
        elapsedMs: Date.now() - session.startedAt,
      },
    };
  }

  /** 세션 상태 SSE 스트리밍 — 진행 중인 세션의 실시간 업데이트 */
  @Get('session/:id/stream')
  @Header('Content-Type', 'text/event-stream')
  @Header('Cache-Control', 'no-cache')
  @Header('Connection', 'keep-alive')
  @Header('X-Accel-Buffering', 'no')
  async streamSession(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const session = this.aiScoringService.getSession(id);
    if (!session) {
      send('error', { message: '세션을 찾을 수 없습니다.' });
      res.end();
      return;
    }

    // 이미 완료된 세션이면 기존 결과를 모두 전송
    if (session.status !== 'running') {
      for (const score of session.scores) {
        send('score', score);
      }
      if (session.status === 'completed') {
        send('done', { elapsedMs: session.elapsedMs });
      } else {
        send('error', { message: session.error || '세션 오류' });
      }
      res.end();
      return;
    }

    // 진행 중인 세션: 이미 완료된 점수 먼저 전송
    let sentScoreCount = session.scores.length;
    for (const score of session.scores) {
      send('score', score);
    }

    let closed = false;
    res.on('close', () => { closed = true; });

    const pollInterval = setInterval(() => {
      if (closed) {
        clearInterval(pollInterval);
        return;
      }

      // 새로 완료된 점수 전송
      while (sentScoreCount < session.scores.length) {
        send('score', session.scores[sentScoreCount]);
        sentScoreCount++;
      }

      // 진행 상황 전송
      if (session.progress) {
        send('progress', session.progress);
      }

      // 완료 / 에러 / 취소
      if (session.status === 'completed') {
        send('done', { elapsedMs: session.elapsedMs });
        clearInterval(pollInterval);
        res.end();
      } else if (session.status === 'cancelled') {
        send('cancelled', { elapsedMs: session.elapsedMs, completedCount: session.scores.length });
        clearInterval(pollInterval);
        res.end();
      } else if (session.status === 'error') {
        send('error', { message: session.error || '세션 오류' });
        clearInterval(pollInterval);
        res.end();
      }
    }, 1000);
  }

  /** 세션 상태 조회 (polling) */
  @Get('session/:id')
  getSession(@Param('id') id: string) {
    const session = this.aiScoringService.getSession(id);
    if (!session) return { found: false };
    return {
      found: true,
      session: {
        id: session.id,
        status: session.status,
        stocks: session.stocks,
        scores: session.scores,
        progress: session.progress,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        elapsedMs: session.status === 'running'
          ? Date.now() - session.startedAt
          : session.elapsedMs,
        error: session.error,
      },
    };
  }

  /** 세션 취소 */
  @Delete('session/:id')
  cancelSession(@Param('id') id: string) {
    const cancelled = this.aiScoringService.cancelSession(id);
    return { cancelled };
  }

  /** 기존 동기 HTTP 엔드포인트 (소수 종목용) */
  @Post('score')
  scoreStocks(@Body() body: AiScoreRequest) {
    return this.aiScoringService.scoreStocks(body.stocks);
  }

  /** RMQ 메시지 패턴 */
  @MessagePattern('ai_scoring.score')
  scoreStocksRmq(@Payload() body: AiScoreRequest) {
    return this.aiScoringService.scoreStocks(body.stocks);
  }
}
