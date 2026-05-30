/**
 * Federal Reserve Liquidity Monitor — Shared Types
 *
 * Server-safe (no 'use client') so both API routes and client components
 * can import from this file cleanly.
 */

/** Per-series resolution status for partial-success debugging */
export interface FedLiquidityDiagnostic {
  /** The FRED series ID that was successfully used (post-fallback) */
  resolvedSeriesId: string
  /** Whether this metric came from FRED or the mock fallback */
  ok: boolean
  /** Error message if the fetch failed */
  error?: string
  /** True if a backup series had to be used instead of the primary */
  usedFallback: boolean
  /** Set when the sanity-band check rejected the value */
  sanityNote?: string
}

/** Verification envelope returned by the /api/fed-liquidity route */
export interface FedLiquidityMeta {
  dataSource: 'FRED_API' | 'MOCK_FALLBACK'
  /**
   * AUTHENTICATED → FRED_API_KEY was present and the primary WALCL fetch succeeded.
   * CACHED        → last successful FRED snapshot served from server-side TTL cache
   *                 (FRED timed out / rate-limited; data is real but not current).
   * DEMO_FALLBACK → no key, WALCL failed, and no cache entry exists yet.
   */
  status: 'AUTHENTICATED' | 'CACHED' | 'DEMO_FALLBACK'
  /**
   * ISO-8601 dates of the latest observations actually used, keyed by the
   * clean display acronyms (the backend still fetches the raw FRED series
   * WALCL / WTREGEN / RRPONTSYD and maps them onto these properties):
   *   fta → WALCL     (Fed Total Assets)
   *   tga → WTREGEN   (Treasury General Account)
   *   rro → RRPONTSYD (Reverse Repo Outstanding)
   */
  seriesDates: { fta: string; tga: string; rro: string }
  /** Wall-clock time the API route ran */
  timestamp: string
  /** Per-series diagnostics — only set on AUTHENTICATED responses */
  diagnostics?: {
    fta: FedLiquidityDiagnostic
    tga: FedLiquidityDiagnostic
    rro: FedLiquidityDiagnostic
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
  /**
   * ICE BofA US High Yield Index Option-Adjusted Spread (FRED: BAMLH0A0HYM2)
   *   Units: percentage points  (e.g. 3.42 = 342 bp over Treasuries)
   *   Tight  (<3.5)  → risk-on, credit benign
   *   Wide   (>5)    → recession / default-stress regime
   *   Mean   ~5.5    over 1996-present
   */
  hyOasSpread?: number
  /** ISO date of the HY OAS observation actually used */
  hyOasDate?: string
  /**
   * St. Louis Fed Financial Stress Index (FRED: STLFSI4)
   *   Zero  = average financial stress
   *   <0    = below-average stress  (calm)
   *   >0    = above-average stress  (warning ≥1, crisis ≥2.5)
   */
  stlfsi?: number
  /** ISO date of the STLFSI4 observation actually used */
  stlfsiDate?: string
  /** Present only when data came from /api/fed-liquidity (not a bundle) */
  meta?: FedLiquidityMeta
}
