'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import type { MarketNode, MarketDataSnapshot } from '@/lib/types/market'

export interface UseMarketNodesState {
  data: MarketDataSnapshot | null
  isLoading: boolean
  error: string | null
  lastUpdated: number | null
}

// ─── Poll constants ───────────────────────────────────────────────────────────
const MIN_POLL_MS      = 30_000       // 30 s  — minimum between any two fetches
const MAX_BACK_OFF_MS  = 5 * 60_000   // 5 min — ceiling for exponential back-off
const MAX_CONSEC_ERR   = 5            // after this many consecutive failures, back off fully

/**
 * useMarketNodes — controlled market-data subscription hook.
 *
 * Dependency contract:
 *   The single useEffect has deps [category, timeframe].  That is the complete
 *   list of values that should trigger a new fetch + poll restart:
 *     • category change  → different instrument set, full restart
 *     • timeframe change → different historical slice, full restart
 *     • pollInterval     → written to a ref; no restart needed
 *   Internal implementation details (fetchData function, abort controller, seq
 *   counter) are stored in refs so they never appear in deps arrays and never
 *   cause spurious re-runs.
 *
 * Race-condition contract:
 *   When [category, timeframe] changes the effect cleanup:
 *     1. Aborts the in-flight HTTP request via AbortController
 *     2. Clears any pending setTimeout so the old poll loop cannot reschedule
 *   The new effect body then starts a fresh single fetch + poll chain.
 *   A monotonic seqRef discards responses that arrive after a newer request
 *   has already been issued (belt-and-braces on top of the abort).
 *
 * Error back-off contract:
 *   On error the retry delay is the full pollInterval (≥ 30 s).  The 10-second
 *   shortcut that was in the original code was the direct cause of 429 storms
 *   under Yahoo rate-limiting.
 */
export function useMarketNodes(
  category: 'fx' | 'commodity' | 'index',
  pollInterval = MIN_POLL_MS,
  timeframe: '1D' | '5D' | '1M' | '3M' = '1D'
): UseMarketNodesState & { refetch: () => void; node: (id: string) => MarketNode | null } {

  const [state, setState] = useState<UseMarketNodesState>({
    data: null,
    isLoading: true,
    error: null,
    lastUpdated: null,
  })

  // ── Refs that carry runtime values without causing effect re-runs ──────────
  const pollRef      = useRef(Math.max(pollInterval, MIN_POLL_MS))
  pollRef.current    = Math.max(pollInterval, MIN_POLL_MS)   // updated every render, never triggers effect

  const timerRef     = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef     = useRef<AbortController | null>(null)
  const seqRef       = useRef(0)
  const mountedRef   = useRef(false)
  const consecErrRef = useRef(0)   // consecutive error counter for exponential back-off

  // ── fetchData stored in a ref so the timer callback always has the latest
  //    implementation without needing to appear in any dependency array.
  //    All state it touches comes from refs above.
  const fetchDataRef = useRef<() => Promise<void>>(async () => {})
  fetchDataRef.current = async () => {
    // Abort previous in-flight request; create fresh controller for this call
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    // Cancel any pending retry/poll timer so we don't double-schedule
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }

    const mySeq = ++seqRef.current

    // Flip isLoading only on cold start (no data yet) to suppress background shimmer
    setState(prev => ({ ...prev, isLoading: prev.data === null, error: null }))

    try {
      const url = `/api/market-nodes?category=${category}&timeframe=${timeframe}`
      const res = await fetch(url, {
        signal: ctrl.signal,
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
      })

      if (!res.ok) throw new Error(`API returned ${res.status}: ${res.statusText}`)

      const snapshot: MarketDataSnapshot = await res.json()

      // Discard stale response if a newer request already superseded this one
      if (mySeq !== seqRef.current || !mountedRef.current) return

      // Successful fetch — reset error counter and schedule next normal poll
      consecErrRef.current = 0
      setState({ data: snapshot, isLoading: false, error: null, lastUpdated: Date.now() })
      timerRef.current = setTimeout(() => fetchDataRef.current(), pollRef.current)

    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return  // intentional cancel

      if (mySeq !== seqRef.current || !mountedRef.current) return

      // Exponential back-off: double the interval for each consecutive failure,
      // capped at MAX_BACK_OFF_MS (5 min).  After MAX_CONSEC_ERR failures the
      // interval stays at the ceiling — we never stop retrying, but we stop
      // hammering the server with rapid 4xx/5xx responses.
      consecErrRef.current = Math.min(consecErrRef.current + 1, MAX_CONSEC_ERR)
      const backOffMs = Math.min(
        pollRef.current * Math.pow(2, consecErrRef.current - 1),
        MAX_BACK_OFF_MS
      )

      setState(prev => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      }))

      console.warn(
        `[useMarketNodes] ${category} fetch error #${consecErrRef.current}; ` +
        `retrying in ${Math.round(backOffMs / 1000)}s`
      )
      timerRef.current = setTimeout(() => fetchDataRef.current(), backOffMs)
    }
  }

  // ── Single effect — deps: [category, timeframe] ───────────────────────────
  // Runs on mount AND whenever category or timeframe changes.
  // Cleanup fires before each re-run, aborting in-flight requests and
  // clearing the poll timer so only one loop is ever active.
  useEffect(() => {
    mountedRef.current = true

    // Abort + clear leftovers from any prior effect invocation
    abortRef.current?.abort()
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }

    // New category/timeframe → fresh slate; don't carry over old error counts
    consecErrRef.current = 0

    fetchDataRef.current()

    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    }
  }, [category, timeframe]) // ← explicit, minimal, correct — no internal refs needed

  // ── Stable public API ─────────────────────────────────────────────────────
  const refetch = useCallback(() => { fetchDataRef.current() }, [])

  const getNode = useCallback(
    (id: string): MarketNode | null => state.data?.nodes[id] ?? null,
    [state.data]
  )

  return { ...state, refetch, node: getNode }
}


/**
 * useAllMarketNodes — fetches all three categories in parallel.
 * Same ref-based pattern; single [pollInterval] effect (category is fixed).
 */
export function useAllMarketNodes(
  pollInterval = MIN_POLL_MS
): UseMarketNodesState & {
  refetch: () => void
  byCategory: (cat: 'fx' | 'commodity' | 'index') => MarketDataSnapshot | null
  node: (id: string) => MarketNode | null
} {
  const [state, setState] = useState<
    UseMarketNodesState & { allData?: Record<string, MarketDataSnapshot> }
  >({
    data: null,
    allData: undefined,
    isLoading: true,
    error: null,
    lastUpdated: null,
  })

  const pollRef    = useRef(Math.max(pollInterval, MIN_POLL_MS))
  pollRef.current  = Math.max(pollInterval, MIN_POLL_MS)

  const timerRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef   = useRef<AbortController | null>(null)
  const seqRef     = useRef(0)
  const mountedRef = useRef(false)

  const fetchDataRef = useRef<() => Promise<void>>(async () => {})
  fetchDataRef.current = async () => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }

    const mySeq = ++seqRef.current
    setState(prev => ({ ...prev, isLoading: prev.data === null, error: null }))

    try {
      const fetchOpts = { signal: ctrl.signal, cache: 'no-store' as const }
      const [fxRes, commRes, idxRes] = await Promise.all([
        fetch('/api/market-nodes?category=fx',        fetchOpts),
        fetch('/api/market-nodes?category=commodity', fetchOpts),
        fetch('/api/market-nodes?category=index',     fetchOpts),
      ])

      if (!fxRes.ok || !commRes.ok || !idxRes.ok) {
        throw new Error('One or more market-nodes endpoints returned an error')
      }

      const [fxData, commData, idxData]: MarketDataSnapshot[] = await Promise.all([
        fxRes.json(), commRes.json(), idxRes.json(),
      ])

      if (mySeq !== seqRef.current || !mountedRef.current) return

      const mergedNodes: Record<string, MarketNode> = {}
      for (const snap of [fxData, commData, idxData]) Object.assign(mergedNodes, snap.nodes)

      setState({
        data: {
          timestamp: Date.now(),
          nodes: mergedNodes,
          health: {
            totalNodes:        Object.keys(mergedNodes).length,
            liveCount:         0,
            staleCount:        0,
            disconnectedCount: 0,
            healthPercent:     0,
          },
          sources: {
            alpaca: { healthy: true, lastSuccessMs: 0 },
            fred:   { healthy: true, lastSuccessMs: 0 },
          },
        },
        allData:     { fx: fxData, commodity: commData, index: idxData },
        isLoading:   false,
        error:       null,
        lastUpdated: Date.now(),
      })

      timerRef.current = setTimeout(() => fetchDataRef.current(), pollRef.current)

    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      if (mySeq !== seqRef.current || !mountedRef.current) return

      setState(prev => ({
        ...prev,
        isLoading: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      }))
      timerRef.current = setTimeout(() => fetchDataRef.current(), pollRef.current)
    }
  }

  useEffect(() => {
    mountedRef.current = true
    abortRef.current?.abort()
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    fetchDataRef.current()
    return () => {
      mountedRef.current = false
      abortRef.current?.abort()
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    }
  }, []) // pollInterval changes handled via ref — no restart needed

  const refetch = useCallback(() => { fetchDataRef.current() }, [])

  const getNode = useCallback(
    (id: string): MarketNode | null => state.data?.nodes[id] ?? null,
    [state.data]
  )
  const getCategoryData = useCallback(
    (cat: 'fx' | 'commodity' | 'index'): MarketDataSnapshot | null =>
      (state as any).allData?.[cat] ?? null,
    [state]
  )

  return { ...state, data: state.data, refetch, byCategory: getCategoryData, node: getNode }
}
