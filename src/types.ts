/**
 * polymarket-kalshi-arbitrage-bot
 * Core type definitions for cross-venue prediction market arbitrage.
 */

export type Venue = 'POLYMARKET' | 'KALSHI';

export type OutcomeSide = 'YES' | 'NO';

export type MarketStatus = 'ACTIVE' | 'CLOSED' | 'RESOLVED';

export interface MarketBook {
  bestBid: number; // price in USD (0.01 - 0.99)
  bestAsk: number; // price in USD (0.01 - 0.99)
  depthBid: number; // number of contracts available at bestBid
  depthAsk: number; // number of contracts available at bestAsk
}

export interface Market {
  id: string;
  venue: Venue;
  ticker: string;
  title: string;
  description?: string;
  category?: string;
  expirationDate: string; // ISO 8601 string
  yes: MarketBook;
  no: MarketBook;
  volume24h?: number;
  status: MarketStatus;
}

export interface ArbitragePair {
  id: string;
  polymarket: Market;
  kalshi: Market;
  fungibilityScore: number; // 0.00 - 1.00 (resolution criteria similarity)
  resolutionDate: string;
  daysToExpiration: number;
}

export type ArbitrageStrategy = 'POLY_YES_KALSHI_NO' | 'KALSHI_YES_POLY_NO';

export interface OpportunityLeg {
  venue: Venue;
  side: OutcomeSide;
  marketId: string;
  marketTicker: string;
  price: number; // price in dollars
  availableContracts: number;
}

export interface ArbitrageOpportunity {
  id: string;
  pairId: string;
  strategy: ArbitrageStrategy;
  title: string;
  fungibilityScore: number;
  expirationDate: string;
  daysToExpiration: number;
  leg1: OpportunityLeg;
  leg2: OpportunityLeg;
  grossSpreadPct: number; // (1 - (p1 + p2)) * 100
  kalshiFeeUsd: number; // for maxSafeContracts
  polyFeeUsd: number; // for maxSafeContracts
  totalCostPerContract: number; // P1 + P2 + fees per contract
  netProfitPerContract: number; // $1.00 - totalCostPerContract
  netRoiPct: number; // (netProfit / totalCost) * 100
  annualizedAprPct: number;
  annualizedApyPct: number;
  maxCounterpartPrice: number;
  maxSafeContracts: number;
  timestamp: number;
}

export interface BreakevenParams {
  primaryPrice: number; // Price of first leg [0.01 - 0.99]
  targetRoiPct?: number; // Desired net ROI percentage, e.g. 1.0 = 1%
  contracts?: number; // Size of trade
  polyGasUsd?: number; // Estimated gas cost in USD (default $0.008)
  polyTakerFeeRate?: number; // Polymarket fee rate (0.00 default)
}

export interface BreakevenCalculation {
  primaryPrice: number;
  targetRoiPct: number;
  contracts: number;
  primaryFeeCents: number;
  maxCounterpartPrice: number;
  maxCounterpartCents: number;
  counterpartFeeCents: number;
  totalCostCents: number;
  netMarginCents: number;
  isProfitable: boolean;
}

export interface ReturnParams {
  p1: number;
  p2: number;
  contracts: number;
  daysToExpiration: number;
  venue1: Venue;
  venue2: Venue;
  polyGasUsd?: number;
  polyTakerFeeRate?: number;
}

export interface ArbitrageReturnMetrics {
  totalCostPerContract: number;
  kalshiFeePerContract: number;
  polyFeePerContract: number;
  grossSpreadPct: number;
  netProfitPerContract: number;
  netRoiPct: number;
  annualizedAprPct: number;
  annualizedApyPct: number;
  isViable: boolean;
}

export interface ExecutionConfig {
  minSpreadPct: number; // Minimum gross spread (e.g. 1.0%)
  minFungibility: number; // Minimum fungibility score (e.g. 0.85)
  targetRoiPct: number; // Minimum net ROI% required after all fees
  maxExposurePerArbUsd: number; // Maximum capital allocated to a single trade
  bankrollUsd: number; // Total bankroll
  latencyMinMs: number; // Simulated min network transit latency
  latencyMaxMs: number; // Simulated max network transit latency
  dryRun: boolean; // Dry-run / paper trading mode
  polyGasUsd: number; // Estimated Polygon gas per trade (default 0.008)
  polyTakerFeeRate: number; // Polymarket taker fee rate (default 0.0)
  pollIntervalMs: number; // Scanner poll interval in milliseconds
}

export type ExecutionStatus = 'FILLED' | 'SCRATCH_UNWOUND' | 'REJECTED' | 'EXPIRED';

export interface LegExecutionRecord {
  venue: Venue;
  side: OutcomeSide;
  orderPrice: number;
  fillPrice: number;
  filledContracts: number;
  feeUsd: number;
  latencyMs: number;
}

export interface ScratchUnwindRecord {
  venue: Venue;
  side: OutcomeSide;
  unwoundContracts: number;
  entryPrice: number;
  exitPrice: number;
  unwindLossUsd: number;
  unwindFeeUsd: number;
  reason: string;
}

export interface ExecutionResult {
  id: string;
  opportunityId: string;
  strategy: ArbitrageStrategy;
  timestamp: number;
  status: ExecutionStatus;
  requestedContracts: number;
  leg1: LegExecutionRecord;
  leg2?: LegExecutionRecord;
  scratchUnwind?: ScratchUnwindRecord;
  totalCostUsd: number;
  expectedPayoutUsd: number;
  realizedPnlUsd: number;
  netRoiPct: number;
  totalRoundTripLatencyMs: number;
  executionLogs: string[];
}

export interface ScannerFilterOptions {
  minSpreadPct?: number;
  minFungibility?: number;
  minDepthContracts?: number;
  maxDaysToExpiration?: number;
}
