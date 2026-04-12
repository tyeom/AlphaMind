import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { Stock } from '../stock/entities/stock.entity';
import { StockDailyPrice } from '../stock/entities/stock-daily-price.entity';
import {
  CandleData,
  DayTradingVariant,
  MeanReversionVariant,
  Signal,
  SignalDirection,
  StrategyAnalysisResult,
  analyzeDayTrading,
  analyzeMeanReversion,
  analyzeInfinityBot,
  analyzeCandlePattern,
} from '@alpha-mind/strategies';
import { BacktestConfig, BacktestResult, BacktestTrade } from './types/backtest.types';
import { ScanResult, ScanResponse } from './types/scan.types';
import { Logger } from '@nestjs/common';

/** 타임존 안전한 날짜 키 (YYYY-MM-DD, 로컬 기준) */
function toDateKey(d: Date): string {
  const date = new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 자동 익절/손절 기본 설정 */
const AUTO_TAKE_PROFIT_PCT = 5; // 5% 이상 수익 시 자동 익절
const AUTO_STOP_LOSS_PCT = -3;  // -3% 이하 손실 시 자동 손절

const STRATEGY_MAP: Record<string, { name: string; analyze: (candles: CandleData[], config?: any) => StrategyAnalysisResult }> = {
  'day-trading': { name: '일간 모멘텀 통합 전략', analyze: analyzeDayTrading },
  'mean-reversion': { name: '평균회귀 전략', analyze: analyzeMeanReversion },
  'infinity-bot': { name: '무한매수봇', analyze: analyzeInfinityBot },
  'candle-pattern': { name: '캔들 패턴 인식', analyze: analyzeCandlePattern },
};

/**
 * 전략별 평가 대상 variant 목록.
 * variant 가 없는 전략은 [undefined] 단일 항목으로 처리해 루프를 일관되게 유지한다.
 */
const STRATEGY_VARIANTS: Record<string, (string | undefined)[]> = {
  'day-trading': [
    DayTradingVariant.Breakout,
    DayTradingVariant.Crossover,
    DayTradingVariant.VolumeSurge,
  ],
  'mean-reversion': [
    MeanReversionVariant.RSI,
    MeanReversionVariant.Bollinger,
    MeanReversionVariant.Grid,
    MeanReversionVariant.MagicSplit,
  ],
  'infinity-bot': [undefined],
  'candle-pattern': [undefined],
};

@Injectable()
export class BacktestService {
  constructor(private readonly em: EntityManager) {}

  async runBacktest(code: string, config: BacktestConfig): Promise<BacktestResult> {
    const strategy = STRATEGY_MAP[config.strategyId];
    if (!strategy) {
      throw new BadRequestException(
        `알 수 없는 전략: ${config.strategyId}. 사용 가능: ${Object.keys(STRATEGY_MAP).join(', ')}`,
      );
    }

    const { stock, candles } = await this.loadCandles(code);

    // 전략 분석으로 신호 추출
    const strategyConfig = config.variant ? { variant: config.variant } : {};
    const analysis = strategy.analyze(candles, strategyConfig);
    const signals = analysis.signals;

    // SELL 신호 존재 여부 확인
    const hasSellSignals = signals.some((s) => s.direction === SignalDirection.Sell);

    // 신호를 날짜 기준 Map으로 변환 (로컬 타임존 안전)
    const signalByDate = new Map<string, Signal>();
    for (const signal of signals) {
      signalByDate.set(toDateKey(signal.date), signal);
    }

    // 시뮬레이션 실행
    return this.simulate(stock, candles, signalByDate, config, strategy.name, hasSellSignals);
  }

  private simulate(
    stock: Stock,
    candles: CandleData[],
    signalByDate: Map<string, Signal>,
    config: BacktestConfig,
    strategyName: string,
    hasSellSignals: boolean,
  ): BacktestResult {
    let cash = config.investmentAmount;
    let quantity = 0;
    let avgBuyPrice = 0;
    const trades: BacktestTrade[] = [];
    let totalRealizedPnl = 0;
    let winTrades = 0;
    let lossTrades = 0;

    // MDD 계산용
    let peakValue = config.investmentAmount;
    let maxDrawdownPct = 0;

    const tradeAmount = config.investmentAmount * (config.tradeRatioPct / 100);
    const commissionRate = config.commissionPct / 100;

    for (const candle of candles) {
      const dateKey = toDateKey(candle.date);
      const signal = signalByDate.get(dateKey);

      // 보유 중이고 SELL 신호가 없는 전략일 때: 자동 익절/손절 체크
      if (!hasSellSignals && quantity > 0 && avgBuyPrice > 0) {
        const returnPct = ((candle.close - avgBuyPrice) / avgBuyPrice) * 100;
        if (returnPct >= AUTO_TAKE_PROFIT_PCT || returnPct <= AUTO_STOP_LOSS_PCT) {
          const sellAmount = quantity * candle.close;
          const commission = sellAmount * commissionRate;
          const pnl = (candle.close - avgBuyPrice) * quantity - commission;

          totalRealizedPnl += pnl;
          if (pnl > 0) winTrades++;
          else lossTrades++;

          cash += sellAmount - commission;

          const reason = returnPct >= AUTO_TAKE_PROFIT_PCT
            ? `자동 익절 (수익률 ${returnPct.toFixed(1)}%)`
            : `자동 손절 (수익률 ${returnPct.toFixed(1)}%)`;

          trades.push({
            date: candle.date,
            direction: SignalDirection.Sell,
            price: candle.close,
            quantity,
            amount: sellAmount,
            commission,
            reason,
            realizedPnl: pnl,
          });

          quantity = 0;
          avgBuyPrice = 0;
          // 같은 날 재매수 방지
          continue;
        }
      }

      if (signal && signal.direction === SignalDirection.Buy && signal.strength >= 0.3) {
        // 매수: tradeAmount 만큼 매수 (현금 충분 시)
        const buyAmount = Math.min(tradeAmount, cash);
        if (buyAmount > 0) {
          const qty = Math.floor(buyAmount / candle.close);

          if (qty > 0) {
            const cost = qty * candle.close;
            const actualCommission = cost * commissionRate;

            // 평균 매수가 갱신
            const totalCost = avgBuyPrice * quantity + cost;
            quantity += qty;
            avgBuyPrice = totalCost / quantity;

            cash -= cost + actualCommission;

            trades.push({
              date: candle.date,
              direction: SignalDirection.Buy,
              price: candle.close,
              quantity: qty,
              amount: cost,
              commission: actualCommission,
              reason: signal.reason,
            });
          }
        }
      } else if (signal && signal.direction === SignalDirection.Sell && signal.strength >= 0.3) {
        // 매도: 보유 수량 전체 매도
        if (quantity > 0) {
          const sellAmount = quantity * candle.close;
          const commission = sellAmount * commissionRate;
          const pnl = (candle.close - avgBuyPrice) * quantity - commission;

          totalRealizedPnl += pnl;
          if (pnl > 0) winTrades++;
          else lossTrades++;

          cash += sellAmount - commission;

          trades.push({
            date: candle.date,
            direction: SignalDirection.Sell,
            price: candle.close,
            quantity,
            amount: sellAmount,
            commission,
            reason: signal.reason,
            realizedPnl: pnl,
          });

          quantity = 0;
          avgBuyPrice = 0;
        }
      }

      // MDD 계산
      const currentValue = cash + quantity * candle.close;
      if (currentValue > peakValue) {
        peakValue = currentValue;
      }
      const drawdown = ((peakValue - currentValue) / peakValue) * 100;
      if (drawdown > maxDrawdownPct) {
        maxDrawdownPct = drawdown;
      }
    }

    const lastPrice = candles[candles.length - 1].close;
    const holdingValue = quantity * lastPrice;
    const finalValue = cash + holdingValue;
    const unrealizedPnl = quantity > 0 ? (lastPrice - avgBuyPrice) * quantity : 0;
    const totalReturnPct = ((finalValue - config.investmentAmount) / config.investmentAmount) * 100;
    const totalTrades = trades.filter((t) => t.direction === SignalDirection.Sell).length;

    return {
      stockCode: stock.code,
      stockName: stock.name,
      strategyId: config.strategyId,
      strategyName,
      variant: config.variant,
      period: {
        from: candles[0].date,
        to: candles[candles.length - 1].date,
      },
      investmentAmount: config.investmentAmount,
      finalValue: Math.round(finalValue),
      totalReturnPct: Math.round(totalReturnPct * 100) / 100,
      totalRealizedPnl: Math.round(totalRealizedPnl),
      unrealizedPnl: Math.round(unrealizedPnl),
      totalTrades,
      winTrades,
      lossTrades,
      winRate: totalTrades > 0 ? Math.round((winTrades / totalTrades) * 10000) / 100 : 0,
      maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
      remainingCash: Math.round(cash),
      remainingQuantity: quantity,
      trades,
    };
  }

  /** 전 종목 스캔: 4가지 전략으로 백테스팅 후 Top N 추출 */
  async scanAllStocks(
    excludeCodes: string[],
    topN: number,
    investmentAmount: number,
    tradeRatioPct: number,
    commissionPct: number,
  ): Promise<ScanResponse> {
    const logger = new Logger('BacktestService');
    const startTime = Date.now();

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    // 1. 전체 종목 로드
    const allStocks = await this.em.find(Stock, {});
    const excludeSet = new Set(excludeCodes);

    // 2. 3개월 데이터가 20일 이상인 종목만 필터 (벌크 카운트 쿼리)
    const knex = this.em.getKnex();
    const countRows = await knex('stock_daily_prices')
      .select('stock_id')
      .count('* as cnt')
      .where('date', '>=', threeMonthsAgo)
      .groupBy('stock_id')
      .having(knex.raw('count(*) >= 20'));

    const eligibleStockIds = new Set(countRows.map((r: any) => r.stock_id));

    const eligibleStocks = allStocks.filter(
      (s) => eligibleStockIds.has(s.id) && !excludeSet.has(s.code),
    );

    logger.log(
      `스캔 대상: ${eligibleStocks.length}개 종목 (전체 ${allStocks.length}, 제외 ${excludeCodes.length}, 데이터 부족 ${allStocks.length - eligibleStockIds.size})`,
    );

    // 3. 벌크로 전체 candle 데이터 로드
    const eligibleIds = eligibleStocks.map((s) => s.id);
    const allPrices = await this.em.find(
      StockDailyPrice,
      { stock: { $in: eligibleIds }, date: { $gte: threeMonthsAgo } },
      { orderBy: { date: 'ASC' }, populate: ['stock'] },
    );

    // 종목별 그룹핑
    const pricesByStockId = new Map<number, StockDailyPrice[]>();
    for (const p of allPrices) {
      const sid = (p.stock as any).id ?? p.stock;
      if (!pricesByStockId.has(sid)) pricesByStockId.set(sid, []);
      pricesByStockId.get(sid)!.push(p);
    }

    // 4. 배치 병렬 처리 (50개씩)
    const BATCH_SIZE = 50;
    const allResults: ScanResult[] = [];

    for (let i = 0; i < eligibleStocks.length; i += BATCH_SIZE) {
      const batch = eligibleStocks.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map((stock) => this.scanSingleStock(stock, pricesByStockId, investmentAmount, tradeRatioPct, commissionPct)),
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value) {
          allResults.push(result.value);
        }
      }
    }

    // 5. 수익률 기준 정렬 후 Top N
    allResults.sort((a, b) => b.totalReturnPct - a.totalReturnPct);
    const topResults = allResults.slice(0, topN);

    const elapsedMs = Date.now() - startTime;
    logger.log(`스캔 완료: ${elapsedMs}ms, 결과 ${allResults.length}개 중 Top ${topResults.length}`);

    return {
      scannedStocks: allStocks.length,
      eligibleStocks: eligibleStocks.length,
      excludedStocks: excludeCodes.length,
      elapsedMs,
      results: topResults,
    };
  }

  /**
   * 특정 종목에 대한 추천 전략 산출
   * - 4가지 전략 모두 백테스팅 후 최고 수익률 전략 반환
   * - 자동매매 세션 시작 시 디폴트 전략 결정에 사용
   */
  async recommendStrategy(
    code: string,
    investmentAmount = 10_000_000,
    tradeRatioPct = 10,
    commissionPct = 0.015,
  ): Promise<{
    stockCode: string;
    stockName: string;
    strategyId: string;
    strategyName: string;
    variant?: string;
    totalReturnPct: number;
    winRate: number;
    maxDrawdownPct: number;
    totalTrades: number;
  } | null> {
    const stock = await this.em.findOne(Stock, { code });
    if (!stock) {
      throw new NotFoundException(`종목 코드 ${code}를 찾을 수 없습니다.`);
    }

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const prices = await this.em.find(
      StockDailyPrice,
      { stock, date: { $gte: threeMonthsAgo } },
      { orderBy: { date: 'ASC' } },
    );

    const pricesByStockId = new Map<number, StockDailyPrice[]>();
    pricesByStockId.set(stock.id, prices);

    const result = await this.scanSingleStock(
      stock,
      pricesByStockId,
      investmentAmount,
      tradeRatioPct,
      commissionPct,
    );

    if (!result) return null;

    return {
      stockCode: result.stockCode,
      stockName: result.stockName,
      strategyId: result.bestStrategy.strategyId,
      strategyName: result.bestStrategy.strategyName,
      variant: result.bestStrategy.variant,
      totalReturnPct: result.totalReturnPct,
      winRate: result.winRate,
      maxDrawdownPct: result.maxDrawdownPct,
      totalTrades: result.totalTrades,
    };
  }

  /** 단일 종목에 대해 4가지 전략 백테스트 → 최고 수익률 전략 선택 */
  private async scanSingleStock(
    stock: Stock,
    pricesByStockId: Map<number, StockDailyPrice[]>,
    investmentAmount: number,
    tradeRatioPct: number,
    commissionPct: number,
  ): Promise<ScanResult | null> {
    const prices = pricesByStockId.get(stock.id);
    if (!prices || prices.length < 20) return null;

    const candles: CandleData[] = prices
      .filter((p) => p.close != null)
      .map((p) => ({
        date: p.date,
        open: p.open ?? p.close!,
        high: p.high ?? p.close!,
        low: p.low ?? p.close!,
        close: p.close!,
        volume: p.volume ?? 0,
      }));

    if (candles.length < 20) return null;

    let bestResult: {
      strategyId: string;
      strategyName: string;
      variant?: string;
      totalReturnPct: number;
      winRate: number;
      maxDrawdownPct: number;
      totalTrades: number;
      finalValue: number;
      analysis: StrategyAnalysisResult;
    } | null = null;

    for (const [strategyId, strategy] of Object.entries(STRATEGY_MAP)) {
      const variants = STRATEGY_VARIANTS[strategyId] ?? [undefined];

      for (const variant of variants) {
        try {
          const analyzeConfig = variant ? { variant } : {};
          const analysis = strategy.analyze(candles, analyzeConfig);
          const signals = analysis.signals;
          const hasSellSignals = signals.some((s) => s.direction === SignalDirection.Sell);

          const signalByDate = new Map<string, Signal>();
          for (const signal of signals) {
            signalByDate.set(toDateKey(signal.date), signal);
          }

          const config: BacktestConfig = {
            strategyId,
            variant,
            investmentAmount,
            tradeRatioPct,
            commissionPct,
          };

          const result = this.simulate(stock, candles, signalByDate, config, strategy.name, hasSellSignals);

          if (!bestResult || result.totalReturnPct > bestResult.totalReturnPct) {
            bestResult = {
              strategyId,
              strategyName: strategy.name,
              variant,
              totalReturnPct: result.totalReturnPct,
              winRate: result.winRate,
              maxDrawdownPct: result.maxDrawdownPct,
              totalTrades: result.totalTrades,
              finalValue: result.finalValue,
              analysis,
            };
          }
        } catch {
          // 전략/변형 분석 실패 시 건너뛰기
        }
      }
    }

    if (!bestResult || bestResult.totalTrades === 0) return null;

    const { analysis } = bestResult;

    return {
      stockCode: stock.code,
      stockName: stock.name,
      sector: stock.sector ?? undefined,
      bestStrategy: {
        strategyId: bestResult.strategyId,
        strategyName: bestResult.strategyName,
        variant: bestResult.variant,
      },
      totalReturnPct: bestResult.totalReturnPct,
      winRate: bestResult.winRate,
      maxDrawdownPct: bestResult.maxDrawdownPct,
      totalTrades: bestResult.totalTrades,
      finalValue: bestResult.finalValue,
      investmentAmount,
      summary: analysis.summary,
      currentSignal: {
        direction: analysis.currentSignal.direction,
        strength: analysis.currentSignal.strength,
        reason: analysis.currentSignal.reason,
      },
      indicators: analysis.indicators,
    };
  }

  private async loadCandles(code: string): Promise<{ stock: Stock; candles: CandleData[] }> {
    const stock = await this.em.findOne(Stock, { code });
    if (!stock) {
      throw new NotFoundException(`종목 코드 ${code}를 찾을 수 없습니다.`);
    }

    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    const prices = await this.em.find(
      StockDailyPrice,
      { stock, date: { $gte: threeMonthsAgo } },
      { orderBy: { date: 'ASC' } },
    );

    if (prices.length === 0) {
      throw new NotFoundException(`종목 ${code}의 최근 3개월 가격 데이터가 없습니다.`);
    }

    const candles: CandleData[] = prices
      .filter((p) => p.close != null)
      .map((p) => ({
        date: p.date,
        open: p.open ?? p.close!,
        high: p.high ?? p.close!,
        low: p.low ?? p.close!,
        close: p.close!,
        volume: p.volume ?? 0,
      }));

    return { stock, candles };
  }
}
