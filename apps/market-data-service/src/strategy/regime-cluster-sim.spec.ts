import { runSyntheticRegimeClusterSimulation } from './__sim__/regime-cluster-sim.core';

describe('regime/cluster offline simulation golden', () => {
  it('keeps regime flips bounded and ON adoption direction conservative', () => {
    expect(runSyntheticRegimeClusterSimulation()).toEqual({
      pass: true,
      regimeFlips: 2,
      maxRegimeFlips: 8,
      labelCounts: {
        CRISIS: 17,
        NEUTRAL: 20,
        ATTACK: 23,
      },
      maxClusterSize: 4,
      clusterCount: 3,
      offSelectedCount: 7,
      onSelectedCount: 2,
      skippedByCluster: 2,
    });
  });
});
