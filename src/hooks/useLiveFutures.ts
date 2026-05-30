'use client'

/**
 * useLiveFutures
 * ──────────────────────────────────────────────────────────────────────────────
 * Polls http://localhost:8000/api/live-futures (Python bridge/main.py → IB Gateway
 * Paper Trading port 4002) every POLL_MS milliseconds and returns futures ticks
 * shaped as FuturesInstrument[] — the same type the dashboard FuturesCard grid
 * expects.
 *
 * Response shape from bridge/main.py:
 *   {
 *     connected: boolean,
 *     timestamp: string,
 *     data: {
 *       "ES": { last, bid, ask, change, change_pct },
 *       "NQ": { ... },
 *       "ZN": { ... }
 *     }
 *   }
 *
 * Symbol mapping:
 *   IB native  →  Yahoo-style (used by the rest of the dashboard)
 *   "ES"       →  "ES=F"
 *   "NQ"       →  "NQ=F"
 *   "ZN"       →  "ZN=F"
 *
 * Sparklines:
 *   A rolling price history (up to MAX_SPARKLINE_PTS) is maintained in a ref
 *   per symbol.  The 1D sparkline is built from this ring buffer; the 5D/1M/3M
 *   slices are empty (no multi-day history is available from the streaming feed).
 *   If the server is disconnected the last known sparkline is preserved.
 *
 * Graceful degradation:
 *   When the Python server is not running (network error or not connected) the
 *   hook returns { futures: [], connected: false } without throwing.  The
 *   dashboard transparently falls back to Yahoo Finance data for the futures grid.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import type { IBTickFields } from '@/app/api/live-futures/route'

// ─── Types ────────────────────────────────────────────────────────────────────

type Timeframe = '1D' | '5D' | '1M' | '3M'

/** Shape that FuturesCard in dashboard/page.tsx expects. */
export interface FuturesInstrument {
  symbol:        string
  name:          string
  price:         number | null
  change:        number | null
  changePercent: number | null
  high?:         number
  low?:          number
  bid?:          number
  ask?:          number
  sparklines:    Record<Timeframe, number[]>
}

export interface LiveFuturesState {
  /** Mapped + enriched futures rows.  Empty when server is down. */
  futures:    FuturesInstrument[]
  /** True when bridge/main.py reports an active IB Gateway connection. */
  connected:  boolean
  /** True during the very first fetch only. */
  isLoading:  boolean
  /**
   * Explicit provider status for graceful UI degradation.
   * 'loading'  — first fetch in progress; no data yet.
   * 'live'     — IB Gateway connected and returning ticks.
   * 'offline'  — server unreachable, 404, timeout, or IB not connected.
   *              Always return a safe fallback object; never throw.
   */
  status:     'loading' | 'live' | 'offline'
  /**
   * True while the Python bridge server at :8000 is reachable, regardless of
   * whether IB Gateway itself is connected.  Flips to false on AbortError /
   * network-level failures (ECONNREFUSED, "Failed to fetch", etc.) so the UI
   * can show a "Waiting for Sync" footer instead of a generic error.
   *
   * Distinct from `connected`:
   *   isGatewayActive=true,  connected=false  → bridge up, IB not logged in
   *   isGatewayActive=false, connected=false  → bridge process is not running
   */
  isGatewayActive: boolean
  /** Non-null when the server is unreachable or IB is not connected. */
  error:      string | null
  /** Unix ms timestamp of the last successful response. */
  lastUpdate: number | null
}

// ─── Internal shape of the raw API response ───────────────────────────────────

interface RawLiveFuturesResponse {
  connected: boolean
  timestamp: string
  data:      Record<string, IBTickFields>
  error?:    string
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Poll every 2 s — IB Gateway tick cadence is ~250 ms, polling headroom is fine. */
const POLL_MS           = 2_000
/** Keep up to 390 price points (~6.5 h at 1 tick/second during RTH). */
const MAX_SPARKLINE_PTS = 390
/** Direct URL to the Python bridge server — bypasses the Next.js proxy.
 *  Override via NEXT_PUBLIC_IB_BRIDGE_URL in production (e.g. Railway/Render). */
const IB_DIRECT_URL =
  process.env.NEXT_PUBLIC_IB_BRIDGE_URL?.trimEnd().replace(/\/$/, '') + '/api/live-futures'
  || 'http://localhost:8000/api/live-futures'

/**
 * IB native symbol → Yahoo Finance-style symbol (dashboard standard).
 * Add rows here when new contracts are added to _CONTRACTS in bridge/main.py.
 */
const IB_TO_YAHOO: Record<string, string> = {
  ES: 'ES=F',
  NQ: 'NQ=F',
  ZN: 'ZN=F',
}

/**
 * Display names to render in the FuturesCard header.
 * Mirrors FUTURES_META in dashboard/page.tsx.
 */
const DISPLAY_NAMES: Record<string, string> = {
  'ES=F': 'S&P 500 E-Mini',
  'NQ=F': 'Nasdaq-100 E-Mini',
  'ZN=F': '10-Year T-Note',
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Map one IB symbol + tick fields to a FuturesInstrument,
 * appending to the rolling sparkline ring buffer.
 */
function tickToInstrument(
  ibSymbol: string,
  fields:   IBTickFields,
  history:  Map<string, number[]>,
): FuturesInstrument {
  const yahooSym = IB_TO_YAHOO[ibSymbol] ?? `${ibSymbol}=F`

  // Append to rolling 1D sparkline (only when we have a valid price)
  const hist = history.get(yahooSym) ?? []
  if (fields.last !== null && fields.last > 0) {
    hist.push(fields.last)
    if (hist.length > MAX_SPARKLINE_PTS) hist.shift()
    history.set(yahooSym, hist)
  }

  return {
    symbol:        yahooSym,
    name:          DISPLAY_NAMES[yahooSym] ?? yahooSym,
    price:         fields.last,
    change:        fields.change,
    changePercent: fields.change_pct,
    ...(fields.bid  != null ? { bid:  fields.bid  } : {}),
    ...(fields.ask  != null ? { ask:  fields.ask  } : {}),
    sparklines: {
      '1D': [...hist],
      '5D': [],   // multi-day history not available from streaming feed
      '1M': [],
      '3M': [],
    },
  }
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useLiveFutures(): LiveFuturesState {
  const [futures,         setFutures]         = useState<FuturesInstrument[]>([])
  const [connected,       setConnected]       = useState(false)
  const [isLoading,       setIsLoading]       = useState(true)
  const [status,          setStatus]          = useState<'loading' | 'live' | 'offline'>('loading')
  const [isGatewayActive, setIsGatewayActive] = useState(true)
  const [error,           setError]           = useState<string | null>(null)
  const [lastUpdate,      setLastUpdate]      = useState<number | null>(null)

  // Rolling sparkline history survives re-renders, resets only on unmount
  const historyRef       = useRef<Map<string, number[]>>(new Map())
  const timerRef         = useRef<ReturnType<typeof setInterval> | null>(null)
  const mountedRef       = useRef(true)
  /**
   * Tracks whether the "gateway offline" message has already been logged.
   * Resets when the gateway comes back online so a reconnect is also logged.
   * This prevents the console from being flooded at 1 line per poll tick.
   */
  const gatewayLoggedRef = useRef(false)

  const tick = useCallback(async () => {
    try {
      const res = await fetch(IB_DIRECT_URL, { cache: 'no-store' })

      if (!mountedRef.current) return

      // Non-2xx response — treat as offline.
      // 404 = bridge endpoint not recognised; any other non-ok = transient error.
      // Log once on the first occurrence, then stay silent to avoid console flood.
      if (!res.ok) {
        const isNotFound = res.status === 404
        const errMsg = isNotFound ? 'Bridge endpoint not found (404)' : `HTTP ${res.status}`
        if (!gatewayLoggedRef.current) {
          console.info(`[useLiveFutures] going offline — ${errMsg}. Polling silently until reconnect.`)
          gatewayLoggedRef.current = true
        }
        if (mountedRef.current) {
          setConnected(false)
          setFutures([])
          setStatus('offline')
          setIsGatewayActive(false)
          setError(errMsg)
        }
        return
      }

      const raw: RawLiveFuturesResponse = await res.json()

      if (!mountedRef.current) return

      if (!raw.connected || Object.keys(raw.data).length === 0) {
        // Bridge is reachable but IB Gateway is not logged in or has no tick data yet.
        // isGatewayActive stays true — the Python process is running.
        setConnected(false)
        setFutures([])
        setStatus('offline')
        setIsGatewayActive(true)
        setError(raw.error ?? 'IB Gateway not connected')
        return
      }

      // ── Successful tick ──────────────────────────────────────────────────────
      // If the gateway was previously offline, log the reconnect and reset the flag.
      if (gatewayLoggedRef.current) {
        console.info('[useLiveFutures] IB Gateway reconnected — resuming live ticks.')
        gatewayLoggedRef.current = false
      }

      // Map the dict response to FuturesInstrument[]
      const mapped = Object.entries(raw.data)
        .filter(([, fields]) => fields.last !== null)  // skip symbols with no data yet
        .map(([sym, fields]) => tickToInstrument(sym, fields, historyRef.current))

      setFutures(mapped)
      setConnected(true)
      setStatus('live')
      setIsGatewayActive(true)
      setError(null)
      setLastUpdate(Date.now())

    } catch (err) {
      if (!mountedRef.current) return

      const msg = err instanceof Error ? err.message : 'Fetch failed'

      // ── Classify the error ───────────────────────────────────────────────────
      // AbortError  → fetch timed out (AbortSignal / fetch timeout)
      // Network err → bridge process is not running (ECONNREFUSED, "Failed to fetch", etc.)
      // These are expected when IB Gateway / the Python bridge is offline.
      // Log once on the first occurrence, then poll silently to avoid terminal flood.
      const isAbort   = err instanceof DOMException && err.name === 'AbortError'
      const isNetwork = (
        msg.includes('fetch failed')          ||   // Next.js server-side undici
        msg.includes('Failed to fetch')       ||   // browser Fetch API
        msg.includes('ECONNREFUSED')          ||   // Node.js TCP refused
        msg.includes('ENOTFOUND')             ||   // DNS / hostname not found
        msg.includes('Network request failed')||   // React Native / some polyfills
        msg.includes('network error')         ||   // generic lower-case variant
        msg.includes('Load failed')                // Safari fetch failure
      )
      const isSilentFailure = isAbort || isNetwork

      if (isSilentFailure) {
        // Only log the first time we go offline; suppress all subsequent identical noise.
        if (!gatewayLoggedRef.current) {
          console.info(
            `[useLiveFutures] IB Gateway unreachable (${isAbort ? 'timeout' : 'network'}) — ` +
            'polling silently until bridge reconnects.',
          )
          gatewayLoggedRef.current = true
        }
        setIsGatewayActive(false)
      } else {
        // Unexpected error (e.g. JSON parse failure) — always surface these.
        console.warn('[useLiveFutures] unexpected error →', msg)
      }

      setConnected(false)
      setFutures([])
      setStatus('offline')
      setError(msg)
    } finally {
      if (mountedRef.current) setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    setIsLoading(true)

    tick()  // immediate first fetch
    timerRef.current = setInterval(tick, POLL_MS)

    return () => {
      mountedRef.current = false
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [tick])

  return { futures, connected, isLoading, status, isGatewayActive, error, lastUpdate }
}
