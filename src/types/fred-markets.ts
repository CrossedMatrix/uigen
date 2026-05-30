// ─── Shared types for /api/fred-markets ──────────────────────────────────────

/** Per-series resolution status (mirrors FedLiquidityDiagnostic) */
export interface FredSeriesDiagnostic {
  /** Series ID actually resolved (matches request unless fallback used) */
  resolvedSeriesId: string
  /** Whether this metric came from FRED or the mock fallback */
  ok:           boolean
  /** Error message when ok=false */
  error?:       string
  /** True if a backup series had to be used instead of the primary */
  usedFallback: boolean
  /** Sanity-band check result – 'value out of band' would be flagged here */
  sanityNote?:  string
}

export interface FredMarketsMeta {
  dataSource: 'FRED_API' | 'MOCK_FALLBACK'
  /**
   * AUTHENTICATED → live FRED data, freshly fetched this request.
   * CACHED        → last successful FRED snapshot served from server-side TTL cache
   *                 (FRED timed out / rate-limited; data is real but not current).
   * DEMO_FALLBACK → no FRED_API_KEY or all fetches failed with no prior cache entry.
   */
  status:     'AUTHENTICATED' | 'CACHED' | 'DEMO_FALLBACK'
  timestamp:  string
  /** Per-series diagnostics – populated on AUTHENTICATED responses */
  diagnostics?: Record<string, FredSeriesDiagnostic>
}

// ─── Treasury Yields ──────────────────────────────────────────────────────────

export interface YieldPoint {
  /** Official FRED series ID e.g. "DGS10" */
  seriesId:   string
  /** Short label shown in the UI e.g. "10Y" */
  label:      string
  /** Maturity in years (used for curve chart positioning) */
  maturity:   number
  /** Latest rate in percent, e.g. 4.38 */
  rate:       number
  /** Previous business-day rate */
  prevRate:   number
  /**
   * Day-over-day change in percentage points.
   * Positive = yields rising (rate increasing).
   * e.g. +0.03 means +3 basis points.
   */
  change:     number
  /** change × 100 — raw basis-point delta, e.g. +3 */
  changeBps:  number
  /** FRED observation date for this data point */
  date:       string
  /** 52-week high for this maturity (percent) */
  high52w?:   number
  /** 52-week low for this maturity (percent) */
  low52w?:    number
}

export interface YieldCurveData {
  points:             YieldPoint[]
  /** DGS10 − DGS2 in percentage points */
  spread2y10y:        number
  /** Day-over-day change in the spread */
  spread2y10yChange:  number
  /** DGS10 − DTB3 in percentage points (10Y–3M spread for banking margins) */
  spread10y3m?:       number
  /** Day-over-day change in the 10Y–3M spread */
  spread10y3mChange?: number
  isInverted:         boolean
  observationDate:    string
  /** Steepening classification: BEAR (long-end driven) vs BULL (short-end driven) */
  steepeningType?:    'BEAR_STEEPENING' | 'BULL_STEEPENING' | null
  meta:               FredMarketsMeta
}

// ─── Dollar Index ─────────────────────────────────────────────────────────────

export interface DXYPoint {
  /** FRED series ID */
  seriesId:   string
  /** UI label */
  label:      string
  /** Index value (not a price – typically 100–130 range) */
  value:      number
  /** Previous business-day value */
  prevValue:  number
  /** value − prevValue */
  change:     number
  /** (change / prevValue) × 100 */
  changePct:  number
  date:       string
}

export interface DXYData {
  /** DTWEXBGS – Nominal Broad Goods & Services Trade-Weighted Dollar Index */
  broad:  DXYPoint
  /** DTWEXAFEGS – Nominal Advanced Foreign Economies Trade-Weighted Dollar Index */
  afe:    DXYPoint
  meta:   FredMarketsMeta
}

// ─── Combined response shape ──────────────────────────────────────────────────

export interface FredMarketsData {
  yieldCurve: YieldCurveData
  dxy:        DXYData
  meta:       FredMarketsMeta
}
