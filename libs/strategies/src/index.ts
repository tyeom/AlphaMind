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
} from './utils/signal-freshness';
export {
  evaluateLongBuyRisk,
  type LongBuyRiskFilterOptions,
  type LongBuyRiskProfile,
} from './utils/buy-risk-filter';

// Trade meta
export { getStrategyTradeMeta, type TradeMeta } from './trade-meta';
