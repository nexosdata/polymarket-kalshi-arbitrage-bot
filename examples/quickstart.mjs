/**
 * Quickstart Example: Programmatic Usage of polymarket-kalshi-arbitrage-bot
 * 
 * Run with:
 *   node dist/cli.js --iterations 1
 * or import directly in your quant trading codebase.
 */

import { ArbitrageScanner, ArbitrageSimulator, solveBreakeven, calculateKalshiTakerFee } from '../dist/index.js';

async function main() {
  console.log('=== Polymarket <-> Kalshi Arbitrage Bot Programmatic Demo ===\n');

  // 1. Standalone Fee and Breakeven Solvers
  console.log('1. Calculating Kalshi Quadratic Fee:');
  const fee100 = calculateKalshiTakerFee(100, 0.50);
  console.log(`   Fee for 100 contracts at $0.50: $${fee100.toFixed(2)}`);

  console.log('\n2. Solving Dual-Leg Breakeven:');
  const be = solveBreakeven({
    primaryPrice: 0.63,
    targetRoiPct: 1.5,
    contracts: 1000,
  });
  console.log(`   Primary Leg (Polymarket YES): $${be.primaryPrice}`);
  console.log(`   Max Counterpart Price (Kalshi NO): $${be.maxCounterpartPrice}`);
  console.log(`   Kalshi Quadratic Fee: $${be.counterpartFeeCents / 100}`);
  console.log(`   Total Outlay: $${be.totalCostCents / 100}`);

  // 2. Scan Synchronized Pairs via NaxosData API
  console.log('\n3. Scanning Live Arbitrage Pairs:');
  const scanner = new ArbitrageScanner();
  const opportunities = await scanner.scanOpportunities({
    minSpreadPct: 1.0,
    minFungibility: 0.85,
  });

  console.log(`   Found ${opportunities.length} viable arbitrage pairs:`);
  for (const opp of opportunities) {
    console.log(`   - [${opp.strategy}] "${opp.title}"`);
    console.log(`     Gross Spread: +${opp.grossSpreadPct.toFixed(2)}% | Net ROI: +${opp.netRoiPct.toFixed(2)}% | APY: +${opp.annualizedApyPct.toFixed(1)}%`);
  }

  // 3. Simulate Simultaneous Dual-Leg Execution
  if (opportunities.length > 0) {
    console.log('\n4. Executing Top Opportunity in Microstructure Simulator:');
    const simulator = new ArbitrageSimulator({
      bankrollUsd: 10000,
      maxExposurePerArbUsd: 2000,
      latencyMinMs: 15,
      latencyMaxMs: 40,
    });

    const result = await simulator.execute(opportunities[0]);
    console.log(`   Status:       ${result.status}`);
    console.log(`   Sized:        ${result.requestedContracts} contracts`);
    console.log(`   Total Wire:   ${result.totalRoundTripLatencyMs}ms`);
    console.log(`   Realized PnL: +$${result.realizedPnlUsd.toFixed(2)} (+${result.netRoiPct.toFixed(2)}%)`);
  }
}

main().catch(console.error);
