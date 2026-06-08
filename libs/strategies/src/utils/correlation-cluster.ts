export interface CorrelationPricePoint {
  date: Date | string;
  close: number;
}

export interface CorrelationClusterOptions {
  threshold?: number;
  minOverlap?: number;
  maxClusterSizeWarn?: number;
  linkage?: 'union' | 'average';
}

export interface CorrelationCluster {
  clusterId: number;
  codes: string[];
  size: number;
}

export interface CorrelationClusterResult {
  clusterByCode: Map<string, number>;
  clusters: CorrelationCluster[];
  largeClusters: CorrelationCluster[];
}

export const DEFAULT_CORRELATION_CLUSTER_OPTIONS = {
  threshold: 0.8,
  minOverlap: 40,
  maxClusterSizeWarn: 6,
  linkage: 'union' as const,
} as const;

function dateKey(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isFiniteNumber(value: number | undefined): value is number {
  return value != null && Number.isFinite(value);
}

export function pearson(
  a: number[],
  b: number[],
  minOverlap = 2,
): number {
  const pairs: Array<[number, number]> = [];
  const n = Math.min(a.length, b.length);

  for (let i = 0; i < n; i++) {
    if (Number.isFinite(a[i]) && Number.isFinite(b[i])) {
      pairs.push([a[i], b[i]]);
    }
  }

  if (pairs.length < minOverlap) return Number.NaN;

  const meanA = pairs.reduce((sum, p) => sum + p[0], 0) / pairs.length;
  const meanB = pairs.reduce((sum, p) => sum + p[1], 0) / pairs.length;
  let cov = 0;
  let varA = 0;
  let varB = 0;

  for (const [av, bv] of pairs) {
    const da = av - meanA;
    const db = bv - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }

  if (varA <= 0 || varB <= 0) return Number.NaN;
  return cov / Math.sqrt(varA * varB);
}

export function buildAlignedLogReturns(
  priceSeriesByCode: Map<string, CorrelationPricePoint[]>,
  lookbackDays: number,
): Map<string, number[]> {
  const returnsByCodeAndDate = new Map<string, Map<string, number>>();
  const allDates = new Set<string>();

  for (const [code, series] of priceSeriesByCode) {
    const sorted = [...series]
      .filter((p) => isFiniteNumber(p.close) && p.close > 0)
      .sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)));
    const sliced =
      lookbackDays > 0 ? sorted.slice(-(lookbackDays + 1)) : sorted;
    const returnsByDate = new Map<string, number>();

    // Step 1. 수익률 날짜는 "오늘 종가 / 전일 종가"의 오늘 날짜로 둔다.
    for (let i = 1; i < sliced.length; i++) {
      const prev = sliced[i - 1].close;
      const curr = sliced[i].close;
      if (prev > 0 && curr > 0) {
        const key = dateKey(sliced[i].date);
        const ret = Math.log(curr / prev);
        if (Number.isFinite(ret)) {
          returnsByDate.set(key, ret);
          allDates.add(key);
        }
      }
    }

    returnsByCodeAndDate.set(code, returnsByDate);
  }

  const dates = [...allDates].sort();
  const aligned = new Map<string, number[]>();
  for (const [code, returnsByDate] of returnsByCodeAndDate) {
    aligned.set(
      code,
      dates.map((date) => returnsByDate.get(date) ?? Number.NaN),
    );
  }
  return aligned;
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  constructor(codes: string[]) {
    for (const code of codes) this.parent.set(code, code);
  }

  find(code: string): string {
    const parent = this.parent.get(code);
    if (!parent || parent === code) return code;
    const root = this.find(parent);
    this.parent.set(code, root);
    return root;
  }

  union(a: string, b: string): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;

    // Step 2. root를 사전순으로 고정해 입력 순서와 무관한 clusterId를 만든다.
    if (rootA.localeCompare(rootB) <= 0) {
      this.parent.set(rootB, rootA);
    } else {
      this.parent.set(rootA, rootB);
    }
  }
}

export function clusterByCorrelation(
  returnsByCode: Map<string, number[]>,
  options: CorrelationClusterOptions = {},
): CorrelationClusterResult {
  const opts = { ...DEFAULT_CORRELATION_CLUSTER_OPTIONS, ...options };
  const codes = [...returnsByCode.keys()].sort();
  const uf = new UnionFind(codes);

  for (let i = 0; i < codes.length; i++) {
    for (let j = i + 1; j < codes.length; j++) {
      const corr = pearson(
        returnsByCode.get(codes[i]) ?? [],
        returnsByCode.get(codes[j]) ?? [],
        opts.minOverlap,
      );
      if (Number.isFinite(corr) && corr > opts.threshold) {
        uf.union(codes[i], codes[j]);
      }
    }
  }

  const byRoot = new Map<string, string[]>();
  for (const code of codes) {
    const root = uf.find(code);
    const bucket = byRoot.get(root) ?? [];
    bucket.push(code);
    byRoot.set(root, bucket);
  }

  const clusters: CorrelationCluster[] = [...byRoot.values()]
    .map((codesInCluster) => codesInCluster.sort())
    .filter((codesInCluster) => codesInCluster.length > 1)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map((codesInCluster, idx) => ({
      clusterId: idx + 1,
      codes: codesInCluster,
      size: codesInCluster.length,
    }));

  const clusterByCode = new Map<string, number>();
  for (const cluster of clusters) {
    for (const code of cluster.codes) {
      clusterByCode.set(code, cluster.clusterId);
    }
  }

  const largeClusters = clusters.filter(
    (cluster) => cluster.size > opts.maxClusterSizeWarn,
  );

  return { clusterByCode, clusters, largeClusters };
}
