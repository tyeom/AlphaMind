export type RegimeLabel = 'CRISIS' | 'NEUTRAL' | 'ATTACK';

export interface BreadthSnapshot {
  universeCount: number;
  aboveSma20Ratio: number;
  aboveSma60Ratio: number;
  medianDailyReturnPct: number;
  medianRet5dPct: number;
  medianAtrPct: number;
}

export interface MarketRegimeState {
  prevSmoothedScore?: number;
  prevLabel?: RegimeLabel;
  updatedAt?: string;
}

export interface MarketRegimeOptions {
  maDays?: number;
  minHoldDays?: number;
  minBreadthSample?: number;
  ret5dSpanPct?: number;
  volFloorPct?: number;
  volCeilPct?: number;
  wTrend?: number;
  wMomentum?: number;
  wVol?: number;
  crisisEnter?: number;
  crisisExit?: number;
  attackEnter?: number;
  attackExit?: number;
  crisisSlotMultiplier?: number;
  crisisAmountMultiplier?: number;
  neutralSlotMultiplier?: number;
  neutralAmountMultiplier?: number;
  attackSlotMultiplier?: number;
  attackAmountMultiplier?: number;
  currentDate?: Date;
}

export interface RegimeResult {
  label: RegimeLabel;
  rawScore: number;
  smoothedScore: number;
  slotMultiplier: number;
  amountMultiplier: number;
  breadth: BreadthSnapshot;
  source: 'breadth' | 'fallback';
}

export const DEFAULT_MARKET_REGIME_OPTIONS = {
  maDays: 5,
  minHoldDays: 1,
  minBreadthSample: 30,
  ret5dSpanPct: 10,
  volFloorPct: 2,
  volCeilPct: 6,
  wTrend: 0.4,
  wMomentum: 0.2,
  wVol: 0.4,
  crisisEnter: 0.35,
  crisisExit: 0.45,
  attackEnter: 0.65,
  attackExit: 0.55,
  crisisSlotMultiplier: 0.5,
  crisisAmountMultiplier: 0.6,
  neutralSlotMultiplier: 0.8,
  neutralAmountMultiplier: 0.8,
  attackSlotMultiplier: 1,
  attackAmountMultiplier: 1,
} as const;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function safePositive(value: number | undefined, fallback: number): number {
  return value != null && Number.isFinite(value) && value > 0
    ? value
    : fallback;
}

function daysBetween(a: Date, b: Date): number {
  const ms = Math.abs(a.getTime() - b.getTime());
  return ms / 86_400_000;
}

function shouldKeepPreviousLabel(
  nextLabel: RegimeLabel,
  state: MarketRegimeState | null | undefined,
  opts: Required<Omit<MarketRegimeOptions, 'currentDate'>> & {
    currentDate: Date;
  },
): boolean {
  if (!state?.prevLabel || state.prevLabel === nextLabel) return false;
  if (opts.minHoldDays <= 0 || !state.updatedAt) return false;

  const updatedAt = new Date(state.updatedAt);
  if (Number.isNaN(updatedAt.getTime())) return false;

  return daysBetween(opts.currentDate, updatedAt) < opts.minHoldDays;
}

function resolveLabel(
  smoothedScore: number,
  prevLabel: RegimeLabel | undefined,
  opts: Required<Omit<MarketRegimeOptions, 'currentDate'>>,
): RegimeLabel {
  if (prevLabel === 'CRISIS') {
    if (smoothedScore < opts.crisisExit) return 'CRISIS';
    if (smoothedScore > opts.attackEnter) return 'ATTACK';
    return 'NEUTRAL';
  }

  if (prevLabel === 'ATTACK') {
    if (smoothedScore > opts.attackExit) return 'ATTACK';
    if (smoothedScore < opts.crisisEnter) return 'CRISIS';
    return 'NEUTRAL';
  }

  if (smoothedScore < opts.crisisEnter) return 'CRISIS';
  if (smoothedScore > opts.attackEnter) return 'ATTACK';
  return 'NEUTRAL';
}

function scaleForLabel(
  label: RegimeLabel,
  opts: Required<Omit<MarketRegimeOptions, 'currentDate'>>,
): { slotMultiplier: number; amountMultiplier: number } {
  let slotMultiplier =
    label === 'CRISIS'
      ? opts.crisisSlotMultiplier
      : label === 'ATTACK'
        ? opts.attackSlotMultiplier
        : opts.neutralSlotMultiplier;
  let amountMultiplier =
    label === 'CRISIS'
      ? opts.crisisAmountMultiplier
      : label === 'ATTACK'
        ? opts.attackAmountMultiplier
        : opts.neutralAmountMultiplier;

  slotMultiplier = safePositive(slotMultiplier, 1);
  amountMultiplier = safePositive(amountMultiplier, 1);

  if (label === 'ATTACK' && slotMultiplier > 1 && amountMultiplier > 1) {
    amountMultiplier = 1;
  }

  return { slotMultiplier, amountMultiplier };
}

function fallbackRegime(breadth: BreadthSnapshot): RegimeResult {
  return {
    label: 'NEUTRAL',
    rawScore: 0.5,
    smoothedScore: 0.5,
    slotMultiplier: 1,
    amountMultiplier: 1,
    breadth,
    source: 'fallback',
  };
}

export function computeMarketRegime(
  breadth: BreadthSnapshot,
  state: MarketRegimeState | null = null,
  options: MarketRegimeOptions = {},
): RegimeResult {
  const opts = {
    ...DEFAULT_MARKET_REGIME_OPTIONS,
    ...options,
    currentDate: options.currentDate ?? new Date(),
  };

  if (
    !Number.isFinite(breadth.universeCount) ||
    breadth.universeCount < opts.minBreadthSample
  ) {
    return fallbackRegime(breadth);
  }

  // Step 1. 시장 폭, 5일 모멘텀, 고정 임계 변동성 점수를 0~1로 정규화한다.
  const trendComponent = clamp01(breadth.aboveSma60Ratio);
  const momentumComponent = clamp01(
    0.5 + breadth.medianRet5dPct / safePositive(opts.ret5dSpanPct, 10),
  );
  const volRange = opts.volCeilPct - opts.volFloorPct;
  const volatilityComponent =
    volRange > 0 && Number.isFinite(breadth.medianAtrPct)
      ? 1 - clamp01((breadth.medianAtrPct - opts.volFloorPct) / volRange)
      : 0.5;

  // Step 2. 가중치 합이 튜닝 중 어긋나도 점수 범위를 유지하도록 합으로 나눈다.
  const weightSum = opts.wTrend + opts.wMomentum + opts.wVol;
  const safeWeightSum = weightSum > 0 ? weightSum : 1;
  const rawScore =
    (opts.wTrend * trendComponent +
      opts.wMomentum * momentumComponent +
      opts.wVol * volatilityComponent) /
    safeWeightSum;

  // Step 3. EMA(기본 5일)로 하루 단위 노이즈를 완화한다.
  const prevSmoothed =
    state?.prevSmoothedScore != null &&
    Number.isFinite(state.prevSmoothedScore)
      ? state.prevSmoothedScore
      : undefined;
  const alpha = 2 / (safePositive(opts.maDays, 5) + 1);
  const smoothedScore =
    prevSmoothed == null
      ? rawScore
      : alpha * rawScore + (1 - alpha) * prevSmoothed;

  // Step 4. 진입/이탈 밴드와 최소 유지일로 레짐 플립플랍을 막는다.
  let label = resolveLabel(smoothedScore, state?.prevLabel, opts);
  if (shouldKeepPreviousLabel(label, state, opts)) {
    label = state!.prevLabel!;
  }

  const scale = scaleForLabel(label, opts);
  return {
    label,
    rawScore,
    smoothedScore,
    ...scale,
    breadth,
    source: 'breadth',
  };
}
