import {
  DEFAULT_SCALE_OUT_PLAN,
  evaluateScaleOut,
  type ScaleOutPlan,
} from '@alpha-mind/strategies';

describe('Scale-out utility', () => {
  it('returns null when scale-out is disabled', () => {
    expect(evaluateScaleOut(DEFAULT_SCALE_OUT_PLAN, 0, 10)).toBeNull();
  });

  it('moves only one stage at a time even when return jumps over multiple tiers', () => {
    const plan: ScaleOutPlan = {
      enabled: true,
      tiers: [
        { triggerPct: 2, sellRatioPct: 50, tag: 'TP1' },
        { triggerPct: 4, sellRatioPct: 50, tag: 'TP2' },
      ],
    };

    const decision = evaluateScaleOut(plan, 0, 10);

    expect(decision).toEqual({
      tier: plan.tiers[0],
      tierIndex: 0,
      nextStage: 1,
    });
  });

  it('returns null when stage is beyond the ladder', () => {
    const plan: ScaleOutPlan = {
      enabled: true,
      tiers: [{ triggerPct: 2, sellRatioPct: 50, tag: 'TP1' }],
    };

    expect(evaluateScaleOut(plan, 1, 10)).toBeNull();
  });

  it('fires on the trigger boundary and waits below it', () => {
    const plan: ScaleOutPlan = {
      enabled: true,
      tiers: [{ triggerPct: 2, sellRatioPct: 50, tag: 'TP1' }],
    };

    expect(evaluateScaleOut(plan, 0, 1.99)).toBeNull();
    expect(evaluateScaleOut(plan, 0, 2)?.nextStage).toBe(1);
  });
});
