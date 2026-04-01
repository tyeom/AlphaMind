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
  kFactor: number;       // 돌파 K 계수 (기본 0.5)
  lookbackPeriod: number; // 룩백 기간 (기본 1)
}

export interface CrossoverConfig {
  shortPeriod: number;  // 단기 MA (기본 10)
  longPeriod: number;   // 장기 MA (기본 20)
}

export interface VolumeSurgeConfig {
  volumeMultiplier: number;    // 거래량 급증 배수 (기본 2.0)
  volumePeriod: number;        // 거래량 평균 기간 (기본 20)
  consecutiveUpCandles: number; // 연속 상승봉 수 (기본 3)
  rsiOverbought: number;       // RSI 과열 기준 (기본 80)
  rsiPeriod: number;           // RSI 기간 (기본 14)
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
  period: number;       // RSI 기간 (기본 14)
  oversold: number;     // 과매도 임계값 (기본 30)
  overbought: number;   // 과매수 임계값 (기본 70)
}

export interface BollingerStrategyConfig {
  period: number;         // SMA 기간 (기본 20)
  stdMultiplier: number;  // 표준편차 승수 (기본 2.0)
}

export interface GridStrategyConfig {
  spacingPct: number;  // 그리드 간격 % (기본 1.0)
  levels: number;      // 그리드 레벨 수 (기본 5)
}

export interface SplitLevel {
  triggerRate: number;  // 매수 트리거 손실률 (%)
  targetRate: number;   // 목표 수익률 (%)
  amount: number;       // 투자 금액
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
  totalAmount: number;     // 총 투자 금액 (기본 10,000,000)
  maxRounds: number;       // 최대 라운드 수 (기본 50)
  roundPct: number;        // 라운드당 투자 비율 % (기본 2)
  dipTriggerPct: number;   // 추가 매수 트리거 하락률 % (기본 2)
  takeProfitPct: number;   // 익절 목표 수익률 % (기본 3)
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
  // 단일 캔들
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
  // 2봉
  BullishEngulfing = 'BullishEngulfing',
  BearishEngulfing = 'BearishEngulfing',
  BullishHarami = 'BullishHarami',
  BearishHarami = 'BearishHarami',
  // 3봉
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
  strength: number; // 0 ~ 1
  confirmation: boolean;
  date: Date;
  price: number;
}

export interface CandlePatternConfig {
  minPatternStrength: number;      // 최소 패턴 강도 (기본 0.6)
  useVolumeConfirmation: boolean;  // 볼륨 확인 (기본 true)
  useTrendConfirmation: boolean;   // 트렌드 확인 (기본 true)
  trendPeriod: number;             // 트렌드 확인 기간 (기본 20)
}
