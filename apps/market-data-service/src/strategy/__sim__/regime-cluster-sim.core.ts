import {
  buildAlignedLogReturns,
  clusterByCorrelation,
  computeMarketRegime,
  type CorrelationPricePoint,
  type MarketRegimeState,
  type RegimeLabel,
} from '@alpha-mind/strategies';

export interface RegimeClusterSimulationSummary {
  pass: boolean;
  regimeFlips: number;
  maxRegimeFlips: number;
  labelCounts: Record<RegimeLabel, number>;
  maxClusterSize: number;
  clusterCount: number;
  offSelectedCount: number;
  onSelectedCount: number;
  skippedByCluster: number;
}

interface CandidateSnapshot {
  stockCode: string;
  clusterId?: number;
  sector?: string;
}

interface AdoptionResult {
  selected: string[];
  skippedByCluster: number;
}

function syntheticDate(day: number): Date {
  return new Date(Date.UTC(2026, 0, day + 1));
}

function regimePhase(day: number): {
  aboveSma60Ratio: number;
  medianRet5dPct: number;
  medianAtrPct: number;
} {
  if (day < 72) {
    return { aboveSma60Ratio: 0.16, medianRet5dPct: -5, medianAtrPct: 6.2 };
  }
  if (day < 96) {
    return { aboveSma60Ratio: 0.48, medianRet5dPct: 0.2, medianAtrPct: 4 };
  }
  return { aboveSma60Ratio: 0.86, medianRet5dPct: 4.5, medianAtrPct: 2 };
}

function buildSyntheticPriceSeries(): Map<string, CorrelationPricePoint[]> {
  const seriesByCode = new Map<string, CorrelationPricePoint[]>();
  const codes = ['AAA', 'AAB', 'AAC', 'AAD', 'BBB', 'BBC', 'CCC', 'DDD'];

  for (const code of codes) {
    const points: CorrelationPricePoint[] = [];
    let close = code.startsWith('A') ? 100 : code.startsWith('B') ? 80 : 50;
    for (let day = 0; day < 90; day++) {
      const commonA = Math.sin(day / 5) * 0.012 + 0.002;
      const commonB = Math.cos(day / 6) * 0.01;
      const idNoise = (code.charCodeAt(2) % 5) * 0.0002;
      const ret = code.startsWith('A')
        ? commonA + idNoise
        : code.startsWith('B')
          ? commonB + idNoise
          : day % 2 === 0
            ? 0.003
            : -0.002;
      close *= Math.exp(ret);
      points.push({ date: syntheticDate(day), close });
    }
    seriesByCode.set(code, points);
  }

  return seriesByCode;
}

function adoptCandidates(
  candidates: CandidateSnapshot[],
  activeCodes: string[],
  clusters: Array<{ clusterId: number; codes: string[] }>,
  maxHoldings: number,
  maxPerCluster: number,
): AdoptionResult {
  const clusterOf = new Map<string, number>();
  for (const cluster of clusters) {
    for (const code of cluster.codes) clusterOf.set(code, cluster.clusterId);
  }

  const clusterCounts = new Map<number, number>();
  for (const code of activeCodes) {
    const clusterId = clusterOf.get(code);
    if (clusterId != null) {
      clusterCounts.set(clusterId, (clusterCounts.get(clusterId) ?? 0) + 1);
    }
  }

  const selected: string[] = [];
  let skippedByCluster = 0;
  const availableSlots = Math.max(0, maxHoldings - activeCodes.length);

  for (const candidate of candidates) {
    if (selected.length >= availableSlots) break;
    const clusterId = candidate.clusterId;
    if (clusterId != null) {
      const count = clusterCounts.get(clusterId) ?? 0;
      if (count >= maxPerCluster) {
        skippedByCluster++;
        continue;
      }
    }
    if (clusterId != null) {
      clusterCounts.set(clusterId, (clusterCounts.get(clusterId) ?? 0) + 1);
    }
    selected.push(candidate.stockCode);
  }

  return { selected, skippedByCluster };
}

export function runSyntheticRegimeClusterSimulation(
  maxRegimeFlips = Number(process.env.SIM_MAX_REGIME_FLIPS ?? 8),
): RegimeClusterSimulationSummary {
  let state: MarketRegimeState | null = null;
  let prevLabel: RegimeLabel | null = null;
  let regimeFlips = 0;
  const labelCounts: Record<RegimeLabel, number> = {
    CRISIS: 0,
    NEUTRAL: 0,
    ATTACK: 0,
  };

  for (let day = 60; day < 120; day++) {
    const phase = regimePhase(day);
    const regime = computeMarketRegime(
      {
        universeCount: 120,
        aboveSma20Ratio: Math.min(1, phase.aboveSma60Ratio + 0.08),
        aboveSma60Ratio: phase.aboveSma60Ratio,
        medianDailyReturnPct: phase.medianRet5dPct / 5,
        medianRet5dPct: phase.medianRet5dPct,
        medianAtrPct: phase.medianAtrPct,
      },
      state,
      {
        currentDate: syntheticDate(day),
        minBreadthSample: 30,
        minHoldDays: 1,
      },
    );

    if (prevLabel && prevLabel !== regime.label) regimeFlips++;
    prevLabel = regime.label;
    labelCounts[regime.label]++;
    state = {
      prevSmoothedScore: regime.smoothedScore,
      prevLabel: regime.label,
      updatedAt: syntheticDate(day).toISOString(),
    };
  }

  const returnsByCode = buildAlignedLogReturns(buildSyntheticPriceSeries(), 60);
  const clusterResult = clusterByCorrelation(returnsByCode, {
    threshold: 0.8,
    minOverlap: 40,
    maxClusterSizeWarn: 6,
  });
  const candidates: CandidateSnapshot[] = [
    'AAB',
    'AAC',
    'AAD',
    'BBB',
    'BBC',
    'CCC',
    'DDD',
  ].map((stockCode) => ({
    stockCode,
    sector: stockCode.startsWith('A') ? 'theme-a' : 'theme-b',
    clusterId: clusterResult.clusterByCode.get(stockCode),
  }));
  const activeCodes = ['AAA'];

  // Step 1. OFF는 기존 동시보유 15개와 클러스터 미적용 경로를 모사한다.
  const off = adoptCandidates(
    candidates,
    activeCodes,
    [],
    15,
    Number.MAX_SAFE_INTEGER,
  );
  // Step 2. ON은 CRISIS floor 3개와 클러스터캡 2개를 동시에 적용한다.
  const on = adoptCandidates(
    candidates,
    activeCodes,
    clusterResult.clusters,
    3,
    2,
  );
  const maxClusterSize = Math.max(
    0,
    ...clusterResult.clusters.map((cluster) => cluster.size),
  );

  const pass =
    regimeFlips <= maxRegimeFlips &&
    on.selected.length < off.selected.length &&
    maxClusterSize <= 6 &&
    on.skippedByCluster > 0;

  return {
    pass,
    regimeFlips,
    maxRegimeFlips,
    labelCounts,
    maxClusterSize,
    clusterCount: clusterResult.clusters.length,
    offSelectedCount: off.selected.length,
    onSelectedCount: on.selected.length,
    skippedByCluster: on.skippedByCluster,
  };
}
