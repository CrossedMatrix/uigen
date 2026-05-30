'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import type { MacroRiskMetrics } from '@/components/dashboard/MacroRiskMatrix'

/**
 * useVolRisk — Real-time Volatility & Risk Indicators
 * ─────────────────────────────────────────────────────────────────────────────
 * Polls /api/vol-risk every 60 seconds to populate MacroRiskMatrix with
 * live VIX, VVIX, MOVE, SKEW, and put/call ratio data from Yahoo Finance.
 *
 * Returns null on the first render (before the first fetch completes).
 * The dashboard uses `volRisk ?? MACRO_RISK_MOCK` as the fallback, so the
 * UI renders mock data immediately and transitions to live data silently.
 *
 * On error / 503 (Yahoo rate-limited), retains the last known-good value
 * rather than dropping back to mock data — stale vol data is preferable
 * to mock data because it reflects an actual market state.
 */

const POLL_INTERVAL_MS = 300_000   // 5 minutes — conservative for local dev / FMP quota

export function useVolRisk(): MacroRiskMetrics | null {
  const [metrics, setMetrics] = useState<MacroRiskMetrics | null>(null)
  const isMountedRef          = useRef(true)
  const timerRef              = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchVolRisk = useCallback(async () => {
    try {
      const res = await fetch('/api/vol-risk', {
        cache:   'no-store',
        headers: { 'Accept': 'application/json' },
      })

      if (!res.ok) {
        // 503 = Yahoo rate-limited; server will serve stale cache on next request.
        // 500 = unexpected error.  Either way, retain last known-good state.
        console.warn(`[useVolRisk] API returned ${res.status} — retaining previous value`)
        return
      }

      const data = (await res.json()) as MacroRiskMetrics

      // Guard against error response JSON (has 'error' key, not 'vix')
      if (typeof data?.vix?.price !== 'number') {
        console.warn('[useVolRisk] Response missing vix.price — not a valid MacroRiskMetrics payload')
        return
      }

      if (isMountedRef.current) {
        setMetrics(data)
        console.info(
          `[useVolRisk] Updated — VIX=${data.vix.price} ` +
          `VVIX=${data.vvix.price} MOVE=${data.move.price} ` +
          `SKEW=${data.skew.price} PCR=${data.putCallRatio}`
        )
      }
    } catch (err) {
      // Network error — retain last known-good value, log for debugging
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[useVolRisk] Fetch failed: ${msg} — retaining previous value`)
    }
  }, [])

  useEffect(() => {
    isMountedRef.current = true

    // Fire immediately on mount so data populates before the first poll interval
    void fetchVolRisk()

    // Schedule recurring polls
    timerRef.current = setInterval(fetchVolRisk, POLL_INTERVAL_MS)

    return () => {
      isMountedRef.current = false
      if (timerRef.current !== null) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [fetchVolRisk])

  return metrics
}
