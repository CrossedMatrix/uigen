import { useState, useEffect, useCallback, useRef } from 'react'
import type { FredMarketsData } from '@/types/fred-markets'

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface UseFredMarketsResult {
  data:           FredMarketsData | null
  isLoading:      boolean
  /** True if either panel resolved live */
  isLive:         boolean
  /** Yield Curve panel resolved live (DGS2 + DGS10 both succeeded) */
  yieldsLive:     boolean
  /** DXY panel resolved live (DTWEXBGS succeeded) */
  dxyLive:        boolean
  lastFetched:    Date | null
  refresh:        () => void
}

/**
 * Fetches /api/fred-markets (Treasury yields + DXY) and keeps it fresh.
 *
 * Returns null until the first successful fetch; the UI falls back to the
 * existing market-API data in the meantime.
 *
 * FRED daily series update once per business day, so a 15-minute interval
 * is appropriate – tight enough to catch close-of-day prints quickly.
 *
 * The returned `yieldsLive` and `dxyLive` flags read the **per-panel**
 * meta.status fields, so each container can light its own ● REAL-TIME FRED
 * badge independently if one feed is healthy and the other isn't.
 */
export function useFredMarkets(
  refreshIntervalMs = 15 * 60_000,
): UseFredMarketsResult {
  const [data,        setData]        = useState<FredMarketsData | null>(null)
  const [isLoading,   setIsLoading]   = useState(true)
  const [lastFetched, setLastFetched] = useState<Date | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const fetch_ = useCallback(async () => {
    abortRef.current?.abort()
    abortRef.current = new AbortController()

    setIsLoading(true)
    try {
      const res = await fetch('/api/fred-markets', {
        cache:  'no-store',
        signal: abortRef.current.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: FredMarketsData = await res.json()
      setData(json)
      setLastFetched(new Date())
    } catch (err: unknown) {
      if (err instanceof Error && err.name !== 'AbortError') {
        console.warn('[useFredMarkets] fetch failed:', err.message)
      }
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetch_()
    const timer = setInterval(fetch_, refreshIntervalMs)
    return () => {
      clearInterval(timer)
      abortRef.current?.abort()
    }
  }, [fetch_, refreshIntervalMs])

  return {
    data,
    isLoading,
    isLive:     data?.meta.status            === 'AUTHENTICATED',
    yieldsLive: data?.yieldCurve.meta.status === 'AUTHENTICATED',
    dxyLive:    data?.dxy.meta.status        === 'AUTHENTICATED',
    lastFetched,
    refresh:    fetch_,
  }
}
