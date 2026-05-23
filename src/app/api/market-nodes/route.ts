import { NextRequest, NextResponse } from 'next/server'
import { fetchMarketData } from '@/lib/services/marketFetcher'
import type { MarketDataSnapshot } from '@/lib/types/market'

/**
 * Market Nodes API Route
 * ─────────────────────────────────────────────────────────────────
 * Server-side endpoint for the Market Data Abstraction Layer.
 *
 * Accepts category query parameter: 'fx' | 'commodity' | 'index'
 * Returns MarketDataSnapshot with liveness indicators and health metrics.
 *
 * URL: /api/market-nodes?category=fx
 */

export async function GET(request: NextRequest) {
  try {
    // Extract category and timeframe from query parameters
    const { searchParams } = new URL(request.url)
    const category = searchParams.get('category')?.toLowerCase()
    const timeframe = searchParams.get('timeframe')?.toUpperCase() || '1D'

    // Validate category parameter
    if (!category || !['fx', 'commodity', 'index'].includes(category as any)) {
      return NextResponse.json(
        {
          error: 'Invalid or missing category parameter',
          message: 'Must provide category=fx, category=commodity, or category=index',
        },
        { status: 400 }
      )
    }

    // Validate timeframe parameter
    if (!['1D', '5D', '1M', '3M'].includes(timeframe)) {
      return NextResponse.json(
        {
          error: 'Invalid timeframe parameter',
          message: 'Must provide timeframe=1D, 5D, 1M, or 3M',
        },
        { status: 400 }
      )
    }

    // Fetch market data server-side (no CORS issues, direct Node.js runtime)
    const snapshot = await fetchMarketData(category as 'fx' | 'commodity' | 'index', timeframe as '1D' | '5D' | '1M' | '3M')

    // Return unified MarketDataSnapshot structure
    return NextResponse.json<MarketDataSnapshot>(snapshot, {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
        'Content-Type': 'application/json',
      },
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[market-nodes-api] Error:', message)

    return NextResponse.json(
      {
        error: 'Failed to fetch market data',
        message,
      },
      { status: 500 }
    )
  }
}
