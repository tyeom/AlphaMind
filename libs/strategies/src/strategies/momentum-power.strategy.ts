import {
  CandleData,
  ExitConfig,
  MomentumPowerConfig,
  MomentumPowerMarket,
  MomentumPowerMode,
  Signal,
  SignalDirection,
  StrategyAnalysisResult,
} from '../types/strategy.types';
import { calculateSMA } from '../indicators/technical-indicators';

const DEFAULT_EXIT_CONFIG: ExitConfig = {
  stopLossEnabled: true,
  stopLossPct: 2.0,
  takeProfitEnabled: true,
  takeProfitPct: 4.0,
  trailingStopEnabled: false,
  trailingTriggerPct: 2.0,
  trailingStopPct: 1.0,
  exitOnOppositeSignal: true,
};

/**
 * Momentum Power (Snow) 전략 기본 설정.
 *
 * 원본 Rust 구현은 200일 MA(약 10개월) 기반이지만,
 * alpha-mind 백테스트는 3개월(≈60 거래일) 윈도우를 사용하므로
 * 실행 가능한 범위의 기본값(40일/5일/7일)으로 조정한다.
 */
const DEFAULT_CONFIG: MomentumPowerConfig = {
  market: MomentumPowerMarket.US,
  tipMaPeriod: 40,
  momentumPeriod: 5,
  rebalanceDays: 7,
  exitConfig: DEFAULT_EXIT_CONFIG,
};

/**
 * Momentum Power (Snow) 전략 분석.
 *
 * 시장 안전도(장기 MA)와 모멘텀(단기 MA) 조합으로
 * 공격(Attack) / 안전(Safe) / 위기(Crisis) 세 가지 모드를 전환하며,
 * 리밸런싱 주기(rebalanceDays) 이상 경과 후 모드 변경 시 신호를 생성한다.
 *
 * - Attack (종가 > 장기 MA AND 종가 > 단기 MA) → BUY
 * - Safe   (종가 > 장기 MA AND 종가 ≤ 단기 MA) → Neutral
 * - Crisis (종가 ≤ 장기 MA)                   → SELL
 */
export function analyzeMomentumPower(
  candles: CandleData[],
  config: Partial<MomentumPowerConfig> = {},
): StrategyAnalysisResult {
  const cfg = mergeConfig(config);
  const signals: Signal[] = [];

  const closes = candles.map((c) => c.close);
  const longMA = calculateSMA(closes, cfg.tipMaPeriod);
  const shortMA = calculateSMA(closes, cfg.momentumPeriod);

  const modeHistory: { date: Date; mode: MomentumPowerMode }[] = [];

  let prevMode: MomentumPowerMode | null = null;
  let lastRebalanceIdx: number | null = null;

  for (let i = 0; i < candles.length; i++) {
    const lMA = longMA[i];
    const sMA = shortMA[i];
    if (lMA == null || sMA == null) continue;

    const close = candles[i].close;
    const marketSafe = close > lMA;
    const hasMomentum = close > sMA;

    const mode: MomentumPowerMode = !marketSafe
      ? MomentumPowerMode.Crisis
      : hasMomentum
        ? MomentumPowerMode.Attack
        : MomentumPowerMode.Safe;

    modeHistory.push({ date: candles[i].date, mode });

    // 리밸런싱 주기 체크: 마지막 리밸런싱으로부터 rebalanceDays 이상 경과했는가
    const canRebalance =
      lastRebalanceIdx == null || i - lastRebalanceIdx >= cfg.rebalanceDays;

    // 모드 변경 + 리밸런싱 주기 충족 시에만 신호 생성
    if (prevMode !== mode && canRebalance) {
      const signal = buildModeSignal(mode, candles[i], cfg, lMA, sMA);
      if (signal) {
        signals.push(signal);
      }
      lastRebalanceIdx = i;
    }

    prevMode = mode;
  }

  const lastIdx = candles.length - 1;
  const lastCandle = candles[lastIdx];
  const currentMode = modeHistory[modeHistory.length - 1]?.mode ?? null;
  const currentSignal = buildCurrentSignal(signals, lastCandle, currentMode);

  return {
    strategyName: 'Momentum Power (Snow)',
    stockCode: '',
    analyzedPeriod: { from: candles[0].date, to: lastCandle.date },
    currentSignal,
    signals,
    indicators: {
      market: cfg.market,
      tipMaPeriod: cfg.tipMaPeriod,
      momentumPeriod: cfg.momentumPeriod,
      rebalanceDays: cfg.rebalanceDays,
      currentLongMA: longMA[lastIdx],
      currentShortMA: shortMA[lastIdx],
      currentMode,
      modeCounts: countModes(modeHistory),
      totalSignals: signals.length,
      buySignals: signals.filter((s) => s.direction === SignalDirection.Buy).length,
      sellSignals: signals.filter((s) => s.direction === SignalDirection.Sell).length,
    },
    summary: buildSummary('Momentum Power', currentSignal, signals, currentMode),
  };
}

// ─── Helpers ───

function mergeConfig(partial: Partial<MomentumPowerConfig>): MomentumPowerConfig {
  return {
    market: partial.market ?? DEFAULT_CONFIG.market,
    tipMaPeriod: partial.tipMaPeriod ?? DEFAULT_CONFIG.tipMaPeriod,
    momentumPeriod: partial.momentumPeriod ?? DEFAULT_CONFIG.momentumPeriod,
    rebalanceDays: partial.rebalanceDays ?? DEFAULT_CONFIG.rebalanceDays,
    exitConfig: { ...DEFAULT_EXIT_CONFIG, ...partial.exitConfig },
  };
}

function buildModeSignal(
  mode: MomentumPowerMode,
  candle: CandleData,
  cfg: MomentumPowerConfig,
  longMA: number,
  shortMA: number,
): Signal | null {
  const meta = {
    mode,
    longMA,
    shortMA,
    tipMaPeriod: cfg.tipMaPeriod,
    momentumPeriod: cfg.momentumPeriod,
  };

  switch (mode) {
    case MomentumPowerMode.Attack: {
      const momentumGap = ((candle.close - shortMA) / shortMA) * 100;
      const trendGap = ((candle.close - longMA) / longMA) * 100;
      return {
        direction: SignalDirection.Buy,
        strength: clamp01(0.5 + momentumGap / 20),
        reason: `Attack 모드 전환 (종가 > 장기MA${cfg.tipMaPeriod}+${trendGap.toFixed(1)}%, 단기MA${cfg.momentumPeriod}+${momentumGap.toFixed(1)}%)`,
        date: candle.date,
        price: candle.close,
        metadata: meta,
      };
    }
    case MomentumPowerMode.Crisis: {
      const riskGap = ((longMA - candle.close) / longMA) * 100;
      return {
        direction: SignalDirection.Sell,
        strength: clamp01(0.5 + riskGap / 10),
        reason: `Crisis 모드 전환 (종가 < 장기MA${cfg.tipMaPeriod} -${riskGap.toFixed(1)}%)`,
        date: candle.date,
        price: candle.close,
        metadata: meta,
      };
    }
    case MomentumPowerMode.Safe:
    default:
      // Safe 모드는 직접적 매매 신호를 만들지 않는다 (관망).
      return null;
  }
}

function buildCurrentSignal(
  signals: Signal[],
  lastCandle: CandleData,
  currentMode: MomentumPowerMode | null,
): Signal {
  const recent = signals.slice(-5);
  if (recent.length === 0) {
    return {
      direction: SignalDirection.Neutral,
      strength: 0,
      reason: currentMode
        ? `현재 모드: ${currentMode} (신호 없음)`
        : '분석에 필요한 데이터 부족',
      date: lastCandle.date,
      price: lastCandle.close,
    };
  }
  return recent[recent.length - 1];
}

function buildSummary(
  name: string,
  current: Signal,
  signals: Signal[],
  currentMode: MomentumPowerMode | null,
): string {
  const buys = signals.filter((s) => s.direction === SignalDirection.Buy).length;
  const sells = signals.filter((s) => s.direction === SignalDirection.Sell).length;
  const modeText = currentMode ? ` (모드=${currentMode})` : '';
  return `[${name}] 총 ${signals.length}개 신호 (매수 ${buys}, 매도 ${sells})${modeText}. 현재: ${current.direction} (강도 ${(current.strength * 100).toFixed(0)}%)`;
}

function countModes(
  history: { date: Date; mode: MomentumPowerMode }[],
): Record<MomentumPowerMode, number> {
  const counts = {
    [MomentumPowerMode.Attack]: 0,
    [MomentumPowerMode.Safe]: 0,
    [MomentumPowerMode.Crisis]: 0,
  };
  for (const h of history) {
    counts[h.mode]++;
  }
  return counts;
}

function clamp01(v: number): number {
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
