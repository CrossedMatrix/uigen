'use client'

/**
 * useMarketLiveFeed
 *
 * Polls the internal Next.js proxy at /api/marketdata every 4 seconds.
 * The proxy handles all IB Client Portal gateway communication server-side:
 *   – TLS self-signed cert bypass (https.Agent rejectUnauthorized: false)
 *   – CORS (browser never touches localhost:5000)
 *   – Persistent keepAlive TCP connection to the gateway
 *
 * Output shape mirrors the existing MarketData interface in dashboard/page.tsx
 * exactly — livePrices can be merged on top of /api/market data without
 * touching any UI component.
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  Primary  →  /api/marketdata  (Next.js proxy → IB gateway)         │
 * │  Fallback →  Financial Modeling Prep REST API  (commented out)      │
 * │  Fallback →  Polygon.io REST API               (commented out)      │
 * └─────────────────────────────────────────────────────────────────────┘
 */

import { useState, useEffect, useRef, useCallback } from 'react'

// ─── Shared Types (mirror dashboard/page.tsx exactly) ─────────────────────────

export type Timeframe = '1D' | '5D' | '1M' | '3M'

/** Matches the `Instrument` interface used by FXTable, CommodityTable, etc. */
export interface LiveInstrument {
  symbol:        string
  name:          string
  price:         number
  change:        number          // absolute $ / point change on the day
  changePercent: number          // e.g. 0.49 means +0.49 %
  high?:         number
  low?:          number
  open?:         number
  sparkline:     number[]        // 1-D intraday history built from rolling prices
  sparklines?:   Record<Timeframe, number[]>
}

/**
 * The slice of MarketData this hook owns.
 * Partial on purpose — rates / fx / volatility come from the /api/market route
 * as before; this hook only replaces the high-frequency pieces.
 */
export interface LivePrices {
  futures:     LiveInstrument[]   // ES=F, NQ=F
  equities:    LiveInstrument[]   // ^GSPC, ^NDX  (used by ratio cards)
  commodities: LiveInstrument[]   // GC=F, SI=F, HG=F, CL=F
  lastUpdated: number             // Unix ms timestamp
  source:      'ib' | 'fmp' | 'polygon' | 'mock'
}

export interface LiveFeedState {
  livePrices:      LivePrices | null
  isLoading:       boolean
  connectionError: string | null
  /** Call to retry after a connection error (resets back-off) */
  reconnect:       () => void
}

// ─── Proxy Response Types ─────────────────────────────────────────────────────
//
// These mirror the exported interfaces from src/app/api/marketdata/route.ts.
// The proxy does all the raw IB parsing (locale strings, % formats, warm-up);
// this hook receives clean numbers.

interface ProxyQuote {
  conid:         string
  symbol:        string
  name:          string
  assetClass:    'future' | 'equity' | 'commodity'
  price:         number
  change:        number
  changePercent: number
  high?:         number
  low?:          number
  open?:         number
  bid?:          number
  ask?:          number
}

interface ProxyResponse {
  authenticated: boolean
  snapshot:      ProxyQuote[]
  timestamp:     number
  partial?:      boolean    // true when IB returned empty fields (warm-up tick)
  error?:        string
}

// ─── Constants ────────────────────────────────────────────────────────────────

/**
 * Symbols sent to the proxy on every poll.
 * The proxy maps each to its IB conid and fetches them in a single snapshot call.
 *
 * To add more instruments, add them here AND add their conid to
 * CONID_REGISTRY in src/app/api/marketdata/route.ts.
 */
const PROXY_SYMBOLS = [
  'ES=F', 'NQ=F',                    // CME equity-index futures
  '^GSPC', '^NDX',                   // cash indices (ratio cards)
  'GC=F', 'SI=F', 'HG=F', 'CL=F',   // commodity futures
].join(',')

const PROXY_URL = `/api/marketdata?symbols=${PROXY_SYMBOLS}`

const POLL_INTERVAL_MS  = 4_000   // 4-second snapshot polling
const WARM_UP_RETRY_MS  = 1_000   // re-poll delay when IB returns empty fields
const MAX_SPARKLINE_PTS = 390     // ~6.5 h of 1-min bars (full regular session)

// ─── Instrument Name Overrides ────────────────────────────────────────────────
//
// The proxy already returns `name` from the CONID_REGISTRY.
// This map lets the hook override names locally if the proxy names diverge
// from what the dashboard components expect.

const NAME_OVERRIDE: Record<string, string> = {
  // Add overrides here if needed, e.g.:
  // 'GC=F': 'Gold Futures',
}

// ─── Data Transformation ──────────────────────────────────────────────────────

/**
 * transformProxySnapshot
 *
 * Converts the proxy's cleaned ProxyQuote[] into LiveInstrument records and
 * updates the rolling price-history map used for 1-D sparklines.
 *
 * The proxy has already handled all IB quirks (locale strings, +0.49% format,
 * warm-up blank fields → price=0), so this function only needs to:
 *   1. Append the new price to the per-symbol history ring buffer.
 *   2. Attach the current history as `sparkline`.
 *   3. Apply any local name overrides.
 */
function transformProxySnapshot(
  quotes:  ProxyQuote[],
  history: Map<string, number[]>,
): Partial<Record<string, LiveInstrument>> {
  const result: Partial<Record<string, LiveInstrument>> = {}

  for (const q of quotes) {
    // Accumulate rolling 1-D sparkline (price history)
    const hist = history.get(q.symbol) ?? []
    if (q.price > 0) {
      hist.push(q.price)
      if (hist.length > MAX_SPARKLINE_PTS) hist.shift()
      history.set(q.symbol, hist)
    }

    result[q.symbol] = {
      symbol:        q.symbol,
      name:          NAME_OVERRIDE[q.symbol] ?? q.name,
      price:         q.price,
      change:        q.change,
      changePercent: q.changePercent,
      ...(q.high !== undefined ? { high: q.high } : {}),
      ...(q.low  !== undefined ? { low:  q.low  } : {}),
      ...(q.open !== undefined ? { open: q.open } : {}),
      sparkline: [...hist],
    }
  }

  return result
}
// ─── FALLBACK A: Polygon.io ───────────────────────────────────────────────────
//
// Uncomment and set NEXT_PUBLIC_POLYGON_API_KEY in .env.local.
// Free tier: end-of-day data only. Starter+ supports real-time.
// Docs: https://polygon.io/docs/indices/get_v3_snapshot_indices__ticker
//
// const POLYGON_API_KEY = process.env.NEXT_PUBLIC_POLYGON_API_KEY ?? ''
// const POLYGON_SYMBOL_MAP: Record<string, string> = {
//   '^GSPC': 'I:SPX',
//   '^NDX':  'I:NDX',
//   'GC=F':  'C:XAUUSD',
//   'SI=F':  'C:XAGUSD',
//   'HG=F':  'C:HGUSD',
//   'CL=F':  'C:USOILWTI',
// }
// const POLYGON_SYMBOL_REVERSE: Record<string, string> = Object.fromEntries(
//   Object.entries(POLYGON_SYMBOL_MAP).map(([k, v]) => [v, k])
// )
//
// interface PolygonSession { close: number; open: number; high: number; low: number; change: number; changePercent: number }
// interface PolygonSnapshot { ticker: string; session: PolygonSession }
//
// async function fetchPolygonPrices(
//   history: Map<string, number[]>,
// ): Promise<{ quotes: Partial<Record<string, LiveInstrument>>; partial: boolean; authError: null }> {
//   const tickers = Object.values(POLYGON_SYMBOL_MAP).join(',')
//   const params  = new URLSearchParams({ ticker: tickers, apiKey: POLYGON_API_KEY })
//   const url     = `https://api.polygon.io/v3/snapshot?${params}`
//   const res     = await fetch(url, { cache: 'no-store' })
//   if (!res.ok) throw new Error(`Polygon HTTP ${res.status}`)
//   const json    = await res.json()
//   const results: PolygonSnapshot[] = json.results ?? []
//
//   const quotes: Partial<Record<string, LiveInstrument>> = {}
//   for (const r of results) {
//     const symbol = POLYGON_SYMBOL_REVERSE[r.ticker]
//     if (!symbol) continue
//     const hist = history.get(symbol) ?? []
//     if (r.session.close > 0) {
//       hist.push(r.session.close)
//       if (hist.length > MAX_SPARKLINE_PTS) hist.shift()
//       history.set(symbol, hist)
//     }
//     quotes[symbol] = {
//       symbol, name: NAME_OVERRIDE[symbol] ?? symbol,
//       price: r.session.close, change: r.session.change, changePercent: r.session.changePercent,
//       high:  r.session.high,  low:   r.session.low,    open: r.session.open,
//       sparkline: [...hist],
//     }
//   }
//   return { quotes, partial: false, authError: null }
// }

// ─── Primary Fetch: /api/marketdata Proxy ─────────────────────────────────────

interface FetchResult {
  quotes:    Partial<Record<string, LiveInstrument>>
  partial:   boolean
  authError: string | null   // non-null when IB reports authenticated: false
}

async function fetchFromProxy(history: Map<string, number[]>): Promise<FetchResult> {
  const res = await fetch(PROXY_URL, { cache: 'no-store' })

  // Non-2xx from the proxy itself (503 = gateway down, 401 = not authenticated, 502 = snapshot failed)
  if (!res.ok) {
    let body: Partial<ProxyResponse> = {}
    try { body = await res.json() } catch { /* ignore */ }
    const msg = body.error ?? `Proxy HTTP ${res.status}`

    if (res.status === 401) {
      // Gateway is reachable but IB session expired — surface as auth error
      return { quotes: {}, partial: false, authError: msg }
    }
    throw new Error(msg)
  }

  const data: ProxyResponse = await res.json()

  // Proxy returned 200 but IB reports session as unauthenticated
  if (!data.authenticated) {
    return {
      quotes:    {},
      partial:   false,
      authError: data.error ?? 'IB session not authenticated. Open https://localhost:5000 and log in.',
    }
  }

  const quotes = transformProxySnapshot(data.snapshot, history)

  return {
    quotes,
    partial:   data.partial ?? false,
    authError: null,
  }
}

// ─── Result Builder ───────────────────────────────────────────────────────────
//
// Assembles the normalized map into the three arrays the dashboard expects.
// Any symbol with price=0 (IB returned empty on first tick) is filtered out
// so the UI falls back to the existing /api/market data for that instrument.

function buildLivePrices(
  priceMap: Partial<Record<string, LiveInstrument>>,
  source:   LivePrices['source'],
): LivePrices {
  const pick = (...syms: string[]) =>
    syms.map(s => priceMap[s]).filter((x): x is LiveInstrument => !!x && x.price > 0)

  return {
    futures:     pick('ES=F', 'NQ=F'),
    equities:    pick('^GSPC', '^NDX'),
    commodities: pick('GC=F', 'SI=F', 'HG=F', 'CL=F'),
    lastUpdated: Date.now(),
    source,
  }
}

// ─── The Hook ─────────────────────────────────────────────────────────────────

export function useMarketLiveFeed(): LiveFeedState {
  const [livePrices,      setLivePrices]     = useState<LivePrices | null>(null)
  const [isLoading,       setIsLoading]      = useState(true)
  const [connectionError, setConnectionError] = useState<string | null>(null)

  // Rolling price history for sparklines — survives re-renders, never resets mid-session
  const historyRef = useRef<Map<string, number[]>>(new Map())

  // Reconnect trigger — incrementing this value restarts the polling effect
  const [retryKey, setRetryKey] = useState(0)

  // Timer handles held in refs so cleanup works across async boundaries
  const pollTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout>  | null>(null)

  const reconnect = useCallback(() => {
    setConnectionError(null)
    setIsLoading(true)
    setRetryKey(k => k + 1)
  }, [])

  useEffect(() => {
    let mounted = true

    function clearTimers() {
      if (pollTimerRef.current)  { clearInterval(pollTimerRef.current);  pollTimerRef.current  = null }
      if (retryTimerRef.current) { clearTimeout(retryTimerRef.current);  retryTimerRef.current = null }
    }

    async function tick() {
      if (!mounted) return

      try {
        // ── Primary: poll /api/marketdata (Next.js proxy → IB gateway) ──────
        const { quotes, partial, authError } = await fetchFromProxy(historyRef.current)

        // ── Alt primary: swap the above line for one of these to use a fallback
        // const { quotes, partial, authError } = await fetchFMPPrices(historyRef.current)
        // const { quotes, partial, authError } = await fetchPolygonPrices(historyRef.current)

        if (!mounted) return

        if (authError) {
          // IB session expired or gateway not authenticated — stop polling,
          // show the error message with a Retry button.
          setConnectionError(authError)
          clearTimers()
          setIsLoading(false)
          return
        }

        if (partial) {
          // IB warm-up tick: fields came back empty because IB streams data
          // lazily on first subscribe. Re-poll once after a short delay instead
          // of waiting a full 4 seconds.
          retryTimerRef.current = setTimeout(tick, WARM_UP_RETRY_MS)
          return
        }

        const prices = buildLivePrices(quotes, 'ib')
        setLivePrices(prices)
        setConnectionError(null)
      } catch (err) {
        if (!mounted) return
        const msg = err instanceof Error ? err.message : String(err)
        // Surface transient errors (network blip, proxy timeout) without clearing
        // the last known good prices — UI keeps showing stale data.
        setConnectionError(`IB feed error: ${msg}`)
        // Don't stop polling on transient errors — the gateway may recover
      } finally {
        if (mounted) setIsLoading(false)
      }
    }

    // ── Initial tick then 4-second interval ──────────────────────────────────
    setIsLoading(true)
    setConnectionError(null)

    tick().then(() => {
      if (!mounted) return
      // Start the interval only after the first tick completes so we never
      // overlap concurrent requests.
      pollTimerRef.current = setInterval(tick, POLL_INTERVAL_MS)
    })

    return () => {
      mounted = false
      clearTimers()
    }
  }, [retryKey])

  return { livePrices, isLoading, connectionError, reconnect }
}
