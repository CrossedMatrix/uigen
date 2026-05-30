/**
 * Interactive Brokers (IBKR) futures market data types
 *
 * Used by:
 *   - /api/live-futures route (proxy to bridge/main.py)
 *   - useLiveFutures hook (direct browser fetch to port 8000)
 */

/** Per-symbol tick fields as returned by bridge/main.py MARKET_DATA dict. */
export interface IBTickFields {
  last:       number | null
  bid:        number | null
  ask:        number | null
  change:     number | null  // absolute point change from prior settlement
  change_pct: number | null  // e.g. 0.2321 means +0.2321 %
}

/** Top-level response shape from bridge/main.py GET /api/live-futures */
export interface LiveFuturesResponse {
  connected: boolean
  timestamp: string          // ISO-8601 UTC
  data:      Record<string, IBTickFields>  // keys: "ES", "NQ", "ZN"
  error?:    string
}
