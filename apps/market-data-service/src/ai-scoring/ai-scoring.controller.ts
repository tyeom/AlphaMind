import { Controller, Post, Body, Res, Header } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
import { Response } from 'express';
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
