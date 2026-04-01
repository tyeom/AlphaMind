import {
  CandleData,
  MeanReversionConfig,
  MeanReversionVariant,
  Signal,
  SignalDirection,
  SplitLevel,
  StrategyAnalysisResult,
} from '../types/strategy.types';
import {
  calculateRSI,
  calculateBollingerBands,
  calculateSMA,
  calculateATR,
} from '../indicators/technical-indicators';

const DEFAULT_CONFIG: MeanReversionConfig = {
  variant: MeanReversionVariant.RSI,
  rsi: { period: 14, oversold: 30, overbought: 70 },
  bollinger: { period: 20, stdMultiplier: 2.0 },
  grid: { spacingPct: 1.0, levels: 5 },
  magicSplit: {
    levels: [
      { triggerRate: 0, targetRate: 10, amount: 100000 },
      { triggerRate: -3, targetRate: 8, amount: 150000 },
      { triggerRate: -5, targetRate: 6, amount: 200000 },
      { triggerRate: -7, targetRate: 5, amount: 250000 },
      { triggerRate: -10, targetRate: 4, amount: 300000 },
    ],
  },
};

export function analyzeMeanReversion(
  candles: CandleData[],
  config: Partial<MeanReversionConfig> = {},
): StrategyAnalysisResult {
  const cfg = mergeConfig(config);

  switch (cfg.variant) {
    case MeanReversionVariant.RSI:
      return analyzeRSI(candles, cfg);
    case MeanReversionVariant.Bollinger:
      return analyzeBollinger(candles, cfg);
    case MeanReversionVariant.Grid:
      return analyzeGrid(candles, cfg);
    case MeanReversionVariant.MagicSplit:
      return analyzeMagicSplit(candles, cfg);
    default:
      return analyzeRSI(candles, cfg);
  }
}

// ─── RSI 평균회귀 ───

function analyzeRSI(
  candles: CandleData[],
  cfg: MeanReversionConfig,
): StrategyAnalysisResult {
  const signals: Signal[] = [];
  const { period, oversold, overbought } = cfg.rsi;
  const closes = candles.map((c) => c.close);
  const rsiValues = calculateRSI(closes, period);

  for (let i = 1; i < candles.length; i++) {
    const prevRsi = rsiValues[i - 1];
    const currRsi = rsiValues[i];
    if (prevRsi == null || currRsi == null) continue;

    // 과매도 진입 (RSI가 30 밑에서 위로 올라올 때)
    if (prevRsi < oversold && currRsi >= oversold) {
      signals.push({
        direction: SignalDirection.Buy,
        strength: Math.min((oversold - prevRsi) / oversold, 1),
        reason: `RSI 과매도 탈출 (${prevRsi.toFixed(1)} → ${currRsi.toFixed(1)})`,
        date: candles[i].date,
        price: candles[i].close,
        metadata: { rsi: currRsi },
      });
    }
    // 과매도 구간 (RSI < 30)
    else if (currRsi < oversold) {
      signals.push({
        direction: SignalDirection.Buy,
        strength: Math.min((oversold - currRsi) / oversold, 1) * 0.7,
        reason: `RSI 과매도 (${currRsi.toFixed(1)})`,
        date: candles[i].date,
        price: candles[i].close,
        metadata: { rsi: currRsi },
      });
    }

    // 과매수 탈출 (RSI가 70 위에서 아래로 내려올 때)
    if (prevRsi > overbought && currRsi <= overbought) {
      signals.push({
        direction: SignalDirection.Sell,
        strength: Math.min((prevRsi - overbought) / (100 - overbought), 1),
        reason: `RSI 과매수 탈출 (${prevRsi.toFixed(1)} → ${currRsi.toFixed(1)})`,
        date: candles[i].date,
        price: candles[i].close,
        metadata: { rsi: currRsi },
      });
    }
    // 과매수 구간 (RSI > 70)
    else if (currRsi > overbought) {
      signals.push({
        direction: SignalDirection.Sell,
        strength: Math.min((currRsi - overbought) / (100 - overbought), 1) * 0.7,
        reason: `RSI 과매수 (${currRsi.toFixed(1)})`,
        date: candles[i].date,
        price: candles[i].close,
        metadata: { rsi: currRsi },
      });
    }
  }

  const lastIdx = candles.length - 1;
  const currentSignal = buildCurrentSignal(signals, candles[lastIdx]);

  return {
    strategyName: 'RSI 평균회귀',
    stockCode: '',
    analyzedPeriod: { from: candles[0].date, to: candles[lastIdx].date },
    currentSignal,
    signals,
    indicators: {
      rsiPeriod: period,
      currentRSI: rsiValues[lastIdx],
      oversold,
      overbought,
      rsiZone:
        rsiValues[lastIdx] != null
          ? rsiValues[lastIdx]! < oversold
            ? '과매도'
            : rsiValues[lastIdx]! > overbought
              ? '과매수'
              : '중립'
          : null,
    },
    summary: buildSummary('RSI 평균회귀', currentSignal, signals),
  };
}

// ─── 볼린저 밴드 ───

function analyzeBollinger(
  candles: CandleData[],
  cfg: MeanReversionConfig,
): StrategyAnalysisResult {
  const signals: Signal[] = [];
  const { period, stdMultiplier } = cfg.bollinger;
  const closes = candles.map((c) => c.close);
  const bbValues = calculateBollingerBands(closes, period, stdMultiplier);

  for (let i = 0; i < candles.length; i++) {
    const bb = bbValues[i];
    if (bb == null) continue;

    const price = candles[i].close;

    // 하단 밴드 터치/이탈 → 매수
    if (price <= bb.lower) {
      const deviation = (bb.lower - price) / (bb.upper - bb.lower);
      signals.push({
        direction: SignalDirection.Buy,
        strength: Math.min(0.5 + deviation, 1),
        reason: `볼린저 하단 이탈 (가격=${price.toFixed(0)}, 하단=${bb.lower.toFixed(0)})`,
        date: candles[i].date,
        price,
        metadata: { upper: bb.upper, middle: bb.middle, lower: bb.lower, bandwidth: bb.bandwidth },
      });
    }
    // 상단 밴드 터치/이탈 → 매도
    else if (price >= bb.upper) {
      const deviation = (price - bb.upper) / (bb.upper - bb.lower);
      signals.push({
        direction: SignalDirection.Sell,
        strength: Math.min(0.5 + deviation, 1),
        reason: `볼린저 상단 이탈 (가격=${price.toFixed(0)}, 상단=${bb.upper.toFixed(0)})`,
        date: candles[i].date,
        price,
        metadata: { upper: bb.upper, middle: bb.middle, lower: bb.lower, bandwidth: bb.bandwidth },
      });
    }
  }

  const lastIdx = candles.length - 1;
  const lastBB = bbValues[lastIdx];
  const currentSignal = buildCurrentSignal(signals, candles[lastIdx]);

  return {
    strategyName: '볼린저 밴드 (Bollinger Bands)',
    stockCode: '',
    analyzedPeriod: { from: candles[0].date, to: candles[lastIdx].date },
    currentSignal,
    signals,
    indicators: {
      period,
      stdMultiplier,
      currentBands: lastBB
        ? { upper: lastBB.upper, middle: lastBB.middle, lower: lastBB.lower }
        : null,
      bandwidth: lastBB?.bandwidth ?? null,
      pricePosition: lastBB
        ? ((candles[lastIdx].close - lastBB.lower) / (lastBB.upper - lastBB.lower)) * 100
        : null,
    },
    summary: buildSummary('볼린저 밴드', currentSignal, signals),
  };
}

// ─── 그리드 트레이딩 ───

function analyzeGrid(
  candles: CandleData[],
  cfg: MeanReversionConfig,
): StrategyAnalysisResult {
  const signals: Signal[] = [];
  const { spacingPct, levels } = cfg.grid;

  // 기준가: 분석 기간 첫 종가
  const basePrice = candles[0].close;
  const gridLines: { buyPrice: number; sellPrice: number }[] = [];

  for (let lv = 1; lv <= levels; lv++) {
    const buyPrice = basePrice * (1 - (spacingPct * lv) / 100);
    const sellPrice = basePrice * (1 + (spacingPct * lv) / 100);
    gridLines.push({ buyPrice, sellPrice });
  }

  // 그리드 레벨 터치 시 신호 생성
  const touchedBuy = new Set<number>();
  const touchedSell = new Set<number>();

  for (let i = 0; i < candles.length; i++) {
    const price = candles[i].close;

    for (let lv = 0; lv < gridLines.length; lv++) {
      const { buyPrice, sellPrice } = gridLines[lv];

      // 매수 레벨 도달
      if (price <= buyPrice && !touchedBuy.has(lv)) {
        touchedBuy.add(lv);
        signals.push({
          direction: SignalDirection.Buy,
          strength: Math.min((lv + 1) / levels, 1),
          reason: `그리드 매수 Lv${lv + 1} (가격=${price.toFixed(0)}, 매수선=${buyPrice.toFixed(0)})`,
          date: candles[i].date,
          price,
          metadata: { level: lv + 1, buyPrice, sellPrice },
        });
      }

      // 매도 레벨 도달
      if (price >= sellPrice && !touchedSell.has(lv)) {
        touchedSell.add(lv);
        signals.push({
          direction: SignalDirection.Sell,
          strength: Math.min((lv + 1) / levels, 1),
          reason: `그리드 매도 Lv${lv + 1} (가격=${price.toFixed(0)}, 매도선=${sellPrice.toFixed(0)})`,
          date: candles[i].date,
          price,
          metadata: { level: lv + 1, buyPrice, sellPrice },
        });
      }
    }
  }

  const lastIdx = candles.length - 1;
  const currentSignal = buildCurrentSignal(signals, candles[lastIdx]);

  return {
    strategyName: '그리드 트레이딩 (Grid Trading)',
    stockCode: '',
    analyzedPeriod: { from: candles[0].date, to: candles[lastIdx].date },
    currentSignal,
    signals,
    indicators: {
      basePrice,
      spacingPct,
      levels,
      gridLines,
      currentPrice: candles[lastIdx].close,
      priceFromBase:
        ((candles[lastIdx].close - basePrice) / basePrice) * 100,
    },
    summary: buildSummary('그리드 트레이딩', currentSignal, signals),
  };
}

// ─── 매직 분할매수 ───

function analyzeMagicSplit(
  candles: CandleData[],
  cfg: MeanReversionConfig,
): StrategyAnalysisResult {
  const signals: Signal[] = [];
  const { levels } = cfg.magicSplit;

  if (levels.length === 0 || candles.length === 0) {
    const lastCandle = candles[candles.length - 1] ?? { date: new Date(), close: 0 };
    return {
      strategyName: '매직 분할매수 (Magic Split)',
      stockCode: '',
      analyzedPeriod: { from: candles[0]?.date ?? new Date(), to: lastCandle.date },
      currentSignal: {
        direction: SignalDirection.Neutral,
        strength: 0,
        reason: '분할 레벨 미설정',
        date: lastCandle.date,
        price: lastCandle.close,
      },
      signals: [],
      indicators: {},
      summary: '매직 분할매수: 레벨 미설정',
    };
  }

  // 기준가: 첫 종가
  const basePrice = candles[0].close;

  // 각 레벨 상태 추적
  const levelStates = levels.map(() => ({
    bought: false,
    entryPrice: 0,
    soldWithProfit: false,
  }));

  for (let i = 0; i < candles.length; i++) {
    const price = candles[i].close;
    const dropPct = ((price - basePrice) / basePrice) * 100;

    for (let lv = 0; lv < levels.length; lv++) {
      const level = levels[lv];

      // 매수 조건: 하락률이 트리거 도달 & 미매수
      if (!levelStates[lv].bought && dropPct <= level.triggerRate) {
        levelStates[lv].bought = true;
        levelStates[lv].entryPrice = price;

        signals.push({
          direction: SignalDirection.Buy,
          strength: Math.min((Math.abs(level.triggerRate) + 1) / 15, 1),
          reason: `분할매수 Lv${lv + 1} (하락률=${dropPct.toFixed(1)}%, 트리거=${level.triggerRate}%)`,
          date: candles[i].date,
          price,
          metadata: {
            level: lv + 1,
            triggerRate: level.triggerRate,
            targetRate: level.targetRate,
            amount: level.amount,
          },
        });
      }

      // 익절 조건: 매수 후 목표 수익률 도달
      if (levelStates[lv].bought && !levelStates[lv].soldWithProfit) {
        const entryPrice = levelStates[lv].entryPrice;
        const returnPct = ((price - entryPrice) / entryPrice) * 100;

        if (returnPct >= level.targetRate) {
          levelStates[lv].soldWithProfit = true;

          signals.push({
            direction: SignalDirection.Sell,
            strength: Math.min(returnPct / level.targetRate, 1),
            reason: `분할익절 Lv${lv + 1} (수익률=${returnPct.toFixed(1)}%, 목표=${level.targetRate}%)`,
            date: candles[i].date,
            price,
            metadata: { level: lv + 1, returnPct, entryPrice },
          });
        }
      }
    }
  }

  const lastIdx = candles.length - 1;
  const currentSignal = buildCurrentSignal(signals, candles[lastIdx]);

  return {
    strategyName: '매직 분할매수 (Magic Split)',
    stockCode: '',
    analyzedPeriod: { from: candles[0].date, to: candles[lastIdx].date },
    currentSignal,
    signals,
    indicators: {
      basePrice,
      levels: levels.map((l, i) => ({
        ...l,
        bought: levelStates[i].bought,
        entryPrice: levelStates[i].entryPrice,
        soldWithProfit: levelStates[i].soldWithProfit,
      })),
      currentDropPct: ((candles[lastIdx].close - basePrice) / basePrice) * 100,
    },
    summary: buildSummary('매직 분할매수', currentSignal, signals),
  };
}

// ─── Helpers ───

function mergeConfig(partial: Partial<MeanReversionConfig>): MeanReversionConfig {
  return {
    variant: partial.variant ?? DEFAULT_CONFIG.variant,
    rsi: { ...DEFAULT_CONFIG.rsi, ...partial.rsi },
    bollinger: { ...DEFAULT_CONFIG.bollinger, ...partial.bollinger },
    grid: { ...DEFAULT_CONFIG.grid, ...partial.grid },
    magicSplit: {
      levels: partial.magicSplit?.levels ?? DEFAULT_CONFIG.magicSplit.levels,
    },
  };
}

function buildCurrentSignal(signals: Signal[], lastCandle: CandleData): Signal {
  const recent = signals.slice(-5);
  if (recent.length === 0) {
    return {
      direction: SignalDirection.Neutral,
      strength: 0,
      reason: '분석 기간 내 신호 없음',
      date: lastCandle.date,
      price: lastCandle.close,
    };
  }
  return recent[recent.length - 1];
}

function buildSummary(name: string, current: Signal, signals: Signal[]): string {
  const buys = signals.filter((s) => s.direction === SignalDirection.Buy).length;
  const sells = signals.filter((s) => s.direction === SignalDirection.Sell).length;
  return `[${name}] 총 ${signals.length}개 신호 (매수 ${buys}, 매도 ${sells}). 현재: ${current.direction} (강도 ${(current.strength * 100).toFixed(0)}%)`;
}
