import type { CandleData } from '../types/strategy.types';
import { calculateATR, calculateSMA } from '../indicators/technical-indicators';

export interface LongBuyRiskFilterOptions {
  minCandles?: number;
  minAvgTurnover20?: number;
  maxAtrPct?: number;
  maxRecent5dDropPct?: number;
  maxBelowSma60Pct?: number;
  maxAboveSma20Pct?: number;
  minSma20Slope5dPct?: number;
  useCompletedCandlesForTurnover?: boolean;
}

export interface LongBuyRiskProfile {
  passed: boolean;
  reasons: string[];
  lastClose: number;
  avgTurnover20?: number;
  volatilityPct?: number;
  sma20?: number;
  sma60?: number;
  sma20Slope5dPct?: number;
  priceFromSma20Pct?: number;
  priceFromSma60Pct?: number;
  recent5dReturnPct?: number;
}

const DEFAULT_OPTIONS: Required<LongBuyRiskFilterOptions> = {
  minCandles: 60,
  minAvgTurnover20: 300_000_000,
  maxAtrPct: 8,
  maxRecent5dDropPct: -7,
  maxBelowSma60Pct: -8,
  maxAboveSma20Pct: 12,
  minSma20Slope5dPct: -0.5,
  useCompletedCandlesForTurnover: false,
};

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function avg(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Conservative long-only entry filter.
 *
 * The strategy signal decides "what to buy"; this filter decides whether the
 * current tape is tradable enough to place fresh long risk. It rejects thin,
 * highly volatile, falling, or overextended setups that tend to turn good
 * backtests into poor live fills.
 */
export function evaluateLongBuyRisk(
  candles: CandleData[],
  options: LongBuyRiskFilterOptions = {},
): LongBuyRiskProfile {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const lastCandle = candles[candles.length - 1];
  const lastClose = lastCandle?.close ?? 0;
  const reasons: string[] = [];

  if (candles.length < opts.minCandles || lastClose <= 0) {
    return {
      passed: false,
      reasons: ['insufficient_history'],
      lastClose,
    };
  }

  const closes = candles.map((c) => c.close);
  const sma20Values = calculateSMA(closes, 20);
  const sma60Values = calculateSMA(closes, 60);
  const atrValues = calculateATR(candles, 14);
  const lastIdx = candles.length - 1;

  const sma20 = sma20Values[lastIdx] ?? undefined;
  const sma60 = sma60Values[lastIdx] ?? undefined;
  const sma20FiveAgo =
    lastIdx >= 5 ? (sma20Values[lastIdx - 5] ?? undefined) : undefined;
  const closeFiveAgo = lastIdx >= 5 ? candles[lastIdx - 5].close : undefined;
  const lastAtr = atrValues[lastIdx] ?? undefined;

  const turnoverSource =
    opts.useCompletedCandlesForTurnover && candles.length > 21
      ? candles.slice(0, -1)
      : candles;
  const avgTurnover20 = avg(
    turnoverSource.slice(-20).map((c) => c.close * c.volume),
  );

  const volatilityPct =
    lastAtr != null && lastClose > 0
      ? round2((lastAtr / lastClose) * 100)
      : undefined;
  const priceFromSma20Pct =
    sma20 != null && sma20 > 0
      ? round2(((lastClose - sma20) / sma20) * 100)
      : undefined;
  const priceFromSma60Pct =
    sma60 != null && sma60 > 0
      ? round2(((lastClose - sma60) / sma60) * 100)
      : undefined;
  const sma20Slope5dPct =
    sma20 != null && sma20FiveAgo != null && sma20FiveAgo > 0
      ? round2(((sma20 - sma20FiveAgo) / sma20FiveAgo) * 100)
      : undefined;
  const recent5dReturnPct =
    closeFiveAgo != null && closeFiveAgo > 0
      ? round2(((lastClose - closeFiveAgo) / closeFiveAgo) * 100)
      : undefined;

  if (avgTurnover20 != null && avgTurnover20 < opts.minAvgTurnover20) {
    reasons.push('low_liquidity');
  }
  if (volatilityPct != null && volatilityPct > opts.maxAtrPct) {
    reasons.push('high_volatility');
  }
  if (
    recent5dReturnPct != null &&
    recent5dReturnPct < opts.maxRecent5dDropPct
  ) {
    reasons.push('recent_selloff');
  }
  if (priceFromSma60Pct != null && priceFromSma60Pct < opts.maxBelowSma60Pct) {
    reasons.push('major_downtrend');
  }
  if (priceFromSma20Pct != null && priceFromSma20Pct > opts.maxAboveSma20Pct) {
    reasons.push('overextended');
  }
  if (sma20Slope5dPct != null && sma20Slope5dPct < opts.minSma20Slope5dPct) {
    reasons.push('falling_sma20');
  }

  return {
    passed: reasons.length === 0,
    reasons,
    lastClose,
    avgTurnover20:
      avgTurnover20 != null ? Math.round(avgTurnover20) : undefined,
    volatilityPct,
    sma20: sma20 != null ? round2(sma20) : undefined,
    sma60: sma60 != null ? round2(sma60) : undefined,
    sma20Slope5dPct,
    priceFromSma20Pct,
    priceFromSma60Pct,
    recent5dReturnPct,
  };
}
