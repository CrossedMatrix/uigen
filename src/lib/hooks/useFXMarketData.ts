'use client'

import { useState, useEffect } from 'react'
import type { FXMarketDataResponse, FXDataWithValidation } from '@/lib/types/fx-market-data'

export interface UseFXMarketDataState {
  data: FXMarketDataResponse | null
  isLoading: boolean
  error: string | null
  lastUpdated: number | null
  validationHealthy: boolean
}

/**
 * Hook to fetch and manage FX market data with validation
 * Integrates FRED macro data with Yahoo Finance live spot rates
 * and validation engine to detect staleness and variance anomalies
 *
 * Usage:
 * const { data, isLoading, error, validationHealthy } = useFXMarketData(5 * 60_000)
 *
 * @param pollInterval Milliseconds between fetches (default 5 minutes)
 */
export function useFXMarketData(pollInterval = 5 * 60_000): UseFXMarketDataState {
  const [state, setState] = useState<UseFXMarketDataState>({
    data: null,
    isLoading: true,
    error: null,
    lastUpdated: null,
    validationHealthy: false,
  })

  useEffect(() => {
    let isMounted = true
    let timeoutId: ReturnType<typeof setTimeout>

    const fetchData = async () => {
      try {
        setState(prev => ({
          ...prev,
          isLoading: true,
          error: null,
        }))

        const res = await fetch('/api/fx-market', {
          cache: 'no-store',
        })

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`)
        }

        const data: FXMarketDataResponse = await res.json()

        if (isMounted) {
          const isHealthy = data.validationHealth.healthPercentage >= 75

          setState({
            data,
            isLoading: false,
            error: null,
            lastUpdated: Date.now(),
            validationHealthy: isHealthy,
          })

          // Schedule next fetch
          timeoutId = setTimeout(fetchData, pollInterval)
        }
      } catch (err) {
        if (isMounted) {
          const errorMsg =
            err instanceof Error ? err.message : 'Unknown error fetching FX data'

          setState(prev => ({
            ...prev,
            isLoading: false,
            error: errorMsg,
          }))

          // Retry after shorter interval on error
          timeoutId = setTimeout(fetchData, Math.min(pollInterval, 30000))
        }
      }
    }

    // Initial fetch
    fetchData()

    return () => {
      isMounted = false
      if (timeoutId) clearTimeout(timeoutId)
    }
  }, [pollInterval])

  return state
}

/**
 * Hook to get a specific FX pair with validation details
 *
 * Usage:
 * const eurUSD = useFXPair(data, 'EURUSD=X')
 */
export function useFXPair(
  data: FXMarketDataResponse | null,
  yahooSymbol: string
): FXDataWithValidation | null {
  if (!data) return null
  return data.pairs.find(p => p.symbol === yahooSymbol) ?? null
}

/**
 * Get human-readable validation status message
 */
export function getValidationStatusMessage(status: string): string {
  const messages: Record<string, string> = {
    'OK': '✅ Data validated and fresh',
    'STALE_MACRO': '⚠️ FRED data is older than 24h, but prices align',
    'VALIDATION_MISMATCH': '⚠️ >0.5% variance detected between FRED and Yahoo',
    'MISSING_YAHOO': '⚠️ Yahoo Finance data unavailable, using FRED',
    'MISSING_FRED': '⚠️ FRED data unavailable, using Yahoo',
  }
  return messages[status] || 'Unknown status'
}

/**
 * Get recommendation badge color
 */
export function getRecommendationColor(recommendation: string): string {
  if (recommendation.includes('yahoo')) {
    return '#34d399' // Green - use live Yahoo data
  }
  if (recommendation.includes('warning')) {
    return '#fbbf24' // Amber - use with caution
  }
  return '#60a5fa' // Blue - use FRED
}
