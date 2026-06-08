import {
  buildAlignedLogReturns,
  clusterByCorrelation,
  pearson,
  type CorrelationPricePoint,
} from '@alpha-mind/strategies';

function series(codeOffset: number, values: number[]): CorrelationPricePoint[] {
  return values.map((close, idx) => ({
    date: new Date(`2026-01-${String(idx + 1).padStart(2, '0')}`),
    close: close + codeOffset,
  }));
}

describe('correlation clustering utilities', () => {
  it('returns near 1.0 pearson correlation for identical return streams', () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
  });

  it('clusters highly correlated codes with deterministic numeric ids', () => {
    const returnsByCode = new Map([
      ['BBB', [0.01, 0.02, 0.03, 0.04]],
      ['AAA', [0.02, 0.04, 0.06, 0.08]],
      ['CCC', [0.03, -0.01, 0.02, -0.02]],
    ]);

    const result = clusterByCorrelation(returnsByCode, {
      threshold: 0.8,
      minOverlap: 4,
    });

    expect(result.clusters).toEqual([
      { clusterId: 1, codes: ['AAA', 'BBB'], size: 2 },
    ]);
    expect(result.clusterByCode.get('AAA')).toBe(1);
    expect(result.clusterByCode.get('BBB')).toBe(1);
    expect(result.clusterByCode.has('CCC')).toBe(false);
  });

  it('does not create edges when overlap is below the minimum', () => {
    const result = clusterByCorrelation(
      new Map([
        ['AAA', [0.01, Number.NaN, Number.NaN]],
        ['BBB', [0.01, Number.NaN, Number.NaN]],
      ]),
      { threshold: 0.8, minOverlap: 2 },
    );

    expect(result.clusters).toHaveLength(0);
  });

  it('does not create edges for zero-variance return streams', () => {
    const result = clusterByCorrelation(
      new Map([
        ['AAA', [0.01, 0.01, 0.01]],
        ['BBB', [0.02, 0.02, 0.02]],
      ]),
      { threshold: 0.8, minOverlap: 3 },
    );

    expect(result.clusters).toHaveLength(0);
  });

  it('uses union-find transitive links for chained correlations', () => {
    const result = clusterByCorrelation(
      new Map([
        ['AAA', [1, 2, 3, 4, 5, 6]],
        ['BBB', [1, 2, 3, 4, 5, 6]],
        ['CCC', [2, 4, 6, 8, 10, 12]],
      ]),
      { threshold: 0.8, minOverlap: 6 },
    );

    expect(result.clusters).toEqual([
      { clusterId: 1, codes: ['AAA', 'BBB', 'CCC'], size: 3 },
    ]);
  });

  it('aligns log returns by date intersection through NaN gaps', () => {
    const aligned = buildAlignedLogReturns(
      new Map([
        ['AAA', series(0, [100, 101, 102, 103])],
        [
          'BBB',
          [
            { date: new Date('2026-01-02'), close: 200 },
            { date: new Date('2026-01-03'), close: 202 },
            { date: new Date('2026-01-04'), close: 204 },
          ],
        ],
      ]),
      60,
    );

    expect(aligned.get('AAA')).toHaveLength(3);
    expect(aligned.get('BBB')?.[0]).toBeNaN();
    expect(aligned.get('BBB')?.[1]).toBeGreaterThan(0);
  });

  it('flags clusters larger than the warning threshold without disabling them', () => {
    const result = clusterByCorrelation(
      new Map([
        ['A', [1, 2, 3]],
        ['B', [1, 2, 3]],
        ['C', [1, 2, 3]],
      ]),
      { threshold: 0.8, minOverlap: 3, maxClusterSizeWarn: 2 },
    );

    expect(result.clusters[0].size).toBe(3);
    expect(result.largeClusters).toEqual(result.clusters);
  });
});
