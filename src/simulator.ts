/**
 * polymarket-kalshi-arbitrage-bot
 * Execution Engine Simulator: Dual-leg simultaneous order placement,
 * synthetic latency modeling (15ms-40ms), slippage modeling, and Leg-1 scratch unwinds.
 */

import {
  ArbitrageOpportunity,
  ExecutionConfig,
  ExecutionResult,
  LegExecutionRecord,
  ScratchUnwindRecord,
  Venue,
} from './types.js';
import {
  calculateKalshiTakerFee,
  calculatePolymarketFee,
  DEFAULT_POLYGON_GAS_USD,
  DEFAULT_POLY_TAKER_FEE_RATE,
} from './math.js';

export interface SimulatorOptions extends Partial<ExecutionConfig> {
  slippageProbability?: number; // Probability of 1-cent adverse slip on Leg 2 (default 0.08)
  leg2FailureProbability?: number; // Probability of complete Leg 2 liquidity pull (default 0.04)
  randomSeed?: number; // Optional seed for deterministic testing
}

export class ArbitrageSimulator {
  private bankrollUsd: number;
  private readonly maxExposurePerArbUsd: number;
  private readonly latencyMinMs: number;
  private readonly latencyMaxMs: number;
  private readonly dryRun: boolean;
  private readonly polyGasUsd: number;
  private readonly polyTakerFeeRate: number;
  private readonly slippageProbability: number;
  private readonly leg2FailureProbability: number;

  private realizedPnlUsd = 0;
  private totalVolumeUsd = 0;
  private tradeHistory: ExecutionResult[] = [];

  constructor(options: SimulatorOptions = {}) {
    this.bankrollUsd = options.bankrollUsd ?? 5000.0;
    this.maxExposurePerArbUsd = options.maxExposurePerArbUsd ?? 1000.0;
    this.latencyMinMs = options.latencyMinMs ?? 15;
    this.latencyMaxMs = options.latencyMaxMs ?? 40;
    this.dryRun = options.dryRun ?? true;
    this.polyGasUsd = options.polyGasUsd ?? DEFAULT_POLYGON_GAS_USD;
    this.polyTakerFeeRate = options.polyTakerFeeRate ?? DEFAULT_POLY_TAKER_FEE_RATE;
    this.slippageProbability = options.slippageProbability ?? 0.08;
    this.leg2FailureProbability = options.leg2FailureProbability ?? 0.04;
  }

  /**
   * Generates a simulated network latency duration (in ms) within configured bounds.
   */
  private sampleLatency(): number {
    const delta = this.latencyMaxMs - this.latencyMinMs;
    return Math.round((this.latencyMinMs + Math.random() * delta) * 10) / 10;
  }

  /**
   * Simulates dual-leg execution of an arbitrage opportunity.
   */
  public async execute(
    opp: ArbitrageOpportunity,
    overrides?: {
      forceLeg2Fail?: boolean;
      forceLeg2Slip?: number;
      customContracts?: number;
    }
  ): Promise<ExecutionResult> {
    const logs: string[] = [];
    const timestamp = Date.now();
    const id = `exec_${opp.id}_${timestamp}`;

    logs.push(`[INIT] Arbitrage Strategy: ${opp.strategy} on "${opp.title}"`);
    logs.push(`[QUOTES] Leg 1 (${opp.leg1.venue} ${opp.leg1.side}) @ $${opp.leg1.price.toFixed(3)} | Leg 2 (${opp.leg2.venue} ${opp.leg2.side}) @ $${opp.leg2.price.toFixed(3)}`);
    logs.push(`[SPREAD] Gross: ${opp.grossSpreadPct.toFixed(2)}% | Net ROI: ${opp.netRoiPct.toFixed(2)}% | Max Counterpart: $${opp.maxCounterpartPrice.toFixed(4)}`);

    // Position Sizing: constrained by bankroll, max exposure, and depth
    const costPerPair = opp.totalCostPerContract;
    const maxAlloc = Math.min(this.bankrollUsd, this.maxExposurePerArbUsd);
    const contractsByCapital = Math.floor(maxAlloc / costPerPair);
    const requestedContracts = overrides?.customContracts ?? Math.max(
      1,
      Math.min(opp.maxSafeContracts, contractsByCapital)
    );

    if (requestedContracts <= 0 || maxAlloc < costPerPair) {
      logs.push(`[REJECT] Insufficient bankroll ($${this.bankrollUsd.toFixed(2)}) for minimum 1 contract pair ($${costPerPair.toFixed(2)})`);
      const rejectedResult: ExecutionResult = {
        id,
        opportunityId: opp.id,
        strategy: opp.strategy,
        timestamp,
        status: 'REJECTED',
        requestedContracts: 0,
        leg1: {
          venue: opp.leg1.venue,
          side: opp.leg1.side,
          orderPrice: opp.leg1.price,
          fillPrice: opp.leg1.price,
          filledContracts: 0,
          feeUsd: 0,
          latencyMs: 0,
        },
        totalCostUsd: 0,
        expectedPayoutUsd: 0,
        realizedPnlUsd: 0,
        netRoiPct: 0,
        totalRoundTripLatencyMs: 0,
        executionLogs: logs,
      };
      this.tradeHistory.push(rejectedResult);
      return rejectedResult;
    }

    logs.push(`[SIZING] Sized order: ${requestedContracts} contracts (Capital required: $${(requestedContracts * costPerPair).toFixed(2)})`);

    // STEP 1: Dispatch Leg 1 (Simulated Latency)
    const leg1Latency = this.sampleLatency();
    logs.push(`[WIRE] Dispatching Leg 1 order to ${opp.leg1.venue}... Wire latency: ${leg1Latency}ms`);

    const leg1FillPrice = opp.leg1.price;
    const leg1FeeUsd =
      opp.leg1.venue === 'KALSHI'
        ? calculateKalshiTakerFee(requestedContracts, leg1FillPrice, true)
        : calculatePolymarketFee(requestedContracts, leg1FillPrice, this.polyTakerFeeRate, this.polyGasUsd);

    const leg1Record: LegExecutionRecord = {
      venue: opp.leg1.venue,
      side: opp.leg1.side,
      orderPrice: opp.leg1.price,
      fillPrice: leg1FillPrice,
      filledContracts: requestedContracts,
      feeUsd: leg1FeeUsd,
      latencyMs: leg1Latency,
    };
    logs.push(`[FILL] Leg 1 ACK received from ${opp.leg1.venue}: Filled ${requestedContracts} @ $${leg1FillPrice.toFixed(3)} (Fee: $${leg1FeeUsd.toFixed(3)})`);

    // STEP 2: Simultaneous Leg 2 Dispatch
    const leg2Latency = this.sampleLatency();
    const totalLatency = Math.round((leg1Latency + leg2Latency) * 10) / 10;
    logs.push(`[WIRE] Dispatching Leg 2 order to ${opp.leg2.venue}... Latency window: ${leg2Latency}ms (Total transit: ${totalLatency}ms)`);

    // Model transit slippage or quote pull by competing HFT
    const isLeg2Wiped =
      overrides?.forceLeg2Fail ?? (Math.random() < this.leg2FailureProbability);
    const slipAmount =
      overrides?.forceLeg2Slip !== undefined
        ? overrides.forceLeg2Slip
        : Math.random() < this.slippageProbability
        ? 0.01
        : 0.0;

    const leg2AttemptPrice = Math.round((opp.leg2.price + slipAmount) * 1000) / 1000;

    // Check if Leg 2 failed or breached maximum acceptable counterpart price
    const breachedBreakeven = leg2AttemptPrice > opp.maxCounterpartPrice + 1e-4;

    if (isLeg2Wiped || breachedBreakeven) {
      // EMERGENCY SCRATCH UNWIND:
      // Leg 1 is held naked. Immediately sell Leg 1 back to the bid on Venue 1.
      const failReason = isLeg2Wiped
        ? 'Leg 2 depth consumed/cancelled by rival HFT during wire flight window'
        : `Leg 2 slipped to $${leg2AttemptPrice.toFixed(3)} exceeding max breakeven ($${opp.maxCounterpartPrice.toFixed(3)})`;

      logs.push(`[ALERT] Leg 2 execution failed: ${failReason}`);
      logs.push(`[SCRATCH] Triggering emergency scratch unwind on Leg 1 (${opp.leg1.venue})...`);

      // Unwind sell into bid: assume 1-cent bid-ask spread
      const unwindPrice = Math.max(0.01, Math.round((leg1FillPrice - 0.01) * 100) / 100);
      const unwindFeeUsd =
        opp.leg1.venue === 'KALSHI'
          ? calculateKalshiTakerFee(requestedContracts, unwindPrice, true)
          : calculatePolymarketFee(requestedContracts, unwindPrice, this.polyTakerFeeRate, this.polyGasUsd);

      const unwindLossUsd =
        Math.round(((leg1FillPrice - unwindPrice) * requestedContracts + leg1FeeUsd + unwindFeeUsd) * 100) / 100;

      const scratchRecord: ScratchUnwindRecord = {
        venue: opp.leg1.venue,
        side: opp.leg1.side,
        unwoundContracts: requestedContracts,
        entryPrice: leg1FillPrice,
        exitPrice: unwindPrice,
        unwindLossUsd,
        unwindFeeUsd,
        reason: failReason,
      };

      this.bankrollUsd -= unwindLossUsd;
      this.realizedPnlUsd -= unwindLossUsd;

      logs.push(`[SCRATCH COMPLETED] Unwound ${requestedContracts} contracts at $${unwindPrice.toFixed(2)}. Scratch Loss: -$${unwindLossUsd.toFixed(2)}`);

      const scratchResult: ExecutionResult = {
        id,
        opportunityId: opp.id,
        strategy: opp.strategy,
        timestamp,
        status: 'SCRATCH_UNWOUND',
        requestedContracts,
        leg1: leg1Record,
        scratchUnwind: scratchRecord,
        totalCostUsd: leg1FillPrice * requestedContracts + leg1FeeUsd,
        expectedPayoutUsd: unwindPrice * requestedContracts,
        realizedPnlUsd: -unwindLossUsd,
        netRoiPct: -(unwindLossUsd / (leg1FillPrice * requestedContracts)) * 100,
        totalRoundTripLatencyMs: totalLatency,
        executionLogs: logs,
      };

      this.tradeHistory.push(scratchResult);
      return scratchResult;
    }

    // SUCCESSFUL DUAL-LEG FILL
    const leg2FeeUsd =
      opp.leg2.venue === 'KALSHI'
        ? calculateKalshiTakerFee(requestedContracts, leg2AttemptPrice, true)
        : calculatePolymarketFee(requestedContracts, leg2AttemptPrice, this.polyTakerFeeRate, this.polyGasUsd);

    const leg2Record: LegExecutionRecord = {
      venue: opp.leg2.venue,
      side: opp.leg2.side,
      orderPrice: opp.leg2.price,
      fillPrice: leg2AttemptPrice,
      filledContracts: requestedContracts,
      feeUsd: leg2FeeUsd,
      latencyMs: leg2Latency,
    };

    logs.push(`[FILL] Leg 2 ACK received from ${opp.leg2.venue}: Filled ${requestedContracts} @ $${leg2AttemptPrice.toFixed(3)} (Fee: $${leg2FeeUsd.toFixed(3)})`);

    const totalOutlayUsd =
      leg1FillPrice * requestedContracts +
      leg1FeeUsd +
      leg2AttemptPrice * requestedContracts +
      leg2FeeUsd;

    // Guaranteed payout at resolution: $1.00 per contract pair
    const guaranteedPayoutUsd = requestedContracts * 1.0;
    const netProfitUsd = Math.round((guaranteedPayoutUsd - totalOutlayUsd) * 100) / 100;
    const actualRoiPct = Math.round((netProfitUsd / totalOutlayUsd) * 10000) / 100;

    this.bankrollUsd += netProfitUsd;
    this.realizedPnlUsd += netProfitUsd;
    this.totalVolumeUsd += totalOutlayUsd;

    logs.push(`[SUCCESS] Dual-leg locked in! Total outlay: $${totalOutlayUsd.toFixed(2)} | Guaranteed payout: $${guaranteedPayoutUsd.toFixed(2)} | Net Profit: +$${netProfitUsd.toFixed(2)} (+${actualRoiPct.toFixed(2)}%)`);

    const successResult: ExecutionResult = {
      id,
      opportunityId: opp.id,
      strategy: opp.strategy,
      timestamp,
      status: 'FILLED',
      requestedContracts,
      leg1: leg1Record,
      leg2: leg2Record,
      totalCostUsd: Math.round(totalOutlayUsd * 100) / 100,
      expectedPayoutUsd: guaranteedPayoutUsd,
      realizedPnlUsd: netProfitUsd,
      netRoiPct: actualRoiPct,
      totalRoundTripLatencyMs: totalLatency,
      executionLogs: logs,
    };

    this.tradeHistory.push(successResult);
    return successResult;
  }

  public getBankroll(): number {
    return Math.round(this.bankrollUsd * 100) / 100;
  }

  public getRealizedPnl(): number {
    return Math.round(this.realizedPnlUsd * 100) / 100;
  }

  public getTotalVolume(): number {
    return Math.round(this.totalVolumeUsd * 100) / 100;
  }

  public getHistory(): ExecutionResult[] {
    return [...this.tradeHistory];
  }

  public getStats() {
    const total = this.tradeHistory.length;
    const filled = this.tradeHistory.filter((t) => t.status === 'FILLED').length;
    const scratched = this.tradeHistory.filter((t) => t.status === 'SCRATCH_UNWOUND').length;
    const rejected = this.tradeHistory.filter((t) => t.status === 'REJECTED').length;
    const winRate = total > 0 ? (filled / (filled + scratched || 1)) * 100 : 0;

    const latencies = this.tradeHistory
      .filter((t) => t.totalRoundTripLatencyMs > 0)
      .map((t) => t.totalRoundTripLatencyMs);
    const avgLatency =
      latencies.length > 0
        ? Math.round((latencies.reduce((a, b) => a + b, 0) / latencies.length) * 10) / 10
        : 0;

    return {
      totalTrades: total,
      filled,
      scratched,
      rejected,
      winRatePct: Math.round(winRate * 10) / 10,
      realizedPnlUsd: this.getRealizedPnl(),
      totalVolumeUsd: this.getTotalVolume(),
      bankrollUsd: this.getBankroll(),
      avgLatencyMs: avgLatency,
    };
  }
}
