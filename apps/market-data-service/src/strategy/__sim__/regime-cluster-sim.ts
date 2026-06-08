import { runSyntheticRegimeClusterSimulation } from './regime-cluster-sim.core';

async function main(): Promise<void> {
  const summary = runSyntheticRegimeClusterSimulation();
  console.log(JSON.stringify(summary, null, 2));

  if (!summary.pass) {
    process.exitCode = 1;
  }
}

void main();
