/**
 * polymarket-kalshi-arbitrage-bot
 * Scanner service: Connects to NaxosData API (/api/v1/pairs & /api/v1/markets)
 * to discover real-time synchronized cross-venue prediction market arbitrage opportunities.
 */

import {
  ArbitrageOpportunity,
  ArbitragePair,
  ArbitrageStrategy,
  Market,
  OpportunityLeg,
  ScannerFilterOptions,
  Venue,
} from './types.js';
import {
  calculateArbitrageReturn,
  calculateKalshiTakerFee,
  calculatePolymarketFee,
  solveBreakeven,
  DEFAULT_POLYGON_GAS_USD,
  DEFAULT_POLY_TAKER_FEE_RATE,
} from './math.js';

export interface ScannerConfig {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  mockFallback?: boolean;
  polyGasUsd?: number;
  polyTakerFeeRate?: number;
  fetchFn?: typeof fetch;
}

export class ArbitrageScanner {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly mockFallback: boolean;
  private readonly polyGasUsd: number;
  private readonly polyTakerFeeRate: number;
  private readonly fetchFn: typeof fetch;

  constructor(config: ScannerConfig = {}) {
    this.apiKey = config.apiKey || process.env.NAXOS_API_KEY || '';
    const rawUrl = config.baseUrl || process.env.NAXOS_API_URL || 'https://naxosdata.com/api/v1';
    this.baseUrl = rawUrl.replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs || 5000;
    this.mockFallback = config.mockFallback !== undefined ? config.mockFallback : true;
    this.polyGasUsd = config.polyGasUsd ?? DEFAULT_POLYGON_GAS_USD;
    this.polyTakerFeeRate = config.polyTakerFeeRate ?? DEFAULT_POLY_TAKER_FEE_RATE;
    this.fetchFn = config.fetchFn || globalThis.fetch;
  }

  /**
   * Fetches synchronized market pairs from NaxosData API or fallback simulator.
   */
  public async fetchPairs(): Promise<ArbitragePair[]> {
    if (!this.apiKey && this.mockFallback) {
      return this.generateMockPairs();
    }

    try {
      const url = `${this.baseUrl}/pairs?venue_a=POLYMARKET&venue_b=KALSHI&status=ACTIVE`;
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${this.apiKey}`,
          'Accept': 'application/json',
          'User-Agent': 'polymarket-kalshi-arbitrage-bot/1.0',
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });

      if (!response.ok) {
        if (this.mockFallback) {
          return this.generateMockPairs();
        }
        throw new Error(`NaxosData API error: HTTP ${response.status} ${response.statusText}`);
      }

      const json = await response.json();
      const rawData = Array.isArray(json) ? json : json.data || [];
      return this.normalizePairs(rawData);
    } catch (err) {
      if (this.mockFallback) {
        return this.generateMockPairs();
      }
      throw err;
    }
  }

  /**
   * Scans all synchronized pairs, calculates gross & net spreads, and filters
   * viable cross-venue dual-leg arbitrage opportunities.
   */
  public async scanOpportunities(
    filters: ScannerFilterOptions = {}
  ): Promise<ArbitrageOpportunity[]> {
    const pairs = await this.fetchPairs();
    const opportunities: ArbitrageOpportunity[] = [];

    const minSpread = filters.minSpreadPct ?? 0.5; // default 0.5% gross spread
    const minFungibility = filters.minFungibility ?? 0.85; // default 85% fungibility
    const minDepth = filters.minDepthContracts ?? 10;
    const maxDays = filters.maxDaysToExpiration ?? 365;

    for (const pair of pairs) {
      if (pair.fungibilityScore < minFungibility) continue;
      if (pair.daysToExpiration > maxDays) continue;

      // Strategy 1: Buy YES on Polymarket, Buy NO on Kalshi
      const opp1 = this.evaluateArbitrage(
        pair,
        'POLY_YES_KALSHI_NO',
        pair.polymarket,
        'YES',
        pair.kalshi,
        'NO',
        minSpread,
        minDepth
      );
      if (opp1) opportunities.push(opp1);

      // Strategy 2: Buy YES on Kalshi, Buy NO on Polymarket
      const opp2 = this.evaluateArbitrage(
        pair,
        'KALSHI_YES_POLY_NO',
        pair.kalshi,
        'YES',
        pair.polymarket,
        'NO',
        minSpread,
        minDepth
      );
      if (opp2) opportunities.push(opp2);
    }

    // Sort opportunities by Net ROI descending
    opportunities.sort((a, b) => b.netRoiPct - a.netRoiPct);
    return opportunities;
  }

  /**
   * Evaluates a single directional pairing between two venues.
   */
  private evaluateArbitrage(
    pair: ArbitragePair,
    strategy: ArbitrageStrategy,
    m1: Market,
    side1: 'YES' | 'NO',
    m2: Market,
    side2: 'YES' | 'NO',
    minSpreadPct: number,
    minDepth: number
  ): ArbitrageOpportunity | null {
    const book1 = side1 === 'YES' ? m1.yes : m1.no;
    const book2 = side2 === 'YES' ? m2.yes : m2.no;

    const p1 = book1.bestAsk;
    const p2 = book2.bestAsk;
    const depth1 = book1.depthAsk;
    const depth2 = book2.depthAsk;

    if (p1 <= 0 || p2 <= 0 || p1 >= 1.0 || p2 >= 1.0) return null;
    if (depth1 < minDepth || depth2 < minDepth) return null;

    const grossSpreadPct = (1.0 - (p1 + p2)) * 100.0;
    if (grossSpreadPct < minSpreadPct) return null;

    const maxSafeContracts = Math.min(depth1, depth2);
    const returns = calculateArbitrageReturn({
      p1,
      p2,
      contracts: maxSafeContracts,
      daysToExpiration: pair.daysToExpiration,
      venue1: m1.venue,
      venue2: m2.venue,
      polyGasUsd: this.polyGasUsd,
      polyTakerFeeRate: this.polyTakerFeeRate,
    });

    if (!returns.isViable) return null;

    const be = solveBreakeven({
      primaryPrice: p1,
      targetRoiPct: 0.0,
      contracts: maxSafeContracts,
      polyGasUsd: this.polyGasUsd,
      polyTakerFeeRate: this.polyTakerFeeRate,
    });

    const leg1: OpportunityLeg = {
      venue: m1.venue,
      side: side1,
      marketId: m1.id,
      marketTicker: m1.ticker,
      price: p1,
      availableContracts: depth1,
    };

    const leg2: OpportunityLeg = {
      venue: m2.venue,
      side: side2,
      marketId: m2.id,
      marketTicker: m2.ticker,
      price: p2,
      availableContracts: depth2,
    };

    const kalshiFeeUsd =
      m1.venue === 'KALSHI'
        ? calculateKalshiTakerFee(maxSafeContracts, p1, true)
        : calculateKalshiTakerFee(maxSafeContracts, p2, true);

    const polyFeeUsd =
      m1.venue === 'POLYMARKET'
        ? calculatePolymarketFee(maxSafeContracts, p1, this.polyTakerFeeRate, this.polyGasUsd)
        : calculatePolymarketFee(maxSafeContracts, p2, this.polyTakerFeeRate, this.polyGasUsd);

    return {
      id: `opp_${pair.id}_${strategy}_${Date.now()}`,
      pairId: pair.id,
      strategy,
      title: pair.polymarket.title,
      fungibilityScore: pair.fungibilityScore,
      expirationDate: pair.resolutionDate,
      daysToExpiration: pair.daysToExpiration,
      leg1,
      leg2,
      grossSpreadPct: returns.grossSpreadPct,
      kalshiFeeUsd: Math.round(kalshiFeeUsd * 100) / 100,
      polyFeeUsd: Math.round(polyFeeUsd * 1000) / 1000,
      totalCostPerContract: returns.totalCostPerContract,
      netProfitPerContract: returns.netProfitPerContract,
      netRoiPct: returns.netRoiPct,
      annualizedAprPct: returns.annualizedAprPct,
      annualizedApyPct: returns.annualizedApyPct,
      maxCounterpartPrice: be.maxCounterpartPrice,
      maxSafeContracts,
      timestamp: Date.now(),
    };
  }

  /**
   * Normalizes raw API response into strongly typed ArbitragePair objects.
   */
  private normalizePairs(raw: any[]): ArbitragePair[] {
    return raw.map((item) => {
      const now = Date.now();
      const expDate = new Date(item.resolution_date || item.expirationDate || item.end_date || '2026-12-31T23:59:59Z');
      const diffMs = expDate.getTime() - now;
      const daysToExpiration = Math.max(0.04, Math.round((diffMs / (1000 * 60 * 60 * 24)) * 100) / 100);

      const polyMarket: Market = {
        id: item.polymarket?.id || item.poly_id || 'poly-unknown',
        venue: 'POLYMARKET',
        ticker: item.polymarket?.ticker || item.poly_ticker || 'POLY-TICKER',
        title: item.polymarket?.title || item.title || 'Prediction Market Item',
        description: item.polymarket?.description,
        expirationDate: expDate.toISOString(),
        yes: {
          bestBid: Number(item.polymarket?.yes?.bestBid ?? item.poly_yes_bid ?? 0.5),
          bestAsk: Number(item.polymarket?.yes?.bestAsk ?? item.poly_yes_ask ?? 0.52),
          depthBid: Number(item.polymarket?.yes?.depthBid ?? 1000),
          depthAsk: Number(item.polymarket?.yes?.depthAsk ?? 1000),
        },
        no: {
          bestBid: Number(item.polymarket?.no?.bestBid ?? (1.0 - (item.polymarket?.yes?.bestAsk ?? 0.52))),
          bestAsk: Number(item.polymarket?.no?.bestAsk ?? (1.0 - (item.polymarket?.yes?.bestBid ?? 0.50))),
          depthBid: Number(item.polymarket?.no?.depthBid ?? 1000),
          depthAsk: Number(item.polymarket?.no?.depthAsk ?? 1000),
        },
        status: 'ACTIVE',
      };

      const kalshiMarket: Market = {
        id: item.kalshi?.id || item.kalshi_id || 'kalshi-unknown',
        venue: 'KALSHI',
        ticker: item.kalshi?.ticker || item.kalshi_ticker || 'KALSHI-TICKER',
        title: item.kalshi?.title || item.title || 'Prediction Market Item',
        description: item.kalshi?.description,
        expirationDate: expDate.toISOString(),
        yes: {
          bestBid: Number(item.kalshi?.yes?.bestBid ?? item.kalshi_yes_bid ?? 0.5),
          bestAsk: Number(item.kalshi?.yes?.bestAsk ?? item.kalshi_yes_ask ?? 0.52),
          depthBid: Number(item.kalshi?.yes?.depthBid ?? 1000),
          depthAsk: Number(item.kalshi?.yes?.depthAsk ?? 1000),
        },
        no: {
          bestBid: Number(item.kalshi?.no?.bestBid ?? (1.0 - (item.kalshi?.yes?.bestAsk ?? 0.52))),
          bestAsk: Number(item.kalshi?.no?.bestAsk ?? (1.0 - (item.kalshi?.yes?.bestBid ?? 0.50))),
          depthBid: Number(item.kalshi?.no?.depthBid ?? 1000),
          depthAsk: Number(item.kalshi?.no?.depthAsk ?? 1000),
        },
        status: 'ACTIVE',
      };

      return {
        id: item.id || `pair_${polyMarket.id}_${kalshiMarket.id}`,
        polymarket: polyMarket,
        kalshi: kalshiMarket,
        fungibilityScore: Number(item.fungibility_score ?? item.fungibilityScore ?? 0.95),
        resolutionDate: expDate.toISOString(),
        daysToExpiration,
      };
    });
  }

  /**
   * Generates realistic simulated prediction market pairs mimicking live NaxosData feeds.
   * Useful for testing, dry-runs, or sandbox environments without API keys.
   */
  public generateMockPairs(): ArbitragePair[] {
    const now = Date.now();
    const dayMs = 86400 * 1000;

    const templates = [
      {
        id: 'fed-cut-nov-2026',
        title: 'Fed Interest Rate Cut in November 2026 FOMC',
        polyTicker: 'FED-CUT-NOV26',
        kalshiTicker: 'FED-26NOV-T4.50',
        daysAhead: 14,
        fungibility: 0.98,
        polyYesBid: 0.61,
        polyYesAsk: 0.62,
        polyDepth: 2500,
        kalshiNoBid: 0.34,
        kalshiNoAsk: 0.35, // 0.62 + 0.35 = 0.97 => 3.0% gross spread
        kalshiDepth: 1800,
      },
      {
        id: 'us-cpi-nov-2026',
        title: 'US CPI Headline Inflation YoY > 2.8% in Nov 2026',
        polyTicker: 'CPI-NOV26-2.8',
        kalshiTicker: 'CPI-26NOV-2.8',
        daysAhead: 21,
        fungibility: 0.96,
        polyYesBid: 0.43,
        polyYesAsk: 0.44,
        polyDepth: 3200,
        kalshiNoBid: 0.52,
        kalshiNoAsk: 0.53, // 0.44 + 0.53 = 0.97 => 3.0% gross spread
        kalshiDepth: 2200,
      },
      {
        id: 'eth-staking-etf-2026',
        title: 'SEC Approves Ethereum ETF In-Kind Staking by Q4 2026',
        polyTicker: 'ETH-STAKE-ETF-Q4',
        kalshiTicker: 'ETHSTAKE-26Q4',
        daysAhead: 45,
        fungibility: 0.94,
        // Kalshi YES (0.28) + Poly NO (0.69) => 0.97 (3% gross spread)
        polyYesBid: 0.30,
        polyYesAsk: 0.32,
        polyDepth: 1500,
        kalshiNoBid: 0.70,
        kalshiNoAsk: 0.71,
        kalshiDepth: 1600,
        kalshiYesAsk: 0.28,
        kalshiYesBid: 0.27,
        polyNoAsk: 0.69,
        polyNoBid: 0.68,
      },
      {
        id: 'spacex-starship-landing-2026',
        title: 'SpaceX Starship Orbital Catch & Tower Landing Success in 2026',
        polyTicker: 'SPACEX-TOWER-CATCH',
        kalshiTicker: 'STARSHIP-26-CATCH',
        daysAhead: 60,
        fungibility: 0.92,
        polyYesBid: 0.50,
        polyYesAsk: 0.51,
        polyDepth: 4000,
        kalshiNoBid: 0.45,
        kalshiNoAsk: 0.46, // 0.51 + 0.46 = 0.97 => 3.0% gross spread
        kalshiDepth: 3500,
      },
      {
        id: 'us-senate-control-2026',
        title: 'Republicans Retain US Senate Majority in 2026 Midterms',
        polyTicker: 'SENATE-GOP-2026',
        kalshiTicker: 'SENATE-26-GOP',
        daysAhead: 90,
        fungibility: 0.99,
        polyYesBid: 0.54,
        polyYesAsk: 0.55,
        polyDepth: 5000,
        kalshiNoBid: 0.42,
        kalshiNoAsk: 0.43, // 0.55 + 0.43 = 0.98 => 2.0% gross spread
        kalshiDepth: 4500,
      },
    ];

    return templates.map((tmpl) => {
      const expDate = new Date(now + tmpl.daysAhead * dayMs).toISOString();

      const polyYesAsk = tmpl.polyYesAsk;
      const polyYesBid = tmpl.polyYesBid;
      const polyNoAsk = tmpl.polyNoAsk ?? Math.round((1.0 - polyYesBid) * 100) / 100;
      const polyNoBid = tmpl.polyNoBid ?? Math.round((1.0 - polyYesAsk) * 100) / 100;

      const kalshiNoAsk = tmpl.kalshiNoAsk;
      const kalshiNoBid = tmpl.kalshiNoBid;
      const kalshiYesAsk = tmpl.kalshiYesAsk ?? Math.round((1.0 - kalshiNoBid) * 100) / 100;
      const kalshiYesBid = tmpl.kalshiYesBid ?? Math.round((1.0 - kalshiNoAsk) * 100) / 100;

      return {
        id: `pair_${tmpl.id}`,
        resolutionDate: expDate,
        daysToExpiration: tmpl.daysAhead,
        fungibilityScore: tmpl.fungibility,
        polymarket: {
          id: `poly_${tmpl.id}`,
          venue: 'POLYMARKET',
          ticker: tmpl.polyTicker,
          title: tmpl.title,
          expirationDate: expDate,
          yes: {
            bestBid: polyYesBid,
            bestAsk: polyYesAsk,
            depthBid: tmpl.polyDepth,
            depthAsk: tmpl.polyDepth,
          },
          no: {
            bestBid: polyNoBid,
            bestAsk: polyNoAsk,
            depthBid: tmpl.polyDepth,
            depthAsk: tmpl.polyDepth,
          },
          status: 'ACTIVE',
        },
        kalshi: {
          id: `kalshi_${tmpl.id}`,
          venue: 'KALSHI',
          ticker: tmpl.kalshiTicker,
          title: tmpl.title,
          expirationDate: expDate,
          yes: {
            bestBid: kalshiYesBid,
            bestAsk: kalshiYesAsk,
            depthBid: tmpl.kalshiDepth,
            depthAsk: tmpl.kalshiDepth,
          },
          no: {
            bestBid: kalshiNoBid,
            bestAsk: kalshiNoAsk,
            depthBid: tmpl.kalshiDepth,
            depthAsk: tmpl.kalshiDepth,
          },
          status: 'ACTIVE',
        },
      };
    });
  }
}
