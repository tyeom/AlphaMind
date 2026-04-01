import {
  CandleData,
  CandlePatternConfig,
  CandlePatternType,
  DetectedPattern,
  PatternDirection,
  Signal,
  SignalDirection,
  StrategyAnalysisResult,
} from '../types/strategy.types';
import { calculateSMA } from '../indicators/technical-indicators';

const DEFAULT_CONFIG: CandlePatternConfig = {
  minPatternStrength: 0.6,
  useVolumeConfirmation: true,
  useTrendConfirmation: true,
  trendPeriod: 20,
};

export function analyzeCandlePattern(
  candles: CandleData[],
  config: Partial<CandlePatternConfig> = {},
): StrategyAnalysisResult {
  const cfg: CandlePatternConfig = { ...DEFAULT_CONFIG, ...config };
  const signals: Signal[] = [];
  const allPatterns: DetectedPattern[] = [];

  // 평균 캔들 크기 (트렌드/패턴 판단 기준)
  const avgBodySize = calcAvgBodySize(candles);
  const closes = candles.map((c) => c.close);
  const trendSMA = calculateSMA(closes, cfg.trendPeriod);
  const volumes = candles.map((c) => c.volume);
  const avgVolumes = calculateSMA(volumes, 20);

  for (let i = 0; i < candles.length; i++) {
    const detected: DetectedPattern[] = [];

    // 단일 캔들 패턴
    const doji = detectDoji(candles[i], avgBodySize);
    if (doji) detected.push({ ...doji, date: candles[i].date, price: candles[i].close });

    const hammer = detectHammer(candles, i, trendSMA);
    if (hammer) detected.push({ ...hammer, date: candles[i].date, price: candles[i].close });

    const marubozu = detectMarubozu(candles[i]);
    if (marubozu) detected.push({ ...marubozu, date: candles[i].date, price: candles[i].close });

    const spinningTop = detectSpinningTop(candles[i]);
    if (spinningTop)
      detected.push({ ...spinningTop, date: candles[i].date, price: candles[i].close });

    // 2봉 패턴
    if (i >= 1) {
      const engulfing = detectEngulfing(candles[i - 1], candles[i]);
      if (engulfing)
        detected.push({ ...engulfing, date: candles[i].date, price: candles[i].close });

      const harami = detectHarami(candles[i - 1], candles[i]);
      if (harami) detected.push({ ...harami, date: candles[i].date, price: candles[i].close });
    }

    // 3봉 패턴
    if (i >= 2) {
      const star = detectStar(candles[i - 2], candles[i - 1], candles[i]);
      if (star) detected.push({ ...star, date: candles[i].date, price: candles[i].close });

      const soldiers = detectThreeSoldiersCrows(candles[i - 2], candles[i - 1], candles[i]);
      if (soldiers)
        detected.push({ ...soldiers, date: candles[i].date, price: candles[i].close });
    }

    // 볼륨 확인
    for (const pattern of detected) {
      if (cfg.useVolumeConfirmation && avgVolumes[i] != null && avgVolumes[i]! > 0) {
        const volRatio = candles[i].volume / avgVolumes[i]!;
        if (volRatio > 1.5) {
          pattern.strength = Math.min(pattern.strength * 1.2, 1);
          pattern.confirmation = true;
        }
      }

      // 트렌드 확인
      if (cfg.useTrendConfirmation && trendSMA[i] != null) {
        const trend =
          candles[i].close > trendSMA[i]!
            ? PatternDirection.Bullish
            : PatternDirection.Bearish;
        // 반전 패턴이 트렌드와 반대 방향이면 강화
        if (
          (pattern.direction === PatternDirection.Bullish &&
            trend === PatternDirection.Bearish) ||
          (pattern.direction === PatternDirection.Bearish &&
            trend === PatternDirection.Bullish)
        ) {
          pattern.strength = Math.min(pattern.strength * 1.1, 1);
        }
      }

      // 최소 강도 필터
      if (pattern.strength >= cfg.minPatternStrength) {
        allPatterns.push(pattern);

        if (pattern.direction !== PatternDirection.Neutral) {
          signals.push({
            direction:
              pattern.direction === PatternDirection.Bullish
                ? SignalDirection.Buy
                : SignalDirection.Sell,
            strength: pattern.strength,
            reason: `${pattern.patternType} 패턴 감지`,
            date: pattern.date,
            price: pattern.price,
            metadata: {
              patternType: pattern.patternType,
              direction: pattern.direction,
              confirmation: pattern.confirmation,
            },
          });
        }
      }
    }
  }

  const lastCandle = candles[candles.length - 1];
  const recentPatterns = allPatterns.slice(-10);
  const currentSignal: Signal =
    signals.length > 0
      ? signals[signals.length - 1]
      : {
          direction: SignalDirection.Neutral,
          strength: 0,
          reason: '패턴 미감지',
          date: lastCandle.date,
          price: lastCandle.close,
        };

  // 패턴 통계
  const patternStats: Record<string, number> = {};
  for (const p of allPatterns) {
    patternStats[p.patternType] = (patternStats[p.patternType] ?? 0) + 1;
  }

  const buys = signals.filter((s) => s.direction === SignalDirection.Buy).length;
  const sells = signals.filter((s) => s.direction === SignalDirection.Sell).length;

  return {
    strategyName: '캔들 패턴 인식 (Candle Pattern)',
    stockCode: '',
    analyzedPeriod: { from: candles[0].date, to: lastCandle.date },
    currentSignal,
    signals,
    indicators: {
      totalPatternsDetected: allPatterns.length,
      recentPatterns,
      patternStats,
      avgCandleBodySize: avgBodySize,
    },
    summary: `[캔들 패턴] 총 ${allPatterns.length}개 패턴 감지, ${signals.length}개 신호 (매수 ${buys}, 매도 ${sells}). 현재: ${currentSignal.direction}`,
  };
}

// ─── 캔들 헬퍼 ───

function bodySize(c: CandleData): number {
  return Math.abs(c.close - c.open);
}

function totalSize(c: CandleData): number {
  return c.high - c.low;
}

function upperShadow(c: CandleData): number {
  return c.high - Math.max(c.close, c.open);
}

function lowerShadow(c: CandleData): number {
  return Math.min(c.close, c.open) - c.low;
}

function isBullish(c: CandleData): boolean {
  return c.close > c.open;
}

function isBearish(c: CandleData): boolean {
  return c.close < c.open;
}

function calcAvgBodySize(candles: CandleData[]): number {
  if (candles.length === 0) return 0;
  const sum = candles.reduce((acc, c) => acc + bodySize(c), 0);
  return sum / candles.length;
}

type RawPattern = Omit<DetectedPattern, 'date' | 'price'>;

// ─── 단일 캔들 패턴 ───

function detectDoji(candle: CandleData, avgBody: number): RawPattern | null {
  const body = bodySize(candle);
  const total = totalSize(candle);
  if (total === 0) return null;

  const bodyRatio = body / total;
  if (bodyRatio >= 0.1) return null;

  const upper = upperShadow(candle);
  const lower = lowerShadow(candle);

  let patternType: CandlePatternType;
  if (lower > upper * 2) {
    patternType = CandlePatternType.DragonflyDoji;
  } else if (upper > lower * 2) {
    patternType = CandlePatternType.GravestoneDoji;
  } else if (total > avgBody * 1.5) {
    patternType = CandlePatternType.LongLeggedDoji;
  } else {
    patternType = CandlePatternType.Doji;
  }

  return {
    patternType,
    direction: PatternDirection.Neutral,
    strength: 1 - bodyRatio,
    confirmation: false,
  };
}

function detectHammer(
  candles: CandleData[],
  idx: number,
  trendSMA: (number | null)[],
): RawPattern | null {
  const candle = candles[idx];
  const body = bodySize(candle);
  const total = totalSize(candle);
  const lower = lowerShadow(candle);
  const upper = upperShadow(candle);

  if (total === 0 || body === 0) return null;

  // 트렌드 판단
  const trend = getTrend(candles, idx, trendSMA);

  // Hammer / Hanging Man: 하단 꼬리 >= 몸통의 2배, 상단 꼬리 작음
  if (lower >= body * 2 && upper < body * 0.5) {
    if (trend === PatternDirection.Bearish) {
      return {
        patternType: CandlePatternType.Hammer,
        direction: PatternDirection.Bullish,
        strength: Math.min(lower / body / 2, 1),
        confirmation: false,
      };
    }
    if (trend === PatternDirection.Bullish) {
      return {
        patternType: CandlePatternType.HangingMan,
        direction: PatternDirection.Bearish,
        strength: Math.min(lower / body / 2, 1),
        confirmation: false,
      };
    }
  }

  // Inverted Hammer / Shooting Star: 상단 꼬리 >= 몸통의 2배, 하단 꼬리 작음
  if (upper >= body * 2 && lower < body * 0.5) {
    if (trend === PatternDirection.Bearish) {
      return {
        patternType: CandlePatternType.InvertedHammer,
        direction: PatternDirection.Bullish,
        strength: Math.min(upper / body / 2, 1),
        confirmation: false,
      };
    }
    if (trend === PatternDirection.Bullish) {
      return {
        patternType: CandlePatternType.ShootingStar,
        direction: PatternDirection.Bearish,
        strength: Math.min(upper / body / 2, 1),
        confirmation: false,
      };
    }
  }

  return null;
}

function detectMarubozu(candle: CandleData): RawPattern | null {
  const body = bodySize(candle);
  const total = totalSize(candle);
  const upper = upperShadow(candle);
  const lower = lowerShadow(candle);

  if (total === 0) return null;

  // 꼬리가 전체의 5% 미만
  if (upper < total * 0.05 && lower < total * 0.05) {
    return {
      patternType: CandlePatternType.Marubozu,
      direction: isBullish(candle) ? PatternDirection.Bullish : PatternDirection.Bearish,
      strength: body / total,
      confirmation: false,
    };
  }

  return null;
}

function detectSpinningTop(candle: CandleData): RawPattern | null {
  const body = bodySize(candle);
  const total = totalSize(candle);
  const upper = upperShadow(candle);
  const lower = lowerShadow(candle);

  if (total === 0) return null;

  const bodyRatio = body / total;
  // 몸통이 전체의 10~30%, 양쪽 꼬리 비슷
  if (bodyRatio >= 0.1 && bodyRatio <= 0.3) {
    const shadowRatio = upper > 0 && lower > 0 ? Math.min(upper, lower) / Math.max(upper, lower) : 0;
    if (shadowRatio > 0.4) {
      return {
        patternType: CandlePatternType.SpinningTop,
        direction: PatternDirection.Neutral,
        strength: 1 - bodyRatio,
        confirmation: false,
      };
    }
  }

  return null;
}

// ─── 2봉 패턴 ───

function detectEngulfing(prev: CandleData, curr: CandleData): RawPattern | null {
  const currBody = bodySize(curr);
  const prevBody = bodySize(prev);

  // Bullish Engulfing
  if (
    isBearish(prev) &&
    isBullish(curr) &&
    curr.open < prev.close &&
    curr.close > prev.open &&
    currBody > prevBody
  ) {
    return {
      patternType: CandlePatternType.BullishEngulfing,
      direction: PatternDirection.Bullish,
      strength: Math.min(currBody / prevBody / 2 + 0.5, 1),
      confirmation: true,
    };
  }

  // Bearish Engulfing
  if (
    isBullish(prev) &&
    isBearish(curr) &&
    curr.open > prev.close &&
    curr.close < prev.open &&
    currBody > prevBody
  ) {
    return {
      patternType: CandlePatternType.BearishEngulfing,
      direction: PatternDirection.Bearish,
      strength: Math.min(currBody / prevBody / 2 + 0.5, 1),
      confirmation: true,
    };
  }

  return null;
}

function detectHarami(prev: CandleData, curr: CandleData): RawPattern | null {
  // Bullish Harami
  if (
    isBearish(prev) &&
    isBullish(curr) &&
    curr.open > prev.close &&
    curr.close < prev.open
  ) {
    return {
      patternType: CandlePatternType.BullishHarami,
      direction: PatternDirection.Bullish,
      strength: 0.7,
      confirmation: false,
    };
  }

  // Bearish Harami
  if (
    isBullish(prev) &&
    isBearish(curr) &&
    curr.open < prev.close &&
    curr.close > prev.open
  ) {
    return {
      patternType: CandlePatternType.BearishHarami,
      direction: PatternDirection.Bearish,
      strength: 0.7,
      confirmation: false,
    };
  }

  return null;
}

// ─── 3봉 패턴 ───

function detectStar(
  first: CandleData,
  mid: CandleData,
  curr: CandleData,
): RawPattern | null {
  const firstBody = bodySize(first);
  const midBody = bodySize(mid);

  // Morning Star
  if (
    isBearish(first) &&
    midBody < firstBody * 0.3 &&
    isBullish(curr) &&
    curr.close > (first.open + first.close) / 2
  ) {
    return {
      patternType: CandlePatternType.MorningStar,
      direction: PatternDirection.Bullish,
      strength: 0.85,
      confirmation: true,
    };
  }

  // Evening Star
  if (
    isBullish(first) &&
    midBody < firstBody * 0.3 &&
    isBearish(curr) &&
    curr.close < (first.open + first.close) / 2
  ) {
    return {
      patternType: CandlePatternType.EveningStar,
      direction: PatternDirection.Bearish,
      strength: 0.85,
      confirmation: true,
    };
  }

  return null;
}

function detectThreeSoldiersCrows(
  c1: CandleData,
  c2: CandleData,
  c3: CandleData,
): RawPattern | null {
  // Three White Soldiers
  if (
    isBullish(c1) &&
    isBullish(c2) &&
    isBullish(c3) &&
    c2.close > c1.close &&
    c3.close > c2.close
  ) {
    const b1 = bodySize(c1);
    const b2 = bodySize(c2);
    const b3 = bodySize(c3);
    if (b2 > b1 * 0.8 && b3 > b2 * 0.8) {
      return {
        patternType: CandlePatternType.ThreeWhiteSoldiers,
        direction: PatternDirection.Bullish,
        strength: 0.9,
        confirmation: true,
      };
    }
  }

  // Three Black Crows
  if (
    isBearish(c1) &&
    isBearish(c2) &&
    isBearish(c3) &&
    c2.close < c1.close &&
    c3.close < c2.close
  ) {
    return {
      patternType: CandlePatternType.ThreeBlackCrows,
      direction: PatternDirection.Bearish,
      strength: 0.9,
      confirmation: true,
    };
  }

  return null;
}

// ─── 트렌드 판단 ───

function getTrend(
  candles: CandleData[],
  idx: number,
  trendSMA: (number | null)[],
): PatternDirection {
  if (trendSMA[idx] != null) {
    return candles[idx].close > trendSMA[idx]!
      ? PatternDirection.Bullish
      : PatternDirection.Bearish;
  }
  // SMA 없으면 최근 5일 가격 추세로 판단
  if (idx >= 5) {
    return candles[idx].close > candles[idx - 5].close
      ? PatternDirection.Bullish
      : PatternDirection.Bearish;
  }
  return PatternDirection.Neutral;
}
