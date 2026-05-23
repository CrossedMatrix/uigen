/**
 * Market Data Fetcher Service
 * Orchestrates data fetching, liveness calculation, and data source fallback logic
 */

import type {
  MarketNode,
  LivenessStatus,
  LivenessMetrics,
  MarketDataSnapshot,
  LivenessContext,
} from '@/lib/types/market'
import { MARKET_REGISTRY, getYahooSymbolsByCategory } from '@/lib/config/marketRegistry'
import { fetchConsolidatedMarketQuotes, fetchHistoricalChart, type HistoricalCandle } from './yahoo-finance-fx'

// ─── Market Hours & Holidays ──────────────────────────────────────────────────

interface MarketStatus {
  isOpen: boolean
  nextOpenMs: number
  nextCloseMs: number
}

/**
 * Determine if market is currently open based on timezone-aware calculation
 */
function calculateMarketStatus(nowDate: Date): MarketStatus {
  // Use America/New_York for all market hours (standard US market time)
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })

  const parts = formatter.formatToParts(nowDate)
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? 'Mon'
  const hour = parseInt(parts.find(p => p.type === 'hour')?.value ?? '0', 10)
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10)

  // Map weekday to number: 0=Sunday, 1=Monday, ..., 6=Saturday
  const dayNum = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday)
  const minuteOfDay = hour * 60 + minute

  // US Equity Markets: Mon-Fri 9:30 AM - 4:00 PM ET (570-960 minutes)
  const equityOpen = [1, 2, 3, 4, 5].includes(dayNum) && minuteOfDay >= 570 && minuteOfDay < 960

  // FX Markets: 24/5 (Sun 5pm ET - Fri 5pm ET)
  // Close Fri 5pm (1700 = 1020 min), reopen Sun 5pm (1700 = 1020 min next day)
  const isFridayOrLater = [5, 6].includes(dayNum)
  const isSunOrEarlier = [0, 1, 2, 3, 4].includes(dayNum)

  const fxOpen =
    (isFridayOrLater && dayNum === 5 && minuteOfDay < 1020) || // Fri before 5pm
    (isSunOrEarlier && dayNum !== 6) // Sun-Fri

  const isOpen = equityOpen || fxOpen

  // TODO: Calculate nextOpenMs and nextCloseMs based on market hours
  return {
    isOpen,
    nextOpenMs: 0,
    nextCloseMs: 0,
  }
}

// ─── Liveness Calculator ─────────────────────────────────────────────────────

/**
 * Determine liveness status based on data age and market state
 * LIVE_INTRADAY: <5 min old, market is active
 * MARKET_CLOSED_STALE: Market is closed, but data is from last close
 * FEED_DISCONNECTED: Data is very old (>30 min) or API errors
 */
export function calculateLiveness(
  lastUpdateMs: number,
  maxAgeMs: number,
  context: LivenessContext,
  feedHealthPercent: number
): LivenessStatus {
  const nowMs = context.nowMs
  const ageMs = nowMs - lastUpdateMs
  const ageSeconds = Math.round(ageMs / 1000)

  // Threshold: if data is >30 min old or feed health is critical, mark disconnected
  if (ageMs > 1_800_000 || feedHealthPercent < 20) {
    return 'FEED_DISCONNECTED'
  }

  // If market is closed and data is from before close, mark as stale (but not disconnected)
  if (!context.marketOpenState.isOpen && ageMs > maxAgeMs) {
    return 'MARKET_CLOSED_STALE'
  }

  // If data is fresh and market is open, mark as live
  if (context.marketOpenState.isOpen && ageMs < 300_000) {
    // <5 min
    return 'LIVE_INTRADAY'
  }

  // If data is reasonably fresh but market just closed
  if (!context.marketOpenState.isOpen && ageMs <= maxAgeMs) {
    return 'LIVE_INTRADAY' // Still fresh from last intraday
  }

  // Default: stale
  return 'MARKET_CLOSED_STALE'
}

/**
 * Generate human-readable status message
 */
function getLivenessMessage(
  status: LivenessStatus,
  ageSeconds: number,
  isMarketOpen: boolean
): string {
  switch (status) {
    case 'LIVE_INTRADAY':
      if (ageSeconds < 60) return `🟢 Live (${ageSeconds}s ago)`
      if (ageSeconds < 300) return `🟢 Live (${Math.round(ageSeconds / 60)}m ago)`
      return '🟢 Live'

    case 'MARKET_CLOSED_STALE':
      if (isMarketOpen) return `⚠️ Market open but data stale (${Math.round(ageSeconds / 60)}m)`
      return `🕐 Market closed (last: ${Math.round(ageSeconds / 60)}m ago)`

    case 'FEED_DISCONNECTED':
      return `🔴 Feed disconnected (${Math.round(ageSeconds / 60)}m stale)`

    default:
      return 'Unknown status'
  }
}

// ─── Market Data Builder ──────────────────────────────────────────────────────

/**
 * Build a MarketNode from raw data and liveness calculation
 */
export function buildMarketNode(
  marketId: string,
  price: number,
  change: number,
  changePercent: number,
  timestamp: number,
  context: LivenessContext,
  feedHealthPercent: number,
  dataSource: 'yahoo' | 'fred' | 'fallback' = 'yahoo',
  sparkline?: number[]
): MarketNode | null {
  const config = MARKET_REGISTRY[marketId]
  if (!config) {
    console.warn(`[marketFetcher] Unknown market ID: ${marketId}`)
    return null
  }

  const lastUpdateMs = timestamp
  const ageSeconds = Math.round((context.nowMs - lastUpdateMs) / 1000)
  const maxAgeMs = config.primarySource.maxAgeMs

  const status = calculateLiveness(lastUpdateMs, maxAgeMs, context, feedHealthPercent)
  const message = getLivenessMessage(status, ageSeconds, context.marketOpenState.isOpen)

  const liveness: LivenessMetrics = {
    status,
    lastUpdateMs,
    ageSeconds,
    isMarketOpen: context.marketOpenState.isOpen,
    feedHealthPercent,
    dataSource,
    message,
  }

  return {
    id: marketId,
    displayName: config.displayName,
    category: config.category,
    sources: [
      {
        type: config.primarySource.type,
        symbol: config.primarySource.symbol,
        priority: 1,
        refreshIntervalMs: config.primarySource.refreshIntervalMs,
        maxAgeMs: config.primarySource.maxAgeMs,
        lastSuccessMs: timestamp,
      },
      ...(config.secondarySource
        ? [
            {
              type: config.secondarySource.type,
              symbol: config.secondarySource.symbol,
              priority: 2,
              refreshIntervalMs: config.secondarySource.refreshIntervalMs,
              maxAgeMs: config.secondarySource.maxAgeMs,
              lastSuccessMs: timestamp,
            },
          ]
        : []),
    ],
    price,
    change,
    changePercent,
    timestamp,
    sparkline,
    liveness,
    decimals: config.decimals,
    unit: config.unit,
    exchangeCode: config.exchangeCode,
  }
}

// ─── Main Fetcher Function ────────────────────────────────────────────────────

interface RawQuote {
  symbol: string
  regularMarketPrice: number
  regularMarketChange: number
  regularMarketChangePercent: number
  regularMarketTime?: number
}

/**
 * Calculate current and historical prices from candle array
 * Handles timeframe-aware indexing and weekend fallback
 * All prices derive from real market data (candles), never from static fallbacks
 */
function calculatePriceMetrics(
  yahooSymbol: string,
  candles: HistoricalCandle[],
  timeframe: '1D' | '5D' | '1M' | '3M',
  liveQuote?: RawQuote
): { currentPrice: number; historicalPrice: number; isWeekendFallback: boolean } {
  // Prefer live quote price, fall back to latest candle close for weekends
  const currentPrice = liveQuote ? liveQuote.regularMarketPrice : (candles[0]?.close ?? 0)
  const isWeekendFallback = !liveQuote || (liveQuote.regularMarketChangePercent === 0 && candles.length > 0)

  // Timeframe-aware historical index offsets
  const indexOffset: Record<'1D' | '5D' | '1M' | '3M', number> = {
    '1D': 1,
    '5D': 5,
    '1M': 22,
    '3M': 64,
  }

  const offset = indexOffset[timeframe]
  const historicalIndex = Math.min(offset, candles.length - 1)
  const historicalPrice = candles[historicalIndex]?.close ?? currentPrice

  return { currentPrice, historicalPrice, isWeekendFallback }
}

/**
 * Main entry point: Fetch market data for a category
 * Orchestrates Yahoo Finance fetching and liveness calculation
 *
 * @param category - Market category: fx, commodity, or index
 * @param timeframe - Historical timeframe: 1D (default), 5D, 1M, 3M
 *   For 1D: uses standard day-over-day change
 *   For 5D+: calculates change relative to historical close from X days ago
 */
export async function fetchMarketData(
  category: 'fx' | 'commodity' | 'index',
  timeframe: '1D' | '5D' | '1M' | '3M' = '1D'
): Promise<MarketDataSnapshot> {
  const startTime = Date.now()
  const nowMs = Date.now()

  // Determine days back for historical comparison
  const daysBack = timeframe === '5D' ? 5 : timeframe === '1M' ? 30 : timeframe === '3M' ? 90 : 1

  // Get market configuration for this category
  const marketConfigs = Object.entries(MARKET_REGISTRY).filter(
    ([_, config]) => config.category === category
  )

  // Get Yahoo symbols
  const yahooSymbols = marketConfigs
    .filter(([_, config]) => config.primarySource.type === 'yahoo-finance')
    .map(([_, config]) => config.primarySource.symbol)

  // Fetch from Yahoo Finance (consolidated batch request to reduce rate limiting)
  let yahooData: Map<string, RawQuote> = new Map()
  let yahooHealthPercent = 0
  let yahooLastSuccessMs = 0
  let yahooError: string | undefined
  let usingFallback = false

  try {
    // Use consolidated batch fetch (single HTTP request for all symbols in category)
    const result = await fetchConsolidatedMarketQuotes(yahooSymbols)

    // Convert MarketDataPoint to RawQuote format (ONLY for live yahoo-finance data, NOT fallback)
    result.forEach((point, symbol) => {
      // CRITICAL: Only include live Yahoo Finance quotes, reject fallback prices
      // Fallback prices corrupt dashboard (old prices like $3291 for Gold, $61 for WTI)
      // Instead use candles array for all price calculations
      if (point.dataSource === 'yahoo-finance') {
        yahooData.set(symbol, {
          symbol,
          regularMarketPrice: point.price,
          regularMarketChange: point.change,
          regularMarketChangePercent: point.changePercent,
          regularMarketTime: Math.floor(point.timestamp / 1000),
        })
      } else {
        // Fallback data: don't add to yahooData, force use of candles array
        usingFallback = true
        console.debug(`[marketFetcher] Skipping fallback price for ${symbol}, will use candles instead`)
      }
    })

    // Health percentage: 100 if all live, 50 if mixed/fallback, 0 if none
    if (yahooData.size > 0) {
      const liveCount = Array.from(result.values()).filter(p => p.dataSource === 'yahoo-finance').length
      yahooHealthPercent = liveCount === yahooSymbols.length ? 100 : (liveCount > 0 ? 50 : 20)
    } else {
      yahooHealthPercent = 0
    }

    yahooLastSuccessMs = Date.now()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`[marketFetcher] Consolidated fetch error: ${msg}`)
    yahooError = msg
    yahooHealthPercent = 0
    usingFallback = true
  }

  // Build market state context
  const marketStatus = calculateMarketStatus(new Date(nowMs))
  const livenessContext: LivenessContext = {
    nowMs,
    marketOpenState: marketStatus,
    feedHealthPercent: yahooHealthPercent,
  }

  // Build MarketNode for each market
  const nodes: Record<string, MarketNode> = {}
  let liveCount = 0
  let staleCount = 0
  let disconnectedCount = 0

  // Prefetch historical data for timeframe change calculations
  // CRITICAL: All prices derive from candles array, NO hardcoded fallbacks
  const candleDataCache: Record<string, HistoricalCandle[]> = {}
  let usingWeekendFallback = false

  // Always fetch historical data (needed for all timeframe calculations and weekend fallback)
  // CRITICAL: Fetch candles for ALL symbols, not just ones with live quotes
  // When Yahoo returns fallback data, we DON'T add it to yahooData, so we MUST have candles for price calculation
  const yahooRange = timeframe === '5D' ? '5d' : timeframe === '1M' ? '1mo' : '3mo'
  const symbolsNeedingHistory = yahooSymbols // Use original symbol list, not filtered yahooData.keys()

  if (symbolsNeedingHistory.length > 0) {
    console.info(`[marketFetcher] Fetching historical candles (${timeframe}/${yahooRange}) for ${symbolsNeedingHistory.length} symbols`)

    // Fetch historical data for each symbol in parallel
    const historyPromises = symbolsNeedingHistory.map(async symbol => {
      try {
        const candles = await fetchHistoricalChart(symbol, yahooRange)

        if (candles.length === 0) {
          console.warn(`[marketFetcher] No valid candles for ${symbol}`)
          candleDataCache[symbol] = []
          return
        }

        // Store full candle array for price calculation
        candleDataCache[symbol] = candles

        // Candles array format: descending chronological (newest first)
        // Index 0 = newest, Index length-1 = oldest
        const newestCandle = candles[0]
        const latestCandle = candles[candles.length - 1]  // Absolute oldest in range

        console.debug(
          `[marketFetcher] ${symbol}: fetched ${candles.length} candles | ` +
          `newest=${newestCandle.close.toFixed(2)} oldest=${latestCandle.close.toFixed(2)}`
        )
      } catch (err) {
        console.warn(`[marketFetcher] Failed to fetch history for ${symbol}:`, err instanceof Error ? err.message : String(err))
        candleDataCache[symbol] = []
      }
    })

    await Promise.all(historyPromises)
    const successCount = Object.keys(candleDataCache).filter(k => candleDataCache[k].length > 0).length
    console.info(`[marketFetcher] Successfully fetched ${successCount}/${symbolsNeedingHistory.length} symbols`)
  }

  for (const [marketId, config] of marketConfigs) {
    const yahooSymbol = config.primarySource.symbol
    const quote = yahooData.get(yahooSymbol)
    const candles = candleDataCache[yahooSymbol] ?? []

    // Use candles + quote to calculate prices (no FALLBACK_QUOTES)
    if (candles.length > 0 || quote) {
      const { currentPrice, historicalPrice, isWeekendFallback } = calculatePriceMetrics(
        yahooSymbol,
        candles,
        timeframe,
        quote
      )

      const displayChange = currentPrice - historicalPrice
      const displayChangePercent =
        historicalPrice > 0 ? parseFloat(((displayChange / historicalPrice) * 100).toFixed(4)) : 0

      // Adjust liveness context for weekend fallback
      let adjustedContext = livenessContext
      if (isWeekendFallback) {
        adjustedContext = {
          ...livenessContext,
          marketOpenState: { isOpen: false, nextOpenMs: 0, nextCloseMs: 0 },
        }
      }

      const node = buildMarketNode(
        marketId,
        currentPrice,
        displayChange,
        displayChangePercent,
        nowMs,
        adjustedContext,
        quote ? yahooHealthPercent : 20,
        quote ? 'yahoo' : 'fallback'
      )

      if (node) {
        nodes[marketId] = node

        if (node.liveness.status === 'LIVE_INTRADAY') liveCount++
        else if (node.liveness.status === 'MARKET_CLOSED_STALE') staleCount++
        else if (node.liveness.status === 'FEED_DISCONNECTED') disconnectedCount++

        console.debug(
          `[marketFetcher] ${marketId} (${timeframe}): ` +
            `${historicalPrice.toFixed(4)} → ${currentPrice.toFixed(4)} = ${displayChangePercent.toFixed(2)}% ` +
            `${isWeekendFallback ? '[WEEKEND]' : ''}`
        )
      }

      if (isWeekendFallback) {
        usingWeekendFallback = true
      }
    } else {
      // No data available at all — create disconnected node
      const node = buildMarketNode(
        marketId,
        0,
        0,
        0,
        nowMs,
        livenessContext,
        0,
        'fallback'
      )

      if (node) {
        nodes[marketId] = node
        disconnectedCount++
        console.warn(`[marketFetcher] No data available for ${yahooSymbol}`)
      }
    }
  }

  const totalNodes = Object.keys(nodes).length
  const healthPercent =
    totalNodes > 0 ? ((liveCount + staleCount) / totalNodes) * 100 : 0

  const elapsed = Date.now() - startTime
  const weekendNote = usingWeekendFallback ? ' [WEEKEND: Using historical candle closes]' : ''
  console.info(
    `[marketFetcher] Fetched ${category} (${timeframe}) in ${elapsed}ms | ` +
      `Live: ${liveCount}, Stale: ${staleCount}, Disconnected: ${disconnectedCount}${weekendNote}`
  )

  return {
    timestamp: nowMs,
    nodes,
    health: {
      totalNodes,
      liveCount,
      staleCount,
      disconnectedCount,
      healthPercent,
    },
    sources: {
      yahoo: {
        healthy: yahooHealthPercent >= 80,
        lastSuccessMs: yahooLastSuccessMs,
        errorMsg: yahooError,
      },
      fred: {
        healthy: true, // Not used in this implementation yet
        lastSuccessMs: 0,
      },
    },
  }
}

/**
 * Fetch data for multiple categories in parallel
 *
 * @param timeframes - Optional timeframe overrides per category
 */
export async function fetchAllMarketData(
  timeframes?: { fx?: '1D' | '5D' | '1M' | '3M'; commodity?: '1D' | '5D' | '1M' | '3M'; index?: '1D' | '5D' | '1M' | '3M' }
): Promise<Record<string, MarketDataSnapshot>> {
  const [fxData, commodityData, indexData] = await Promise.all([
    fetchMarketData('fx', timeframes?.fx ?? '1D'),
    fetchMarketData('commodity', timeframes?.commodity ?? '1D'),
    fetchMarketData('index', timeframes?.index ?? '1D'),
  ])

  return {
    fx: fxData,
    commodity: commodityData,
    index: indexData,
  }
}
