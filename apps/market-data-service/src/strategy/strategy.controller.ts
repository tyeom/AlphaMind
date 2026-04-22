import { Controller, Get, Post, Body, Param, Query, Inject, Logger } from '@nestjs/common';
import { ClientProxy, EventPattern, MessagePattern, Payload } from '@nestjs/microservices';
import { Public } from '@alpha-mind/common';
import { StrategyService } from './strategy.service';
import { BacktestService } from './backtest.service';
import {
  DayTradingQueryDto,
  MeanReversionQueryDto,
  InfinityBotQueryDto,
  CandlePatternQueryDto,
} from './dto/strategy-query.dto';
import { BacktestQueryDto } from './dto/backtest-query.dto';
import { ScanBodyDto } from './dto/scan-query.dto';
import { BACKEND_SERVICE } from '../rmq/rmq.module';

function parseNumberOrDefault(value: string | undefined, defaultValue: number): number {
  if (value == null || value.trim() === '') {
    return defaultValue;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

@Controller('strategies')
export class StrategyController {
  private readonly logger = new Logger(StrategyController.name);

  constructor(
    private readonly strategyService: StrategyService,
    private readonly backtestService: BacktestService,
    @Inject(BACKEND_SERVICE) private readonly backendClient: ClientProxy,
  ) {}

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
      ...(query.dipTriggerPct && { dipTriggerPct: parseFloat(query.dipTriggerPct) }),
      ...(query.takeProfitPct && { takeProfitPct: parseFloat(query.takeProfitPct) }),
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

  /** 전 종목 스캔 — Top N 추출 (HTTP) */
  @Post('scan')
  scanStocks(@Body() body: ScanBodyDto) {
    return this.backtestService.scanAllStocks(
      body.excludeCodes ?? [],
      body.topN ?? 10,
      body.investmentAmount ?? 10_000_000,
      body.tradeRatioPct ?? 10,
      body.commissionPct ?? 0.015,
      body.autoTakeProfitPct ?? 5,
      body.autoStopLossPct ?? -3,
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
    try {
      const response = await this.backtestService.scanAllStocks(
        body.excludeCodes ?? [],
        body.topN ?? 10,
        body.investmentAmount ?? 10_000_000,
        body.tradeRatioPct ?? 10,
        body.commissionPct ?? 0.015,
        body.autoTakeProfitPct ?? 5,
        body.autoStopLossPct ?? -3,
      );
      this.backendClient.emit('strategy.scan.completed', {
        userId,
        requestId,
        response,
      });
      this.logger.log(
        `scan.completed 전송 userId=${userId} requestId=${requestId} results=${response.results.length}`,
      );
    } catch (err: any) {
      const message = err?.message ?? String(err);
      this.logger.error(
        `scan.request 실패 userId=${userId} requestId=${requestId}: ${message}`,
      );
      this.backendClient.emit('strategy.scan.failed', {
        userId,
        requestId,
        error: message,
      });
    }
  }

  /** 단일 종목 추천 전략 (RMQ) — 4개 전략 백테스트 후 최고 수익률 전략 반환 */
  @MessagePattern('strategy.recommend')
  recommendStrategyRmq(
    @Payload()
    body: {
      stockCode: string;
      investmentAmount?: number;
      tradeRatioPct?: number;
      commissionPct?: number;
    },
  ) {
    return this.backtestService.recommendStrategy(
      body.stockCode,
      body.investmentAmount,
      body.tradeRatioPct,
      body.commissionPct,
    );
  }

  /** 백테스팅 */
  @Get(':code/backtest')
  runBacktest(
    @Param('code') code: string,
    @Query() query: BacktestQueryDto,
  ) {
    return this.backtestService.runBacktest(code, {
      strategyId: query.strategyId,
      variant: query.variant,
      investmentAmount: parseNumberOrDefault(query.investmentAmount, 10_000_000),
      tradeRatioPct: parseNumberOrDefault(query.tradeRatioPct, 10),
      commissionPct: parseNumberOrDefault(query.commissionPct, 0.015),
      autoTakeProfitPct: parseNumberOrDefault(query.autoTakeProfitPct, 5),
      autoStopLossPct: parseNumberOrDefault(query.autoStopLossPct, -3),
    });
  }
}
