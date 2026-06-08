import { computeMarketRegime, type BreadthSnapshot } from '@alpha-mind/strategies';

function breadth(overrides: Partial<BreadthSnapshot>): BreadthSnapshot {
  return {
    universeCount: 100,
    aboveSma20Ratio: 0.5,
    aboveSma60Ratio: 0.5,
    medianDailyReturnPct: 0,
    medianRet5dPct: 0,
    medianAtrPct: 4,
    ...overrides,
  };
}

describe('computeMarketRegime', () => {
  it('classifies weak breadth and high fixed-threshold volatility as CRISIS', () => {
    const result = computeMarketRegime(
      breadth({
        aboveSma60Ratio: 0.05,
        medianRet5dPct: -5,
        medianAtrPct: 6,
      }),
      null,
      { minBreadthSample: 30 },
    );

    expect(result.label).toBe('CRISIS');
    expect(result.slotMultiplier).toBe(0.5);
    expect(result.amountMultiplier).toBe(0.6);
    expect(result.source).toBe('breadth');
  });

  it('classifies strong breadth and low fixed-threshold volatility as ATTACK', () => {
    const result = computeMarketRegime(
      breadth({
        aboveSma60Ratio: 0.95,
        medianRet5dPct: 5,
        medianAtrPct: 2,
      }),
      null,
      { minBreadthSample: 30 },
    );

    expect(result.label).toBe('ATTACK');
    expect(result.slotMultiplier).toBe(1);
    expect(result.amountMultiplier).toBe(1);
  });

  it('uses EMA smoothing before applying hysteresis bands', () => {
    const result = computeMarketRegime(
      breadth({
        aboveSma60Ratio: 0.1,
        medianRet5dPct: -5,
        medianAtrPct: 6,
      }),
      { prevSmoothedScore: 0.8, prevLabel: 'ATTACK' },
      { maDays: 5, minBreadthSample: 30 },
    );

    expect(result.rawScore).toBeLessThan(0.35);
    expect(result.smoothedScore).toBeGreaterThan(0.35);
    expect(result.label).toBe('NEUTRAL');
  });

  it('keeps the previous label inside hysteresis exit bands', () => {
    const result = computeMarketRegime(
      breadth({
        aboveSma60Ratio: 0.4,
        medianRet5dPct: 0,
        medianAtrPct: 4,
      }),
      { prevSmoothedScore: 0.4, prevLabel: 'CRISIS' },
      { maDays: 5, minBreadthSample: 30 },
    );

    expect(result.smoothedScore).toBeCloseTo(0.42, 3);
    expect(result.label).toBe('CRISIS');
  });

  it('blocks same-day label changes with the minimum hold-day guard', () => {
    const result = computeMarketRegime(
      breadth({
        aboveSma60Ratio: 0.95,
        medianRet5dPct: 5,
        medianAtrPct: 2,
      }),
      {
        prevSmoothedScore: 0.2,
        prevLabel: 'CRISIS',
        updatedAt: '2026-06-08T00:00:00.000Z',
      },
      {
        maDays: 1,
        minBreadthSample: 30,
        currentDate: new Date('2026-06-08T08:00:00.000Z'),
      },
    );

    expect(result.label).toBe('CRISIS');
  });

  it('falls back to neutral 1.0 scale when breadth sample is too small', () => {
    const result = computeMarketRegime(
      breadth({ universeCount: 10, medianAtrPct: 10 }),
      null,
      { minBreadthSample: 30 },
    );

    expect(result).toEqual(
      expect.objectContaining({
        label: 'NEUTRAL',
        source: 'fallback',
        slotMultiplier: 1,
        amountMultiplier: 1,
      }),
    );
  });

  it('guards against simultaneous ATTACK slot and amount expansion', () => {
    const result = computeMarketRegime(
      breadth({
        aboveSma60Ratio: 0.95,
        medianRet5dPct: 5,
        medianAtrPct: 2,
      }),
      null,
      {
        minBreadthSample: 30,
        attackSlotMultiplier: 1.2,
        attackAmountMultiplier: 1.3,
      },
    );

    expect(result.slotMultiplier).toBe(1.2);
    expect(result.amountMultiplier).toBe(1);
  });
});
