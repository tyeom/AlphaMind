import { computeRiskBasedQty } from '@alpha-mind/strategies';

describe('Risk-based position sizing utility', () => {
  it('computes quantity from per-position equity and per-share risk', () => {
    const result = computeRiskBasedQty(1_000_000, 10_000, -2, {
      riskPct: 0.5,
      budgetCapAmount: 1_000_000,
    });

    expect(result).toEqual({
      qty: 25,
      perShareRisk: 200,
    });
  });

  it('clamps quantity by the remaining budget cap', () => {
    const result = computeRiskBasedQty(1_000_000, 10_000, -2, {
      riskPct: 5,
      budgetCapAmount: 120_000,
    });

    expect(result?.qty).toBe(12);
  });

  it('returns null for invalid stop-loss risk', () => {
    expect(
      computeRiskBasedQty(1_000_000, 10_000, 0, {
        riskPct: 0.5,
        budgetCapAmount: 1_000_000,
      }),
    ).toBeNull();
    expect(
      computeRiskBasedQty(1_000_000, 10_000, 1, {
        riskPct: 0.5,
        budgetCapAmount: 1_000_000,
      }),
    ).toBeNull();
  });

  it('returns zero quantity when the calculated size is below minQty', () => {
    const result = computeRiskBasedQty(10_000, 100_000, -5, {
      riskPct: 0.5,
      budgetCapAmount: 100_000,
    });

    expect(result?.qty).toBe(0);
  });

  it('returns null for non-finite inputs', () => {
    expect(
      computeRiskBasedQty(Number.POSITIVE_INFINITY, 10_000, -2, {
        riskPct: 0.5,
        budgetCapAmount: 1_000_000,
      }),
    ).toBeNull();
  });
});
