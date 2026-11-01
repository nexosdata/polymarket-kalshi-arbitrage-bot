/**
 * polymarket-kalshi-arbitrage-bot
 * Mathematical solver: quadratic Kalshi taker fee, dual-leg breakeven solver,
 * net ROI%, and annualized yields (APR/APY).
 */

import {
  BreakevenCalculation,
  BreakevenParams,
  ReturnParams,
  ArbitrageReturnMetrics,
  Venue,
} from './types.js';

export const DEFAULT_POLYGON_GAS_USD = 0.008;
export const DEFAULT_POLY_TAKER_FEE_RATE = 0.0;
export const KALSHI_FEE_COEFFICIENT = 0.07;

/**
 * Rounds a dollar value up to the nearest whole cent ($0.01),
 * preventing floating-point imprecision artifacts.
 */
export function ceilCents(valDollars: number): number {
  if (valDollars <= 0) return 0;
  // Guard against IEEE 754 precision issues (e.g., 1.7500000000000002 -> 1.76)
  const cents = Math.round(valDollars * 1000000) / 10000;
  return Math.ceil(cents) / 100;
}

/**
 * Calculates exact Kalshi taker fee for C contracts at price P.
 * Official CFTC exchange formula: Fee = ceil_cents(0.07 * C * P * (1 - P))
 *
 * @param contracts Number of contracts (C >= 1)
 * @param price Contract price in dollars [0.01 - 0.99]
 * @param roundToCents Whether to round up to whole cent per exchange rule
 * @returns Total fee in USD
 */
export function calculateKalshiTakerFee(
  contracts: number,
  price: number,
  roundToCents = true
): number {
  if (contracts <= 0 || price <= 0 || price >= 1.0) {
    return 0;
  }
  const rawFee = KALSHI_FEE_COEFFICIENT * contracts * price * (1.0 - price);
  if (roundToCents) {
    return ceilCents(rawFee);
  }
  return rawFee;
}

/**
 * Polymarket order fee calculator:
 * Models Polygon PoS L2 gas (~$0.008 USD per batch order) + taker fee rate (default 0%).
 */
export function calculatePolymarketFee(
  contracts: number,
  price: number,
  takerFeeRate = DEFAULT_POLY_TAKER_FEE_RATE,
  gasUsd = DEFAULT_POLYGON_GAS_USD
): number {
  if (contracts <= 0 || price <= 0) return 0;
  const takerFee = contracts * price * takerFeeRate;
  return takerFee + gasUsd;
}

/**
 * Solves the maximum counterpart leg price (e.g. Kalshi NO) that guarantees
 * at least targetRoiPct when paired with a primary leg (e.g. Polymarket YES).
 *
 * Analytical derivation:
 * Total payout = $1.00 per contract pair.
 * Total cost per contract = P_primary + fee_primary + P_counterpart + fee_counterpart(P_counterpart).
 * For target ROI r:
 *   1.0 / Cost >= 1 + r/100  =>  Cost <= 1.0 / (1 + r/100).
 * Let K = 1.0 / (1 + r/100) - P_primary - fee_primary.
 * Counterpart Kalshi fee per contract: 0.07 * P * (1 - P).
 *   P + 0.07 * P * (1 - P) <= K
 *   -0.07 * P^2 + 1.07 * P <= K
 *   0.07 * P^2 - 1.07 * P + K >= 0
 * Roots: P = (1.07 - sqrt(1.1449 - 0.28 * K)) / 0.14
 */
export function solveBreakeven(params: BreakevenParams): BreakevenCalculation {
  const {
    primaryPrice,
    targetRoiPct = 0.0,
    contracts = 100,
    polyGasUsd = DEFAULT_POLYGON_GAS_USD,
    polyTakerFeeRate = DEFAULT_POLY_TAKER_FEE_RATE,
  } = params;

  const c = Math.max(1, contracts);
  const polyP = Math.max(0.001, Math.min(0.999, primaryPrice));
  const polyTotalFee = calculatePolymarketFee(c, polyP, polyTakerFeeRate, polyGasUsd);
  const polyFeePerContract = polyTotalFee / c;

  const targetMultiple = 1.0 + Math.max(0, targetRoiPct) / 100.0;
  const maxTotalOutlayPerContract = 1.0 / targetMultiple;

  const k = maxTotalOutlayPerContract - polyP - polyFeePerContract;
  let bestCounterpartPrice = 0.0;

  if (k > 0) {
    const disc = 1.1449 - 0.28 * k;
    if (disc >= 0) {
      const pAnalytic = (1.07 - Math.sqrt(disc)) / 0.14;
      let testP = Math.min(0.99, Math.max(0.005, pAnalytic));
      testP = Math.floor(testP * 10000) / 10000;

      // Discrete step search verifying exact whole-cent ceil fee rule
      while (testP >= 0.005) {
        const feeUsd = calculateKalshiTakerFee(c, testP, true);
        const feePerContract = feeUsd / c;
        const outlay = polyP + testP + polyFeePerContract + feePerContract;
        if (outlay <= maxTotalOutlayPerContract + 1e-6) {
          bestCounterpartPrice = testP;
          break;
        }
        testP = Math.round((testP - 0.0005) * 10000) / 10000;
      }
    }
  }

  const kalshiFeeUsd =
    bestCounterpartPrice > 0 ? calculateKalshiTakerFee(c, bestCounterpartPrice, true) : 0;
  const kalshiFeeContract = bestCounterpartPrice > 0 ? kalshiFeeUsd / c : 0;
  const combinedCost =
    polyP + bestCounterpartPrice + polyFeePerContract + kalshiFeeContract;
  const netMarginCents =
    bestCounterpartPrice > 0 ? Math.max(0, (1.0 - combinedCost) * 100.0) : 0;

  return {
    primaryPrice: Math.round(polyP * 10000) / 10000,
    targetRoiPct: Math.round(targetRoiPct * 100) / 100,
    contracts: c,
    primaryFeeCents: Math.round(polyFeePerContract * 100 * 1000) / 1000,
    maxCounterpartPrice: Math.round(bestCounterpartPrice * 10000) / 10000,
    maxCounterpartCents: Math.round(bestCounterpartPrice * 10000) / 100,
    counterpartFeeCents: Math.round(kalshiFeeContract * 100 * 1000) / 1000,
    totalCostCents: Math.round(combinedCost * 10000) / 100,
    netMarginCents: Math.round(netMarginCents * 100) / 100,
    isProfitable: bestCounterpartPrice > 0 && combinedCost < 1.0,
  };
}

/**
 * Calculates net return, gross spread, APR, and APY for a dual-leg trade.
 */
export function calculateArbitrageReturn(params: ReturnParams): ArbitrageReturnMetrics {
  const {
    p1,
    p2,
    contracts,
    daysToExpiration,
    venue1,
    venue2,
    polyGasUsd = DEFAULT_POLYGON_GAS_USD,
    polyTakerFeeRate = DEFAULT_POLY_TAKER_FEE_RATE,
  } = params;

  const c = Math.max(1, contracts);

  let kalshiFeeUsd = 0;
  let polyFeeUsd = 0;

  if (venue1 === 'KALSHI') {
    kalshiFeeUsd += calculateKalshiTakerFee(c, p1, true);
  } else {
    polyFeeUsd += calculatePolymarketFee(c, p1, polyTakerFeeRate, polyGasUsd);
  }

  if (venue2 === 'KALSHI') {
    kalshiFeeUsd += calculateKalshiTakerFee(c, p2, true);
  } else {
    polyFeeUsd += calculatePolymarketFee(c, p2, polyTakerFeeRate, polyGasUsd);
  }

  const kalshiFeePerContract = kalshiFeeUsd / c;
  const polyFeePerContract = polyFeeUsd / c;
  const totalCostPerContract = p1 + p2 + kalshiFeePerContract + polyFeePerContract;

  const grossSpreadPct = (1.0 - (p1 + p2)) * 100;
  const netProfitPerContract = 1.0 - totalCostPerContract;
  const netRoiPct = totalCostPerContract > 0 ? (netProfitPerContract / totalCostPerContract) * 100 : 0;

  // Annualized return (APR & APY)
  // Clamp effective days to minimum 1 hour (1/24 days) for realistic annualization
  const effectiveDays = Math.max(1 / 24, daysToExpiration);
  const annualizedAprPct = netRoiPct * (365.0 / effectiveDays);

  let annualizedApyPct = 0;
  if (netRoiPct > -100 && netRoiPct < 500) {
    const compoundPeriods = 365.0 / effectiveDays;
    // Cap compound periods at 365 to prevent numerical overflow for ultra-short tenors
    const cappedPeriods = Math.min(compoundPeriods, 365);
    const compoundFactor = Math.pow(1.0 + netRoiPct / 100.0, cappedPeriods) - 1.0;
    annualizedApyPct = Math.min(compoundFactor * 100.0, 99999.0);
  } else if (netRoiPct >= 500) {
    annualizedApyPct = 99999.0;
  }

  return {
    totalCostPerContract: Math.round(totalCostPerContract * 10000) / 10000,
    kalshiFeePerContract: Math.round(kalshiFeePerContract * 10000) / 10000,
    polyFeePerContract: Math.round(polyFeePerContract * 10000) / 10000,
    grossSpreadPct: Math.round(grossSpreadPct * 100) / 100,
    netProfitPerContract: Math.round(netProfitPerContract * 10000) / 10000,
    netRoiPct: Math.round(netRoiPct * 100) / 100,
    annualizedAprPct: Math.round(annualizedAprPct * 100) / 100,
    annualizedApyPct: Math.round(annualizedApyPct * 100) / 100,
    isViable: netProfitPerContract > 0 && totalCostPerContract < 1.0,
  };
}
