import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
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
  analyzeMomentumPower,
  analyzeMomentumSurge,
  evaluateLongBuyRisk,
  LongBuyRiskProfile,
} from '@alpha-mind/strategies';
import {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  GridSearchPoint,
  GridSearchResult,
} from './types/backtest.types';
import { ScanResult, ScanResponse } from './types/scan.types';
import { OptimalParamsService } from './optimal-params.service';

/** 타임존 안전한 날짜 키 (YYYY-MM-DD, 로컬 기준) */
function toDateKey(d: Date): string {
  const date = new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 단기 자동매매 기본 설정 */
const DEFAULT_AUTO_TAKE_PROFIT_PCT = 2.0;
const DEFAULT_AUTO_STOP_LOSS_PCT = -2.0;
const DEFAULT_MAX_HOLDING_DAYS = 7; // 7거래일 이내 청산
const DEFAULT_MIN_CURRENT_SIGNAL_STRENGTH = 0.65;
const DEFAULT_MIN_TOTAL_TRADES = 10; // walk-forward 도입으로 통계 유의성 확보
const BACKTEST_MIN_BUY_SIGNAL_STRENGTH = 0.65;
const INFINITY_BOT_MIN_BUY_SIGNAL_STRENGTH = 0.3;
const SCAN_YIELD_INTERVAL_MS = 50;
/** 전 종목 스캔 시 한 번에 가격 데이터를 로드할 종목 수.
 *  값이 클수록 IO 왕복은 줄지만 워킹셋(메모리)이 커진다. 200 ≈ chunk 당 ~24k 행. */
const SCAN_STOCK_CHUNK_SIZE = 200;
const DEFAULT_TRAILING_STOP_TRIGGER_PCT = 1.2;
const DEFAULT_TRAILING_STOP_GIVEBACK_PCT = 0.8;
const DEFAULT_BREAKEVEN_TRIGGER_PCT = 1.0;
const DEFAULT_BREAKEVEN_FLOOR_PCT = 0.1;

/** 한국 시장 매도 시 거래세 (%) — KOSPI 0.18 기준. 백테스트 → 실거래 갭 축소용. */
const DEFAULT_SELL_TAX_PCT = 0.18;
/** 슬리피지 % (양방향). 단타 실측치(0.03~0.1) 중앙값. */
const DEFAULT_SLIPPAGE_PCT = 0.05;
/** 매수를 다음봉 시가에 실행할지 — 실거래(익일 09:00 시가) 패턴과 일치 */
const DEFAULT_USE_NEXT_OPEN_FOR_BUY = true;

/** 스캔 윈도우 — walk-forward 분리를 위해 6개월 데이터를 사용 */
const SCAN_LOOKBACK_MONTHS = 6;
/** Out-of-sample 비율 — 마지막 N% 구간을 검증용으로 분리 */
const OUT_OF_SAMPLE_RATIO = 1 / 3;
/** in-sample 최소 거래수 */
const MIN_IN_SAMPLE_TRADES = 5;
/** out-of-sample 최소 거래수 */
const MIN_OUT_OF_SAMPLE_TRADES = 2;
/** OOS 거래 품질 필터 — 낮은 승률/손익비 후보는 실거래 손실로 이어지기 쉬워 제외 */
const MIN_OOS_WIN_RATE = 50;
const MIN_OOS_PROFIT_FACTOR = 1.2;
const MIN_OOS_EXPECTANCY_PCT = 0;
const MIN_OOS_RETURN_TO_DRAWDOWN = 0.35;

const STRATEGY_MAP: Record<
  string,
  {
    name: string;
    analyze: (
      candles: CandleData[],
      config?: any,
      stockCode?: string,
    ) => StrategyAnalysisResult;
  }
> = {
  'day-trading': { name: '일간 모멘텀 통합 전략', analyze: analyzeDayTrading },
  'mean-reversion': { name: '평균회귀 전략', analyze: analyzeMeanReversion },
  'infinity-bot': { name: '무한매수봇', analyze: analyzeInfinityBot },
  'candle-pattern': { name: '캔들 패턴 인식', analyze: analyzeCandlePattern },
  'momentum-power': { name: 'Momentum Power', analyze: analyzeMomentumPower },
  'momentum-surge': {
    name: 'Momentum Surge',
    analyze: (candles, config, stockCode) =>
      analyzeMomentumSurge(candles, config, stockCode ?? ''),
  },
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
  'momentum-power': [undefined],
  'momentum-surge': [undefined],
};

/**
 * 단타/중단타 스캔에서는 장기 보유나 피라미딩 성격이 강한 전략을 제외한다.
 * 전체 전략 분석/단일 백테스트 API에서는 기존처럼 모든 전략을 사용할 수 있다.
 */
const SHORT_TERM_SCAN_STRATEGY_IDS = [
  'day-trading',
  'mean-reversion',
  'candle-pattern',
];

const SHORT_TERM_SCAN_VARIANTS: Record<string, (string | undefined)[]> = {
  'day-trading': STRATEGY_VARIANTS['day-trading'],
  'mean-reversion': [MeanReversionVariant.RSI, MeanReversionVariant.Bollinger],
  'candle-pattern': [undefined],
};

interface TradeQuality {
  profitFactor: number;
  expectancyPct: number;
  avgWinPnl: number;
  avgLossPnl: number;
  payoffRatio: number;
}

@Injectable()
export class BacktestService {
  constructor(
    private readonly em: EntityManager,
    private readonly optimalParamsService: OptimalParamsService,
  ) {}

  async runBacktest(
    code: string,
    config: BacktestConfig,
  ): Promise<BacktestResult> {
    const strategy = STRATEGY_MAP[config.strategyId];
    if (!strategy) {
      throw new BadRequestException(
        `알 수 없는 전략: ${config.strategyId}. 사용 가능: ${Object.keys(STRATEGY_MAP).join(', ')}`,
      );
    }

    const { stock, candles } = await this.loadCandles(code);

    // 전략 분석으로 신호 추출
    const strategyConfig = config.variant ? { variant: config.variant } : {};
    const analysis = strategy.analyze(candles, strategyConfig, stock.code);
    const signals = analysis.signals;

    // 신호를 날짜 기준 Map으로 변환 (로컬 타임존 안전)
    const signalByDate = new Map<string, Signal>();
    for (const signal of signals) {
      signalByDate.set(toDateKey(signal.date), signal);
    }

    // 시뮬레이션 실행
    return this.simulate(stock, candles, signalByDate, config, strategy.name);
  }

  private simulate(
    stock: Stock,
    candles: CandleData[],
    signalByDate: Map<string, Signal>,
    config: BacktestConfig,
    strategyName: string,
  ): BacktestResult {
    let cash = config.investmentAmount;
    let quantity = 0;
    let avgBuyPrice = 0;
    let entryIndex: number | null = null;
    let highestPriceAfterEntry = 0;
    const trades: BacktestTrade[] = [];
    let totalRealizedPnl = 0;
    let winTrades = 0;
    let lossTrades = 0;

    // MDD 계산용
    let peakValue = config.investmentAmount;
    let maxDrawdownPct = 0;

    const tradeAmount = config.investmentAmount * (config.tradeRatioPct / 100);
    const commissionRate = config.commissionPct / 100;
    const sellTaxRate = (config.sellTaxPct ?? DEFAULT_SELL_TAX_PCT) / 100;
    const slippageRate = (config.slippagePct ?? DEFAULT_SLIPPAGE_PCT) / 100;
    const useNextOpen =
      config.useNextOpenForBuy ?? DEFAULT_USE_NEXT_OPEN_FOR_BUY;
    const maxHoldingDays = config.maxHoldingDays ?? DEFAULT_MAX_HOLDING_DAYS;
    const isInfinityBot = config.strategyId === 'infinity-bot';
    const allowAddOnBuy = config.allowAddOnBuy ?? isInfinityBot;
    const minBuySignalStrength =
      config.minBuySignalStrength ??
      (isInfinityBot
        ? INFINITY_BOT_MIN_BUY_SIGNAL_STRENGTH
        : BACKTEST_MIN_BUY_SIGNAL_STRENGTH);
    const trailingStopTriggerPct =
      config.trailingStopTriggerPct ?? DEFAULT_TRAILING_STOP_TRIGGER_PCT;
    const trailingStopGivebackPct =
      config.trailingStopGivebackPct ?? DEFAULT_TRAILING_STOP_GIVEBACK_PCT;
    const breakevenTriggerPct =
      config.breakevenTriggerPct ?? DEFAULT_BREAKEVEN_TRIGGER_PCT;
    const breakevenFloorPct =
      config.breakevenFloorPct ?? DEFAULT_BREAKEVEN_FLOOR_PCT;

    /**
     * 매도 체결: rawPrice 에서 슬리피지 차감 → 거래세 + 수수료 부과.
     * 한국 시장의 매도 비용 구조를 백테스트에 일치시켜 실거래 수익과의 갭을 줄인다.
     */
    const closePosition = (
      candle: CandleData,
      rawPrice: number,
      reason: string,
    ) => {
      const fillPrice = rawPrice * (1 - slippageRate);
      const sellAmount = quantity * fillPrice;
      const commission = sellAmount * commissionRate;
      const sellTax = sellAmount * sellTaxRate;
      const slippageCost = quantity * (rawPrice - fillPrice);
      const totalSellCost = commission + sellTax;
      const pnl = (fillPrice - avgBuyPrice) * quantity - totalSellCost;

      totalRealizedPnl += pnl;
      if (pnl > 0) winTrades++;
      else lossTrades++;

      cash += sellAmount - totalSellCost;

      trades.push({
        date: candle.date,
        direction: SignalDirection.Sell,
        price: fillPrice,
        quantity,
        amount: sellAmount,
        commission,
        sellTax,
        slippageCost,
        reason,
        realizedPnl: pnl,
      });

      quantity = 0;
      avgBuyPrice = 0;
      entryIndex = null;
      highestPriceAfterEntry = 0;
    };

    for (let candleIndex = 0; candleIndex < candles.length; candleIndex++) {
      const candle = candles[candleIndex];
      const dateKey = toDateKey(candle.date);
      const signal = signalByDate.get(dateKey);
      let exitedThisCandle = false;

      // 보유 중일 때 청산 검사 — 갭(시가 점프) → 일중 변동 → 최대 보유기간 순.
      // 갭다운: 시가가 손절선 아래에서 시작하면 시가에 청산 (실거래에서 손절선 미체결).
      // 갭상승: 시가가 익절선 위에서 시작하면 시가에 청산.
      // 둘 다 아닐 때만 일중 high/low 로 판정. 동시 도달 시 보수적으로 손절 우선.
      if (quantity > 0 && avgBuyPrice > 0) {
        highestPriceAfterEntry = Math.max(
          highestPriceAfterEntry || avgBuyPrice,
          candle.open,
          avgBuyPrice,
        );
        const takeProfitPrice =
          avgBuyPrice * (1 + config.autoTakeProfitPct / 100);
        const stopLossPrice = avgBuyPrice * (1 + config.autoStopLossPct / 100);
        const breakevenPrice = avgBuyPrice * (1 + breakevenFloorPct / 100);
        let peakReturnPct =
          ((highestPriceAfterEntry - avgBuyPrice) / avgBuyPrice) * 100;
        let trailingStopPrice =
          highestPriceAfterEntry * (1 - trailingStopGivebackPct / 100);

        if (candle.open <= stopLossPrice) {
          closePosition(
            candle,
            candle.open,
            `갭다운 손절 (시가 ${candle.open.toFixed(0)}, 손절선 ${stopLossPrice.toFixed(0)})`,
          );
          exitedThisCandle = true;
        } else if (candle.open >= takeProfitPrice) {
          closePosition(
            candle,
            candle.open,
            `갭상승 익절 (시가 ${candle.open.toFixed(0)}, 익절선 ${takeProfitPrice.toFixed(0)})`,
          );
          exitedThisCandle = true;
        } else if (
          peakReturnPct >= breakevenTriggerPct &&
          candle.open <= breakevenPrice
        ) {
          closePosition(
            candle,
            candle.open,
            `갭하락 본전 보호 (시가 ${candle.open.toFixed(0)}, 보호선 ${breakevenPrice.toFixed(0)})`,
          );
          exitedThisCandle = true;
        } else if (
          peakReturnPct >= trailingStopTriggerPct &&
          candle.open <= trailingStopPrice
        ) {
          closePosition(
            candle,
            candle.open,
            `갭하락 트레일링 스톱 (시가 ${candle.open.toFixed(0)}, 추적선 ${trailingStopPrice.toFixed(0)})`,
          );
          exitedThisCandle = true;
        } else {
          const takeProfitHit = candle.high >= takeProfitPrice;
          const stopLossHit = candle.low <= stopLossPrice;
          highestPriceAfterEntry = Math.max(
            highestPriceAfterEntry,
            candle.high,
          );
          peakReturnPct =
            ((highestPriceAfterEntry - avgBuyPrice) / avgBuyPrice) * 100;
          trailingStopPrice =
            highestPriceAfterEntry * (1 - trailingStopGivebackPct / 100);
          const breakevenHit =
            peakReturnPct >= breakevenTriggerPct &&
            candle.low <= breakevenPrice;
          const trailingStopHit =
            peakReturnPct >= trailingStopTriggerPct &&
            candle.low <= trailingStopPrice;
          if (stopLossHit) {
            closePosition(
              candle,
              stopLossPrice,
              `자동 손절 (수익률 ${config.autoStopLossPct.toFixed(1)}%)`,
            );
            exitedThisCandle = true;
          } else if (takeProfitHit) {
            closePosition(
              candle,
              takeProfitPrice,
              `자동 익절 (수익률 ${config.autoTakeProfitPct.toFixed(1)}%)`,
            );
            exitedThisCandle = true;
          } else if (breakevenHit) {
            closePosition(
              candle,
              breakevenPrice,
              `본전 보호 (최고 수익률 ${peakReturnPct.toFixed(1)}%)`,
            );
            exitedThisCandle = true;
          } else if (trailingStopHit) {
            const trailingReturnPct =
              ((trailingStopPrice - avgBuyPrice) / avgBuyPrice) * 100;
            closePosition(
              candle,
              trailingStopPrice,
              `트레일링 스톱 (최고 ${peakReturnPct.toFixed(1)}%, 청산 ${trailingReturnPct.toFixed(1)}%)`,
            );
            exitedThisCandle = true;
          } else if (
            maxHoldingDays > 0 &&
            entryIndex != null &&
            candleIndex - entryIndex >= maxHoldingDays
          ) {
            const returnPct =
              ((candle.close - avgBuyPrice) / avgBuyPrice) * 100;
            closePosition(
              candle,
              candle.close,
              `최대 보유기간 ${maxHoldingDays}일 도달 (수익률 ${returnPct.toFixed(1)}%)`,
            );
            exitedThisCandle = true;
          }
        }
      }

      // 진입/매도 신호 처리
      // - useNextOpen=true: 어제 신호를 오늘 시가에 체결 (실거래 패턴과 일치)
      // - useNextOpen=false: 신호봉 종가에 즉시 체결 (이전 동작, 단위 테스트용)
      let actionSignal: Signal | undefined;
      let actionPrice: number;
      if (useNextOpen) {
        const prevCandle = candleIndex > 0 ? candles[candleIndex - 1] : null;
        actionSignal = prevCandle
          ? signalByDate.get(toDateKey(prevCandle.date))
          : undefined;
        actionPrice = candle.open;
      } else {
        actionSignal = signal;
        actionPrice = candle.close;
      }

      if (!exitedThisCandle && actionSignal) {
        if (
          actionSignal.direction === SignalDirection.Buy &&
          actionSignal.strength >= minBuySignalStrength &&
          (quantity === 0 || allowAddOnBuy)
        ) {
          // 매수 슬리피지: 실 체결가는 시가 + 슬리피지로 약간 비싸게 잡힌다.
          const fillPrice = actionPrice * (1 + slippageRate);
          // 수수료까지 포함해 현금이 음수로 내려가지 않게 주문 가능 금액을 산정.
          const buyAmount = Math.min(tradeAmount, cash / (1 + commissionRate));
          if (buyAmount > 0) {
            const qty = Math.floor(buyAmount / fillPrice);
            if (qty > 0) {
              const wasFlat = quantity === 0;
              const cost = qty * fillPrice;
              const actualCommission = cost * commissionRate;
              const slippageCost = qty * (fillPrice - actionPrice);

              const totalCost = avgBuyPrice * quantity + cost;
              quantity += qty;
              avgBuyPrice = totalCost / quantity;
              highestPriceAfterEntry = wasFlat
                ? fillPrice
                : Math.max(highestPriceAfterEntry, fillPrice);
              if (wasFlat) {
                entryIndex = candleIndex;
              }

              cash -= cost + actualCommission;

              trades.push({
                date: candle.date,
                direction: SignalDirection.Buy,
                price: fillPrice,
                quantity: qty,
                amount: cost,
                commission: actualCommission,
                slippageCost,
                reason: actionSignal.reason,
              });
            }
          }
        } else if (
          actionSignal.direction === SignalDirection.Sell &&
          actionSignal.strength >= 0.3 &&
          quantity > 0
        ) {
          closePosition(candle, actionPrice, actionSignal.reason);
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
    const unrealizedPnl =
      quantity > 0 ? (lastPrice - avgBuyPrice) * quantity : 0;
    const totalReturnPct =
      ((finalValue - config.investmentAmount) / config.investmentAmount) * 100;
    const totalTrades = trades.filter(
      (t) => t.direction === SignalDirection.Sell,
    ).length;

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
      winRate:
        totalTrades > 0
          ? Math.round((winTrades / totalTrades) * 10000) / 100
          : 0,
      maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
      remainingCash: Math.round(cash),
      remainingQuantity: quantity,
      trades,
    };
  }

  /** 전 종목 스캔: 단기 전략으로 백테스팅 후 Top N 추출 */
  async scanAllStocks(
    excludeCodes: string[],
    topN: number,
    investmentAmount: number,
    tradeRatioPct: number,
    commissionPct: number,
    autoTakeProfitPct = DEFAULT_AUTO_TAKE_PROFIT_PCT,
    autoStopLossPct = DEFAULT_AUTO_STOP_LOSS_PCT,
    maxHoldingDays = DEFAULT_MAX_HOLDING_DAYS,
    minCurrentSignalStrength = DEFAULT_MIN_CURRENT_SIGNAL_STRENGTH,
    minTotalTrades = DEFAULT_MIN_TOTAL_TRADES,
  ): Promise<ScanResponse> {
    const logger = new Logger('BacktestService');
    const startTime = Date.now();

    const lookbackFrom = new Date();
    lookbackFrom.setMonth(lookbackFrom.getMonth() - SCAN_LOOKBACK_MONTHS);

    // 1. 전체 종목 로드
    const allStocks = await this.em.find(Stock, {});
    const excludeSet = new Set(excludeCodes);

    // 2. 단기 walk-forward 검증을 위해 60거래일 이상 데이터가 있는 종목만 필터
    const knex = this.em.getKnex();
    const countRows = await knex('stock_daily_prices')
      .select('stock_id')
      .count('* as cnt')
      .where('date', '>=', lookbackFrom)
      .groupBy('stock_id')
      .having(knex.raw('count(*) >= 60'));

    const eligibleStockIds = new Set(countRows.map((r: any) => r.stock_id));

    const eligibleStocks = allStocks.filter(
      (s) => eligibleStockIds.has(s.id) && !excludeSet.has(s.code),
    );

    logger.log(
      `스캔 대상: ${eligibleStocks.length}개 종목 (전체 ${allStocks.length}, 제외 ${excludeCodes.length}, 데이터 부족 ${allStocks.length - eligibleStockIds.size}, 윈도우 ${SCAN_LOOKBACK_MONTHS}개월)`,
    );

    // 3. 종목을 chunk 로 나눠 처리해 메모리 사용을 일정하게 유지한다.
    //    em.find(StockDailyPrice, populate:['stock']) 로 일괄 hydrate 하면
    //    6개월 × 전 종목 분량의 엔티티가 식별맵에 상주해 OOM 으로 이어진다.
    //    필요한 컬럼만 knex raw row 로 chunk 로드해 워킹셋을 chunk 크기에 비례하게 묶는다.
    const liteStocks = eligibleStocks.map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      sector: s.sector ?? undefined,
    }));

    // 이후 단계에서는 Stock/StockDailyPrice 엔티티가 더 이상 필요 없으므로
    // 식별맵을 비워 1단계에서 hydrate 한 엔티티들을 GC 가 회수할 수 있게 한다.
    this.em.clear();

    type PriceRow = {
      stock_id: number;
      date: Date | string;
      open: number | string | null;
      high: number | string | null;
      low: number | string | null;
      close: number | string | null;
      volume: number | string | null;
    };

    const toNum = (v: number | string | null): number | undefined =>
      v == null ? undefined : typeof v === 'number' ? v : Number(v);

    const allResults: ScanResult[] = [];
    let lastYieldAt = Date.now();

    for (let off = 0; off < liteStocks.length; off += SCAN_STOCK_CHUNK_SIZE) {
      const chunk = liteStocks.slice(off, off + SCAN_STOCK_CHUNK_SIZE);
      const chunkIds = chunk.map((s) => s.id);

      const rows = (await knex('stock_daily_prices')
        .select('stock_id', 'date', 'open', 'high', 'low', 'close', 'volume')
        .whereIn('stock_id', chunkIds)
        .andWhere('date', '>=', lookbackFrom)
        .orderBy([
          { column: 'stock_id' },
          { column: 'date', order: 'asc' },
        ])) as PriceRow[];

      // scanSingleStock 은 date/open/high/low/close/volume 만 사용하므로
      // StockDailyPrice 엔티티가 아닌 동일 형태의 plain 객체로 채운다.
      const pricesByStockId = new Map<number, StockDailyPrice[]>();
      for (const r of rows) {
        let bucket = pricesByStockId.get(r.stock_id);
        if (!bucket) {
          bucket = [];
          pricesByStockId.set(r.stock_id, bucket);
        }
        bucket.push({
          date: r.date instanceof Date ? r.date : new Date(r.date),
          open: toNum(r.open),
          high: toNum(r.high),
          low: toNum(r.low),
          close: toNum(r.close),
          volume: toNum(r.volume),
        } as unknown as StockDailyPrice);
      }

      for (const stock of chunk) {
        try {
          const result = this.scanSingleStock(
            stock as unknown as Stock,
            pricesByStockId,
            investmentAmount,
            tradeRatioPct,
            commissionPct,
            autoTakeProfitPct,
            autoStopLossPct,
            maxHoldingDays,
            minCurrentSignalStrength,
            minTotalTrades,
          );
          if (result) {
            allResults.push(result);
          }
        } catch (err) {
          logger.debug(
            `scan skip ${stock.code}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (Date.now() - lastYieldAt >= SCAN_YIELD_INTERVAL_MS) {
          // CPU-bound 루프가 heartbeat/재연결 타이머를 막지 않도록 주기적으로 양보한다.
          await new Promise((resolve) => setImmediate(resolve));
          lastYieldAt = Date.now();
        }
      }

      // chunk 처리 종료. 다음 chunk 로딩 전에 직전 chunk 의 가격 데이터가
      // GC 대상이 되도록 참조를 명시적으로 끊는다.
      pricesByStockId.clear();
    }

    // 5. 단기 운용 적합도 기반 위험조정 점수로 정렬 후 Top N
    allResults.sort((a, b) => b.rankScore - a.rankScore);
    const topResults = allResults.slice(0, topN);

    const elapsedMs = Date.now() - startTime;
    logger.log(
      `스캔 완료: ${elapsedMs}ms, 결과 ${allResults.length}개 중 Top ${topResults.length}`,
    );

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
   * - 단기 전략 백테스팅 후 위험조정 점수 최고 전략 반환
   * - 자동매매 세션 시작 시 디폴트 전략 결정에 사용
   */
  async recommendStrategy(
    code: string,
    investmentAmount = 10_000_000,
    tradeRatioPct = 10,
    commissionPct = 0.015,
    autoTakeProfitPct = DEFAULT_AUTO_TAKE_PROFIT_PCT,
    autoStopLossPct = DEFAULT_AUTO_STOP_LOSS_PCT,
    maxHoldingDays = DEFAULT_MAX_HOLDING_DAYS,
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

    const lookbackFrom = new Date();
    lookbackFrom.setMonth(lookbackFrom.getMonth() - SCAN_LOOKBACK_MONTHS);

    const prices = await this.em.find(
      StockDailyPrice,
      { stock, date: { $gte: lookbackFrom } },
      { orderBy: { date: 'ASC' } },
    );

    const pricesByStockId = new Map<number, StockDailyPrice[]>();
    pricesByStockId.set(stock.id, prices);

    const result = this.scanSingleStock(
      stock,
      pricesByStockId,
      investmentAmount,
      tradeRatioPct,
      commissionPct,
      autoTakeProfitPct,
      autoStopLossPct,
      maxHoldingDays,
      DEFAULT_MIN_CURRENT_SIGNAL_STRENGTH,
      DEFAULT_MIN_TOTAL_TRADES,
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

  /**
   * 단일 종목에 대해 단기 전략 백테스트 → 위험조정 점수 최고 전략 선택.
   *
   * Walk-forward / out-of-sample 검증:
   * - 캔들을 in-sample(앞 2/3) + out-of-sample(뒤 1/3)로 분리.
   * - 전략은 in-sample 에서 성과를 검증한 뒤, OOS 에서도 양수 + 최소 거래수를 충족해야 통과.
   * - 랭킹은 OOS 지표 기준 → "과거에 잘 맞은 전략"이 아니라 "독립 구간에서도 작동한 전략"을 선호.
   * - 최종 currentSignal 도 OOS 구간 마지막 1거래일 이내에 발생해야 매수 후보로 인정.
   */
  private scanSingleStock(
    stock: Stock,
    pricesByStockId: Map<number, StockDailyPrice[]>,
    investmentAmount: number,
    tradeRatioPct: number,
    commissionPct: number,
    autoTakeProfitPct = DEFAULT_AUTO_TAKE_PROFIT_PCT,
    autoStopLossPct = DEFAULT_AUTO_STOP_LOSS_PCT,
    maxHoldingDays = DEFAULT_MAX_HOLDING_DAYS,
    minCurrentSignalStrength = DEFAULT_MIN_CURRENT_SIGNAL_STRENGTH,
    minTotalTrades = DEFAULT_MIN_TOTAL_TRADES,
  ): ScanResult | null {
    const prices = pricesByStockId.get(stock.id);
    if (!prices || prices.length < 60) return null;

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

    if (candles.length < 60) return null;

    // walk-forward 분리: 앞 2/3 = in-sample, 뒤 1/3 = out-of-sample
    const splitIdx = Math.floor(candles.length * (1 - OUT_OF_SAMPLE_RATIO));
    const inSampleCandles = candles.slice(0, splitIdx);
    const outOfSampleCandles = candles.slice(splitIdx);
    if (
      inSampleCandles.length < 30 ||
      outOfSampleCandles.length < MIN_OUT_OF_SAMPLE_TRADES + 10
    ) {
      return null;
    }

    // 공통 매수 리스크 필터: 유동성 부족/고변동/하락 추세/과열 후보는 제외.
    const riskProfile = evaluateLongBuyRisk(candles);
    if (!riskProfile.passed) {
      return null;
    }
    const volatilityPct = riskProfile.volatilityPct;

    let bestResult: {
      strategyId: string;
      strategyName: string;
      variant?: string;
      inSample: BacktestResult;
      outOfSample: BacktestResult;
      rankScore: number;
      analysis: StrategyAnalysisResult;
      tradeQuality: TradeQuality;
    } | null = null;

    for (const strategyId of SHORT_TERM_SCAN_STRATEGY_IDS) {
      const strategy = STRATEGY_MAP[strategyId];
      if (!strategy) continue;
      const variants = SHORT_TERM_SCAN_VARIANTS[strategyId] ?? [undefined];

      for (const variant of variants) {
        try {
          const analyzeConfig = variant ? { variant } : {};
          // 지표 연속성을 위해 전체 캔들로 한 번 분석한 뒤,
          // 신호를 날짜 맵으로 변환해 in-sample / OOS 시뮬레이션에서 공유 사용.
          const analysis = strategy.analyze(candles, analyzeConfig, stock.code);
          const signals = analysis.signals;

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
            autoTakeProfitPct,
            autoStopLossPct,
            maxHoldingDays,
            allowAddOnBuy: false,
            minBuySignalStrength: BACKTEST_MIN_BUY_SIGNAL_STRENGTH,
          };

          // In-sample: 전략 선정 단계
          const inSample = this.simulate(
            stock,
            inSampleCandles,
            signalByDate,
            config,
            strategy.name,
          );
          if (inSample.totalTrades < MIN_IN_SAMPLE_TRADES) continue;
          if (inSample.totalReturnPct <= 0) continue;

          // Out-of-sample: 같은 전략을 독립 구간에서 검증
          const outOfSample = this.simulate(
            stock,
            outOfSampleCandles,
            signalByDate,
            config,
            strategy.name,
          );
          if (outOfSample.totalTrades < MIN_OUT_OF_SAMPLE_TRADES) continue;
          if (outOfSample.totalReturnPct <= 0) continue;
          const tradeQuality = this.calculateTradeQuality(outOfSample);
          if (!this.passesOosQuality(outOfSample, tradeQuality)) continue;

          // 합산 거래수 최소치 (튜닝 가능한 통계 신뢰도 임계)
          const combinedTrades = inSample.totalTrades + outOfSample.totalTrades;
          if (combinedTrades < minTotalTrades) continue;

          // currentSignal 검증: 매수 방향 + 최소 강도 + 최근 1거래일 이내
          const currentSignal = analysis.currentSignal;
          if (
            currentSignal.direction !== SignalDirection.Buy ||
            currentSignal.strength < minCurrentSignalStrength
          ) {
            continue;
          }

          // 랭킹은 OOS 지표 기준 (in-sample fitting bias 회피)
          const rankScore = this.calculateScanRankScore(
            outOfSample,
            currentSignal.strength,
            tradeQuality,
            riskProfile,
          );

          if (!bestResult || rankScore > bestResult.rankScore) {
            bestResult = {
              strategyId,
              strategyName: strategy.name,
              variant,
              inSample,
              outOfSample,
              rankScore,
              analysis,
              tradeQuality,
            };
          }
        } catch {
          // 전략/변형 분석 실패 시 건너뛰기
        }
      }
    }

    if (!bestResult) return null;

    const { analysis, inSample, outOfSample } = bestResult;

    return {
      stockCode: stock.code,
      stockName: stock.name,
      sector: stock.sector ?? undefined,
      bestStrategy: {
        strategyId: bestResult.strategyId,
        strategyName: bestResult.strategyName,
        variant: bestResult.variant,
      },
      // 외부 필드는 OOS 기준 (예측 가능한 신뢰 구간 지표)
      totalReturnPct: outOfSample.totalReturnPct,
      winRate: outOfSample.winRate,
      maxDrawdownPct: outOfSample.maxDrawdownPct,
      totalTrades: outOfSample.totalTrades,
      rankScore: bestResult.rankScore,
      finalValue: outOfSample.finalValue,
      investmentAmount,
      volatilityPct,
      profitFactor: bestResult.tradeQuality.profitFactor,
      expectancyPct: bestResult.tradeQuality.expectancyPct,
      riskProfile: {
        avgTurnover20: riskProfile.avgTurnover20,
        sma20Slope5dPct: riskProfile.sma20Slope5dPct,
        priceFromSma20Pct: riskProfile.priceFromSma20Pct,
        priceFromSma60Pct: riskProfile.priceFromSma60Pct,
        recent5dReturnPct: riskProfile.recent5dReturnPct,
      },
      inSample: {
        totalReturnPct: inSample.totalReturnPct,
        winRate: inSample.winRate,
        totalTrades: inSample.totalTrades,
        maxDrawdownPct: inSample.maxDrawdownPct,
      },
      outOfSample: {
        totalReturnPct: outOfSample.totalReturnPct,
        winRate: outOfSample.winRate,
        totalTrades: outOfSample.totalTrades,
        maxDrawdownPct: outOfSample.maxDrawdownPct,
      },
      summary: analysis.summary,
      currentSignal: {
        direction: analysis.currentSignal.direction,
        strength: analysis.currentSignal.strength,
        reason: analysis.currentSignal.reason,
      },
      indicators: analysis.indicators,
    };
  }

  private calculateScanRankScore(
    result: BacktestResult,
    currentSignalStrength: number,
    tradeQuality: TradeQuality,
    riskProfile: LongBuyRiskProfile,
  ): number {
    const tradeFrequencyBonus = Math.min(result.totalTrades, 8) * 0.15;
    const winRateBonus = (result.winRate - 50) * 0.05;
    const signalBonus = currentSignalStrength * 3;
    const profitFactorBonus =
      (Math.min(tradeQuality.profitFactor, 3) - 1) * 1.5;
    const expectancyBonus = tradeQuality.expectancyPct * 4;
    const drawdownPenalty = result.maxDrawdownPct * 0.35;
    const openPositionPenalty = result.remainingQuantity > 0 ? 1.5 : 0;
    const volatilityPenalty =
      riskProfile.volatilityPct != null && riskProfile.volatilityPct > 5
        ? (riskProfile.volatilityPct - 5) * 0.35
        : 0;
    const extensionPenalty =
      riskProfile.priceFromSma20Pct != null && riskProfile.priceFromSma20Pct > 8
        ? (riskProfile.priceFromSma20Pct - 8) * 0.25
        : 0;

    return (
      Math.round(
        (result.totalReturnPct +
          winRateBonus +
          signalBonus +
          profitFactorBonus +
          expectancyBonus +
          tradeFrequencyBonus -
          drawdownPenalty -
          openPositionPenalty -
          volatilityPenalty -
          extensionPenalty) *
          100,
      ) / 100
    );
  }

  private calculateTradeQuality(result: BacktestResult): TradeQuality {
    const sellTrades = result.trades.filter(
      (t) => t.direction === SignalDirection.Sell && t.realizedPnl != null,
    );
    const wins = sellTrades
      .map((t) => t.realizedPnl ?? 0)
      .filter((pnl) => pnl > 0);
    const losses = sellTrades
      .map((t) => t.realizedPnl ?? 0)
      .filter((pnl) => pnl < 0);

    const grossProfit = wins.reduce((sum, pnl) => sum + pnl, 0);
    const grossLoss = Math.abs(losses.reduce((sum, pnl) => sum + pnl, 0));
    const avgWinPnl = wins.length > 0 ? grossProfit / wins.length : 0;
    const avgLossPnl = losses.length > 0 ? grossLoss / losses.length : 0;
    const profitFactor =
      grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
    const payoffRatio =
      avgLossPnl > 0 ? avgWinPnl / avgLossPnl : avgWinPnl > 0 ? 99 : 0;
    const expectancyPct =
      sellTrades.length > 0 && result.investmentAmount > 0
        ? ((grossProfit - grossLoss) /
            sellTrades.length /
            result.investmentAmount) *
          100
        : 0;

    return {
      profitFactor: Math.round(profitFactor * 100) / 100,
      expectancyPct: Math.round(expectancyPct * 1000) / 1000,
      avgWinPnl: Math.round(avgWinPnl),
      avgLossPnl: Math.round(avgLossPnl),
      payoffRatio: Math.round(payoffRatio * 100) / 100,
    };
  }

  private passesOosQuality(
    result: BacktestResult,
    quality: TradeQuality,
  ): boolean {
    if (result.winRate < MIN_OOS_WIN_RATE) return false;
    if (quality.profitFactor < MIN_OOS_PROFIT_FACTOR) return false;
    if (quality.expectancyPct <= MIN_OOS_EXPECTANCY_PCT) return false;

    if (result.maxDrawdownPct > 0) {
      const returnToDrawdown = result.totalReturnPct / result.maxDrawdownPct;
      if (returnToDrawdown < MIN_OOS_RETURN_TO_DRAWDOWN) return false;
    }

    return true;
  }

  /**
   * 단타용 TP/SL 그리드 서치.
   *
   * - 동작: tpRange × slRange 의 모든 조합에 대해 표본 종목군에 walk-forward 백테스트를 적용,
   *   각 조합의 OOS 평균 성과로 점수를 매겨 최적 (TP, SL) 산출.
   * - 점수: medianReturn × profitableProportion − 0.3 × avgMDD
   *   (수익 중앙값 × 통과 종목 비율 − 위험 패널티) — 일부 종목에서만 좋은 조합을 거른다.
   * - 결과를 OptimalParamsService 로 영속화하면 ScheduledScannerService 가 RMQ 로 조회해 사용.
   */
  async gridSearchOptimalTpSl(opts?: {
    tpRange?: number[];
    slRange?: number[];
    stockSampleSize?: number;
    investmentAmount?: number;
    maxHoldingDays?: number;
  }): Promise<GridSearchResult> {
    const logger = new Logger('BacktestService.gridSearchOptimalTpSl');
    const startTime = Date.now();

    const tpRange = opts?.tpRange ?? [1.5, 2.0, 2.5, 3.0, 4.0];
    const slRange = opts?.slRange ?? [-1.0, -1.5, -2.0, -2.5, -3.0];
    const sampleSize = opts?.stockSampleSize ?? 50;
    const investmentAmount = opts?.investmentAmount ?? 1_000_000;
    const tradeRatioPct = 100; // 그리드 평가는 단일 매매 풀 사용 — 결과 노이즈 최소화
    const commissionPct = 0.015;
    const maxHoldingDays = opts?.maxHoldingDays ?? DEFAULT_MAX_HOLDING_DAYS;

    const lookbackFrom = new Date();
    lookbackFrom.setMonth(lookbackFrom.getMonth() - SCAN_LOOKBACK_MONTHS);

    // 1) 표본 종목 추출 (60거래일 이상, 코드 정렬 결정적 N개)
    const knex = this.em.getKnex();
    const countRows = await knex('stock_daily_prices')
      .select('stock_id')
      .count('* as cnt')
      .where('date', '>=', lookbackFrom)
      .groupBy('stock_id')
      .having(knex.raw('count(*) >= 60'));
    const eligibleIds = countRows.map((r: any) => r.stock_id as number);
    if (eligibleIds.length === 0) {
      throw new BadRequestException(
        '그리드 서치 가능한 종목이 없습니다 (60거래일 이상 데이터 필요).',
      );
    }

    const allEligible = await this.em.find(
      Stock,
      { id: { $in: eligibleIds } },
      { orderBy: { code: 'ASC' } },
    );
    const sampledStocks = allEligible.slice(0, sampleSize);
    const sampledIds = sampledStocks.map((s) => s.id);

    // 2) 캔들 + 신호 사전 계산 — analyze() 가 가장 비싼 부분이므로
    //    전략/변형별로 한 번만 실행해 캐시한다. 그리드 점은 simulate() 만 재호출.
    const allPrices = await this.em.find(
      StockDailyPrice,
      { stock: { $in: sampledIds }, date: { $gte: lookbackFrom } },
      { orderBy: { date: 'ASC' }, populate: ['stock'] },
    );
    const candlesByStockId = new Map<number, CandleData[]>();
    for (const p of allPrices) {
      const sid = (p.stock as any).id ?? p.stock;
      if (!candlesByStockId.has(sid)) candlesByStockId.set(sid, []);
      if (p.close != null) {
        candlesByStockId.get(sid)!.push({
          date: p.date,
          open: p.open ?? p.close,
          high: p.high ?? p.close,
          low: p.low ?? p.close,
          close: p.close,
          volume: p.volume ?? 0,
        });
      }
    }

    type StrategyRun = {
      strategyId: string;
      variant?: string;
      strategyName: string;
      signalByDate: Map<string, Signal>;
    };
    const stockData: {
      stock: Stock;
      candles: CandleData[];
      runs: StrategyRun[];
    }[] = [];

    let lastYieldAt = Date.now();
    for (const stock of sampledStocks) {
      const candles = candlesByStockId.get(stock.id);
      if (!candles || candles.length < 60) continue;
      if (!evaluateLongBuyRisk(candles).passed) continue;

      const runs: StrategyRun[] = [];
      for (const sid of SHORT_TERM_SCAN_STRATEGY_IDS) {
        const strategy = STRATEGY_MAP[sid];
        if (!strategy) continue;
        const variants = SHORT_TERM_SCAN_VARIANTS[sid] ?? [undefined];
        for (const variant of variants) {
          try {
            const analyzeConfig = variant ? { variant } : {};
            const analysis = strategy.analyze(
              candles,
              analyzeConfig,
              stock.code,
            );
            const signalByDate = new Map<string, Signal>();
            for (const s of analysis.signals) {
              signalByDate.set(toDateKey(s.date), s);
            }
            runs.push({
              strategyId: sid,
              variant,
              strategyName: strategy.name,
              signalByDate,
            });
          } catch {
            // 전략 분석 실패 시 건너뛰기
          }
        }
      }
      if (runs.length > 0) {
        stockData.push({ stock, candles, runs });
      }

      if (Date.now() - lastYieldAt >= SCAN_YIELD_INTERVAL_MS) {
        await new Promise((resolve) => setImmediate(resolve));
        lastYieldAt = Date.now();
      }
    }

    logger.log(
      `그리드 사전 분석 완료: ${stockData.length}개 종목, ${tpRange.length}×${slRange.length}=${tpRange.length * slRange.length} 조합 평가 시작`,
    );
    if (stockData.length === 0) {
      throw new BadRequestException(
        '그리드 서치 가능한 종목이 없습니다 (리스크 필터/데이터 조건 통과 종목 없음).',
      );
    }

    // 3) 그리드 평가 — (tp, sl) × stock × strategy run 으로 simulate 만 재실행
    const grid: GridSearchPoint[] = [];
    for (const tp of tpRange) {
      for (const sl of slRange) {
        const oosReturns: number[] = [];
        const oosWinRates: number[] = [];
        const oosDrawdowns: number[] = [];
        let profitableCount = 0;

        for (const data of stockData) {
          const evaluation = this.evaluateStockGridPoint(
            data.stock,
            data.candles,
            data.runs,
            tp,
            sl,
            investmentAmount,
            tradeRatioPct,
            commissionPct,
            maxHoldingDays,
          );
          if (!evaluation) continue;
          oosReturns.push(evaluation.oosReturnPct);
          oosWinRates.push(evaluation.oosWinRate);
          oosDrawdowns.push(evaluation.oosDrawdownPct);
          if (evaluation.oosReturnPct > 0) profitableCount++;

          if (Date.now() - lastYieldAt >= SCAN_YIELD_INTERVAL_MS) {
            await new Promise((resolve) => setImmediate(resolve));
            lastYieldAt = Date.now();
          }
        }

        const sampledN = oosReturns.length;
        const avgReturn =
          sampledN > 0 ? oosReturns.reduce((a, b) => a + b, 0) / sampledN : 0;
        const sortedReturns = [...oosReturns].sort((a, b) => a - b);
        const medianReturn =
          sortedReturns.length > 0
            ? sortedReturns[Math.floor(sortedReturns.length / 2)]
            : 0;
        const avgWinRate =
          sampledN > 0 ? oosWinRates.reduce((a, b) => a + b, 0) / sampledN : 0;
        const avgMaxDrawdown =
          sampledN > 0 ? oosDrawdowns.reduce((a, b) => a + b, 0) / sampledN : 0;
        const profitableProp = sampledN > 0 ? profitableCount / sampledN : 0;
        const score = medianReturn * profitableProp - avgMaxDrawdown * 0.3;

        grid.push({
          tpPct: tp,
          slPct: sl,
          sampledStocks: sampledN,
          avgReturnPct: Math.round(avgReturn * 100) / 100,
          medianReturnPct: Math.round(medianReturn * 100) / 100,
          avgWinRate: Math.round(avgWinRate * 100) / 100,
          profitableCount,
          profitableProportion: Math.round(profitableProp * 1000) / 1000,
          avgMaxDrawdownPct: Math.round(avgMaxDrawdown * 100) / 100,
          score: Math.round(score * 1000) / 1000,
        });
      }
    }

    grid.sort((a, b) => b.score - a.score);
    const best = grid[0];
    if (!best) {
      throw new BadRequestException(
        '그리드 서치 결과가 비었습니다 — 데이터 부족 또는 전략 통과 종목 없음.',
      );
    }

    const optimal = {
      tpPct: best.tpPct,
      slPct: best.slPct,
      score: best.score,
      sampleSize: best.sampledStocks,
      updatedAt: new Date().toISOString(),
    };
    await this.optimalParamsService.saveShortTermTpSl(optimal);

    const elapsedMs = Date.now() - startTime;
    logger.log(
      `그리드 서치 완료 (${elapsedMs}ms) — optimal TP=${best.tpPct}% SL=${best.slPct}% (score=${best.score.toFixed(3)}, 통과 ${best.sampledStocks}/${stockData.length})`,
    );

    return {
      optimal: {
        tpPct: optimal.tpPct,
        slPct: optimal.slPct,
        score: optimal.score,
        sampleSize: optimal.sampleSize,
      },
      grid,
      totalSampleSize: stockData.length,
      elapsedMs,
    };
  }

  /**
   * 단일 종목 × 단일 (TP, SL) 평가 — 그리드 점 산출 전용.
   * scanSingleStock 과 같은 walk-forward 로직이지만 currentSignal 검증은 건너뛴다
   * (그리드 평가 목적은 "이 (TP, SL) 가 과거 구간에서 얼마나 좋았나" — 오늘 신호와 무관).
   */
  private evaluateStockGridPoint(
    stock: Stock,
    candles: CandleData[],
    runs: {
      strategyId: string;
      variant?: string;
      strategyName: string;
      signalByDate: Map<string, Signal>;
    }[],
    tp: number,
    sl: number,
    investmentAmount: number,
    tradeRatioPct: number,
    commissionPct: number,
    maxHoldingDays: number,
  ): {
    oosReturnPct: number;
    oosWinRate: number;
    oosDrawdownPct: number;
    oosTrades: number;
  } | null {
    const splitIdx = Math.floor(candles.length * (1 - OUT_OF_SAMPLE_RATIO));
    const inSampleCandles = candles.slice(0, splitIdx);
    const outOfSampleCandles = candles.slice(splitIdx);
    if (
      inSampleCandles.length < 30 ||
      outOfSampleCandles.length < MIN_OUT_OF_SAMPLE_TRADES + 10
    ) {
      return null;
    }

    let bestOos: BacktestResult | null = null;
    for (const run of runs) {
      try {
        const config: BacktestConfig = {
          strategyId: run.strategyId,
          variant: run.variant,
          investmentAmount,
          tradeRatioPct,
          commissionPct,
          autoTakeProfitPct: tp,
          autoStopLossPct: sl,
          maxHoldingDays,
          allowAddOnBuy: false,
          minBuySignalStrength: BACKTEST_MIN_BUY_SIGNAL_STRENGTH,
        };

        const inSample = this.simulate(
          stock,
          inSampleCandles,
          run.signalByDate,
          config,
          run.strategyName,
        );
        if (inSample.totalTrades < MIN_IN_SAMPLE_TRADES) continue;
        if (inSample.totalReturnPct <= 0) continue;

        const oos = this.simulate(
          stock,
          outOfSampleCandles,
          run.signalByDate,
          config,
          run.strategyName,
        );
        if (oos.totalTrades < MIN_OUT_OF_SAMPLE_TRADES) continue;
        const oosQuality = this.calculateTradeQuality(oos);
        if (!this.passesOosQuality(oos, oosQuality)) continue;

        if (!bestOos || oos.totalReturnPct > bestOos.totalReturnPct) {
          bestOos = oos;
        }
      } catch {
        // 한 전략 실패는 무시
      }
    }
    if (!bestOos) return null;

    return {
      oosReturnPct: bestOos.totalReturnPct,
      oosWinRate: bestOos.winRate,
      oosDrawdownPct: bestOos.maxDrawdownPct,
      oosTrades: bestOos.totalTrades,
    };
  }

  /**
   * ScheduledScannerService 가 스캔 직전에 호출 — 영속화된 optimal 이 있으면 반환,
   * 없으면 fallback 기본값. 한 번도 그리드 서치를 안 돌렸을 때도 안전하게 동작.
   */
  async getActiveShortTermTpSl(): Promise<{
    tpPct: number;
    slPct: number;
    source: 'optimized' | 'default';
    updatedAt?: string;
    score?: number;
    sampleSize?: number;
  }> {
    const optimal = await this.optimalParamsService.getShortTermTpSl();
    if (optimal) {
      return {
        tpPct: optimal.tpPct,
        slPct: optimal.slPct,
        source: 'optimized',
        updatedAt: optimal.updatedAt,
        score: optimal.score,
        sampleSize: optimal.sampleSize,
      };
    }
    return {
      tpPct: DEFAULT_AUTO_TAKE_PROFIT_PCT,
      slPct: DEFAULT_AUTO_STOP_LOSS_PCT,
      source: 'default',
    };
  }

  private async loadCandles(
    code: string,
  ): Promise<{ stock: Stock; candles: CandleData[] }> {
    const stock = await this.em.findOne(Stock, { code });
    if (!stock) {
      throw new NotFoundException(`종목 코드 ${code}를 찾을 수 없습니다.`);
    }

    const lookbackFrom = new Date();
    lookbackFrom.setMonth(lookbackFrom.getMonth() - SCAN_LOOKBACK_MONTHS);

    const prices = await this.em.find(
      StockDailyPrice,
      { stock, date: { $gte: lookbackFrom } },
      { orderBy: { date: 'ASC' } },
    );

    if (prices.length === 0) {
      throw new NotFoundException(
        `종목 ${code}의 최근 ${SCAN_LOOKBACK_MONTHS}개월 가격 데이터가 없습니다.`,
      );
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
