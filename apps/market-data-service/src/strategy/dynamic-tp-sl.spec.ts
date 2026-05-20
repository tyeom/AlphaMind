import { computeAtrDynamicTpSl } from '@alpha-mind/strategies';

describe('Dynamic TP/SL', () => {
  it('falls back to base values when volatility is missing or invalid', () => {
    expect(computeAtrDynamicTpSl(2.5, -2.0, undefined)).toEqual({
      takeProfitPct: 2.5,
      stopLossPct: -2.0,
    });
    expect(computeAtrDynamicTpSl(2.5, -2.0, Number.POSITIVE_INFINITY)).toEqual({
      takeProfitPct: 2.5,
      stopLossPct: -2.0,
    });
  });

  it('widens TP/SL from ATR and clamps extreme volatility', () => {
    expect(computeAtrDynamicTpSl(2.5, -2.0, 2.0)).toEqual({
      takeProfitPct: 3.6,
      stopLossPct: -2.6,
    });
    expect(computeAtrDynamicTpSl(2.5, -2.0, 10.0)).toEqual({
      takeProfitPct: 6.0,
      stopLossPct: -5.0,
    });
  });
});
