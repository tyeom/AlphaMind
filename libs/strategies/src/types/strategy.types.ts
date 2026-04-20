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

// ─── Exit Config (공통: 손절/익절/트레일링 스탑) ───

export interface ExitConfig {
  /** 손절 활성화 (기본: true) */
  stopLossEnabled: boolean;
  /** 손절 비율 % (기본: 2.0) */
  stopLossPct: number;
  /** 익절 활성화 (기본: true) */
  takeProfitEnabled: boolean;
  /** 익절 비율 % (기본: 4.0) */
  takeProfitPct: number;
  /** 트레일링 스톱 활성화 (기본: false) */
  trailingStopEnabled: boolean;
  /** 트레일링 시작 수익률 % (기본: 2.0) */
  trailingTriggerPct: number;
  /** 트레일링 스톱 비율 % (기본: 1.0) */
  trailingStopPct: number;
  /** 반대 신호 시 청산 (기본: true) */
  exitOnOppositeSignal: boolean;
}

// ─── Momentum Power Types ───

/** 시장 타입 */
export enum MomentumPowerMarket {
  KR = 'kr',
  US = 'us',
}

/** 전략 모드 */
export enum MomentumPowerMode {
  /** 시장 안전 + 모멘텀 양호 */
  Attack = 'attack',
  /** 시장 안전 + 모멘텀 부진 */
  Safe = 'safe',
  /** 시장 위험 */
  Crisis = 'crisis',
}

export interface MomentumPowerConfig {
  /** 시장 타입 (KR/US) */
  market: MomentumPowerMarket;
  /** 시장 안전 지표 MA 기간 (기본: 200일 ≒ 10개월) */
  tipMaPeriod: number;
  /** 모멘텀 확인 MA 기간 (기본: 5일) */
  momentumPeriod: number;
  /** 리밸런싱 간격 (일) (기본: 30일) */
  rebalanceDays: number;
  /** 청산 설정 */
  exitConfig: ExitConfig;
}

// ─── Momentum Surge Types ───

/** ETF 타입 */
export enum MomentumSurgeEtfKind {
  /** 레버리지 계열 (정배열 추세 추종) */
  Leverage = 'leverage',
  /** 인버스 계열 (역배열 추세 추종) */
  Inverse = 'inverse',
  /** 티커 기반 자동 판별 */
  Auto = 'auto',
}

export interface MomentumSurgeConfig {
  /** ETF 타입 (자동 판별 또는 강제 지정) */
  etfKind: MomentumSurgeEtfKind;
  /** 코스피 레버리지 티커 (기본: 122630) */
  kospiLeverage: string;
  /** 코스닥 레버리지 티커 (기본: 233740) */
  kosdaqLeverage: string;
  /** 코스피 인버스 티커 (기본: 252670) */
  kospiInverse: string;
  /** 코스닥 인버스 티커 (기본: 251340) */
  kosdaqInverse: string;
  /** 종목당 투자 비율 (기본: 0.5) */
  positionRatio: number;
  /** OBV 추세 확인 기간 (기본: 10) */
  obvPeriod: number;
  /** 단기 MA (기본: 5) */
  maShort: number;
  /** 중기 MA (기본: 20) */
  maMedium: number;
  /** 장기 MA (기본: 60) */
  maLong: number;
  /** RSI 기간 (기본: 14) */
  rsiPeriod: number;
  /** 손절 % (기본: 3.0) */
  stopLossPct: number;
  /** 익절 % (기본: 10.0) */
  takeProfitPct: number;
  /** 청산 설정 */
  exitConfig: ExitConfig;
}
