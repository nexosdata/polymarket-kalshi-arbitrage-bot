import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateKalshiTakerFee,
  calculatePolymarketFee,
  ceilCents,
  solveBreakeven,
  calculateArbitrageReturn,
  ArbitrageScanner,
  ArbitrageSimulator,
} from '../dist/index.js';
import { parseArgs } from '../dist/cli.js';

test('Fee Math: ceilCents rounds up to whole cent without floating point glitches', () => {
  assert.equal(ceilCents(0), 0);
  assert.equal(ceilCents(0.001), 0.01);
  assert.equal(ceilCents(0.009), 0.01);
  assert.equal(ceilCents(0.010), 0.01);
  assert.equal(ceilCents(0.0101), 0.02);
  assert.equal(ceilCents(1.7500000000000002), 1.75);
  assert.equal(ceilCents(0.175), 0.18);
});

test('Fee Math: calculateKalshiTakerFee exact exchange quadratic formula', () => {
  // 100 contracts at $0.50: 0.07 * 100 * 0.5 * 0.5 = 1.75 -> $1.75
  assert.equal(calculateKalshiTakerFee(100, 0.5), 1.75);

  // 10 contracts at $0.50: 0.07 * 10 * 0.25 = 0.175 -> $0.18 (rounded up to nearest whole cent)
  assert.equal(calculateKalshiTakerFee(10, 0.5), 0.18);

  // 1 contract at $0.10: 0.07 * 1 * 0.10 * 0.90 = 0.0063 -> $0.01
  assert.equal(calculateKalshiTakerFee(1, 0.1), 0.01);

  // Symmetry: P = 0.30 and P = 0.70 produce identical quadratic fees
  const fee30 = calculateKalshiTakerFee(500, 0.3);
  const fee70 = calculateKalshiTakerFee(500, 0.7);
  assert.equal(fee30, fee70);
  // 0.07 * 500 * 0.21 = 7.35 -> $7.35
  assert.equal(fee30, 7.35);

  // Boundary conditions
  assert.equal(calculateKalshiTakerFee(0, 0.5), 0);
  assert.equal(calculateKalshiTakerFee(-10, 0.5), 0);
  assert.equal(calculateKalshiTakerFee(100, 0), 0);
  assert.equal(calculateKalshiTakerFee(100, 1.0), 0);
  assert.equal(calculateKalshiTakerFee(100, -0.1), 0);
  assert.equal(calculateKalshiTakerFee(100, 1.2), 0);
});

test('Fee Math: calculatePolymarketFee calculates L2 gas and taker fee', () => {
  // Default: 0% taker fee, $0.008 L2 gas
  const defaultFee = calculatePolymarketFee(1000, 0.65);
  assert.equal(defaultFee, 0.008);

  // With 1% taker fee: 1000 * 0.50 * 0.01 + 0.008 = 5.008
  const feeWithTaker = calculatePolymarketFee(1000, 0.5, 0.01, 0.008);
  assert.equal(Math.round(feeWithTaker * 1000) / 1000, 5.008);

  // Zero contracts
  assert.equal(calculatePolymarketFee(0, 0.5), 0);
});

test('Breakeven Solver: solveBreakeven solves maximum counterpart price within budget', () => {
  const result = solveBreakeven({
    primaryPrice: 0.62,
    targetRoiPct: 1.0,
    contracts: 1000,
  });

  assert.ok(result.isProfitable, 'Trade should be profitable');
  assert.ok(result.maxCounterpartPrice > 0, 'Max counterpart price must be positive');
  assert.ok(result.maxCounterpartPrice < 0.38, 'Must be under gross residual of 0.38');
  assert.ok(result.totalCostCents <= 100, 'Total cost per contract cannot exceed 100 cents');

  // Higher target ROI strictly decreases maximum allowable counterpart price
  const higherTarget = solveBreakeven({
    primaryPrice: 0.62,
    targetRoiPct: 3.0,
    contracts: 1000,
  });
  assert.ok(higherTarget.maxCounterpartPrice < result.maxCounterpartPrice);

  // Unprofitable primary price (e.g. 0.999 with 5% target ROI)
  const impossible = solveBreakeven({
    primaryPrice: 0.99,
    targetRoiPct: 5.0,
    contracts: 100,
  });
  assert.equal(impossible.isProfitable, false);
});

test('Return Math: calculateArbitrageReturn metrics, APR, and APY', () => {
  const viable = calculateArbitrageReturn({
    p1: 0.62,
    p2: 0.35,
    contracts: 1000,
    daysToExpiration: 14,
    venue1: 'POLYMARKET',
    venue2: 'KALSHI',
  });

  assert.equal(viable.isViable, true);
  assert.equal(viable.grossSpreadPct, 3.0); // 1.00 - (0.62 + 0.35) = 0.03 -> 3.00%
  assert.ok(viable.netProfitPerContract > 0);
  assert.ok(viable.netRoiPct > 0);
  assert.ok(viable.annualizedAprPct > viable.netRoiPct, 'APR must scale with shorter tenor');
  assert.ok(viable.annualizedApyPct >= viable.annualizedAprPct, 'APY compound must exceed APR');

  // Negative spread (cost > 1.00)
  const inviable = calculateArbitrageReturn({
    p1: 0.65,
    p2: 0.40,
    contracts: 100,
    daysToExpiration: 30,
    venue1: 'POLYMARKET',
    venue2: 'KALSHI',
  });
  assert.equal(inviable.isViable, false);
  assert.ok(inviable.netProfitPerContract < 0);
  assert.ok(inviable.netRoiPct < 0);

  // Sub-day expiration handling (does not throw or produce NaN/Infinity)
  const subDay = calculateArbitrageReturn({
    p1: 0.5,
    p2: 0.48,
    contracts: 100,
    daysToExpiration: 0,
    venue1: 'POLYMARKET',
    venue2: 'KALSHI',
  });
  assert.ok(Number.isFinite(subDay.annualizedAprPct));
  assert.ok(Number.isFinite(subDay.annualizedApyPct));
});

test('Scanner: generateMockPairs produces realistic synchronized pairs', () => {
  const scanner = new ArbitrageScanner({ mockFallback: true });
  const pairs = scanner.generateMockPairs();

  assert.ok(pairs.length >= 5, 'Should generate at least 5 benchmark pairs');
  for (const pair of pairs) {
    assert.ok(pair.id.startsWith('pair_'));
    assert.equal(pair.polymarket.venue, 'POLYMARKET');
    assert.equal(pair.kalshi.venue, 'KALSHI');
    assert.ok(pair.fungibilityScore >= 0.85);
    assert.ok(pair.daysToExpiration > 0);
    assert.ok(pair.polymarket.yes.bestAsk > 0 && pair.polymarket.yes.bestAsk < 1);
    assert.ok(pair.kalshi.no.bestAsk > 0 && pair.kalshi.no.bestAsk < 1);
  }
});

test('Scanner: scanOpportunities filters by spread, fungibility, and depth', async () => {
  const scanner = new ArbitrageScanner({ mockFallback: true });

  // Default filter (minSpread 0.5%, minFungibility 0.85)
  const defaultOpps = await scanner.scanOpportunities();
  assert.ok(defaultOpps.length >= 3, 'Should discover multiple opportunities');

  // High spread threshold (e.g. 5%) should filter out smaller spreads
  const strictSpreadOpps = await scanner.scanOpportunities({ minSpreadPct: 5.0 });
  assert.equal(strictSpreadOpps.length, 0, 'No pairs should exceed 5% spread');

  // High fungibility threshold (e.g. 0.97) filters out pairs with < 0.97
  const strictFungibilityOpps = await scanner.scanOpportunities({ minFungibility: 0.97 });
  for (const opp of strictFungibilityOpps) {
    assert.ok(opp.fungibilityScore >= 0.97);
  }
});

test('Scanner: custom fetch mock connects and parses API correctly', async () => {
  let capturedUrl = '';
  let capturedHeaders = {};

  const mockFetch = async (url, init) => {
    capturedUrl = String(url);
    capturedHeaders = init?.headers || {};
    return new Response(
      JSON.stringify({
        status: 'success',
        data: [
          {
            id: 'pair-test-1',
            fungibility_score: 0.99,
            resolution_date: '2026-12-15T00:00:00Z',
            polymarket: {
              id: 'poly-1',
              ticker: 'POLY-T1',
              title: 'Test Fed Rate Cut',
              yes: { bestBid: 0.60, bestAsk: 0.61, depthBid: 2000, depthAsk: 2000 },
              no: { bestBid: 0.38, bestAsk: 0.39, depthBid: 2000, depthAsk: 2000 },
            },
            kalshi: {
              id: 'kalshi-1',
              ticker: 'KALSHI-T1',
              title: 'Test Fed Rate Cut',
              yes: { bestBid: 0.62, bestAsk: 0.63, depthBid: 1500, depthAsk: 1500 },
              no: { bestBid: 0.36, bestAsk: 0.37, depthBid: 1500, depthAsk: 1500 },
            },
          },
        ],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  };

  const scanner = new ArbitrageScanner({
    apiKey: 'nx_live_mock_token_abc',
    fetchFn: mockFetch,
    mockFallback: false,
  });

  const pairs = await scanner.fetchPairs();
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].id, 'pair-test-1');
  assert.equal(pairs[0].fungibilityScore, 0.99);
  assert.ok(capturedUrl.includes('/pairs'));
  assert.equal(capturedHeaders.Authorization, 'Bearer nx_live_mock_token_abc');

  const opps = await scanner.scanOpportunities({ minSpreadPct: 1.0 });
  assert.ok(opps.length >= 1);
  // Poly YES (0.61) + Kalshi NO (0.37) = 0.98 -> 2.0% spread
  assert.equal(opps[0].strategy, 'POLY_YES_KALSHI_NO');
  assert.equal(opps[0].grossSpreadPct, 2.0);
});

test('Simulator: executes dual-leg order with latency and updates bankroll', async () => {
  const simulator = new ArbitrageSimulator({
    bankrollUsd: 5000,
    maxExposurePerArbUsd: 1000,
    latencyMinMs: 15,
    latencyMaxMs: 40,
    slippageProbability: 0.0,
    leg2FailureProbability: 0.0,
  });

  const scanner = new ArbitrageScanner({ mockFallback: true });
  const opps = await scanner.scanOpportunities({ minSpreadPct: 1.0 });
  assert.ok(opps.length > 0);

  const bestOpp = opps[0];
  const initialBankroll = simulator.getBankroll();
  const result = await simulator.execute(bestOpp);

  assert.equal(result.status, 'FILLED');
  assert.ok(result.requestedContracts > 0);
  assert.equal(result.leg1.filledContracts, result.requestedContracts);
  assert.ok(result.leg2 && result.leg2.filledContracts === result.requestedContracts);
  assert.ok(result.totalRoundTripLatencyMs >= 30, 'Total latency should be sum of 2 legs');
  assert.ok(result.realizedPnlUsd > 0, 'Realized PnL should be positive');
  assert.equal(simulator.getBankroll(), Math.round((initialBankroll + result.realizedPnlUsd) * 100) / 100);

  const stats = simulator.getStats();
  assert.equal(stats.totalTrades, 1);
  assert.equal(stats.filled, 1);
  assert.equal(stats.scratched, 0);
  assert.equal(stats.winRatePct, 100);
});

test('Simulator: triggers emergency scratch unwind when Leg 2 liquidity is pulled', async () => {
  const simulator = new ArbitrageSimulator({
    bankrollUsd: 5000,
    maxExposurePerArbUsd: 1000,
  });

  const scanner = new ArbitrageScanner({ mockFallback: true });
  const opps = await scanner.scanOpportunities();
  const testOpp = opps[0];

  const initialBankroll = simulator.getBankroll();

  // Force Leg 2 failure
  const result = await simulator.execute(testOpp, { forceLeg2Fail: true });

  assert.equal(result.status, 'SCRATCH_UNWOUND');
  assert.ok(result.scratchUnwind, 'Must contain scratch unwind record');
  assert.equal(result.scratchUnwind.venue, testOpp.leg1.venue);
  assert.equal(result.scratchUnwind.unwoundContracts, result.requestedContracts);
  assert.ok(result.scratchUnwind.unwindLossUsd > 0, 'Scratch loss must be positive cost');
  assert.ok(result.realizedPnlUsd < 0, 'Realized PnL must be negative on scratch');
  assert.equal(simulator.getBankroll(), Math.round((initialBankroll - result.scratchUnwind.unwindLossUsd) * 100) / 100);

  const stats = simulator.getStats();
  assert.equal(stats.totalTrades, 1);
  assert.equal(stats.filled, 0);
  assert.equal(stats.scratched, 1);
  assert.equal(stats.winRatePct, 0);
});

test('Simulator: triggers scratch unwind when Leg 2 slips beyond max breakeven price', async () => {
  const simulator = new ArbitrageSimulator({
    bankrollUsd: 5000,
    maxExposurePerArbUsd: 1000,
  });

  const scanner = new ArbitrageScanner({ mockFallback: true });
  const opps = await scanner.scanOpportunities();
  const testOpp = opps[0];

  // Force Leg 2 to slip by 15 cents, well past maxCounterpartPrice
  const result = await simulator.execute(testOpp, { forceLeg2Slip: 0.15 });

  assert.equal(result.status, 'SCRATCH_UNWOUND');
  assert.ok(result.scratchUnwind?.reason.includes('exceeding max breakeven'));
});

test('Simulator: rejects execution when bankroll is exhausted', async () => {
  const simulator = new ArbitrageSimulator({
    bankrollUsd: 0.10, // Insufficient for even 1 contract pair (~$0.97)
  });

  const scanner = new ArbitrageScanner({ mockFallback: true });
  const opps = await scanner.scanOpportunities();
  const result = await simulator.execute(opps[0]);

  assert.equal(result.status, 'REJECTED');
  assert.equal(result.requestedContracts, 0);
});

test('CLI: parseArgs correctly parses flags and applies defaults', () => {
  const defaultArgs = parseArgs([]);
  assert.equal(defaultArgs.minSpreadPct, 1.0);
  assert.equal(defaultArgs.minFungibility, 0.85);
  assert.equal(defaultArgs.pollIntervalMs, 2000);
  assert.equal(defaultArgs.dryRun, true);
  assert.equal(defaultArgs.bankrollUsd, 5000.0);
  assert.equal(defaultArgs.maxExposurePerArbUsd, 1000.0);

  const customArgs = parseArgs([
    '--min-spread', '2.5',
    '--min-fungibility', '0.95',
    '--poll-interval-ms', '1500',
    '--bankroll', '25000',
    '--max-exposure-per-arb', '5000',
    '--target-roi', '1.2',
    '--latency-min-ms', '20',
    '--latency-max-ms', '50',
    '--api-key', 'nx_live_test_key_123',
    '--iterations', '5',
    '--live',
  ]);

  assert.equal(customArgs.minSpreadPct, 2.5);
  assert.equal(customArgs.minFungibility, 0.95);
  assert.equal(customArgs.pollIntervalMs, 1500);
  assert.equal(customArgs.bankrollUsd, 25000);
  assert.equal(customArgs.maxExposurePerArbUsd, 5000);
  assert.equal(customArgs.targetRoiPct, 1.2);
  assert.equal(customArgs.latencyMinMs, 20);
  assert.equal(customArgs.latencyMaxMs, 50);
  assert.equal(customArgs.apiKey, 'nx_live_test_key_123');
  assert.equal(customArgs.iterations, 5);
  assert.equal(customArgs.dryRun, false);
});
