#!/usr/bin/env node
/**
 * polymarket-kalshi-arbitrage-bot CLI Runner
 * Production-ready executable for prediction market cross-venue arbitrage.
 */

import { ArbitrageScanner } from './scanner.js';
import { ArbitrageSimulator } from './simulator.js';
import { ExecutionConfig } from './types.js';

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';
const GRAY = '\x1b[90m';

export interface CliArgs extends ExecutionConfig {
  apiKey: string;
  iterations?: number;
  help: boolean;
}

export function parseArgs(rawArgs: string[]): CliArgs {
  const args: CliArgs = {
    minSpreadPct: 1.0,
    minFungibility: 0.85,
    pollIntervalMs: 2000,
    dryRun: true,
    bankrollUsd: 5000.0,
    maxExposurePerArbUsd: 1000.0,
    targetRoiPct: 0.5,
    latencyMinMs: 15,
    latencyMaxMs: 40,
    polyGasUsd: 0.008,
    polyTakerFeeRate: 0.0,
    apiKey: process.env.NAXOS_API_KEY || '',
    help: false,
  };

  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    const next = rawArgs[i + 1];

    switch (arg) {
      case '--min-spread':
        if (next) args.minSpreadPct = parseFloat(next);
        i++;
        break;
      case '--min-fungibility':
        if (next) args.minFungibility = parseFloat(next);
        i++;
        break;
      case '--poll-interval-ms':
        if (next) args.pollIntervalMs = parseInt(next, 10);
        i++;
        break;
      case '--bankroll':
        if (next) args.bankrollUsd = parseFloat(next);
        i++;
        break;
      case '--max-exposure-per-arb':
        if (next) args.maxExposurePerArbUsd = parseFloat(next);
        i++;
        break;
      case '--target-roi':
        if (next) args.targetRoiPct = parseFloat(next);
        i++;
        break;
      case '--latency-min-ms':
        if (next) args.latencyMinMs = parseFloat(next);
        i++;
        break;
      case '--latency-max-ms':
        if (next) args.latencyMaxMs = parseFloat(next);
        i++;
        break;
      case '--api-key':
        if (next) args.apiKey = next;
        i++;
        break;
      case '--iterations':
        if (next) args.iterations = parseInt(next, 10);
        i++;
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--live':
        args.dryRun = false;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
    }
  }

  return args;
}

function printHelp(): void {
  console.log(`
================================================================================
  Polymarket-Kalshi Arbitrage Bot (pka-bot)
  High-frequency dual-leg cross-venue prediction market arbitrage engine
================================================================================

Usage:
  pka-bot [options]
  polymarket-kalshi-arbitrage-bot [options]

Options:
  --min-spread <pct>            Minimum gross spread percentage (default: 1.0)
  --min-fungibility <score>     Minimum market fungibility score 0.0-1.0 (default: 0.85)
  --target-roi <pct>            Minimum net ROI percentage after all fees (default: 0.5)
  --bankroll <usd>              Starting bankroll capital in USD (default: 5000)
  --max-exposure-per-arb <usd>  Max capital allocation per single arbitrage (default: 1000)
  --poll-interval-ms <ms>       Scanner polling interval in milliseconds (default: 2000)
  --latency-min-ms <ms>         Simulated min network transit latency in ms (default: 15)
  --latency-max-ms <ms>         Simulated max network transit latency in ms (default: 40)
  --dry-run                     Run in paper trading simulation mode (default: true)
  --live                        Run in real execution mode (requires exchange API keys)
  --api-key <key>               NaxosData API key (or set NAXOS_API_KEY environment variable)
  --iterations <num>            Run N scan iterations and exit (useful for testing & CI)
  --help, -h                    Show this help message

Environment Variables:
  NAXOS_API_KEY                 NaxosData API Key (get from https://naxosdata.com)
  NAXOS_API_URL                 Custom NaxosData endpoint (default: https://naxosdata.com/api/v1)

Examples:
  pka-bot --dry-run --min-spread 1.5 --iterations 3
  pka-bot --bankroll 10000 --max-exposure-per-arb 2500 --poll-interval-ms 1000
================================================================================
`);
}

function printBanner(args: CliArgs): void {
  console.log(CYAN + `
================================================================================
  POLYMARKET <-> KALSHI DUAL-LEG ARBITRAGE ENGINE v1.0.0
  Powered by NaxosData Market Microstructure Feeds
================================================================================` + RESET);
  console.log(GRAY + '--------------------------------------------------------------------------------' + RESET);
  console.log(` Mode:              ${BOLD}${YELLOW}${args.dryRun ? 'PAPER SIMULATION (Dry Run)' : 'LIVE PRODUCTION'}${RESET}`);
  console.log(` Bankroll:          ${GREEN}$${args.bankrollUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}${RESET} | Max Per Arb: ${GREEN}$${args.maxExposurePerArbUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}${RESET}`);
  console.log(` Filter Criteria:   Min Spread: ${MAGENTA}${args.minSpreadPct}%${RESET} | Min Fungibility: ${MAGENTA}${args.minFungibility}${RESET} | Target ROI: ${MAGENTA}${args.targetRoiPct}%${RESET}`);
  console.log(` Latency Profile:   Synthetic Wire Delay: ${CYAN}${args.latencyMinMs}ms - ${args.latencyMaxMs}ms${RESET}`);
  console.log(` NaxosData Feed:    ${args.apiKey ? GREEN + 'API Key Authenticated' + RESET : YELLOW + 'Offline / Synthetic Mock Engine Active' + RESET}`);
  console.log(GRAY + '--------------------------------------------------------------------------------' + RESET + '\n');
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return;
  }

  printBanner(args);

  const scanner = new ArbitrageScanner({
    apiKey: args.apiKey,
    polyGasUsd: args.polyGasUsd,
    polyTakerFeeRate: args.polyTakerFeeRate,
  });

  const simulator = new ArbitrageSimulator({
    bankrollUsd: args.bankrollUsd,
    maxExposurePerArbUsd: args.maxExposurePerArbUsd,
    latencyMinMs: args.latencyMinMs,
    latencyMaxMs: args.latencyMaxMs,
    dryRun: args.dryRun,
    polyGasUsd: args.polyGasUsd,
    polyTakerFeeRate: args.polyTakerFeeRate,
  });

  let running = true;
  let cycle = 0;

  const handleShutdown = () => {
    console.log(`\n${YELLOW}[SHUTDOWN] Terminating gracefully...${RESET}`);
    running = false;
    printSummary(simulator);
    process.exit(0);
  };

  process.on('SIGINT', handleShutdown);
  process.on('SIGTERM', handleShutdown);

  while (running) {
    cycle++;
    const cycleTime = new Date().toLocaleTimeString();
    console.log(`${GRAY}[${cycleTime}] --- Scan Cycle #${cycle} ---${RESET}`);

    try {
      const opportunities = await scanner.scanOpportunities({
        minSpreadPct: args.minSpreadPct,
        minFungibility: args.minFungibility,
      });

      if (opportunities.length === 0) {
        console.log(`${GRAY}No arbitrage opportunities above ${args.minSpreadPct}% spread threshold.${RESET}`);
      } else {
        console.log(`${GREEN}Found ${opportunities.length} viable arbitrage opportunit${opportunities.length === 1 ? 'y' : 'ies'}:${RESET}`);

        for (const opp of opportunities) {
          console.log(`\n  ${BOLD}${WHITE}► ${opp.title}${RESET}`);
          console.log(`    Strategy:        ${CYAN}${opp.strategy}${RESET} (Fungibility: ${YELLOW}${opp.fungibilityScore.toFixed(2)}${RESET})`);
          console.log(`    Leg 1:           ${BLUE}${opp.leg1.venue} ${opp.leg1.side}${RESET} @ $${opp.leg1.price.toFixed(3)} (${opp.leg1.availableContracts} contracts)`);
          console.log(`    Leg 2:           ${MAGENTA}${opp.leg2.venue} ${opp.leg2.side}${RESET} @ $${opp.leg2.price.toFixed(3)} (${opp.leg2.availableContracts} contracts)`);
          console.log(`    Gross Spread:    ${GREEN}+${opp.grossSpreadPct.toFixed(2)}%${RESET}`);
          console.log(`    Kalshi Quad Fee: -$${opp.kalshiFeeUsd.toFixed(2)} | Poly Gas: -$${opp.polyFeeUsd.toFixed(3)}`);
          console.log(`    Net ROI:         ${BOLD}${GREEN}+${opp.netRoiPct.toFixed(2)}%${RESET} (Annualized APR: ${YELLOW}+${opp.annualizedAprPct.toFixed(1)}%${RESET}, APY: ${YELLOW}+${opp.annualizedApyPct.toFixed(1)}%${RESET})`);
          console.log(`    Max Leg2 Price:  $${opp.maxCounterpartPrice.toFixed(4)}`);

          // Execute the best opportunity
          console.log(`    ${GRAY}Triggering simultaneous dual-leg execution...${RESET}`);
          const result = await simulator.execute(opp);

          if (result.status === 'FILLED') {
            console.log(`    ${GREEN}✔ EXECUTED: Dual-leg locked in! Net PnL: +$${result.realizedPnlUsd.toFixed(2)} in ${result.totalRoundTripLatencyMs}ms${RESET}`);
          } else if (result.status === 'SCRATCH_UNWOUND') {
            console.log(`    ${RED}✖ SCRATCH UNWIND: ${result.scratchUnwind?.reason} | Loss: -$${result.scratchUnwind?.unwindLossUsd.toFixed(2)}${RESET}`);
          } else {
            console.log(`    ${YELLOW}⚠ SKIPPED: ${result.status}${RESET}`);
          }
        }
      }
    } catch (err: any) {
      console.error(`${RED}[ERROR] Scan error: ${err?.message || err}${RESET}`);
    }

    if (args.iterations && cycle >= args.iterations) {
      console.log(`\n${GREEN}[DONE] Completed requested ${args.iterations} iteration(s).${RESET}`);
      printSummary(simulator);
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, args.pollIntervalMs));
  }
}

function printSummary(sim: ArbitrageSimulator): void {
  const stats = sim.getStats();
  console.log(`\n${BOLD}${CYAN}====================== PORTFOLIO PERFORMANCE SUMMARY ======================${RESET}`);
  console.log(` Total Trades Executed:   ${stats.totalTrades} (Filled: ${GREEN}${stats.filled}${RESET}, Scratched: ${RED}${stats.scratched}${RESET}, Rejected: ${stats.rejected})`);
  console.log(` Win Rate:                ${GREEN}${stats.winRatePct}%${RESET}`);
  console.log(` Total Capital Deployed:  $${stats.totalVolumeUsd.toFixed(2)}`);
  console.log(` Realized Net PnL:        ${stats.realizedPnlUsd >= 0 ? GREEN + '+$' : RED + '-$'}${Math.abs(stats.realizedPnlUsd).toFixed(2)}${RESET}`);
  console.log(` Current Bankroll:        ${BOLD}$${stats.bankrollUsd.toFixed(2)}${RESET}`);
  console.log(` Average Latency:         ${stats.avgLatencyMs}ms`);
  console.log(`${BOLD}${CYAN}===========================================================================${RESET}\n`);
}

// Auto-run if executed directly
const isMain = process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts');
if (isMain) {
  runCli().catch((err) => {
    console.error('Fatal CLI exception:', err);
    process.exit(1);
  });
}
