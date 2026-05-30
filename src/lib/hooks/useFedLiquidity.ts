import { useState, useEffect, useCallback, useRef } from 'react'
import type {
  FedLiquiditySnapshot,
} from '@/lib/types/fed-liquidity'

// ─── Local fallback (shown instantly, replaced once fetch resolves) ────────────

const FALLBACK: FedLiquiditySnapshot = {
  date:              new Date().toISOString().split('T')[0],
  balanceSheetTotal: 7_240,
  tga:               165,
  rrp:               2_480,
  netLiquidity:      4_595,
  momentum14d:       -2.4,
  momentumDirection: 'contracting',
  meta: {
    dataSource:  'MOCK_FALLBACK',
    status:      'DEMO_FALLBACK',
    seriesDates: { fta: '—', tga: '—', rro: '—' },
    timestamp:   new Date().toISOString(),
  },
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

interface UseFedLiquidityResult {
  snapshot:    FedLiquiditySnapshot
  isLoading:   boolean
  isLive:      boolean    // true when meta.status === 'AUTHENTICATED'
  lastFetched: Date | null
  refresh:     () => void
}

/**
 * Fetches /api/fed-liquidity and keeps it fresh on `refreshIntervalMs`.
 * Returns the local fallback snapshot immediately so the UI never shows blank.
 */
export function useFedLiquidity(
  /** How often to auto-refresh in ms. Default: 5 minutes. */
  refreshIntervalMs = 5 * 60_000,
): UseFedLiquidityResult {
  const [snapshot,    setSnapshot]    = useState<FedLiquiditySnapshot>(FALLBACK)
  const [isLoading,   setIsLoading]   = useState(true)
  const [lastFetched, setLastFetched] = useState<Date | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const fetch_ = useCallback(async () => {
    // Cancel any in-flight request
    abortRef.current?.abort()
    abortRef.current = new AbortController()

    setIsLoading(true)
    try {
      const res = await fetch('/api/fed-liquidity', {
        cache:  'no-store',
        signal: abortRef.current.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data: FedLiquiditySnapshot = await res.json()
      setSnapshot(data)
      setLastFetched(new Date())
    } catch (err: unknown) {
      // AbortError is normal on unmount – don't log it
      if (err instanceof Error && err.name !== 'AbortError') {
        console.warn('[useFedLiquidity] fetch failed, keeping previous data:', err.message)
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
    snapshot,
    isLoading,
    isLive:      snapshot.meta?.status === 'AUTHENTICATED',
    lastFetched,
    refresh:     fetch_,
  }
}
