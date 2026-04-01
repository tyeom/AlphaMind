/** OHLCV 캔들 데이터 */
export interface CandleData {
  date: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** 매매 신호 방향 */
export enum SignalDirection {
  Buy = 'BUY',
  Sell = 'SELL',
  Neutral = 'NEUTRAL',
}

/** 개별 매매 신호 */
export interface Signal {
  direction: SignalDirection;
  strength: number; // 0 ~ 1
  reason: string;
  date: Date;
  price: number;
  metadata?: Record<string, unknown>;
}

/** 전략 분석 결과 (공통) */
export interface StrategyAnalysisResult {
  strategyName: string;
  stockCode: string;
  analyzedPeriod: { from: Date; to: Date };
  currentSignal: Signal;
  signals: Signal[];
  indicators: Record<string, unknown>;
  summary: string;
}

// ─── Day Trading Types ───

export enum DayTradingVariant {
  Breakout = 'breakout',
  Crossover = 'crossover',
  VolumeSurge = 'volume_surge',
}

export interface BreakoutConfig {
  kFactor: number;
  lookbackPeriod: number;
}

export interface CrossoverConfig {
  shortPeriod: number;
  longPeriod: number;
}

export interface VolumeSurgeConfig {
  volumeMultiplier: number;
  volumePeriod: number;
  consecutiveUpCandles: number;
  rsiOverbought: number;
  rsiPeriod: number;
}

export interface DayTradingConfig {
  variant: DayTradingVariant;
  breakout: BreakoutConfig;
  crossover: CrossoverConfig;
  volumeSurge: VolumeSurgeConfig;
}

// ─── Mean Reversion Types ───

export enum MeanReversionVariant {
  RSI = 'rsi',
  Bollinger = 'bollinger',
  Grid = 'grid',
  MagicSplit = 'magic_split',
}

export interface RsiStrategyConfig {
  period: number;
  oversold: number;
  overbought: number;
}

export interface BollingerStrategyConfig {
  period: number;
  stdMultiplier: number;
}

export interface GridStrategyConfig {
  spacingPct: number;
  levels: number;
}

export interface SplitLevel {
  triggerRate: number;
  targetRate: number;
  amount: number;
}

export interface MagicSplitConfig {
  levels: SplitLevel[];
}

export interface MeanReversionConfig {
  variant: MeanReversionVariant;
  rsi: RsiStrategyConfig;
  bollinger: BollingerStrategyConfig;
  grid: GridStrategyConfig;
  magicSplit: MagicSplitConfig;
}

// ─── Infinity Bot Types ───

export interface InfinityBotConfig {
  totalAmount: number;
  maxRounds: number;
  roundPct: number;
  dipTriggerPct: number;
  takeProfitPct: number;
}

export interface RoundInfo {
  round: number;
  entryPrice: number;
  quantity: number;
  date: Date;
}

export interface InfinityBotResult extends StrategyAnalysisResult {
  simulation: {
    rounds: RoundInfo[];
    currentRound: number;
    avgPrice: number | null;
    totalQuantity: number;
    investedAmount: number;
    currentReturn: number | null;
    takeProfitTriggered: boolean;
  };
}

// ─── Candle Pattern Types ───

export enum CandlePatternType {
  Hammer = 'Hammer',
  InvertedHammer = 'InvertedHammer',
  HangingMan = 'HangingMan',
  ShootingStar = 'ShootingStar',
  Doji = 'Doji',
  LongLeggedDoji = 'LongLeggedDoji',
  DragonflyDoji = 'DragonflyDoji',
  GravestoneDoji = 'GravestoneDoji',
  Marubozu = 'Marubozu',
  SpinningTop = 'SpinningTop',
  BullishEngulfing = 'BullishEngulfing',
  BearishEngulfing = 'BearishEngulfing',
  BullishHarami = 'BullishHarami',
  BearishHarami = 'BearishHarami',
  MorningStar = 'MorningStar',
  EveningStar = 'EveningStar',
  ThreeWhiteSoldiers = 'ThreeWhiteSoldiers',
  ThreeBlackCrows = 'ThreeBlackCrows',
}

export enum PatternDirection {
  Bullish = 'Bullish',
  Bearish = 'Bearish',
  Neutral = 'Neutral',
}

export interface DetectedPattern {
  patternType: CandlePatternType;
  direction: PatternDirection;
  strength: number;
  confirmation: boolean;
  date: Date;
  price: number;
}

export interface CandlePatternConfig {
  minPatternStrength: number;
  useVolumeConfirmation: boolean;
  useTrendConfirmation: boolean;
  trendPeriod: number;
}
