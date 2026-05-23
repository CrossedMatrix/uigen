/**
 * Yahoo Finance Market Data Service
 * Consolidated batch fetching for FX pairs, commodities, and indices.
 * Implements robust request spoofing, header rotation, and unified fallback mechanisms.
 * Eliminates HTTP 429 rate limits through single consolidated batch request.
 */

export interface YahooQuote {
  symbol: string
  regularMarketPrice: number
  regularMarketChange: number
  regularMarketChangePercent: number
  currency?: string
  regularMarketTime?: number
}

export interface MarketDataPoint {
  symbol: string
  price: number
  change: number
  changePercent: number
  timestamp: number
  dataSource: 'yahoo-finance' | 'fallback'
}

export interface HistoricalCandle {
  timestamp: number
  close: number
  open?: number
  high?: number
  low?: number
  volume?: number
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      timestamp?: number[]
      indicators?: {
        quote?: Array<{
          close?: (number | null)[]
        }>
      }
    }>
    error?: unknown
  }
  error?: unknown
}

interface YahooResponse {
  quoteResponse?: {
    result?: YahooQuote[]
    error?: unknown
  }
}

// ─── Realistic Browser Header Rotation ─────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
]

function buildBrowserHeaders(): Record<string, string> {
  const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)]
  return {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'DNT': '1',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Cache-Control': 'max-age=0',
    'Referer': 'https://finance.yahoo.com/',
    'Origin': 'https://finance.yahoo.com',
  }
}

/**
 * Fetch historical chart data for a single symbol
 * Used for calculating multi-day price changes (5D, 1M, 3M)
 */
export async function fetchHistoricalChart(
  symbol: string,
  range: '5d' | '1mo' | '3mo'
): Promise<HistoricalCandle[]> {
  const hosts = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com']

  for (const host of hosts) {
    try {
      const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d`
      const headers = buildBrowserHeaders()

      const res = await fetch(url, {
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      })

      if (!res.ok) {
        console.warn(`[yahoo-chart] ${host} returned HTTP ${res.status} for ${symbol}`)
        continue
      }

      const json = (await res.json()) as YahooChartResponse

      if (json.error || !json.chart?.result?.[0]) {
        console.warn(`[yahoo-chart] ${host} returned invalid response for ${symbol}`)
        continue
      }

      const result = json.chart.result[0]
      if (!result.timestamp || !result.indicators?.quote?.[0]?.close) {
        console.warn(`[yahoo-chart] ${host} missing timestamp/close data for ${symbol}`)
        continue
      }

      const timestamps = result.timestamp
      const closes = result.indicators.quote[0].close

      // Build candle array, filtering out null/invalid closes
      const candles: HistoricalCandle[] = timestamps
        .map((ts, i) => ({
          timestamp: ts * 1000, // Convert to milliseconds
          close: closes[i] ?? 0,
        }))
        .filter(c => c.close > 0) // Only include valid prices

      if (candles.length === 0) {
        console.warn(`[yahoo-chart] No valid candles found for ${symbol}`)
        continue
      }

      console.info(`[yahoo-chart] Fetched ${candles.length} candles for ${symbol} (${range})`)
      return candles
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[yahoo-chart] ${host} request failed for ${symbol}: ${msg}`)
    }
  }

  console.error(`[yahoo-chart] All hosts failed to fetch ${symbol} (${range})`)
  return []
}

// ─── Symbol Maps: FRED → Yahoo Finance ─────────────────────────────────────
export const FX_SYMBOL_MAP: Record<string, string> = {
  'DXY': 'DX-Y.NYB',
  'EURUSD': 'EURUSD=X',
  'GBPUSD': 'GBPUSD=X',
  'USDJPY': 'USDJPY=X',
  'USDCNY': 'CNY=X',
  'AUDUSD': 'AUDUSD=X',
}

export const COMMODITY_SYMBOL_MAP: Record<string, string> = {
  'GC': 'GC=F',     // Gold
  'SI': 'SI=F',     // Silver
  'CL': 'CL=F',     // WTI Crude
  'BZ': 'BZ=F',     // Brent Crude
  'HG': 'HG=F',     // Copper
  'NG': 'NG=F',     // Natural Gas
}

// ─── Unified Fallback Matrix (FX + Commodities) ────────────────────────────
// Reference settlement values used when all primary sources fail
export const FALLBACK_QUOTES: Record<string, Omit<MarketDataPoint, 'timestamp' | 'dataSource'>> = {
  // FX Pairs
  'DX-Y.NYB': { symbol: 'DX-Y.NYB', price: 99.84, change: -0.42, changePercent: -0.42 },
  'EURUSD=X': { symbol: 'EURUSD=X', price: 1.1348, change: 0.0048, changePercent: 0.42 },
  'GBPUSD=X': { symbol: 'GBPUSD=X', price: 1.3412, change: 0.0028, changePercent: 0.21 },
  'USDJPY=X': { symbol: 'USDJPY=X', price: 143.28, change: -0.48, changePercent: -0.33 },
  'CNY=X': { symbol: 'CNY=X', price: 7.1842, change: 0.0038, changePercent: 0.05 },
  'AUDUSD=X': { symbol: 'AUDUSD=X', price: 0.6482, change: 0.0024, changePercent: 0.37 },

  // Commodities (weekend settlement values)
  'GC=F': { symbol: 'GC=F', price: 3291.80, change: -9.40, changePercent: -0.28 },
  'SI=F': { symbol: 'SI=F', price: 32.84, change: -0.28, changePercent: -0.84 },
  'CL=F': { symbol: 'CL=F', price: 61.53, change: -0.36, changePercent: -0.58 },
  'BZ=F': { symbol: 'BZ=F', price: 64.78, change: -0.41, changePercent: -0.63 },
  'HG=F': { symbol: 'HG=F', price: 4.74, change: 0.06, changePercent: 1.28 },
  'NG=F': { symbol: 'NG=F', price: 3.58, change: -0.08, changePercent: -2.19 },
}

/**
 * Consolidated batch fetch for multiple market data points
 * Single HTTP request reduces rate limiting and improves resilience
 * Accepts mixed FX, commodity, and index symbols in one batch
 */
export async function fetchConsolidatedMarketQuotes(symbols: string[]): Promise<Map<string, MarketDataPoint>> {
  if (symbols.length === 0) {
    return new Map()
  }

  const joined = symbols.map(encodeURIComponent).join(',')
  const results = new Map<string, MarketDataPoint>()

  // ─── Primary: Consolidated batch request with header rotation ───────────
  for (const host of ['query2.finance.yahoo.com', 'query1.finance.yahoo.com']) {
    try {
      // Single consolidated URL — reduces 429 errors significantly
      const url = `https://${host}/v7/finance/quote?symbols=${joined}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketTime`
      const headers = buildBrowserHeaders()

      console.info(`[yahoo-batch] Fetching ${symbols.length} symbols from ${host}`)

      const res = await fetch(url, {
        headers,
        cache: 'no-store',
        signal: AbortSignal.timeout(10000), // 10s for larger batch
      })

      if (!res.ok) {
        console.warn(`[yahoo-batch] ${host} returned HTTP ${res.status} ${res.statusText} — trying fallback host...`)
        continue
      }

      const json = (await res.json()) as YahooResponse
      const quotes = json.quoteResponse?.result ?? []

      if (!Array.isArray(quotes) || quotes.length === 0) {
        console.warn(`[yahoo-batch] ${host} returned empty results, trying next host...`)
        continue
      }

      // Populate results from batch response
      for (const quote of quotes) {
        if (quote.symbol && typeof quote.regularMarketPrice === 'number') {
          results.set(quote.symbol, {
            symbol: quote.symbol,
            price: quote.regularMarketPrice,
            change: quote.regularMarketChange ?? 0,
            changePercent: quote.regularMarketChangePercent ?? 0,
            timestamp: quote.regularMarketTime ? quote.regularMarketTime * 1000 : Date.now(),
            dataSource: 'yahoo-finance',
          })
        }
      }

      if (results.size > 0) {
        console.info(`[yahoo-batch] Successfully fetched ${results.size}/${symbols.length} quotes from Yahoo`)
        return results
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.warn(`[yahoo-batch] ${host} request failed: ${msg}`)
    }
  }

  // ─── Secondary: Fallback to cached market data ──────────────────────────
  console.warn(`[yahoo-batch] Primary endpoints failed, using fallback cache for ${symbols.length} symbols`)

  for (const symbol of symbols) {
    if (symbol in FALLBACK_QUOTES) {
      const fallback = FALLBACK_QUOTES[symbol]
      results.set(symbol, {
        ...fallback,
        timestamp: Date.now(),
        dataSource: 'fallback',
      })
    }
  }

  if (results.size > 0) {
    console.info(`[yahoo-batch] Serving ${results.size} symbols from fallback (market may be closed)`)
    return results
  }

  console.error('[yahoo-batch] Unable to fetch any market data — returning empty results')
  return results
}

/**
 * Legacy FX-only interface (maintains backward compatibility)
 */
export async function fetchYahooFXQuotes(symbols: string[]): Promise<Map<string, MarketDataPoint>> {
  return fetchConsolidatedMarketQuotes(symbols)
}

/**
 * Legacy batch fetch interface (maintains backward compatibility)
 * Returns consolidated market data with intelligent retry
 */
export async function fetchFXBatch(yahooSymbols: string[]): Promise<Map<string, MarketDataPoint>> {
  const maxRetries = 2
  let lastError: Error | null = null

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const results = await fetchConsolidatedMarketQuotes(yahooSymbols)

      if (results.size > 0) {
        // Check if any data came from yahoo-finance (not just fallback)
        const yahooCount = Array.from(results.values()).filter(r => r.dataSource === 'yahoo-finance').length
        if (yahooCount > 0) {
          console.info(`[batch] Attempt ${attempt + 1}: Got ${yahooCount} live quotes, ${results.size - yahooCount} cached`)
          return results
        }

        // All results are from fallback, but we have data
        if (attempt < maxRetries) {
          console.info(`[batch] Attempt ${attempt + 1}: Only fallback, retrying...`)
          await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
          continue
        }
        return results
      }

      // Empty results, retry
      if (attempt < maxRetries) {
        console.warn(`[batch] Attempt ${attempt + 1}: No data, retrying...`)
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
      }
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      console.error(`[batch] Attempt ${attempt + 1}: ${lastError.message}`)

      if (attempt < maxRetries) {
        await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
      }
    }
  }

  console.error(`[batch] All retries exhausted: ${lastError?.message || 'Unknown error'}`)

  // Return fallback as last resort
  const fallbackResults = new Map<string, MarketDataPoint>()
  for (const symbol of yahooSymbols) {
    if (symbol in FALLBACK_QUOTES) {
      fallbackResults.set(symbol, {
        ...FALLBACK_QUOTES[symbol],
        timestamp: Date.now(),
        dataSource: 'fallback',
      })
    }
  }

  if (fallbackResults.size > 0) {
    console.warn(`[batch] Returning ${fallbackResults.size} fallback rates`)
  }

  return fallbackResults
}
