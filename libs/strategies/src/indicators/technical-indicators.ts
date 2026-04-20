import { CandleData } from '../types/strategy.types';

/** SMA (단순이동평균) 계산 */
export function calculateSMA(prices: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += prices[j];
    }
    result.push(sum / period);
  }
  return result;
}

/** RSI (상대강도지수) 계산 */
export function calculateRSI(prices: number[], period: number = 14): (number | null)[] {
  const result: (number | null)[] = [null];

  if (prices.length < period + 1) {
    return prices.map(() => null);
  }

  const gains: number[] = [];
  const losses: number[] = [];

  for (let i = 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    gains.push(change > 0 ? change : 0);
    losses.push(change < 0 ? -change : 0);
  }

  for (let i = 0; i < gains.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    let avgGain = 0;
    let avgLoss = 0;
    for (let j = i - period + 1; j <= i; j++) {
      avgGain += gains[j];
      avgLoss += losses[j];
    }
    avgGain /= period;
    avgLoss /= period;

    if (avgLoss === 0) {
      result.push(100);
      continue;
    }

    const rs = avgGain / avgLoss;
    result.push(100 - 100 / (1 + rs));
  }

  return result;
}

/** 볼린저 밴드 계산 결과 */
export interface BollingerBands {
  upper: number;
  middle: number;
  lower: number;
  bandwidth: number;
}

/** 볼린저 밴드 계산 */
export function calculateBollingerBands(
  prices: number[],
  period: number = 20,
  stdMultiplier: number = 2,
): (BollingerBands | null)[] {
  const result: (BollingerBands | null)[] = [];

  for (let i = 0; i < prices.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    const slice = prices.slice(i - period + 1, i + 1);
    const sma = slice.reduce((a, b) => a + b, 0) / period;

    const variance = slice.reduce((sum, p) => sum + (p - sma) ** 2, 0) / period;
    const stdDev = Math.sqrt(variance);

    const upper = sma + stdMultiplier * stdDev;
    const lower = sma - stdMultiplier * stdDev;
    const bandwidth = sma !== 0 ? ((upper - lower) / sma) * 100 : 0;

    result.push({ upper, middle: sma, lower, bandwidth });
  }

  return result;
}

/** ATR (Average True Range) 계산 */
export function calculateATR(candles: CandleData[], period: number = 14): (number | null)[] {
  const result: (number | null)[] = [null];

  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevClose = candles[i - 1].close;
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trueRanges.push(tr);
  }

  for (let i = 0; i < trueRanges.length; i++) {
    if (i < period - 1) {
      result.push(null);
      continue;
    }

    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      sum += trueRanges[j];
    }
    result.push(sum / period);
  }

  return result;
}

/** 평균 거래량 계산 */
export function calculateAvgVolume(volumes: number[], period: number): (number | null)[] {
  return calculateSMA(volumes, period);
}

/** 연속 상승봉 수 (현재 캔들부터 역순) */
export function countConsecutiveUpCandles(candles: CandleData[], fromIndex: number): number {
  let count = 0;
  for (let i = fromIndex; i >= 0; i--) {
    if (candles[i].close > candles[i].open) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/** OBV (On-Balance Volume) 누적 값 시리즈 계산 */
export function calculateOBV(candles: CandleData[]): number[] {
  const obv: number[] = [];
  if (candles.length === 0) return obv;

  obv.push(candles[0].volume);

  for (let i = 1; i < candles.length; i++) {
    const prev = obv[i - 1];
    const priceDelta = candles[i].close - candles[i - 1].close;
    if (priceDelta > 0) {
      obv.push(prev + candles[i].volume);
    } else if (priceDelta < 0) {
      obv.push(prev - candles[i].volume);
    } else {
      obv.push(prev);
    }
  }

  return obv;
}
