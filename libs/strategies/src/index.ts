// Types
export * from './types/strategy.types';

// Indicators
export {
  calculateSMA,
  calculateRSI,
  calculateBollingerBands,
  calculateATR,
  calculateAvgVolume,
  calculateOBV,
  countConsecutiveUpCandles,
  type BollingerBands,
} from './indicators/technical-indicators';

// Strategies
export { analyzeDayTrading } from './strategies/day-trading.strategy';
export { analyzeMeanReversion } from './strategies/mean-reversion.strategy';
export { analyzeInfinityBot } from './strategies/infinity-bot.strategy';
export { analyzeCandlePattern } from './strategies/candle-pattern.strategy';
export { analyzeMomentumPower } from './strategies/momentum-power.strategy';
export { analyzeMomentumSurge } from './strategies/momentum-surge.strategy';

// Utils
export {
  isFreshSignal,
  pickFreshCurrentSignal,
  pickFreshStrongestSignal,
  type FreshSignalOptions,
} from './utils/signal-freshness';
export {
  evaluateLongBuyRisk,
  type LongBuyRiskFilterOptions,
  type LongBuyRiskProfile,
} from './utils/buy-risk-filter';
export {
  DEFAULT_DYNAMIC_TP_SL_OPTIONS,
  computeAtrDynamicTpSl,
  type DynamicTpSlOptions,
  type DynamicTpSlResult,
} from './utils/dynamic-tp-sl';
export {
  computeScaleOutSellQty,
  DEFAULT_SCALE_OUT_PLAN,
  evaluateScaleOut,
  type ScaleOutDecision,
  type ScaleOutPlan,
  type ScaleOutSellQtyInput,
  type ScaleOutTier,
} from './utils/scale-out';
export {
  computeRiskBasedQty,
  type RiskSizingOptions,
  type RiskSizingResult,
} from './utils/position-sizing';
export {
  DEFAULT_MARKET_REGIME_OPTIONS,
  computeMarketRegime,
  type BreadthSnapshot,
  type MarketRegimeOptions,
  type MarketRegimeState,
  type RegimeLabel,
  type RegimeResult,
} from './utils/market-regime';
export {
  DEFAULT_CORRELATION_CLUSTER_OPTIONS,
  buildAlignedLogReturns,
  clusterByCorrelation,
  pearson,
  type CorrelationCluster,
  type CorrelationClusterOptions,
  type CorrelationClusterResult,
  type CorrelationPricePoint,
} from './utils/correlation-cluster';

// Trade meta
export { getStrategyTradeMeta, type TradeMeta } from './trade-meta';
