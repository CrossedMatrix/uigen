'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import type { AlpacaProxyResponse, AlpacaQuote } from '@/app/api/alpaca/route'

// ─── Default symbols ──────────────────────────────────────────────────────────

export const DEFAULT_CRYPTO_SYMBOLS  = ['BTC/USD', 'ETH/USD']
export const DEFAULT_EQUITY_SYMBOLS  = ['SPY', 'QQQ', 'IWM', 'DIA']

// ─── Back-off constants ───────────────────────────────────────────────────────
// On consecutive 4xx/5xx errors: double the retry interval each time, up to 5 min.
// Prevents hammering the Alpaca proxy when credentials are missing or the
// upstream provider returns persistent errors.
const MAX_CONSEC_ERR   = 5           // clamp exponent so we don't overflow
const MAX_BACK_OFF_MS  = 5 * 60_000  // 5 min ceiling

// ─── Hook ─────────────────────────────────────────────────────────────────────

export interface UseAlpacaDataOptions {
  symbols?:     string[]
  assetClass?:  'crypto' | 'us_equity'
  type?:        'snapshot' | 'bars' | 'snapshot+bars'
  timeframe?:   '1Min' | '5Min' | '15Min' | '1Hour' | '1Day'
  limit?:       number
  /** Poll interval in ms. Set to 0 to disable polling. Default: 30 000 */
  pollInterval?: number
}

/** Provider connection status surfaced to consumers for graceful UI degradation. */
export type AlpacaStatus = 'loading' | 'live' | 'offline'

export interface UseAlpacaDataReturn {
  quotes:      AlpacaQuote[]
  quoteMap:    Map<string, AlpacaQuote>
  isLoading:   boolean
  /** 'loading' on first fetch, 'live' on success, 'offline' on 404/timeout/network error. */
  status:      AlpacaStatus
  error:       string | null
  lastUpdated: number | null
  refetch:     () => void
}

export function useAlpacaData({
  symbols    = DEFAULT_CRYPTO_SYMBOLS,
  assetClass = 'crypto',
  type       = 'snapshot',
  timeframe  = '1Day',
  limit      = 30,
  pollInterval = 30_000,
}: UseAlpacaDataOptions = {}): UseAlpacaDataReturn {
  const [quotes,      setQuotes]      = useState<AlpacaQuote[]>([])
  const [isLoading,   setIsLoading]   = useState(true)
  const [status,      setStatus]      = useState<AlpacaStatus>('loading')
  const [error,       setError]       = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<number | null>(null)

  // ── Refs (stable across renders, no effect re-runs) ───────────────────────
  const mountedRef     = useRef(true)
  const timerRef       = useRef<ReturnType<typeof setTimeout> | null>(null)
  const consecErrRef   = useRef(0)
  const pollRef        = useRef(Math.max(pollInterval, 10_000))
  pollRef.current      = Math.max(pollInterval, 10_000)

  // Key ref: stable string identity for the current symbol+options set.
  // When it changes, the effect resets the error counter and restarts the loop.
  const optKeyRef  = useRef('')
  const newOptKey  = `${symbols.join(',')}|${assetClass}|${type}|${timeframe}|${limit}`

  // ── Core fetch function (kept in ref so the timer always sees latest options)
  const fetchRef = useRef<() => Promise<void>>(async () => {})
  fetchRef.current = async () => {
    if (!mountedRef.current) return

    // Cancel any pending poll timer
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }

    // isLoading stays true on cold-start; remains false on background re-polls

    try {
      const params = new URLSearchParams({
        type,
        symbols:     symbols.join(','),
        asset_class: assetClass,
        timeframe,
        limit:       String(limit),
      })
      const res = await fetch(`/api/alpaca?${params}`, { cache: 'no-store' })

      // 404 = unsupported symbol/class; treat as a permanent offline for this
      // symbol set so the UI shows a clean "offline" state instead of retrying
      // into a 404 loop that crowds the server log.
      if (res.status === 404) {
        const text = await res.text().catch(() => 'Not Found')
        console.warn(`[useAlpacaData] 404 — ${text.slice(0, 120)}`)
        if (mountedRef.current) {
          setError(`Offline (404): ${text.slice(0, 80)}`)
          setStatus('offline')
          setIsLoading(false)
        }
        // Back-off retry — don't hammer on a permanent 404
        scheduleRetry(true)
        return
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: AlpacaProxyResponse = await res.json()

      if (!mountedRef.current) return

      if (data.error) {
        // Alpaca returned a payload-level error (e.g. credentials not configured)
        console.warn('[useAlpacaData]', data.error)
        setError(data.error)
        setStatus('offline')
        setIsLoading(false)
        scheduleRetry(true)
        return
      }

      // ── Success ────────────────────────────────────────────────────────────
      consecErrRef.current = 0
      setQuotes(data.quotes)
      setError(null)
      setStatus('live')
      setLastUpdated(data.timestamp)
      setIsLoading(false)

      if (pollRef.current > 0) {
        timerRef.current = setTimeout(() => { void fetchRef.current() }, pollRef.current)
      }
    } catch (err) {
      if (!mountedRef.current) return
      const msg = err instanceof Error ? err.message : String(err)
      // Timeout signals (AbortError / TimeoutError) surface as 'offline' — the
      // network is reachable but the provider is not responding in time.
      const isTimeout = msg.includes('abort') || msg.includes('timeout') || msg.includes('Timeout')
      console.warn('[useAlpacaData] fetch failed:', msg)
      setError(msg)
      setStatus(isTimeout ? 'offline' : 'offline')   // all errors → offline
      setIsLoading(false)
      scheduleRetry(true)
    }
  }

  /** Schedule the next fetch with optional exponential back-off on errors. */
  function scheduleRetry(isError: boolean) {
    if (!mountedRef.current || pollRef.current <= 0) return
    if (isError) {
      consecErrRef.current = Math.min(consecErrRef.current + 1, MAX_CONSEC_ERR)
    }
    const delay = isError
      ? Math.min(pollRef.current * Math.pow(2, consecErrRef.current - 1), MAX_BACK_OFF_MS)
      : pollRef.current
    timerRef.current = setTimeout(() => { void fetchRef.current() }, delay)
  }

  // ── Effect: restart the fetch loop whenever symbol set or options change ───
  useEffect(() => {
    mountedRef.current = true
    optKeyRef.current  = newOptKey
    consecErrRef.current = 0          // fresh start for new option set
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }

    void fetchRef.current()

    return () => {
      mountedRef.current = false
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    }
  }, [newOptKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Stable public refetch ─────────────────────────────────────────────────
  const refetch = useCallback(() => { void fetchRef.current() }, [])

  const quoteMap = new Map(quotes.map(q => [q.symbol, q]))

  return { quotes, quoteMap, isLoading, status, error, lastUpdated, refetch }
}
