/**
 * Shared types and mock data for the Institutional Squawk system.
 *
 * IMPORTANT: This file has NO 'use client' directive — it is intentionally
 * server-safe so that both the API routes (`/api/institutional-squawk`,
 * `/api/fed-liquidity`) and the client component
 * (`InstitutionalSquawkNewsStream`) can import from it cleanly.
 *
 * Previously the types lived inside the 'use client' component file and were
 * imported from there by the server routes.  In Next.js 14/15 that crosses the
 * client boundary and can cause the import to resolve as `undefined` on the
 * server, which made SQUAWK_NEWS_MOCK silently disappear and caused the
 * Market Movers Heatmap and Squawk Feed panels to render blank.
 */

// ─── Core Types ───────────────────────────────────────────────────────────────

export interface SquawkArticle {
  id: string
  title: string
  source: string
  sourceHandle: string
  timestamp: number
  rawHTML?: string
  headline: string
  importance: 'high' | 'medium' | 'low'
  macroKeywords: string[]
}

export interface TopMover {
  rank: number
  keyword: string
  headline: string
  sourceCount: number
  sources: string[]
  latestTimestamp: number
  heatScore: number // 0-100
}

/** Per-series resolution status (useful for partial-success debugging) */
export interface FedLiquidityDiagnostic {
  /** The FRED series ID that was successfully used (post-fallback) */
  resolvedSeriesId: string
  /** Whether this metric came from FRED or the mock fallback */
  ok: boolean
  /** Error message if the fetch failed (only set when ok=false) */
  error?: string
  /** True if a backup series had to be used instead of the primary */
  usedFallback: boolean
  /** Set when the sanity-band check rejected the value */
  sanityNote?: string
}

/** Verification envelope returned by the /api/fed-liquidity route */
export interface FedLiquidityMeta {
  /** Where the numbers came from */
  dataSource: 'FRED_API' | 'MOCK_FALLBACK'
  /**
   * AUTHENTICATED → FRED_API_KEY was present and the primary WALCL fetch
   *                  succeeded (individual sub-series may have fallen back).
   * DEMO_FALLBACK  → no key, or WALCL itself failed.
   */
  status: 'AUTHENTICATED' | 'DEMO_FALLBACK'
  /** ISO-8601 dates of the latest observations actually used */
  seriesDates: { walcl: string; wtregen: string; rrpontsyd: string }
  /** Wall-clock time the API route ran */
  timestamp: string
  /** Per-series diagnostics — only set on AUTHENTICATED responses */
  diagnostics?: {
    walcl:     FedLiquidityDiagnostic
    tga:       FedLiquidityDiagnostic
    rrpontsyd: FedLiquidityDiagnostic
  }
}

export interface FedLiquiditySnapshot {
  date: string
  balanceSheetTotal: number // billions
  tga: number              // Treasury General Account – billions
  rrp: number              // Reverse Repo Outstanding – billions
  netLiquidity: number     // WALCL − TGA − RRP
  momentum14d: number      // rolling 14-day % change on WALCL
  momentumDirection: 'expanding' | 'contracting' | 'flat'
  /** Present only when data came from /api/fed-liquidity (not the squawk bundle) */
  meta?: FedLiquidityMeta
}


export interface SquawkNewsData {
  articles: SquawkArticle[]
  topMovers: TopMover[]
  fedLiquidity: FedLiquiditySnapshot
}

// ─── Mock / Fallback Data ────────────────────────────────────────────────────
// Timestamps use a factory so each import gets a fresh relative time (avoids
// stale timestamps after long-running server processes).

export function buildSquawkMock(): SquawkNewsData {
  const now = Date.now()
  return {
    articles: [
      {
        id: '1',
        title: 'Fed Signals Higher-For-Longer Rates Ahead of FOMC Decision',
        source: 'First Squawk',
        sourceHandle: '@FirstSquawk',
        timestamp: now - 120_000,
        headline: 'Fed Signals Higher-For-Longer Rates Ahead of FOMC Decision',
        importance: 'high',
        macroKeywords: ['FED', 'RATE', 'FOMC'],
      },
      {
        id: '2',
        title: 'CPI Print Beats Expectations, Inflation Momentum Accelerating',
        source: 'Bloomberg Terminal',
        sourceHandle: 'BLOOMBERG',
        timestamp: now - 240_000,
        headline: 'CPI Print Beats Expectations, Inflation Momentum Accelerating',
        importance: 'high',
        macroKeywords: ['CPI', 'INFLATION', 'FED'],
      },
      {
        id: '3',
        title: 'Oil Rallies as OPEC+ Holds Production Cuts Steady',
        source: 'ZeroHedge',
        sourceHandle: '@zerohedge',
        timestamp: now - 360_000,
        headline: 'Oil Rallies as OPEC+ Holds Production Cuts Steady',
        importance: 'medium',
        macroKeywords: ['CRUDE'],
      },
      {
        id: '4',
        title: 'Treasury Yields Climb on Fed Rate-Hike Bets, 10-Year Nears 4.5%',
        source: 'First Squawk',
        sourceHandle: '@FirstSquawk',
        timestamp: now - 180_000,
        headline: 'Treasury Yields Climb on Fed Rate-Hike Bets, 10-Year Nears 4.5%',
        importance: 'high',
        macroKeywords: ['YIELD', 'FED', 'RATE'],
      },
      {
        id: '5',
        title: 'VIX Spikes to 22 on Geopolitical Tensions, Tech Volatility Spreads',
        source: 'DeltaOne',
        sourceHandle: '@DeltaOne',
        timestamp: now - 300_000,
        headline: 'VIX Spikes to 22 on Geopolitical Tensions, Tech Volatility Spreads',
        importance: 'high',
        macroKeywords: ['VOLATILITY', 'RATE'],
      },
      {
        id: '6',
        title: 'Goldman Sachs Raises 2026 GDP Forecast on Strong Labor Market',
        source: 'FinancialJuice',
        sourceHandle: '@FinancialJuice',
        timestamp: now - 420_000,
        headline: 'Goldman Sachs Raises 2026 GDP Forecast on Strong Labor Market',
        importance: 'medium',
        macroKeywords: ['GDP', 'FOMC'],
      },
      {
        id: '7',
        title: 'FOMC Minutes Signal Rate Path Uncertainty; Markets Reprice Fed Pivot',
        source: 'ZeroHedge',
        sourceHandle: '@zerohedge',
        timestamp: now - 90_000,
        headline: 'FOMC Minutes Signal Rate Path Uncertainty; Markets Reprice Fed Pivot',
        importance: 'high',
        macroKeywords: ['FOMC', 'FED', 'RATE'],
      },
    ],
    topMovers: [
      {
        rank: 1,
        keyword: 'FED',
        headline: 'Fed Signals Higher-For-Longer Rates Ahead of FOMC Decision',
        sourceCount: 3,
        sources: ['@FirstSquawk', 'BLOOMBERG', '@zerohedge'],
        latestTimestamp: now - 90_000,
        heatScore: 95,
      },
      {
        rank: 2,
        keyword: 'RATE',
        headline: 'Treasury Yields Climb on Fed Rate-Hike Bets, 10-Year Nears 4.5%',
        sourceCount: 3,
        sources: ['@FirstSquawk', '@DeltaOne', '@zerohedge'],
        latestTimestamp: now - 90_000,
        heatScore: 88,
      },
      {
        rank: 3,
        keyword: 'FOMC',
        headline: 'FOMC Minutes Signal Rate Path Uncertainty; Markets Reprice Fed Pivot',
        sourceCount: 3,
        sources: ['@FirstSquawk', '@FinancialJuice', '@zerohedge'],
        latestTimestamp: now - 90_000,
        heatScore: 82,
      },
      {
        rank: 4,
        keyword: 'CPI',
        headline: 'CPI Print Beats Expectations, Inflation Momentum Accelerating',
        sourceCount: 2,
        sources: ['BLOOMBERG', '@FinancialJuice'],
        latestTimestamp: now - 240_000,
        heatScore: 78,
      },
      {
        rank: 5,
        keyword: 'YIELD',
        headline: 'Treasury Yields Climb on Fed Rate-Hike Bets, 10-Year Nears 4.5%',
        sourceCount: 2,
        sources: ['@FirstSquawk', '@DeltaOne'],
        latestTimestamp: now - 180_000,
        heatScore: 72,
      },
    ],
    fedLiquidity: {
      date: new Date().toISOString().split('T')[0],
      balanceSheetTotal: 7_240,
      tga: 165,
      rrp: 2_480,
      netLiquidity: 4_595,
      momentum14d: -2.4,
      momentumDirection: 'contracting',
    },
  }
}

/**
 * Static export for places that need a single reference (component default
 * prop, dashboard fallback, etc.).  The mock data is generated once at module
 * load time so all importers share the same object reference.
 */
export const SQUAWK_NEWS_MOCK: SquawkNewsData = buildSquawkMock()
