import {
  CandleData,
  ScalpingConfig,
  ScalpingVariant,
  Signal,
  SignalDirection,
  StrategyAnalysisResult,
} from '../types/strategy.types';
import {
  calculateAvgVolume,
  calculateRSI,
  calculateSMA,
  countConsecutiveDownCandles,
} from '../indicators/technical-indicators';
import { pickFreshCurrentSignal } from '../utils/signal-freshness';

/**
 * 단타 스캘핑 (짧게 먹고 빠지기 반복).
 *
 * 일봉 종가 신호 → 익일 시가 진입 → 타이트한 고정 TP/SL + 짧은 보유일(trade-meta
 * exit profile)로 청산까지 백테스트와 실전이 같은 규칙을 쓴다.
 * 매도(SELL) 신호는 의도적으로 방출하지 않는다 — 실전 청산은 backend 의
 * 실시간 손절/익절/본전보호/트레일링 엔진이 담당하므로, 백테스트에서만 작동하는
 * 반대 신호 청산을 만들면 검증↔실전 정합이 깨진다.
 *
 * 라이브 재검증이 KIS 일봉 30~60개로 돌기 때문에 모든 지표 기간은 20일 이하다.
 */

const DEFAULT_CONFIG: ScalpingConfig = {
  variant: ScalpingVariant.Ensemble,
  pullback: {
    trendSmaPeriod: 20,
    fastSmaPeriod: 5,
    pullbackMinPct: 2,
    pullbackMaxPct: 7,
    highLookback: 10,
    volumeContractionRatio: 1.0,
  },
  rsiSnapback: {
    rsiPeriod: 3,
    rsiOversold: 20,
    trendSmaPeriod: 20,
    minConsecutiveDownCandles: 2,
  },
  gapMomentum: {
    rvolPeriod: 20,
    minRvol: 1.8,
    minClosePosition: 0.7,
    breakoutLookback: 20,
    rsiPeriod: 14,
    rsiOverbought: 78,
    maxDailyGainPct: 15,
  },
  ensemble: {
    confluenceBoost: 0.1,
    soloDampen: 0.9,
  },
};

/** 신호 강도 상한 — 단일 조건 포화로 1.0 고정되는 것을 방지 */
const MAX_STRENGTH = 0.95;

/** 사전 계산된 지표 시리즈 — variant 간 공유 */
interface IndicatorContext {
  sma5: (number | null)[];
  sma20: (number | null)[];
  /** rsi_snapback 전용 추세 SMA — 기간이 pullback 과 같으면 sma20 을 재사용 */
  snapbackTrendSma: (number | null)[];
  rsiFast: (number | null)[];
  rsiSlow: (number | null)[];
  avgVolume20: (number | null)[];
}

export function analyzeScalping(
  candles: CandleData[],
  config: Partial<ScalpingConfig> = {},
): StrategyAnalysisResult {
  const cfg = mergeConfig(config);
  const trendPeriod = Math.max(
    cfg.pullback.trendSmaPeriod,
    cfg.rsiSnapback.trendSmaPeriod,
  );

  if (candles.length < trendPeriod + 2) {
    return buildEmptyResult(cfg, candles);
  }

  const ctx = buildIndicatorContext(candles, cfg);

  const signals: Signal[] = [];
  const warmup = trendPeriod + 1;

  for (let i = warmup; i < candles.length; i++) {
    const signal =
      cfg.variant === ScalpingVariant.Ensemble
        ? evaluateEnsemble(candles, i, cfg, ctx)
        : evaluateVariant(cfg.variant, candles, i, cfg, ctx);
    if (signal) signals.push(signal);
  }

  const lastIdx = candles.length - 1;
  const lastCandle = candles[lastIdx];
  const currentSignal = pickFreshCurrentSignal(
    signals,
    lastCandle,
    undefined,
    undefined,
    { tradingDates: candles },
  );

  return {
    strategyName: variantDisplayName(cfg.variant),
    stockCode: '',
    analyzedPeriod: { from: candles[0].date, to: lastCandle.date },
    currentSignal,
    signals,
    indicators: {
      variant: cfg.variant,
      currentSma5: ctx.sma5[lastIdx],
      currentSma20: ctx.sma20[lastIdx],
      currentRsiFast: ctx.rsiFast[lastIdx],
      currentRsiSlow: ctx.rsiSlow[lastIdx],
      currentRvol:
        ctx.avgVolume20[lastIdx] != null && ctx.avgVolume20[lastIdx]! > 0
          ? candles[lastIdx].volume / ctx.avgVolume20[lastIdx]!
          : null,
      totalSignals: signals.length,
    },
    summary: buildSummary(cfg.variant, currentSignal, signals),
  };
}

// ─── Variant 평가 ───

function evaluateVariant(
  variant: ScalpingVariant,
  candles: CandleData[],
  i: number,
  cfg: ScalpingConfig,
  ctx: IndicatorContext,
): Signal | null {
  switch (variant) {
    case ScalpingVariant.Pullback:
      return evaluatePullback(candles, i, cfg, ctx);
    case ScalpingVariant.RsiSnapback:
      return evaluateRsiSnapback(candles, i, cfg, ctx);
    case ScalpingVariant.GapMomentum:
      return evaluateGapMomentum(candles, i, cfg, ctx);
    default:
      return null;
  }
}

/**
 * 눌림목: 상승 추세(종가 > SMA20, SMA20 상승) 중 단기 고점 대비 2~7% 조정이
 * 5일선 부근까지 진행된 뒤 반전 양봉이 나오면 다음날 반등을 노린다.
 */
function evaluatePullback(
  candles: CandleData[],
  i: number,
  cfg: ScalpingConfig,
  ctx: IndicatorContext,
): Signal | null {
  const p = cfg.pullback;
  const c = candles[i];
  const sma20 = ctx.sma20[i];
  const sma20Prev = ctx.sma20[i - 3] ?? ctx.sma20[i - 1];
  const sma5 = ctx.sma5[i];
  // 거래량 베이스라인은 전일까지의 평균 — 당일 거래량이 분모를 키우는 왜곡 방지
  const avgVol = i >= 1 ? ctx.avgVolume20[i - 1] : null;
  if (sma20 == null || sma20Prev == null || sma5 == null) return null;

  // 상승 추세: 종가가 20일선 위 + 20일선 자체가 상승 중
  if (c.close <= sma20 || sma20 <= sma20Prev) return null;

  // 단기 고점 대비 조정폭 (당일 저가 기준)
  const lookbackStart = Math.max(0, i - p.highLookback);
  let recentHigh = 0;
  for (let j = lookbackStart; j < i; j++) {
    if (candles[j].high > recentHigh) recentHigh = candles[j].high;
  }
  if (recentHigh <= 0) return null;
  const pullbackPct = ((recentHigh - c.low) / recentHigh) * 100;
  if (pullbackPct < p.pullbackMinPct || pullbackPct > p.pullbackMaxPct) {
    return null;
  }

  // 눌림 위치: 당일 저가가 5일선을 터치(이하)했어야 의미 있는 눌림
  if (c.low > sma5 * 1.005) return null;

  // 반전 양봉: 양봉 + 종가가 일중 레인지 상단부
  const range = c.high - c.low;
  if (range <= 0 || c.close <= c.open) return null;
  const closePos = (c.close - c.low) / range;
  if (closePos < 0.5) return null;

  // 조정 중 거래량 수축 (소프트 조건 — 투매성 하락 배제 가점)
  const recentVolAvg =
    (candles[i].volume +
      candles[i - 1].volume +
      candles[i - 2].volume) /
    3;
  const volumeContracted =
    avgVol != null && avgVol > 0
      ? recentVolAvg <= avgVol * p.volumeContractionRatio
      : false;

  // 조정폭 sweet spot(중앙) 가점 — 너무 얕거나 깊으면 감점
  const mid = (p.pullbackMinPct + p.pullbackMaxPct) / 2;
  const half = (p.pullbackMaxPct - p.pullbackMinPct) / 2;
  const depthScore = half > 0 ? 1 - Math.abs(pullbackPct - mid) / half : 0;

  const slopePct = ((sma20 - sma20Prev) / sma20Prev) * 100;
  const slopeScore = Math.min(slopePct / 1.5, 1);

  const strength = Math.min(
    0.58 +
      0.1 * depthScore +
      0.12 * closePos +
      (volumeContracted ? 0.06 : 0) +
      0.09 * slopeScore,
    MAX_STRENGTH,
  );

  return {
    direction: SignalDirection.Buy,
    strength,
    reason: `눌림목 반등 (고점 -${pullbackPct.toFixed(1)}%, 5일선 터치 후 반전 양봉)`,
    date: c.date,
    price: c.close,
    metadata: { pullbackPct, closePos, volumeContracted, sma5, sma20 },
  };
}

/**
 * RSI 스냅백: 추세(종가 > SMA20) 위에서 단기 RSI(3) 과매도 + 연속 음봉 —
 * 다음날 기술적 반등을 노리는 단기 평균회귀.
 */
function evaluateRsiSnapback(
  candles: CandleData[],
  i: number,
  cfg: ScalpingConfig,
  ctx: IndicatorContext,
): Signal | null {
  const r = cfg.rsiSnapback;
  const c = candles[i];
  const trendSma = ctx.snapbackTrendSma[i];
  const rsi = ctx.rsiFast[i];
  if (trendSma == null || rsi == null) return null;

  // 추세 필터: 하락 추세의 폭락은 받지 않는다
  if (c.close <= trendSma) return null;
  if (rsi >= r.rsiOversold) return null;

  const consecutiveDown = countConsecutiveDownCandles(candles, i);
  if (consecutiveDown < r.minConsecutiveDownCandles) return null;

  // 과매도 깊이 + 연속 음봉 수에 비례한 강도
  const oversoldDepth = (r.rsiOversold - rsi) / r.rsiOversold;
  const downScore = Math.min(
    (consecutiveDown - r.minConsecutiveDownCandles + 1) / 3,
    1,
  );

  const strength = Math.min(
    0.6 + 0.18 * oversoldDepth + 0.12 * downScore,
    MAX_STRENGTH,
  );

  return {
    direction: SignalDirection.Buy,
    strength,
    reason: `RSI 스냅백 (RSI${r.rsiPeriod}=${rsi.toFixed(0)}, ${consecutiveDown}연속 음봉, 추세 위 과매도)`,
    date: c.date,
    price: c.close,
    metadata: { rsi, consecutiveDown, trendSma },
  };
}

/**
 * 강종가 모멘텀: 거래량 급증(RVOL) + 고가권 마감 + 단기 신고가 돌파 —
 * 다음날 시초 연속성(갭/모멘텀)을 노린다. 과열(RSI14)·상한가 추격은 차단.
 */
function evaluateGapMomentum(
  candles: CandleData[],
  i: number,
  cfg: ScalpingConfig,
  ctx: IndicatorContext,
): Signal | null {
  const g = cfg.gapMomentum;
  const c = candles[i];
  // RVOL 분모는 전일까지의 평균 거래량 — 당일 급증분이 분모를 키워 RVOL 을
  // 과소평가하는 왜곡을 막는다 (표준 RVOL 정의와 일치)
  const avgVol = i >= 1 ? ctx.avgVolume20[i - 1] : null;
  const rsiSlow = ctx.rsiSlow[i];
  if (avgVol == null || avgVol <= 0) return null;

  const range = c.high - c.low;
  if (range <= 0 || c.close <= c.open) return null;

  const closePos = (c.close - c.low) / range;
  if (closePos < g.minClosePosition) return null;

  const rvol = c.volume / avgVol;
  if (rvol < g.minRvol) return null;

  // 단기 신고가 돌파 (종가 기준)
  const lookbackStart = Math.max(0, i - g.breakoutLookback);
  let priorMaxClose = 0;
  for (let j = lookbackStart; j < i; j++) {
    if (candles[j].close > priorMaxClose) priorMaxClose = candles[j].close;
  }
  if (priorMaxClose <= 0 || c.close <= priorMaxClose) return null;

  // 과열 차단: RSI14 과열 또는 당일 급등 과도(상한가 추격) 시 진입하지 않는다
  if (rsiSlow != null && rsiSlow >= g.rsiOverbought) return null;
  const prevClose = candles[i - 1].close;
  if (prevClose > 0) {
    const dailyGainPct = ((c.close - prevClose) / prevClose) * 100;
    if (dailyGainPct > g.maxDailyGainPct) return null;
  }

  const rvolScore = Math.min((rvol - g.minRvol) / g.minRvol, 1);
  const closePosScore =
    (closePos - g.minClosePosition) / (1 - g.minClosePosition);
  const breakoutMarginPct = ((c.close - priorMaxClose) / priorMaxClose) * 100;
  const breakoutScore = Math.min(breakoutMarginPct / 2, 1);

  const strength = Math.min(
    0.58 + 0.15 * rvolScore + 0.12 * closePosScore + 0.1 * breakoutScore,
    MAX_STRENGTH,
  );

  return {
    direction: SignalDirection.Buy,
    strength,
    reason: `강종가 모멘텀 (RVOL ${rvol.toFixed(1)}배, ${g.breakoutLookback}일 신고가 돌파, 고가권 마감)`,
    date: c.date,
    price: c.close,
    metadata: { rvol, closePos, breakoutMarginPct },
  };
}

/**
 * 혼합(ensemble): 세 sub-variant 를 모두 평가해 2개 이상 합의하면 강도를 가산,
 * 단독 신호는 감쇠해 자연스럽게 컨플루언스 우선으로 동작한다.
 *
 * 합의는 당일 + 전일 신호를 함께 센다 (전일 데이터만 사용 — 인과적).
 * rsi_snapback(음봉 필요)과 pullback/gap(양봉 필요)은 같은 날 동시 발화가
 * 구조적으로 불가능하므로, "어제 과매도 → 오늘 반전" 같은 연속 셋업을
 * 합의 증거로 인정해야 컨플루언스가 실제로 작동한다.
 */
const ENSEMBLE_SUB_VARIANTS = [
  ScalpingVariant.Pullback,
  ScalpingVariant.RsiSnapback,
  ScalpingVariant.GapMomentum,
] as const;

function evaluateEnsemble(
  candles: CandleData[],
  i: number,
  cfg: ScalpingConfig,
  ctx: IndicatorContext,
): Signal | null {
  const today = ENSEMBLE_SUB_VARIANTS.map((variant) =>
    evaluateVariant(variant, candles, i, cfg, ctx),
  );
  const firingToday = today.filter((s): s is Signal => s != null);
  if (firingToday.length === 0) return null;

  // 전일 신호는 합의 증거로만 — 당일 미발화 variant 한정
  const priorEvidence =
    i >= 1
      ? ENSEMBLE_SUB_VARIANTS.filter((_, idx) => today[idx] == null)
          .map((variant) => evaluateVariant(variant, candles, i - 1, cfg, ctx))
          .filter((s): s is Signal => s != null)
      : [];

  const confluenceCount = firingToday.length + priorEvidence.length;
  const strongest = firingToday.reduce((a, b) =>
    b.strength > a.strength ? b : a,
  );

  if (confluenceCount >= 2) {
    const reasons = [
      ...firingToday.map((s) => s.reason.split(' (')[0]),
      ...priorEvidence.map((s) => `전일 ${s.reason.split(' (')[0]}`),
    ].join(' + ');
    return {
      direction: SignalDirection.Buy,
      strength: Math.min(
        strongest.strength + cfg.ensemble.confluenceBoost,
        MAX_STRENGTH,
      ),
      reason: `단타 컨플루언스 (${reasons})`,
      date: candles[i].date,
      price: candles[i].close,
      metadata: {
        confluenceCount,
        subReasons: [
          ...firingToday.map((s) => s.reason),
          ...priorEvidence.map((s) => `(전일) ${s.reason}`),
        ],
      },
    };
  }

  return {
    ...strongest,
    strength: Math.min(
      strongest.strength * cfg.ensemble.soloDampen,
      MAX_STRENGTH,
    ),
    metadata: { ...strongest.metadata, confluenceCount: 1 },
  };
}

// ─── Helpers ───

function buildIndicatorContext(
  candles: CandleData[],
  cfg: ScalpingConfig,
): IndicatorContext {
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);
  const sma20 = calculateSMA(closes, cfg.pullback.trendSmaPeriod);
  return {
    sma5: calculateSMA(closes, cfg.pullback.fastSmaPeriod),
    sma20,
    snapbackTrendSma:
      cfg.rsiSnapback.trendSmaPeriod === cfg.pullback.trendSmaPeriod
        ? sma20
        : calculateSMA(closes, cfg.rsiSnapback.trendSmaPeriod),
    rsiFast: calculateRSI(closes, cfg.rsiSnapback.rsiPeriod),
    rsiSlow: calculateRSI(closes, cfg.gapMomentum.rsiPeriod),
    avgVolume20: calculateAvgVolume(volumes, cfg.gapMomentum.rvolPeriod),
  };
}

const KNOWN_VARIANTS = new Set<string>(Object.values(ScalpingVariant));

function mergeConfig(partial: Partial<ScalpingConfig>): ScalpingConfig {
  // 미지의 variant 문자열(세션 오타 등)은 조용히 0신호가 되지 않도록
  // 기본(ensemble)으로 정규화한다 — day-trading 의 default-fallback 패턴과 동일.
  const variant =
    partial.variant != null && KNOWN_VARIANTS.has(partial.variant)
      ? partial.variant
      : DEFAULT_CONFIG.variant;
  return {
    variant,
    pullback: { ...DEFAULT_CONFIG.pullback, ...partial.pullback },
    rsiSnapback: { ...DEFAULT_CONFIG.rsiSnapback, ...partial.rsiSnapback },
    gapMomentum: { ...DEFAULT_CONFIG.gapMomentum, ...partial.gapMomentum },
    ensemble: { ...DEFAULT_CONFIG.ensemble, ...partial.ensemble },
  };
}

function variantDisplayName(variant: ScalpingVariant): string {
  switch (variant) {
    case ScalpingVariant.Pullback:
      return '단타 스캘핑 — 눌림목 (Pullback)';
    case ScalpingVariant.RsiSnapback:
      return '단타 스캘핑 — RSI 스냅백 (RSI Snapback)';
    case ScalpingVariant.GapMomentum:
      return '단타 스캘핑 — 강종가 모멘텀 (Gap Momentum)';
    case ScalpingVariant.Ensemble:
    default:
      return '단타 스캘핑 — 혼합 (Ensemble)';
  }
}

function buildEmptyResult(
  cfg: ScalpingConfig,
  candles: CandleData[],
): StrategyAnalysisResult {
  const last = candles[candles.length - 1];
  const now = last?.date ?? new Date(0);
  return {
    strategyName: variantDisplayName(cfg.variant),
    stockCode: '',
    analyzedPeriod: {
      from: candles[0]?.date ?? now,
      to: now,
    },
    currentSignal: {
      direction: SignalDirection.Neutral,
      strength: 0,
      reason: '분석에 필요한 캔들 수 부족',
      date: now,
      price: last?.close ?? 0,
    },
    signals: [],
    indicators: { variant: cfg.variant },
    summary: `[${variantDisplayName(cfg.variant)}] 분석에 필요한 캔들 수 부족`,
  };
}

function buildSummary(
  variant: ScalpingVariant,
  current: Signal,
  signals: Signal[],
): string {
  const buys = signals.filter(
    (s) => s.direction === SignalDirection.Buy,
  ).length;
  return (
    `[${variantDisplayName(variant)}] 총 ${signals.length}개 신호 (매수 ${buys}). ` +
    `현재: ${current.direction} (강도 ${(current.strength * 100).toFixed(0)}%)`
  );
}
