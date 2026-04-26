import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  Inject,
  Logger,
} from '@nestjs/common';
import {
  ClientProxy,
  EventPattern,
  MessagePattern,
  Payload,
} from '@nestjs/microservices';
import { Public } from '@alpha-mind/common';
import { firstValueFrom } from 'rxjs';
import { StrategyService } from './strategy.service';
import { BacktestService } from './backtest.service';
import { WeeklyOptimizerService } from './weekly-optimizer.service';
import {
  DayTradingQueryDto,
  MeanReversionQueryDto,
  InfinityBotQueryDto,
  CandlePatternQueryDto,
} from './dto/strategy-query.dto';
import { BacktestQueryDto } from './dto/backtest-query.dto';
import { ScanBodyDto } from './dto/scan-query.dto';
import { BACKEND_SERVICE } from '../rmq/rmq.module';

const SCAN_RESULT_EMIT_MAX_ATTEMPTS = 10;
const SCAN_RESULT_EMIT_RETRY_DELAY_MS = 1000;

function parseNumberOrDefault(
  value: string | undefined,
  defaultValue: number,
): number {
  if (value == null || value.trim() === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function parseBooleanOptional(value: string | undefined): boolean | undefined {
  if (value == null || value.trim() === '') {
    return undefined;
  }

  return value === 'true';
}

@Controller('strategies')
export class StrategyController {
  private readonly logger = new Logger(StrategyController.name);

  constructor(
    private readonly strategyService: StrategyService,
    private readonly backtestService: BacktestService,
    private readonly weeklyOptimizerService: WeeklyOptimizerService,
    @Inject(BACKEND_SERVICE) private readonly backendClient: ClientProxy,
  ) {}

  private getErrorMessage(err: unknown): string {
    if (err instanceof Error) {
      return err.message;
    }
    return String(err);
  }

  private isRetryableEmitError(err: unknown): boolean {
    const message = this.getErrorMessage(err).toLowerCase();
    return (
      message.includes('connection lost') ||
      message.includes('trying to reconnect') ||
      message.includes('disconnected') ||
      message.includes('channel closed') ||
      message.includes('socket closed') ||
      message.includes('econnreset')
    );
  }

  private async wait(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async emitBackendEventWithRetry(
    pattern: 'strategy.scan.completed' | 'strategy.scan.failed',
    payload: Record<string, unknown>,
    requestId: string,
  ): Promise<void> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= SCAN_RESULT_EMIT_MAX_ATTEMPTS; attempt++) {
      try {
        await firstValueFrom(this.backendClient.emit(pattern, payload), {
          defaultValue: undefined,
        });
        if (attempt > 1) {
          this.logger.log(
            `${pattern} 전송 재시도 성공 requestId=${requestId} attempt=${attempt}`,
          );
        }
        return;
      } catch (err: unknown) {
        lastError = err;
        const message = this.getErrorMessage(err);
        const retryable = this.isRetryableEmitError(err);

        if (!retryable || attempt === SCAN_RESULT_EMIT_MAX_ATTEMPTS) {
          throw err;
        }

        this.logger.warn(
          `${pattern} 전송 재시도 대기 requestId=${requestId} attempt=${attempt}/${SCAN_RESULT_EMIT_MAX_ATTEMPTS}: ${message}`,
        );
        await this.wait(SCAN_RESULT_EMIT_RETRY_DELAY_MS);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /** 사용 가능한 전략 목록 */
  @Get()
  listStrategies() {
    return this.strategyService.getAvailableStrategies();
  }

  /** 전체 전략 종합 분석 */
  @Get(':code/analyze')
  analyzeAll(@Param('code') code: string) {
    return this.strategyService.analyzeAll(code);
  }

  /** Day Trading 분석 */
  @Get(':code/day-trading')
  analyzeDayTrading(
    @Param('code') code: string,
    @Query() query: DayTradingQueryDto,
  ) {
    return this.strategyService.analyzeDayTrading(code, {
      variant: query.variant,
      breakout: {
        kFactor: parseFloat(query.kFactor!) || 0.5,
        lookbackPeriod: parseInt(query.lookbackPeriod!) || 1,
      },
      crossover: {
        shortPeriod: parseInt(query.shortPeriod!) || 10,
        longPeriod: parseInt(query.longPeriod!) || 20,
      },
      volumeSurge: {
        volumeMultiplier: parseFloat(query.volumeMultiplier!) || 2.0,
        volumePeriod: parseInt(query.volumePeriod!) || 20,
        consecutiveUpCandles: parseInt(query.consecutiveUpCandles!) || 3,
        rsiOverbought: parseFloat(query.rsiOverbought!) || 80,
        rsiPeriod: 14,
      },
    });
  }

  /** Mean Reversion 분석 */
  @Get(':code/mean-reversion')
  analyzeMeanReversion(
    @Param('code') code: string,
    @Query() query: MeanReversionQueryDto,
  ) {
    return this.strategyService.analyzeMeanReversion(code, {
      variant: query.variant,
      rsi: {
        period: parseInt(query.rsiPeriod!) || 14,
        oversold: parseFloat(query.oversold!) || 30,
        overbought: parseFloat(query.overbought!) || 70,
      },
      bollinger: {
        period: parseInt(query.bbPeriod!) || 20,
        stdMultiplier: parseFloat(query.stdMultiplier!) || 2.0,
      },
      grid: {
        spacingPct: parseFloat(query.spacingPct!) || 1.0,
        levels: parseInt(query.gridLevels!) || 5,
      },
    });
  }

  /** Infinity Bot 시뮬레이션 */
  @Get(':code/infinity-bot')
  analyzeInfinityBot(
    @Param('code') code: string,
    @Query() query: InfinityBotQueryDto,
  ) {
    return this.strategyService.analyzeInfinityBot(code, {
      ...(query.totalAmount && { totalAmount: parseFloat(query.totalAmount) }),
      ...(query.maxRounds && { maxRounds: parseInt(query.maxRounds) }),
      ...(query.roundPct && { roundPct: parseFloat(query.roundPct) }),
      ...(query.dipTriggerPct && {
        dipTriggerPct: parseFloat(query.dipTriggerPct),
      }),
      ...(query.takeProfitPct && {
        takeProfitPct: parseFloat(query.takeProfitPct),
      }),
    });
  }

  /** Candle Pattern 인식 */
  @Get(':code/candle-pattern')
  analyzeCandlePattern(
    @Param('code') code: string,
    @Query() query: CandlePatternQueryDto,
  ) {
    return this.strategyService.analyzeCandlePattern(code, {
      ...(query.minPatternStrength && {
        minPatternStrength: parseFloat(query.minPatternStrength),
      }),
      ...(query.useVolumeConfirmation != null && {
        useVolumeConfirmation: query.useVolumeConfirmation === 'true',
      }),
      ...(query.useTrendConfirmation != null && {
        useTrendConfirmation: query.useTrendConfirmation === 'true',
      }),
      ...(query.trendPeriod && { trendPeriod: parseInt(query.trendPeriod) }),
    });
  }

  /** Momentum Power (Snow) 분석 */
  @Get(':code/momentum-power')
  analyzeMomentumPower(@Param('code') code: string) {
    return this.strategyService.analyzeMomentumPower(code);
  }

  /** Momentum Surge (레버리지/인버스 ETF) 분석 */
  @Get(':code/momentum-surge')
  analyzeMomentumSurge(@Param('code') code: string) {
    return this.strategyService.analyzeMomentumSurge(code);
  }

  /**
   * 전 종목 스캔 — Top N 추출 (HTTP).
   * body 에서 TP/SL 미지정 시 그리드 서치 결과(`getActiveShortTermTpSl`) 자동 적용.
   * minTotalTrades 도 walk-forward 기준(in-sample 5 + OOS 5)에 맞춰 10 으로 통일.
   */
  @Post('scan')
  async scanStocks(@Body() body: ScanBodyDto) {
    const optimal = await this.backtestService.getActiveShortTermTpSl();
    return this.backtestService.scanAllStocks(
      body.excludeCodes ?? [],
      body.topN ?? 10,
      body.investmentAmount ?? 10_000_000,
      body.tradeRatioPct ?? 10,
      body.commissionPct ?? 0.015,
      body.autoTakeProfitPct ?? optimal.tpPct,
      body.autoStopLossPct ?? optimal.slPct,
      body.maxHoldingDays ?? 7,
      body.minCurrentSignalStrength ?? 0.6,
      body.minTotalTrades ?? 10,
    );
  }

  /**
   * 전 종목 스캔 요청 (RMQ event, fire-and-forget)
   * - 백엔드가 `strategy.scan.request` 이벤트를 emit하면 비동기로 처리
   * - 완료/실패 결과는 `strategy.scan.completed` / `strategy.scan.failed` 이벤트로 백엔드에 통지
   * - RPC 응답 대기 없이 실행되므로 긴 스캔이 RMQ heartbeat/채널을 블록하지 않는다
   */
  @Public()
  @EventPattern('strategy.scan.request')
  async handleScanRequest(
    @Payload() body: ScanBodyDto & { userId: number; requestId: string },
  ): Promise<void> {
    const { userId, requestId } = body;
    this.logger.log(
      `scan.request 수신 userId=${userId} requestId=${requestId} exclude=${body.excludeCodes?.length ?? 0}`,
    );

    let response;
    try {
      response = await this.backtestService.scanAllStocks(
        body.excludeCodes ?? [],
        body.topN ?? 10,
        body.investmentAmount ?? 10_000_000,
        body.tradeRatioPct ?? 10,
        body.commissionPct ?? 0.015,
        body.autoTakeProfitPct ?? 2.5,
        body.autoStopLossPct ?? -3,
        body.maxHoldingDays ?? 7,
        body.minCurrentSignalStrength ?? 0.6,
        body.minTotalTrades ?? 3,
      );
    } catch (err: any) {
      const message = this.getErrorMessage(err);
      this.logger.error(
        `scan.request 실패 userId=${userId} requestId=${requestId}: ${message}`,
      );
      try {
        await this.emitBackendEventWithRetry(
          'strategy.scan.failed',
          {
            userId,
            requestId,
            error: message,
          },
          requestId,
        );
      } catch (notifyErr: any) {
        this.logger.error(
          `scan.failed 전송 실패 userId=${userId} requestId=${requestId}: ${this.getErrorMessage(notifyErr)}`,
        );
      }
      return;
    }

    try {
      await this.emitBackendEventWithRetry(
        'strategy.scan.completed',
        {
          userId,
          requestId,
          response,
        },
        requestId,
      );
      this.logger.log(
        `scan.completed 전송 userId=${userId} requestId=${requestId} results=${response.results.length}`,
      );
    } catch (err: any) {
      this.logger.error(
        `scan.completed 전송 실패 userId=${userId} requestId=${requestId}: ${this.getErrorMessage(err)}`,
      );
    }
  }

  /** 단일 종목 추천 전략 (RMQ) — 단기 전략 백테스트 후 위험조정 최고 전략 반환 */
  @MessagePattern('strategy.recommend')
  recommendStrategyRmq(
    @Payload()
    body: {
      stockCode: string;
      investmentAmount?: number;
      tradeRatioPct?: number;
      commissionPct?: number;
      autoTakeProfitPct?: number;
      autoStopLossPct?: number;
      maxHoldingDays?: number;
    },
  ) {
    return this.backtestService.recommendStrategy(
      body.stockCode,
      body.investmentAmount,
      body.tradeRatioPct,
      body.commissionPct,
      body.autoTakeProfitPct,
      body.autoStopLossPct,
      body.maxHoldingDays,
    );
  }

  /**
   * 단타용 최적 TP/SL 조회 (RMQ) — ScheduledScannerService 가 스캔 직전 호출.
   * 영속화된 그리드 서치 결과가 있으면 그 값을, 없으면 fallback 기본값을 반환.
   */
  @MessagePattern('strategy.optimal-params')
  getOptimalShortTermTpSlRmq() {
    return this.backtestService.getActiveShortTermTpSl();
  }

  /**
   * TP/SL 그리드 서치 트리거.
   * - 표본 종목 × (tpRange × slRange) 조합을 walk-forward 백테스트해 최적 TP/SL 산출.
   * - 결과는 data/optimal_params.json 에 영속화되어 다음 스캔부터 자동 적용.
   */
  @Post('optimize-tp-sl')
  async optimizeTpSl(
    @Body()
    body: {
      tpRange?: number[];
      slRange?: number[];
      stockSampleSize?: number;
      investmentAmount?: number;
      maxHoldingDays?: number;
    },
  ) {
    return this.backtestService.gridSearchOptimalTpSl(body ?? {});
  }

  /**
   * 현재 적용 중인 단타 TP/SL (HTTP) — 프론트 입력 폼 초기값 주입에 사용.
   * 그리드 서치 결과가 있으면 그 값, 없으면 코드 기본값(source='default').
   */
  @Get('optimal-params/short-term-tp-sl')
  getOptimalShortTermTpSl() {
    return this.backtestService.getActiveShortTermTpSl();
  }

  /**
   * 주간 자동 최적화를 지금 즉시 실행 (cron 대기 없이) — 첫 적용 / 임시 재계산용.
   * cron 동일 로직을 호출하므로 결과는 data/optimal_params.json + history 파일에 동일하게 기록.
   */
  @Post('optimize-tp-sl/run-weekly-now')
  runWeeklyOptimizerNow() {
    return this.weeklyOptimizerService.runOptimization('manual');
  }

  /** 백테스팅 */
  @Get(':code/backtest')
  runBacktest(@Param('code') code: string, @Query() query: BacktestQueryDto) {
    const allowAddOnBuy = parseBooleanOptional(query.allowAddOnBuy);
    const useNextOpenForBuy = parseBooleanOptional(query.useNextOpenForBuy);

    return this.backtestService.runBacktest(code, {
      strategyId: query.strategyId,
      variant: query.variant,
      investmentAmount: parseNumberOrDefault(
        query.investmentAmount,
        10_000_000,
      ),
      tradeRatioPct: parseNumberOrDefault(query.tradeRatioPct, 10),
      commissionPct: parseNumberOrDefault(query.commissionPct, 0.015),
      autoTakeProfitPct: parseNumberOrDefault(query.autoTakeProfitPct, 2.5),
      autoStopLossPct: parseNumberOrDefault(query.autoStopLossPct, -3),
      maxHoldingDays: parseNumberOrDefault(query.maxHoldingDays, 7),
      sellTaxPct: parseNumberOrDefault(query.sellTaxPct, 0.18),
      slippagePct: parseNumberOrDefault(query.slippagePct, 0.05),
      ...(allowAddOnBuy !== undefined && { allowAddOnBuy }),
      ...(useNextOpenForBuy !== undefined && { useNextOpenForBuy }),
    });
  }
}
