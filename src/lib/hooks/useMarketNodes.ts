'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import type { MarketNode, MarketDataSnapshot } from '@/lib/types/market'

export interface UseMarketNodesState {
  data: MarketDataSnapshot | null
  isLoading: boolean
  error: string | null
  lastUpdated: number | null
}

/**
 * Hook to fetch market data for a specific category
 * Automatically polls based on refresh intervals from market registry
 *
 * Usage:
 * const { data, isLoading } = useMarketNodes('fx', 30000, '1D')
 */
export function useMarketNodes(
  category: 'fx' | 'commodity' | 'index',
  pollInterval = 30000,
  timeframe: '1D' | '5D' | '1M' | '3M' = '1D'
): UseMarketNodesState & { refetch: () => Promise<void>; node: (id: string) => MarketNode | null } {
  const [state, setState] = useState<UseMarketNodesState>({
    data: null,
    isLoading: true,
    error: null,
    lastUpdated: null,
  })

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMountedRef = useRef(true)

  const fetchData = useCallback(async () => {
    try {
      setState(prev => ({ ...prev, isLoading: true, error: null }))

      // Fetch from server-side API endpoint to avoid CORS issues
      const response = await fetch(`/api/market-nodes?category=${category}&timeframe=${timeframe}`, {
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
      })

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${response.statusText}`)
      }

      const snapshot = await response.json()

      if (isMountedRef.current) {
        setState({
          data: snapshot,
          isLoading: false,
          error: null,
          lastUpdated: Date.now(),
        })

        // Schedule next fetch
        timeoutRef.current = setTimeout(fetchData, pollInterval)
      }
    } catch (err) {
      if (isMountedRef.current) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: errorMsg,
        }))

        // Retry after shorter interval on error
        timeoutRef.current = setTimeout(fetchData, Math.min(pollInterval, 10000))
      }
    }
  }, [category, pollInterval, timeframe])

  useEffect(() => {
    isMountedRef.current = true
    fetchData()

    return () => {
      isMountedRef.current = false
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [fetchData])

  const getNode = useCallback(
    (id: string): MarketNode | null => {
      return state.data?.nodes[id] ?? null
    },
    [state.data]
  )

  return {
    ...state,
    refetch: fetchData,
    node: getNode,
  }
}

/**
 * Hook to fetch all market data across categories
 * Useful for dashboards that show multiple categories
 */
export function useAllMarketNodes(
  pollInterval = 30000
): UseMarketNodesState & {
  refetch: () => Promise<void>
  byCategory: (cat: 'fx' | 'commodity' | 'index') => MarketDataSnapshot | null
  node: (id: string) => MarketNode | null
} {
  const [state, setState] = useState<UseMarketNodesState & { allData?: Record<string, MarketDataSnapshot> }>({
    data: null,
    allData: undefined,
    isLoading: true,
    error: null,
    lastUpdated: null,
  })

  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMountedRef = useRef(true)

  const fetchData = useCallback(async () => {
    try {
      setState(prev => ({ ...prev, isLoading: true, error: null }))

      // Fetch all three categories in parallel from server-side API endpoints
      const [fxRes, commodityRes, indexRes] = await Promise.all([
        fetch('/api/market-nodes?category=fx', {
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
        }),
        fetch('/api/market-nodes?category=commodity', {
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
        }),
        fetch('/api/market-nodes?category=index', {
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
        }),
      ])

      if (!fxRes.ok || !commodityRes.ok || !indexRes.ok) {
        throw new Error('One or more API endpoints returned an error')
      }

      const [fxData, commodityData, indexData] = await Promise.all([
        fxRes.json(),
        commodityRes.json(),
        indexRes.json(),
      ])

      const allData = {
        fx: fxData,
        commodity: commodityData,
        index: indexData,
      }

      if (isMountedRef.current) {
        // Merge all data into a single snapshot for compatibility
        const mergedNodes: Record<string, MarketNode> = {}
        Object.values(allData).forEach(snapshot => {
          Object.assign(mergedNodes, snapshot.nodes)
        })

        setState({
          data: {
            timestamp: Date.now(),
            nodes: mergedNodes,
            health: {
              totalNodes: Object.keys(mergedNodes).length,
              liveCount: 0,
              staleCount: 0,
              disconnectedCount: 0,
              healthPercent: 0,
            },
            sources: {
              yahoo: { healthy: true, lastSuccessMs: 0 },
              fred: { healthy: true, lastSuccessMs: 0 },
            },
          },
          allData,
          isLoading: false,
          error: null,
          lastUpdated: Date.now(),
        })

        timeoutRef.current = setTimeout(fetchData, pollInterval)
      }
    } catch (err) {
      if (isMountedRef.current) {
        const errorMsg = err instanceof Error ? err.message : 'Unknown error'
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: errorMsg,
        }))

        timeoutRef.current = setTimeout(fetchData, Math.min(pollInterval, 10000))
      }
    }
  }, [pollInterval])

  useEffect(() => {
    isMountedRef.current = true
    fetchData()

    return () => {
      isMountedRef.current = false
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [fetchData])

  const getNode = useCallback(
    (id: string): MarketNode | null => {
      return state.data?.nodes[id] ?? null
    },
    [state.data]
  )

  const getCategoryData = useCallback(
    (cat: 'fx' | 'commodity' | 'index'): MarketDataSnapshot | null => {
      return state.allData?.[cat] ?? null
    },
    [state.allData]
  )

  return {
    ...state,
    data: state.data,
    refetch: fetchData,
    byCategory: getCategoryData,
    node: getNode,
  }
}
