import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { promises as fs } from 'fs';
import * as path from 'path';
import { ConfigService } from '@nestjs/config';
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
  DEFAULT_DYNAMIC_TP_SL_OPTIONS,
  computeAtrDynamicTpSl,
  pickFreshStrongestSignal,
  computeScaleOutSellQty,
  computeRiskBasedQty,
  evaluateScaleOut,
  DEFAULT_CORRELATION_CLUSTER_OPTIONS,
  DEFAULT_MARKET_REGIME_OPTIONS,
  buildAlignedLogReturns,
  clusterByCorrelation,
  computeMarketRegime,
  type BreadthSnapshot,
  type CorrelationPricePoint,
  type MarketRegimeOptions,
  type MarketRegimeState,
  type ScaleOutPlan,
} from '@alpha-mind/strategies';
import {
  BacktestConfig,
  BacktestResult,
  BacktestTrade,
  GridSearchPoint,
  GridSearchResult,
} from './types/backtest.types';
import {
  RegimeCorrelationOptions,
  ScanResult,
  ScanResponse,
  SurvivorshipBiasEstimate,
} from './types/scan.types';
import { OptimalParamsService } from './optimal-params.service';

/** 타임존 안전한 날짜 키 (YYYY-MM-DD, 로컬 기준) */
function toDateKey(d: Date): string {
  const date = new Date(d);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

interface BreadthAccumulator {
  universeCount: number;
  aboveSma20: number;
  aboveSma60: number;
  dailyReturns: number[];
  ret5d: number[];
  atrPct: number[];
}

function createBreadthAccumulator(): BreadthAccumulator {
  return {
    universeCount: 0,
    aboveSma20: 0,
    aboveSma60: 0,
    dailyReturns: [],
    ret5d: [],
    atrPct: [],
  };
}

function median(values: number[]): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function averageLast(values: number[], period: number): number | undefined {
  if (values.length < period) return undefined;
  const slice = values.slice(-period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

function buildCandlesFromPrices(prices: StockDailyPrice[]): CandleData[] {
  return prices
    .filter((p) => p.close != null)
    .map((p) => ({
      date: p.date,
      open: p.open ?? p.close!,
      high: p.high ?? p.close!,
      low: p.low ?? p.close!,
      close: p.close!,
      volume: p.volume ?? 0,
    }));
}

function lastAtr(candles: CandleData[], period: number): number | undefined {
  if (candles.length < period + 1) return undefined;
  const slice = candles.slice(-(period + 1));
  const trueRanges: number[] = [];

  for (let i = 1; i < slice.length; i++) {
    const high = slice[i].high;
    const low = slice[i].low;
    const prevClose = slice[i - 1].close;
    trueRanges.push(
      Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)),
    );
  }

  return trueRanges.reduce((sum, value) => sum + value, 0) / period;
}

function recordBreadthSample(
  acc: BreadthAccumulator,
  prices: StockDailyPrice[] | undefined,
): void {
  if (!prices || prices.length < 60) return;

  const candles = buildCandlesFromPrices(prices);
  if (candles.length < 60) return;

  const closes = candles.map((c) => c.close);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const close5dAgo = closes[closes.length - 6];
  const sma20 = averageLast(closes, 20);
  const sma60 = averageLast(closes, 60);
  const atr14 = lastAtr(candles, 14);

  acc.universeCount++;
  if (sma20 != null && last > sma20) acc.aboveSma20++;
  if (sma60 != null && last > sma60) acc.aboveSma60++;
  if (prev > 0) acc.dailyReturns.push(((last - prev) / prev) * 100);
  if (close5dAgo > 0) acc.ret5d.push(((last - close5dAgo) / close5dAgo) * 100);
  if (atr14 != null && last > 0) acc.atrPct.push((atr14 / last) * 100);
}

function finalizeBreadth(acc: BreadthAccumulator): BreadthSnapshot {
  const denom = acc.universeCount > 0 ? acc.universeCount : 1;
  return {
    universeCount: acc.universeCount,
    aboveSma20Ratio: acc.aboveSma20 / denom,
    aboveSma60Ratio: acc.aboveSma60 / denom,
    medianDailyReturnPct: median(acc.dailyReturns),
    medianRet5dPct: median(acc.ret5d),
    medianAtrPct: median(acc.atrPct),
  };
}

function pricePointsFromPrices(
  prices: StockDailyPrice[] | undefined,
  lookbackDays: number,
): CorrelationPricePoint[] {
  if (!prices) return [];
  const points = prices
    .filter((p) => p.close != null && Number.isFinite(p.close))
    .map((p) => ({ date: p.date, close: p.close! }));
  return lookbackDays > 0 ? points.slice(-(lookbackDays + 1)) : points;
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
const DEFAULT_SCALE_OUT_ENABLED = false;
const DEFAULT_SCALE_OUT_TP1_TRIGGER_PCT = 2.0;
// 백테스트 튜닝: TP1 50%→33% (러너 추세 확보로 평균수익↑). 검증↔실전 동일값.
const DEFAULT_SCALE_OUT_TP1_SELL_RATIO_PCT = 33;
const DEFAULT_SCALE_OUT_MIN_REMAINDER_QTY = 1;
const DEFAULT_RUNNER_TRAILING_TRIGGER_PCT = 3.5;
const DEFAULT_RUNNER_TRAILING_GIVEBACK_PCT = 2.5;
const DEFAULT_RUNNER_BREAKEVEN_TRIGGER_PCT = 4.0;
const DEFAULT_RUNNER_BREAKEVEN_FLOOR_PCT = 1.0;
const DEFAULT_RUNNER_TAKE_PROFIT_PCT = 6.0;
const DEFAULT_R_SIZING_ENABLED = false;
const DEFAULT_R_RISK_PCT = 0.5;
const DEFAULT_GRID_TP_RANGE = [1.5, 2.0, 2.5, 3.0, 4.0, 5.0, 6.0];
const DEFAULT_GRID_SL_RANGE = [-1.0, -1.5, -2.0, -2.5, -3.0, -4.0, -5.0];

/** 한국 시장 매도 시 거래세 (%) — 2025 기준 0.15(거래세0%+농특세0.15%). */
const DEFAULT_SELL_TAX_PCT = 0.15;
/** 슬리피지 % (양방향). 단타 실측치(0.03~0.1) 중앙값. */
const DEFAULT_SLIPPAGE_PCT = 0.05;
/** 매수를 다음봉 시가에 실행할지 — 실거래(익일 09:00 시가) 패턴과 일치 */
const DEFAULT_USE_NEXT_OPEN_FOR_BUY = true;

/** 스캔 윈도우 — walk-forward 분리를 위해 6개월 데이터를 사용 */
const SCAN_LOOKBACK_MONTHS = 6;
const DEFAULT_SURVIVORSHIP_RETAIN_DELISTED = false;
const DEFAULT_SCAN_INCLUDE_DELISTED_FOR_BACKTEST = false;
const DEFAULT_SURVIVORSHIP_ASSUMED_DELIST_RATE_ANNUAL = 0.02;
const DEFAULT_AVG_DELIST_LOSS_FRACTION = 0.5;
/** Out-of-sample 비율 — 마지막 N% 구간을 검증용으로 분리 */
const OUT_OF_SAMPLE_RATIO = 1 / 3;
/** in-sample 최소 거래수 */
const MIN_IN_SAMPLE_TRADES = 5;
/** out-of-sample 최소 거래수 */
const MIN_OUT_OF_SAMPLE_TRADES = 2;
const MIN_IN_SAMPLE_LENGTH = 30;
const MIN_OOS_LENGTH = MIN_OUT_OF_SAMPLE_TRADES + 10;
const DEFAULT_ROLLING_WF_ENABLED = false;
const HARD_WF_MAX_FOLDS = 3;
const DEFAULT_WF_MAX_FOLDS = 3;
const DEFAULT_WF_MIN_VALID_FOLDS = 2;
const DEFAULT_WF_CONSISTENCY_WEIGHT = 0;
/**
 * OOS 거래 품질 필터 — 낮은 승률/손익비 후보는 실거래 손실로 이어지기 쉬워 제외.
 * 한국 단타 시장 특성(승률 45~55%, PF 1.0~1.3)에 맞춰 완화: 50/1.2/0.35 → 45/1.1/0.25.
 * 기존 임계는 통과 종목 수가 극단적으로 적어 매수 후보가 거의 0건으로 수렴하는 부작용.
 */
const MIN_OOS_WIN_RATE = 45;
const MIN_OOS_PROFIT_FACTOR = 1.1;
const MIN_OOS_EXPECTANCY_PCT = 0;
const MIN_OOS_RETURN_TO_DRAWDOWN = 0.25;
/** RVOL>1 후보에만 가점을 주되 과필터/과가중을 막기 위해 상한을 둔다. */
const RVOL_BONUS_CAP = 2;
const RVOL_BONUS_WEIGHT = 0.5;

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

interface WalkForwardFold {
  foldIndex: number;
  inSampleStart: number;
  inSampleEnd: number;
  oosStart: number;
  oosEnd: number;
}

interface EvaluatedWalkForwardFold {
  fold: WalkForwardFold;
  inSample: BacktestResult;
  outOfSample: BacktestResult;
}

interface WalkForwardEvaluation {
  inSample: BacktestResult;
  outOfSample: BacktestResult;
  folds: EvaluatedWalkForwardFold[];
  wfConsistency: number;
  rollingEnabled: boolean;
  usedFallback: boolean;
}

interface ScaleOutBacktestOptions {
  scaleOut?: ScaleOutPlan;
  runnerTrailingTriggerPct?: number;
  runnerTrailingGivebackPct?: number;
  runnerBreakevenTriggerPct?: number;
  runnerBreakevenFloorPct?: number;
  runnerTakeProfitPct?: number;
  rSizing?: {
    enabled: boolean;
    riskPct: number;
  };
}

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);
  private rollingWfCaveatLogged = false;
  private readonly marketRegimeStatePath = path.resolve(
    process.cwd(),
    'data/market_regime_state.json',
  );

  constructor(
    private readonly em: EntityManager,
    private readonly optimalParamsService: OptimalParamsService,
    private readonly configService: ConfigService,
  ) {}

  private async readMarketRegimeState(): Promise<MarketRegimeState | null> {
    try {
      const raw = await fs.readFile(this.marketRegimeStatePath, 'utf8');
      const parsed = JSON.parse(raw) as MarketRegimeState;
      if (
        typeof parsed.prevSmoothedScore === 'number' &&
        (parsed.prevLabel === 'CRISIS' ||
          parsed.prevLabel === 'NEUTRAL' ||
          parsed.prevLabel === 'ATTACK')
      ) {
        return parsed;
      }
      this.logger.warn(
        'market_regime_state.json 형식이 올바르지 않아 첫 실행 상태로 진행',
      );
      return null;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      this.logger.warn(
        `market_regime_state.json 읽기 실패 — raw 레짐으로 진행: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  private async writeMarketRegimeState(
    regime: NonNullable<ScanResponse['regime']>,
  ): Promise<void> {
    if (regime.source !== 'breadth') return;

    try {
      const state: MarketRegimeState = {
        prevSmoothedScore: regime.smoothedScore,
        prevLabel: regime.label,
        updatedAt: new Date().toISOString(),
      };
      await fs.mkdir(path.dirname(this.marketRegimeStatePath), {
        recursive: true,
      });
      await fs.writeFile(
        this.marketRegimeStatePath,
        JSON.stringify(state, null, 2),
        'utf8',
      );
    } catch (err: any) {
      this.logger.warn(
        `market_regime_state.json 저장 실패 — 다음 스캔에서 첫 실행 상태로 진행 가능: ${err?.message ?? err}`,
      );
    }
  }

  private getNumberConfig(key: string, fallback: number): number {
    const value = this.configService.get<number | string>(key);
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string'
          ? Number(value)
          : Number.NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private getBooleanConfig(key: string, fallback: boolean): boolean {
    const value = this.configService.get<boolean | string>(key);
    if (value === true || value === 'true') return true;
    if (value === false || value === 'false') return false;
    return fallback;
  }

  private buildMarketRegimeOptions(): MarketRegimeOptions {
    return {
      maDays: this.getNumberConfig(
        'REGIME_MA_DAYS',
        DEFAULT_MARKET_REGIME_OPTIONS.maDays,
      ),
      minHoldDays: this.getNumberConfig(
        'REGIME_MIN_HOLD_DAYS',
        DEFAULT_MARKET_REGIME_OPTIONS.minHoldDays,
      ),
      minBreadthSample: this.getNumberConfig(
        'REGIME_MIN_BREADTH_SAMPLE',
        DEFAULT_MARKET_REGIME_OPTIONS.minBreadthSample,
      ),
      ret5dSpanPct: this.getNumberConfig(
        'REGIME_RET5D_SPAN',
        DEFAULT_MARKET_REGIME_OPTIONS.ret5dSpanPct,
      ),
      volFloorPct: this.getNumberConfig(
        'REGIME_VOL_FLOOR_PCT',
        DEFAULT_MARKET_REGIME_OPTIONS.volFloorPct,
      ),
      volCeilPct: this.getNumberConfig(
        'REGIME_VOL_CEIL_PCT',
        DEFAULT_MARKET_REGIME_OPTIONS.volCeilPct,
      ),
      wTrend: this.getNumberConfig(
        'REGIME_W_TREND',
        DEFAULT_MARKET_REGIME_OPTIONS.wTrend,
      ),
      wMomentum: this.getNumberConfig(
        'REGIME_W_MOM',
        DEFAULT_MARKET_REGIME_OPTIONS.wMomentum,
      ),
      wVol: this.getNumberConfig(
        'REGIME_W_VOL',
        DEFAULT_MARKET_REGIME_OPTIONS.wVol,
      ),
      crisisEnter: this.getNumberConfig(
        'REGIME_CRISIS_ENTER',
        DEFAULT_MARKET_REGIME_OPTIONS.crisisEnter,
      ),
      crisisExit: this.getNumberConfig(
        'REGIME_CRISIS_EXIT',
        DEFAULT_MARKET_REGIME_OPTIONS.crisisExit,
      ),
      attackEnter: this.getNumberConfig(
        'REGIME_ATTACK_ENTER',
        DEFAULT_MARKET_REGIME_OPTIONS.attackEnter,
      ),
      attackExit: this.getNumberConfig(
        'REGIME_ATTACK_EXIT',
        DEFAULT_MARKET_REGIME_OPTIONS.attackExit,
      ),
      crisisSlotMultiplier: this.getNumberConfig(
        'REGIME_CRISIS_SLOT_MULT',
        DEFAULT_MARKET_REGIME_OPTIONS.crisisSlotMultiplier,
      ),
      crisisAmountMultiplier: this.getNumberConfig(
        'REGIME_CRISIS_AMOUNT_MULT',
        DEFAULT_MARKET_REGIME_OPTIONS.crisisAmountMultiplier,
      ),
      neutralSlotMultiplier: this.getNumberConfig(
        'REGIME_NEUTRAL_SLOT_MULT',
        DEFAULT_MARKET_REGIME_OPTIONS.neutralSlotMultiplier,
      ),
      neutralAmountMultiplier: this.getNumberConfig(
        'REGIME_NEUTRAL_AMOUNT_MULT',
        DEFAULT_MARKET_REGIME_OPTIONS.neutralAmountMultiplier,
      ),
      attackSlotMultiplier: this.getNumberConfig(
        'REGIME_ATTACK_SLOT_MULT',
        DEFAULT_MARKET_REGIME_OPTIONS.attackSlotMultiplier,
      ),
      attackAmountMultiplier: this.getNumberConfig(
        'REGIME_ATTACK_AMOUNT_MULT',
        DEFAULT_MARKET_REGIME_OPTIONS.attackAmountMultiplier,
      ),
    };
  }

  private buildCorrelationOptions() {
    return {
      threshold: this.getNumberConfig(
        'CORRELATION_THRESHOLD',
        DEFAULT_CORRELATION_CLUSTER_OPTIONS.threshold,
      ),
      minOverlap: this.getNumberConfig(
        'CORR_MIN_OVERLAP',
        DEFAULT_CORRELATION_CLUSTER_OPTIONS.minOverlap,
      ),
      maxClusterSizeWarn: this.getNumberConfig(
        'CORR_MAX_CLUSTER_SIZE_WARN',
        DEFAULT_CORRELATION_CLUSTER_OPTIONS.maxClusterSizeWarn,
      ),
      linkage:
        this.configService.get<'union' | 'average'>('CORR_LINKAGE') ??
        DEFAULT_CORRELATION_CLUSTER_OPTIONS.linkage,
    };
  }

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
    let scaleOutStage = 0;
    let initialQtyAtEntry = 0;
    const trades: BacktestTrade[] = [];
    let totalRealizedPnl = 0;
    let winTrades = 0;
    let lossTrades = 0;

    // MDD 계산용
    let peakValue = config.investmentAmount;
    let maxDrawdownPct = 0;

    const tradeAmount = config.investmentAmount * (config.tradeRatioPct / 100);
    const commissionRate = config.commissionPct / 100;
    const sellTaxRate =
      (config.sellTaxPct ?? this.getDefaultSellTaxPct()) / 100;
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
    const scaleOutPlan: ScaleOutPlan = config.scaleOut ?? {
      enabled: DEFAULT_SCALE_OUT_ENABLED,
      tiers: [
        {
          triggerPct: DEFAULT_SCALE_OUT_TP1_TRIGGER_PCT,
          sellRatioPct: DEFAULT_SCALE_OUT_TP1_SELL_RATIO_PCT,
          tag: 'TP1',
        },
      ],
    };
    const runnerTrailingTriggerPct =
      config.runnerTrailingTriggerPct ?? DEFAULT_RUNNER_TRAILING_TRIGGER_PCT;
    const runnerTrailingGivebackPct =
      config.runnerTrailingGivebackPct ?? DEFAULT_RUNNER_TRAILING_GIVEBACK_PCT;
    const runnerBreakevenTriggerPct =
      config.runnerBreakevenTriggerPct ?? DEFAULT_RUNNER_BREAKEVEN_TRIGGER_PCT;
    const runnerBreakevenFloorPct =
      config.runnerBreakevenFloorPct ?? DEFAULT_RUNNER_BREAKEVEN_FLOOR_PCT;
    const runnerTakeProfitPct =
      config.runnerTakeProfitPct ?? DEFAULT_RUNNER_TAKE_PROFIT_PCT;
    const rSizing = config.rSizing ?? {
      enabled: DEFAULT_R_SIZING_ENABLED,
      riskPct: DEFAULT_R_RISK_PCT,
    };

    /**
     * 매도 체결: rawPrice 에서 슬리피지 차감 → 거래세 + 수수료 부과.
     * 한국 시장의 매도 비용 구조를 백테스트에 일치시켜 실거래 수익과의 갭을 줄인다.
     */
    const tryEvaluateScaleOut = (returnPct: number) => {
      try {
        return evaluateScaleOut(scaleOutPlan, scaleOutStage, returnPct);
      } catch (err: any) {
        this.logger.warn(
          `백테스트 부분익절 평가 실패, 기존 익절 경로로 폴백: ${stock.code} - ${err.message ?? err}`,
        );
        return null;
      }
    };

    const tryComputeScaleOutSellQty = (sellRatioPct: number) => {
      try {
        return computeScaleOutSellQty({
          holdingQty: quantity,
          sellRatioPct,
          minRemainderQty: DEFAULT_SCALE_OUT_MIN_REMAINDER_QTY,
        });
      } catch (err: any) {
        this.logger.warn(
          `백테스트 부분익절 수량 계산 실패, 기존 익절 경로로 폴백: ${stock.code} - ${err.message ?? err}`,
        );
        return 0;
      }
    };

    const computeBacktestBuyQty = (
      fillPrice: number,
      buyAmount: number,
      wasFlat: boolean,
    ) => {
      const legacyQty = Math.floor(buyAmount / fillPrice);
      if (!rSizing.enabled || !wasFlat) {
        return legacyQty;
      }

      try {
        const r = computeRiskBasedQty(
          config.investmentAmount,
          fillPrice,
          config.autoStopLossPct,
          {
            riskPct: rSizing.riskPct,
            budgetCapAmount: buyAmount,
          },
        );
        return r ? Math.min(r.qty, legacyQty) : legacyQty;
      } catch (err: any) {
        this.logger.warn(
          `백테스트 R기반 수량 계산 실패, 기존 비율식으로 폴백: ${stock.code} - ${err.message ?? err}`,
        );
        return legacyQty;
      }
    };

    const reducePosition = (
      candle: CandleData,
      rawPrice: number,
      reason: string,
      sellQty: number,
    ) => {
      const qtyToSell = Math.min(Math.max(0, sellQty), quantity);
      if (qtyToSell <= 0) return;

      const fillPrice = rawPrice * (1 - slippageRate);
      const sellAmount = qtyToSell * fillPrice;
      const commission = sellAmount * commissionRate;
      const sellTax = sellAmount * sellTaxRate;
      const slippageCost = qtyToSell * (rawPrice - fillPrice);
      const totalSellCost = commission + sellTax;
      const pnl = (fillPrice - avgBuyPrice) * qtyToSell - totalSellCost;
      const partial = qtyToSell < quantity;

      totalRealizedPnl += pnl;
      if (pnl > 0) winTrades++;
      else lossTrades++;

      cash += sellAmount - totalSellCost;

      trades.push({
        date: candle.date,
        direction: SignalDirection.Sell,
        price: fillPrice,
        quantity: qtyToSell,
        amount: sellAmount,
        commission,
        sellTax,
        slippageCost,
        reason,
        realizedPnl: pnl,
        ...(partial && { partial: true, initialQtyAtEntry }),
      });

      quantity -= qtyToSell;
      if (quantity <= 0) {
        quantity = 0;
        avgBuyPrice = 0;
        entryIndex = null;
        highestPriceAfterEntry = 0;
        scaleOutStage = 0;
        initialQtyAtEntry = 0;
      }
    };

    const closePosition = (
      candle: CandleData,
      rawPrice: number,
      reason: string,
    ) => {
      reducePosition(candle, rawPrice, reason, quantity);
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
        const isRunner = scaleOutPlan.enabled && scaleOutStage > 0;
        const activeTrailingStopTriggerPct = isRunner
          ? runnerTrailingTriggerPct
          : trailingStopTriggerPct;
        const activeTrailingStopGivebackPct = isRunner
          ? runnerTrailingGivebackPct
          : trailingStopGivebackPct;
        const activeBreakevenTriggerPct = isRunner
          ? runnerBreakevenTriggerPct
          : breakevenTriggerPct;
        const activeBreakevenFloorPct = isRunner
          ? runnerBreakevenFloorPct
          : breakevenFloorPct;
        const takeProfitPrice =
          avgBuyPrice * (1 + config.autoTakeProfitPct / 100);
        const runnerTakeProfitPrice =
          avgBuyPrice * (1 + runnerTakeProfitPct / 100);
        const activeTakeProfitPrice = isRunner
          ? runnerTakeProfitPrice
          : takeProfitPrice;
        const stopLossPrice = avgBuyPrice * (1 + config.autoStopLossPct / 100);
        const breakevenPrice =
          avgBuyPrice * (1 + activeBreakevenFloorPct / 100);
        let peakReturnPct =
          ((highestPriceAfterEntry - avgBuyPrice) / avgBuyPrice) * 100;
        let trailingStopPrice =
          highestPriceAfterEntry * (1 - activeTrailingStopGivebackPct / 100);
        const openReturnPct = ((candle.open - avgBuyPrice) / avgBuyPrice) * 100;

        if (candle.open <= stopLossPrice) {
          closePosition(
            candle,
            candle.open,
            `갭다운 손절 (시가 ${candle.open.toFixed(0)}, 손절선 ${stopLossPrice.toFixed(0)})`,
          );
          exitedThisCandle = true;
        } else if (isRunner && candle.open >= runnerTakeProfitPrice) {
          closePosition(
            candle,
            candle.open,
            `갭상승 러너 익절 (시가 ${candle.open.toFixed(0)}, 익절선 ${runnerTakeProfitPrice.toFixed(0)})`,
          );
          exitedThisCandle = true;
        } else if (scaleOutPlan.enabled) {
          const decision = tryEvaluateScaleOut(openReturnPct);
          const sellQty = decision
            ? tryComputeScaleOutSellQty(decision.tier.sellRatioPct)
            : 0;
          if (decision && sellQty > 0) {
            reducePosition(
              candle,
              candle.open,
              `갭상승 ${decision.tier.tag} 부분익절 (시가 ${candle.open.toFixed(0)}, 수익률 ${openReturnPct.toFixed(1)}%)`,
              sellQty,
            );
            if (quantity > 0) {
              scaleOutStage = decision.nextStage;
            }
            exitedThisCandle = true;
            if (quantity > 0 && candle.low <= stopLossPrice) {
              closePosition(
                candle,
                stopLossPrice,
                `부분익절 후 손절 (수익률 ${config.autoStopLossPct.toFixed(1)}%)`,
              );
            }
          }
        }

        if (!exitedThisCandle && candle.open >= activeTakeProfitPrice) {
          closePosition(
            candle,
            candle.open,
            `갭상승 익절 (시가 ${candle.open.toFixed(0)}, 익절선 ${activeTakeProfitPrice.toFixed(0)})`,
          );
          exitedThisCandle = true;
        }

        if (
          !exitedThisCandle &&
          peakReturnPct >= activeBreakevenTriggerPct &&
          candle.open <= breakevenPrice
        ) {
          closePosition(
            candle,
            candle.open,
            `갭하락 본전 보호 (시가 ${candle.open.toFixed(0)}, 보호선 ${breakevenPrice.toFixed(0)})`,
          );
          exitedThisCandle = true;
        } else if (
          !exitedThisCandle &&
          peakReturnPct >= activeTrailingStopTriggerPct &&
          candle.open <= trailingStopPrice
        ) {
          closePosition(
            candle,
            candle.open,
            `갭하락 트레일링 스톱 (시가 ${candle.open.toFixed(0)}, 추적선 ${trailingStopPrice.toFixed(0)})`,
          );
          exitedThisCandle = true;
        }

        if (!exitedThisCandle) {
          const takeProfitHit = candle.high >= takeProfitPrice;
          const runnerTakeProfitHit =
            isRunner && candle.high >= runnerTakeProfitPrice;
          const stopLossHit = candle.low <= stopLossPrice;
          highestPriceAfterEntry = Math.max(
            highestPriceAfterEntry,
            candle.high,
          );
          peakReturnPct =
            ((highestPriceAfterEntry - avgBuyPrice) / avgBuyPrice) * 100;
          trailingStopPrice =
            highestPriceAfterEntry * (1 - activeTrailingStopGivebackPct / 100);
          const breakevenHit =
            peakReturnPct >= activeBreakevenTriggerPct &&
            candle.low <= breakevenPrice;
          const trailingStopHit =
            peakReturnPct >= activeTrailingStopTriggerPct &&
            candle.low <= trailingStopPrice;
          if (stopLossHit) {
            closePosition(
              candle,
              stopLossPrice,
              `자동 손절 (수익률 ${config.autoStopLossPct.toFixed(1)}%)`,
            );
            exitedThisCandle = true;
          } else if (runnerTakeProfitHit) {
            closePosition(
              candle,
              runnerTakeProfitPrice,
              `러너 익절 (수익률 ${runnerTakeProfitPct.toFixed(1)}%)`,
            );
            exitedThisCandle = true;
          } else if (scaleOutPlan.enabled) {
            const scaleOutReturnPct =
              ((candle.high - avgBuyPrice) / avgBuyPrice) * 100;
            const decision = tryEvaluateScaleOut(scaleOutReturnPct);
            const sellQty = decision
              ? tryComputeScaleOutSellQty(decision.tier.sellRatioPct)
              : 0;
            if (decision && sellQty > 0) {
              const scaleOutPrice =
                avgBuyPrice * (1 + decision.tier.triggerPct / 100);
              reducePosition(
                candle,
                scaleOutPrice,
                `${decision.tier.tag} 부분익절 (수익률 ${decision.tier.triggerPct.toFixed(1)}%)`,
                sellQty,
              );
              if (quantity > 0) {
                scaleOutStage = decision.nextStage;
              }
              exitedThisCandle = true;
              if (quantity > 0 && candle.low <= stopLossPrice) {
                closePosition(
                  candle,
                  stopLossPrice,
                  `부분익절 후 손절 (수익률 ${config.autoStopLossPct.toFixed(1)}%)`,
                );
              }
            }
          }

          if (!exitedThisCandle && !isRunner && takeProfitHit) {
            closePosition(
              candle,
              takeProfitPrice,
              `자동 익절 (수익률 ${config.autoTakeProfitPct.toFixed(1)}%)`,
            );
            exitedThisCandle = true;
          } else if (!exitedThisCandle && breakevenHit) {
            closePosition(
              candle,
              breakevenPrice,
              `본전 보호 (최고 수익률 ${peakReturnPct.toFixed(1)}%)`,
            );
            exitedThisCandle = true;
          } else if (!exitedThisCandle && trailingStopHit) {
            const trailingReturnPct =
              ((trailingStopPrice - avgBuyPrice) / avgBuyPrice) * 100;
            closePosition(
              candle,
              trailingStopPrice,
              `트레일링 스톱 (최고 ${peakReturnPct.toFixed(1)}%, 청산 ${trailingReturnPct.toFixed(1)}%)`,
            );
            exitedThisCandle = true;
          } else if (
            !exitedThisCandle &&
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
            const wasFlat = quantity === 0;
            const qty = computeBacktestBuyQty(fillPrice, buyAmount, wasFlat);
            if (qty > 0) {
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
              initialQtyAtEntry = quantity;
              scaleOutStage = 0;

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
    scaleOutOptions: ScaleOutBacktestOptions = {},
    regimeCorrelationOptions: RegimeCorrelationOptions = {},
  ): Promise<ScanResponse> {
    const logger = new Logger('BacktestService');
    const startTime = Date.now();
    const regimeEnabled = regimeCorrelationOptions.regimeEnabled === true;
    const correlationEnabled =
      regimeCorrelationOptions.correlationEnabled === true;
    const correlationLookbackDays =
      regimeCorrelationOptions.correlationLookbackDays ??
      this.getNumberConfig('CORR_LOOKBACK_DAYS', 60);

    const lookbackFrom = new Date();
    lookbackFrom.setMonth(lookbackFrom.getMonth() - SCAN_LOOKBACK_MONTHS);
    const retainDelisted = this.getBooleanConfig(
      'SURVIVORSHIP_RETAIN_DELISTED',
      DEFAULT_SURVIVORSHIP_RETAIN_DELISTED,
    );
    const includeDelistedForBacktest = this.getBooleanConfig(
      'SCAN_INCLUDE_DELISTED_FOR_BACKTEST',
      DEFAULT_SCAN_INCLUDE_DELISTED_FOR_BACKTEST,
    );

    // 1. 전체 종목 로드
    const allStocks = await this.em.find(Stock, {});
    const excludeSet = new Set(excludeCodes);
    const survivorshipBias = this.estimateSurvivorshipBias(allStocks);

    // 2. 단기 walk-forward 검증을 위해 60거래일 이상 데이터가 있는 종목만 필터
    const knex = this.em.getKnex();
    const countRows = await knex('stock_daily_prices')
      .select('stock_id')
      .count('* as cnt')
      .where('date', '>=', lookbackFrom)
      .groupBy('stock_id')
      .having(knex.raw('count(*) >= 60'));

    const eligibleStockIds = new Set(countRows.map((r: any) => r.stock_id));

    // DB having 쿼리에서는 상폐를 제외하지 않는다. 현재 매수 스캔과
    // 보존 종목 백테스트의 유니버스 분기는 이 코드 한 곳에서만 결정한다.
    const eligibleStocks = allStocks.filter(
      (stock) =>
        eligibleStockIds.has(stock.id) &&
        !excludeSet.has(stock.code) &&
        (includeDelistedForBacktest || stock.delistedAt == null),
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
      delistedAt: s.delistedAt ?? undefined,
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
    const breadthAcc = regimeEnabled ? createBreadthAccumulator() : null;
    const candidatePriceSeriesByCode = new Map<string, CorrelationPricePoint[]>();
    let lastYieldAt = Date.now();
    let eligibleStockCount = 0;

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
        const prices = pricesByStockId.get(stock.id);
        if (
          stock.delistedAt != null &&
          !this.isDelistedStockEligibleAtWindowEnd(stock.delistedAt, prices)
        ) {
          continue;
        }
        eligibleStockCount++;

        if (breadthAcc) {
          try {
            recordBreadthSample(breadthAcc, prices);
          } catch (err) {
            logger.debug(
              `breadth skip ${stock.code}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

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
            scaleOutOptions,
          );
          if (result) {
            allResults.push(result);
            if (correlationEnabled) {
              candidatePriceSeriesByCode.set(
                result.stockCode,
                pricePointsFromPrices(prices, correlationLookbackDays),
              );
            }
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
    let regime: ScanResponse['regime'];
    let clusters: ScanResponse['clusters'];

    if (regimeEnabled && breadthAcc) {
      try {
        const source =
          this.configService.get<string>('REGIME_INDEX_SOURCE') ?? 'breadth';
        if (source !== 'breadth') {
          logger.warn(
            `REGIME_INDEX_SOURCE=${source} 는 Sprint3 미구현 — breadth 산출로 폴백`,
          );
        }
        const breadth = finalizeBreadth(breadthAcc);
        const prevRegime =
          regimeCorrelationOptions.prevRegime ??
          (await this.readMarketRegimeState());
        regime = computeMarketRegime(
          breadth,
          prevRegime,
          {
            ...this.buildMarketRegimeOptions(),
            ...(regimeCorrelationOptions.regimeOptions ?? {}),
          },
        );
        await this.writeMarketRegimeState(regime);
      } catch (err) {
        const breadth = finalizeBreadth(breadthAcc);
        regime = {
          label: 'NEUTRAL',
          rawScore: 0.5,
          smoothedScore: 0.5,
          slotMultiplier: 1,
          amountMultiplier: 1,
          breadth,
          source: 'fallback',
        };
        logger.warn(
          `시장 레짐 계산 실패 — NEUTRAL 폴백: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    if (correlationEnabled) {
      try {
        const priceSeriesByCode = new Map<string, CorrelationPricePoint[]>();
        for (const result of topResults) {
          const series = candidatePriceSeriesByCode.get(result.stockCode);
          if (series && series.length > 0) {
            priceSeriesByCode.set(result.stockCode, series);
          }
        }

        const activeSeries = await this.loadCorrelationPriceSeries(
          regimeCorrelationOptions.correlationCodes ?? [],
          lookbackFrom,
          correlationLookbackDays,
        );
        for (const [code, series] of activeSeries) {
          if (series.length > 0) priceSeriesByCode.set(code, series);
        }

        if (priceSeriesByCode.size >= 2) {
          const returnsByCode = buildAlignedLogReturns(
            priceSeriesByCode,
            correlationLookbackDays,
          );
          const clusterResult = clusterByCorrelation(returnsByCode, {
            ...this.buildCorrelationOptions(),
            ...(regimeCorrelationOptions.correlationOptions ?? {}),
          });
          for (const result of topResults) {
            const clusterId = clusterResult.clusterByCode.get(result.stockCode);
            if (clusterId != null) result.clusterId = clusterId;
          }
          clusters = clusterResult.clusters;

          if (clusterResult.largeClusters.length > 0) {
            logger.warn(
              `상관 거대 클러스터 감지: ` +
                clusterResult.largeClusters
                  .map((c) => `#${c.clusterId}(${c.size})`)
                  .join(', '),
            );
          }
        }
      } catch (err) {
        logger.warn(
          `상관 클러스터 계산 실패 — 캡 미적용 폴백: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    const elapsedMs = Date.now() - startTime;
    logger.log(
      `스캔 완료: ${elapsedMs}ms, 결과 ${allResults.length}개 중 Top ${topResults.length}`,
    );

    const response: ScanResponse = {
      scannedStocks: allStocks.length,
      eligibleStocks: eligibleStockCount,
      excludedStocks: excludeCodes.length,
      elapsedMs,
      results: topResults,
      ...(regime && { regime }),
      ...(clusters && { clusters }),
    };

    // 토글 OFF에서는 JSON.stringify 결과를 기존 응답과 바이트 동일하게 유지한다.
    Object.defineProperty(response, 'survivorshipBias', {
      value: survivorshipBias,
      enumerable: retainDelisted,
      configurable: false,
      writable: false,
    });

    return response;
  }

  private isDelistedStockEligibleAtWindowEnd(
    delistedAt: Date,
    prices: StockDailyPrice[] | undefined,
  ): boolean {
    if (!prices || prices.length === 0) return false;

    const windowEnd = prices[prices.length - 1].date;
    return delistedAt.getTime() > new Date(windowEnd).getTime();
  }

  /**
   * 추정 haircut은 성과에서 빼지 않고 caveat로만 노출한다.
   * 전향적 보존 이전의 과거 상폐는 소급 복구할 수 없으므로 실측 보정치가 아니다.
   */
  private estimateSurvivorshipBias(
    stocks: Pick<Stock, 'delistedAt'>[],
  ): SurvivorshipBiasEstimate {
    const annualRate = Math.max(
      0,
      this.getNumberConfig(
        'SURVIVORSHIP_ASSUMED_DELIST_RATE_ANNUAL',
        DEFAULT_SURVIVORSHIP_ASSUMED_DELIST_RATE_ANNUAL,
      ),
    );
    const avgLossFraction = Math.max(
      0,
      this.getNumberConfig(
        'AVG_DELIST_LOSS_FRACTION',
        DEFAULT_AVG_DELIST_LOSS_FRACTION,
      ),
    );
    const windowYears = SCAN_LOOKBACK_MONTHS / 12;
    const estimatedReturnHaircutPct =
      Math.round(annualRate * windowYears * avgLossFraction * 10_000) / 100;

    return {
      universeSize: stocks.length,
      delistedRetained: stocks.filter((stock) => stock.delistedAt != null)
        .length,
      assumedAnnualDelistRate: annualRate,
      estimatedReturnHaircutPct,
      researchAnchor: 'CAGR 26%→12%(모멘텀, 외부)',
      note: 'forward-only 보존 이전 구간은 소급 복구 불가. 약 131거래일에는 즉효가 없고 가정 기반 추정일 뿐 실측이 아니며, OOS 성과는 여전히 낙관 편향됐을 수 있음. 성과 수치에서는 차감하지 않음.',
    };
  }

  private async loadCorrelationPriceSeries(
    codes: string[],
    lookbackFrom: Date,
    lookbackDays: number,
  ): Promise<Map<string, CorrelationPricePoint[]>> {
    const uniqueCodes = [...new Set(codes.filter(Boolean))];
    const result = new Map<string, CorrelationPricePoint[]>();
    if (uniqueCodes.length === 0) return result;

    type CorrelationPriceRow = {
      code: string;
      date: Date | string;
      close: number | string | null;
    };

    const rows = (await this.em
      .getKnex()('stock_daily_prices as p')
      .join('stocks as s', 's.id', 'p.stock_id')
      .select('s.code', 'p.date', 'p.close')
      .whereIn('s.code', uniqueCodes)
      .andWhere('p.date', '>=', lookbackFrom)
      .orderBy([
        { column: 's.code' },
        { column: 'p.date', order: 'asc' },
      ])) as CorrelationPriceRow[];

    for (const row of rows) {
      const close =
        typeof row.close === 'number'
          ? row.close
          : row.close == null
            ? Number.NaN
            : Number(row.close);
      if (!Number.isFinite(close) || close <= 0) continue;

      const bucket = result.get(row.code) ?? [];
      bucket.push({ date: row.date, close });
      result.set(row.code, bucket);
    }

    for (const [code, series] of result) {
      if (lookbackDays > 0) {
        result.set(code, series.slice(-(lookbackDays + 1)));
      }
    }

    return result;
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
    scaleOutOptions: ScaleOutBacktestOptions = {},
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
      scaleOutOptions,
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

  private buildWalkForwardFolds(candleCount: number): WalkForwardFold[] {
    const legacySplit = Math.floor(
      candleCount * (1 - OUT_OF_SAMPLE_RATIO),
    );
    const legacyFold: WalkForwardFold = {
      foldIndex: 0,
      inSampleStart: 0,
      inSampleEnd: legacySplit,
      oosStart: legacySplit,
      oosEnd: candleCount,
    };

    if (
      !this.getBooleanConfig(
        'ROLLING_WF_ENABLED',
        DEFAULT_ROLLING_WF_ENABLED,
      )
    ) {
      return [legacyFold];
    }

    const configuredMode =
      this.configService.get<string>('WF_MODE') ?? 'anchored';
    if (configuredMode !== 'anchored' && !this.rollingWfCaveatLogged) {
      this.logger.warn(
        `WF_MODE=${configuredMode} 는 약 131거래일에서 in-sample 부족 위험이 있어 anchored로 폴백합니다.`,
      );
    }

    const configuredMaxFolds = Math.max(
      1,
      Math.floor(
        this.getNumberConfig('WF_MAX_FOLDS', DEFAULT_WF_MAX_FOLDS),
      ),
    );
    const potentialFoldCount = Math.floor(
      (candleCount - MIN_IN_SAMPLE_LENGTH) / MIN_OOS_LENGTH,
    );
    const foldCount = Math.min(
      HARD_WF_MAX_FOLDS,
      configuredMaxFolds,
      potentialFoldCount,
    );

    if (foldCount < DEFAULT_WF_MIN_VALID_FOLDS) {
      return [legacyFold];
    }

    const oosLength = Math.ceil(
      (candleCount - MIN_IN_SAMPLE_LENGTH) / foldCount,
    );
    const folds: WalkForwardFold[] = [];

    for (let index = 0; index < foldCount; index++) {
      const oosStart = MIN_IN_SAMPLE_LENGTH + index * oosLength;
      const oosEnd = Math.min(oosStart + oosLength, candleCount);
      if (oosEnd - oosStart < MIN_OOS_LENGTH) continue;

      folds.push({
        foldIndex: index,
        inSampleStart: 0,
        inSampleEnd: oosStart,
        oosStart,
        oosEnd,
      });
    }

    return folds.length >= DEFAULT_WF_MIN_VALID_FOLDS
      ? folds
      : [legacyFold];
  }

  private simulateWalkForwardRun(
    stock: Stock,
    candles: CandleData[],
    signalByDate: Map<string, Signal>,
    config: BacktestConfig,
    strategyName: string,
    legacyRequirePositiveOos = true,
  ): WalkForwardEvaluation | null {
    const rollingEnabled = this.getBooleanConfig(
      'ROLLING_WF_ENABLED',
      DEFAULT_ROLLING_WF_ENABLED,
    );

    if (rollingEnabled && !this.rollingWfCaveatLogged) {
      this.logger.warn(
        '롤링 WF는 약 131거래일 한계상 폴드당 OOS 2~5건의 추세 일관성 확인까지만 유효합니다. 통계적 유의성을 주장할 수 없고 절대치를 과신하면 안 됩니다.',
      );
      this.rollingWfCaveatLogged = true;
    }

    const folds = this.buildWalkForwardFolds(candles.length);
    if (!rollingEnabled || folds.length === 1) {
      const evaluated = this.evaluateLegacyWalkForwardFold(
        stock,
        candles,
        signalByDate,
        config,
        strategyName,
        folds[0],
        legacyRequirePositiveOos,
      );
      if (!evaluated) return null;

      return {
        inSample: evaluated.inSample,
        outOfSample: evaluated.outOfSample,
        folds: [evaluated],
        wfConsistency: evaluated.outOfSample.totalReturnPct > 0 ? 1 : 0,
        rollingEnabled,
        usedFallback: rollingEnabled,
      };
    }

    const evaluatedFolds: EvaluatedWalkForwardFold[] = [];
    for (const fold of folds) {
      const inSampleCandles = candles.slice(0, fold.oosStart);
      const outOfSampleCandles = candles.slice(fold.oosStart, fold.oosEnd);
      if (
        inSampleCandles.length < MIN_IN_SAMPLE_LENGTH ||
        outOfSampleCandles.length < MIN_OOS_LENGTH
      ) {
        continue;
      }

      const inSample = this.simulate(
        stock,
        inSampleCandles,
        signalByDate,
        config,
        strategyName,
      );
      if (inSample.totalTrades < MIN_IN_SAMPLE_TRADES) continue;

      const outOfSample = this.simulate(
        stock,
        outOfSampleCandles,
        signalByDate,
        config,
        strategyName,
      );
      if (outOfSample.totalTrades < MIN_OUT_OF_SAMPLE_TRADES) continue;

      evaluatedFolds.push({ fold, inSample, outOfSample });
    }

    const minValidFolds = Math.max(
      1,
      Math.floor(
        this.getNumberConfig(
          'WF_MIN_VALID_FOLDS',
          DEFAULT_WF_MIN_VALID_FOLDS,
        ),
      ),
    );
    if (evaluatedFolds.length < minValidFolds) {
      const legacyFold = {
        foldIndex: 0,
        inSampleStart: 0,
        inSampleEnd: Math.floor(
          candles.length * (1 - OUT_OF_SAMPLE_RATIO),
        ),
        oosStart: Math.floor(candles.length * (1 - OUT_OF_SAMPLE_RATIO)),
        oosEnd: candles.length,
      };
      const fallback = this.evaluateLegacyWalkForwardFold(
        stock,
        candles,
        signalByDate,
        config,
        strategyName,
        legacyFold,
        legacyRequirePositiveOos,
      );
      if (!fallback) return null;

      return {
        inSample: fallback.inSample,
        outOfSample: fallback.outOfSample,
        folds: [fallback],
        wfConsistency: fallback.outOfSample.totalReturnPct > 0 ? 1 : 0,
        rollingEnabled: true,
        usedFallback: true,
      };
    }

    const outOfSample = this.aggregateBacktestResults(
      evaluatedFolds.map((fold) => fold.outOfSample),
    );
    const positiveFoldCount = evaluatedFolds.filter(
      (fold) => fold.outOfSample.totalReturnPct > 0,
    ).length;

    return {
      // 앵커드 in-sample은 중첩되므로 가장 큰 마지막 확장 윈도우를 대표값으로 쓴다.
      inSample: evaluatedFolds[evaluatedFolds.length - 1].inSample,
      outOfSample,
      folds: evaluatedFolds,
      wfConsistency:
        Math.round((positiveFoldCount / evaluatedFolds.length) * 1000) / 1000,
      rollingEnabled: true,
      usedFallback: false,
    };
  }

  private evaluateLegacyWalkForwardFold(
    stock: Stock,
    candles: CandleData[],
    signalByDate: Map<string, Signal>,
    config: BacktestConfig,
    strategyName: string,
    fold: WalkForwardFold,
    requirePositiveOos: boolean,
  ): EvaluatedWalkForwardFold | null {
    const inSampleCandles = candles.slice(0, fold.oosStart);
    const outOfSampleCandles = candles.slice(fold.oosStart, fold.oosEnd);
    if (
      inSampleCandles.length < MIN_IN_SAMPLE_LENGTH ||
      outOfSampleCandles.length < MIN_OOS_LENGTH
    ) {
      return null;
    }

    const inSample = this.simulate(
      stock,
      inSampleCandles,
      signalByDate,
      config,
      strategyName,
    );
    if (inSample.totalTrades < MIN_IN_SAMPLE_TRADES) return null;
    if (inSample.totalReturnPct <= 0) return null;

    const outOfSample = this.simulate(
      stock,
      outOfSampleCandles,
      signalByDate,
      config,
      strategyName,
    );
    if (outOfSample.totalTrades < MIN_OUT_OF_SAMPLE_TRADES) return null;
    if (requirePositiveOos && outOfSample.totalReturnPct <= 0) return null;

    return { fold, inSample, outOfSample };
  }

  private aggregateBacktestResults(
    results: BacktestResult[],
  ): BacktestResult {
    const first = results[0];
    const last = results[results.length - 1];
    let compoundedValue = first.investmentAmount;

    for (const result of results) {
      compoundedValue *= 1 + result.totalReturnPct / 100;
    }

    const totalTrades = results.reduce(
      (sum, result) => sum + result.totalTrades,
      0,
    );
    const winTrades = results.reduce(
      (sum, result) => sum + result.winTrades,
      0,
    );
    const lossTrades = results.reduce(
      (sum, result) => sum + result.lossTrades,
      0,
    );

    return {
      stockCode: first.stockCode,
      stockName: first.stockName,
      strategyId: first.strategyId,
      strategyName: first.strategyName,
      variant: first.variant,
      period: {
        from: first.period.from,
        to: last.period.to,
      },
      investmentAmount: first.investmentAmount,
      finalValue: Math.round(compoundedValue),
      totalReturnPct:
        Math.round(
          ((compoundedValue - first.investmentAmount) /
            first.investmentAmount) *
            10_000,
        ) / 100,
      totalRealizedPnl: Math.round(
        results.reduce(
          (sum, result) => sum + result.totalRealizedPnl,
          0,
        ),
      ),
      unrealizedPnl: Math.round(
        results.reduce((sum, result) => sum + result.unrealizedPnl, 0),
      ),
      totalTrades,
      winTrades,
      lossTrades,
      winRate:
        totalTrades > 0
          ? Math.round((winTrades / totalTrades) * 10_000) / 100
          : 0,
      maxDrawdownPct: Math.max(
        ...results.map((result) => result.maxDrawdownPct),
      ),
      remainingCash: Math.round(compoundedValue),
      remainingQuantity: results.reduce(
        (sum, result) => sum + result.remainingQuantity,
        0,
      ),
      trades: results.flatMap((result) => result.trades),
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
    scaleOutOptions: ScaleOutBacktestOptions = {},
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

    const structuralFolds = this.buildWalkForwardFolds(candles.length);
    if (
      structuralFolds.length === 0 ||
      structuralFolds.every(
        (fold) =>
          fold.inSampleEnd - fold.inSampleStart < MIN_IN_SAMPLE_LENGTH ||
          fold.oosEnd - fold.oosStart < MIN_OOS_LENGTH,
      )
    ) {
      return null;
    }

    // 공통 매수 리스크 필터: 유동성 부족/고변동/하락 추세/과열 후보는 제외.
    const riskProfile = evaluateLongBuyRisk(candles);
    if (!riskProfile.passed) {
      return null;
    }
    const volatilityPct = riskProfile.volatilityPct;
    // 종목별 ATR 보정 TP/SL 을 백테스트부터 적용한다.
    // backend 세션도 ScanResult 의 같은 값을 사용하므로 검증 룰과 실전 룰이 어긋나지 않는다.
    const dynamicTpSl = computeAtrDynamicTpSl(
      autoTakeProfitPct,
      autoStopLossPct,
      volatilityPct,
    );

    let bestResult: {
      strategyId: string;
      strategyName: string;
      variant?: string;
      inSample: BacktestResult;
      outOfSample: BacktestResult;
      rankScore: number;
      analysis: StrategyAnalysisResult;
      currentSignal: Signal;
      tradeQuality: TradeQuality;
      folds: EvaluatedWalkForwardFold[];
      wfConsistency: number;
      rollingEnabled: boolean;
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
            autoTakeProfitPct: dynamicTpSl.takeProfitPct,
            autoStopLossPct: dynamicTpSl.stopLossPct,
            maxHoldingDays,
            allowAddOnBuy: false,
            minBuySignalStrength: BACKTEST_MIN_BUY_SIGNAL_STRENGTH,
            ...scaleOutOptions,
          };

          const walkForward = this.simulateWalkForwardRun(
            stock,
            candles,
            signalByDate,
            config,
            strategy.name,
          );
          if (!walkForward) continue;

          const { inSample, outOfSample } = walkForward;
          if (inSample.totalReturnPct <= 0) continue;
          if (outOfSample.totalReturnPct <= 0) continue;
          const tradeQuality = this.calculateTradeQuality(outOfSample);
          if (!this.passesOosQuality(outOfSample, tradeQuality)) continue;

          // 합산 거래수 최소치 (튜닝 가능한 통계 신뢰도 임계)
          const combinedTrades = inSample.totalTrades + outOfSample.totalTrades;
          if (combinedTrades < minTotalTrades) continue;

          // 스캔 매수 후보는 "현재 상태"가 아니라 fresh BUY 중 가장 강한 신호로 판단한다.
          // currentSignal 자체는 최신 방향 표시용이므로 반대 신호와 섞어 쓰지 않는다.
          const currentSignal = pickFreshStrongestSignal(
            signals,
            candles[candles.length - 1],
            SignalDirection.Buy,
            { tradingDates: candles },
          );
          if (
            !currentSignal ||
            currentSignal.strength < minCurrentSignalStrength
          ) {
            continue;
          }

          // 랭킹은 집계 OOS 지표 기준이며 폴드별 양수 AND 조건을 요구하지 않는다.
          const baseRankScore = this.calculateScanRankScore(
            outOfSample,
            currentSignal.strength,
            tradeQuality,
            riskProfile,
          );
          const consistencyBonus = walkForward.rollingEnabled
            ? walkForward.wfConsistency *
              this.getNumberConfig(
                'WF_CONSISTENCY_WEIGHT',
                DEFAULT_WF_CONSISTENCY_WEIGHT,
              )
            : 0;
          const rankScore =
            Math.round((baseRankScore + consistencyBonus) * 100) / 100;

          if (!bestResult || rankScore > bestResult.rankScore) {
            bestResult = {
              strategyId,
              strategyName: strategy.name,
              variant,
              inSample,
              outOfSample,
              rankScore,
              analysis,
              currentSignal,
              tradeQuality,
              folds: walkForward.folds,
              wfConsistency: walkForward.wfConsistency,
              rollingEnabled: walkForward.rollingEnabled,
            };
          }
        } catch {
          // 전략/변형 분석 실패 시 건너뛰기
        }
      }
    }

    if (!bestResult) return null;

    const { analysis, currentSignal, inSample, outOfSample } = bestResult;

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
      autoTakeProfitPct: dynamicTpSl.takeProfitPct,
      autoStopLossPct: dynamicTpSl.stopLossPct,
      profitFactor: bestResult.tradeQuality.profitFactor,
      expectancyPct: bestResult.tradeQuality.expectancyPct,
      riskProfile: {
        avgTurnover20: riskProfile.avgTurnover20,
        sma20Slope5dPct: riskProfile.sma20Slope5dPct,
        priceFromSma20Pct: riskProfile.priceFromSma20Pct,
        priceFromSma60Pct: riskProfile.priceFromSma60Pct,
        recent5dReturnPct: riskProfile.recent5dReturnPct,
        rvol: riskProfile.rvol,
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
      ...(bestResult.rollingEnabled && {
        folds: bestResult.folds.map(({ fold, inSample, outOfSample }) => ({
          foldIndex: fold.foldIndex,
          inSampleLength: fold.inSampleEnd - fold.inSampleStart,
          outOfSampleLength: fold.oosEnd - fold.oosStart,
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
        })),
        wfConsistency: bestResult.wfConsistency,
      }),
      summary: analysis.summary,
      currentSignal: {
        direction: currentSignal.direction,
        strength: currentSignal.strength,
        reason: currentSignal.reason,
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
    const rvolBonus =
      riskProfile.rvol != null
        ? Math.min(Math.max(riskProfile.rvol - 1, 0), RVOL_BONUS_CAP) *
          RVOL_BONUS_WEIGHT
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
          extensionPenalty +
          rvolBonus) *
          100,
      ) / 100
    );
  }

  private getDefaultSellTaxPct(): number {
    const value = Number(
      this.configService.get<number | string>(
        'BACKTEST_SELL_TAX_PCT',
        DEFAULT_SELL_TAX_PCT,
      ),
    );

    return Number.isFinite(value) ? value : DEFAULT_SELL_TAX_PCT;
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
    scaleOut?: ScaleOutPlan;
    runnerTrailingTriggerPct?: number;
    runnerTrailingGivebackPct?: number;
    runnerBreakevenTriggerPct?: number;
    runnerBreakevenFloorPct?: number;
    runnerTakeProfitPct?: number;
    rSizing?: {
      enabled: boolean;
      riskPct: number;
    };
  }): Promise<GridSearchResult> {
    const logger = new Logger('BacktestService.gridSearchOptimalTpSl');
    const startTime = Date.now();

    // 주간 자동 최적화가 4/-1 같은 경계값에 붙으면 실제 최적점이 범위 밖인지 알 수 없다.
    // ATR 동적 보정의 운용 상한(6/-5)까지 기본 탐색 범위를 넓혀 경계 bias 를 줄인다.
    const tpRange = opts?.tpRange ?? DEFAULT_GRID_TP_RANGE;
    const slRange = opts?.slRange ?? DEFAULT_GRID_SL_RANGE;
    const sampleSize = opts?.stockSampleSize ?? 50;
    const investmentAmount = opts?.investmentAmount ?? 1_000_000;
    const tradeRatioPct = 100; // 그리드 평가는 단일 매매 풀 사용 — 결과 노이즈 최소화
    const commissionPct = 0.015;
    const maxHoldingDays = opts?.maxHoldingDays ?? DEFAULT_MAX_HOLDING_DAYS;
    const scaleOutOptions: ScaleOutBacktestOptions = {
      scaleOut: opts?.scaleOut,
      runnerTrailingTriggerPct: opts?.runnerTrailingTriggerPct,
      runnerTrailingGivebackPct: opts?.runnerTrailingGivebackPct,
      runnerBreakevenTriggerPct: opts?.runnerBreakevenTriggerPct,
      runnerBreakevenFloorPct: opts?.runnerBreakevenFloorPct,
      runnerTakeProfitPct: opts?.runnerTakeProfitPct,
      rSizing: opts?.rSizing,
    };

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
            scaleOutOptions,
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
    scaleOutOptions: ScaleOutBacktestOptions = {},
  ): {
    oosReturnPct: number;
    oosWinRate: number;
    oosDrawdownPct: number;
    oosTrades: number;
  } | null {
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
          ...scaleOutOptions,
        };

        const walkForward = this.simulateWalkForwardRun(
          stock,
          candles,
          run.signalByDate,
          config,
          run.strategyName,
          false,
        );
        if (!walkForward) continue;

        const { inSample, outOfSample: oos } = walkForward;
        if (inSample.totalReturnPct <= 0) continue;
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
    dynamicTpSl: typeof DEFAULT_DYNAMIC_TP_SL_OPTIONS;
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
        dynamicTpSl: DEFAULT_DYNAMIC_TP_SL_OPTIONS,
      };
    }
    return {
      tpPct: DEFAULT_AUTO_TAKE_PROFIT_PCT,
      slPct: DEFAULT_AUTO_STOP_LOSS_PCT,
      source: 'default',
      dynamicTpSl: DEFAULT_DYNAMIC_TP_SL_OPTIONS,
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
