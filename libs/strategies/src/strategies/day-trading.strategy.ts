import {
  CandleData,
  DayTradingConfig,
  DayTradingVariant,
  Signal,
  SignalDirection,
  StrategyAnalysisResult,
} from '../types/strategy.types';
import {
  calculateSMA,
  calculateRSI,
  calculateATR,
  calculateAvgVolume,
  countConsecutiveUpCandles,
} from '../indicators/technical-indicators';
import { pickFreshCurrentSignal } from '../utils/signal-freshness';

const DEFAULT_CONFIG: DayTradingConfig = {
  variant: DayTradingVariant.Breakout,
  breakout: { kFactor: 0.5, lookbackPeriod: 1 },
  crossover: { shortPeriod: 10, longPeriod: 20 },
  volumeSurge: {
    volumeMultiplier: 2.0,
    volumePeriod: 20,
    consecutiveUpCandles: 3,
    rsiOverbought: 80,
    rsiPeriod: 14,
  },
};

export function analyzeDayTrading(
  candles: CandleData[],
  config: Partial<DayTradingConfig> = {},
): StrategyAnalysisResult {
  const cfg = mergeConfig(config);

  switch (cfg.variant) {
    case DayTradingVariant.Breakout:
      return analyzeBreakout(candles, cfg);
    case DayTradingVariant.Crossover:
      return analyzeCrossover(candles, cfg);
    case DayTradingVariant.VolumeSurge:
      return analyzeVolumeSurge(candles, cfg);
    default:
      return analyzeBreakout(candles, cfg);
  }
}

// ─── Volatility Breakout (래리 윌리엄스 변동성 돌파) ───

function analyzeBreakout(
  candles: CandleData[],
  cfg: DayTradingConfig,
): StrategyAnalysisResult {
  const signals: Signal[] = [];
  const { kFactor, lookbackPeriod } = cfg.breakout;
  const breakoutLevels: { date: Date; upper: number; lower: number }[] = [];

  for (let i = lookbackPeriod; i < candles.length; i++) {
    // 전일 레인지
    const prevHigh = candles[i - lookbackPeriod].high;
    const prevLow = candles[i - lookbackPeriod].low;
    const prevRange = prevHigh - prevLow;

    if (prevRange <= 0) continue;

    const todayOpen = candles[i].open;
    const upperBreak = todayOpen + prevRange * kFactor;
    const lowerBreak = todayOpen - prevRange * kFactor;

    breakoutLevels.push({ date: candles[i].date, upper: upperBreak, lower: lowerBreak });

    // 상단 돌파 → 매수
    if (candles[i].close >= upperBreak) {
      const rangePct = (prevRange / candles[i].close) * 100;
      if (rangePct >= 0.5 && rangePct <= 10) {
        signals.push({
          direction: SignalDirection.Buy,
          strength: Math.min((candles[i].close - upperBreak) / prevRange + 0.5, 1),
          reason: `변동성 상단 돌파 (K=${kFactor}, 돌파가=${upperBreak.toFixed(0)})`,
          date: candles[i].date,
          price: candles[i].close,
          metadata: { upperBreak, lowerBreak, prevRange },
        });
      }
    }
    // 하단 돌파 → 매도
    else if (candles[i].close <= lowerBreak) {
      const rangePct = (prevRange / candles[i].close) * 100;
      if (rangePct >= 0.5 && rangePct <= 10) {
        signals.push({
          direction: SignalDirection.Sell,
          strength: Math.min((lowerBreak - candles[i].close) / prevRange + 0.5, 1),
          reason: `변동성 하단 돌파 (K=${kFactor}, 돌파가=${lowerBreak.toFixed(0)})`,
          date: candles[i].date,
          price: candles[i].close,
          metadata: { upperBreak, lowerBreak, prevRange },
        });
      }
    }
  }

  const lastCandle = candles[candles.length - 1];
  const lastBreakout = breakoutLevels[breakoutLevels.length - 1];
  const currentSignal = buildCurrentSignal(signals, lastCandle);

  return {
    strategyName: '변동성 돌파 (Volatility Breakout)',
    stockCode: '',
    analyzedPeriod: { from: candles[0].date, to: lastCandle.date },
    currentSignal,
    signals,
    indicators: {
      kFactor,
      lastBreakoutLevel: lastBreakout ?? null,
      totalSignals: signals.length,
      buySignals: signals.filter((s) => s.direction === SignalDirection.Buy).length,
      sellSignals: signals.filter((s) => s.direction === SignalDirection.Sell).length,
    },
    summary: buildSummary('변동성 돌파', currentSignal, signals),
  };
}

// ─── SMA Crossover (이동평균 크로스오버) ───

function analyzeCrossover(
  candles: CandleData[],
  cfg: DayTradingConfig,
): StrategyAnalysisResult {
  const signals: Signal[] = [];
  const { shortPeriod, longPeriod } = cfg.crossover;
  const closes = candles.map((c) => c.close);

  const shortSMA = calculateSMA(closes, shortPeriod);
  const longSMA = calculateSMA(closes, longPeriod);

  for (let i = 1; i < candles.length; i++) {
    const prevShort = shortSMA[i - 1];
    const prevLong = longSMA[i - 1];
    const currShort = shortSMA[i];
    const currLong = longSMA[i];

    if (prevShort == null || prevLong == null || currShort == null || currLong == null) continue;

    // 골든 크로스 (단기가 장기를 상향 돌파)
    if (prevShort <= prevLong && currShort > currLong) {
      signals.push({
        direction: SignalDirection.Buy,
        strength: Math.min(Math.abs(currShort - currLong) / currLong * 100, 1),
        reason: `골든 크로스 (SMA${shortPeriod} > SMA${longPeriod})`,
        date: candles[i].date,
        price: candles[i].close,
        metadata: { shortSMA: currShort, longSMA: currLong },
      });
    }
    // 데드 크로스 (단기가 장기를 하향 돌파)
    else if (prevShort >= prevLong && currShort < currLong) {
      signals.push({
        direction: SignalDirection.Sell,
        strength: Math.min(Math.abs(currLong - currShort) / currLong * 100, 1),
        reason: `데드 크로스 (SMA${shortPeriod} < SMA${longPeriod})`,
        date: candles[i].date,
        price: candles[i].close,
        metadata: { shortSMA: currShort, longSMA: currLong },
      });
    }
  }

  const lastCandle = candles[candles.length - 1];
  const lastIdx = candles.length - 1;
  const currentSignal = buildCurrentSignal(signals, lastCandle);

  return {
    strategyName: 'SMA 크로스오버 (SMA Crossover)',
    stockCode: '',
    analyzedPeriod: { from: candles[0].date, to: lastCandle.date },
    currentSignal,
    signals,
    indicators: {
      shortPeriod,
      longPeriod,
      currentShortSMA: shortSMA[lastIdx],
      currentLongSMA: longSMA[lastIdx],
      smaSpread: shortSMA[lastIdx] != null && longSMA[lastIdx] != null
        ? shortSMA[lastIdx]! - longSMA[lastIdx]!
        : null,
    },
    summary: buildSummary('SMA 크로스오버', currentSignal, signals),
  };
}

// ─── Volume Surge (거래량 급증 모멘텀) ───

function analyzeVolumeSurge(
  candles: CandleData[],
  cfg: DayTradingConfig,
): StrategyAnalysisResult {
  const signals: Signal[] = [];
  const { volumeMultiplier, volumePeriod, consecutiveUpCandles, rsiOverbought, rsiPeriod } =
    cfg.volumeSurge;

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const rsiValues = calculateRSI(closes, rsiPeriod);
  const avgVolumes = calculateAvgVolume(volumes, volumePeriod);

  for (let i = volumePeriod; i < candles.length; i++) {
    const avgVol = avgVolumes[i];
    const rsi = rsiValues[i];

    if (avgVol == null || avgVol === 0) continue;

    const volRatio = candles[i].volume / avgVol;
    const consecutiveUp = countConsecutiveUpCandles(candles, i);
    const rsiNotOverbought = rsi == null || rsi < rsiOverbought;

    // 거래량 급증 + 연속 상승봉 + RSI 과열 아님
    if (
      volRatio >= volumeMultiplier &&
      consecutiveUp >= consecutiveUpCandles &&
      rsiNotOverbought
    ) {
      signals.push({
        direction: SignalDirection.Buy,
        strength: Math.min(volRatio / (volumeMultiplier * 2), 1),
        reason: `거래량 급증 (${volRatio.toFixed(1)}배) + ${consecutiveUp}연속 상승봉`,
        date: candles[i].date,
        price: candles[i].close,
        metadata: { volRatio, consecutiveUp, rsi },
      });
    }
  }

  const lastCandle = candles[candles.length - 1];
  const lastIdx = candles.length - 1;
  const currentSignal = buildCurrentSignal(signals, lastCandle);

  return {
    strategyName: '거래량 급증 (Volume Surge)',
    stockCode: '',
    analyzedPeriod: { from: candles[0].date, to: lastCandle.date },
    currentSignal,
    signals,
    indicators: {
      currentRSI: rsiValues[lastIdx],
      currentVolume: candles[lastIdx].volume,
      avgVolume: avgVolumes[lastIdx],
      volumeRatio:
        avgVolumes[lastIdx] != null && avgVolumes[lastIdx]! > 0
          ? candles[lastIdx].volume / avgVolumes[lastIdx]!
          : null,
    },
    summary: buildSummary('거래량 급증', currentSignal, signals),
  };
}

// ─── Helpers ───

function mergeConfig(partial: Partial<DayTradingConfig>): DayTradingConfig {
  return {
    variant: partial.variant ?? DEFAULT_CONFIG.variant,
    breakout: { ...DEFAULT_CONFIG.breakout, ...partial.breakout },
    crossover: { ...DEFAULT_CONFIG.crossover, ...partial.crossover },
    volumeSurge: { ...DEFAULT_CONFIG.volumeSurge, ...partial.volumeSurge },
  };
}

function buildCurrentSignal(signals: Signal[], lastCandle: CandleData): Signal {
  return pickFreshCurrentSignal(signals, lastCandle);
}

function buildSummary(name: string, current: Signal, signals: Signal[]): string {
  const buys = signals.filter((s) => s.direction === SignalDirection.Buy).length;
  const sells = signals.filter((s) => s.direction === SignalDirection.Sell).length;
  return `[${name}] 총 ${signals.length}개 신호 (매수 ${buys}, 매도 ${sells}). 현재: ${current.direction} (강도 ${(current.strength * 100).toFixed(0)}%)`;
}
