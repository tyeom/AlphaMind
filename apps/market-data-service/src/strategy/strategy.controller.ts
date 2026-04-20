import { Controller, Get, Post, Body, Param, Query } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';
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

@Controller('strategies')
export class StrategyController {
  constructor(
    private readonly strategyService: StrategyService,
    private readonly backtestService: BacktestService,
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
    );
  }

  /** 전 종목 스캔 — Top N 추출 (RMQ) */
  @MessagePattern('strategy.scan')
  scanStocksRmq(@Payload() body: ScanBodyDto) {
    return this.backtestService.scanAllStocks(
      body.excludeCodes ?? [],
      body.topN ?? 10,
      body.investmentAmount ?? 10_000_000,
      body.tradeRatioPct ?? 10,
      body.commissionPct ?? 0.015,
    );
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
      investmentAmount: parseFloat(query.investmentAmount || '') || 10_000_000,
      tradeRatioPct: parseFloat(query.tradeRatioPct || '') || 10,
      commissionPct: parseFloat(query.commissionPct || '') || 0.015,
    });
  }
}
