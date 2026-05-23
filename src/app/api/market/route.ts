import { NextResponse } from 'next/server'

// ─── Market Data API Route ────────────────────────────────────────────────────
// Fetches live financial market data from Yahoo Finance and generates deterministic
// mock sparklines. Optimized for dashboard performance with no fundamental data.

const SYMBOL_NAMES: Record<string, string> = {
  // ──────────────────────────────────────────────────────────────────
  // INDEX FUTURES (Primary trackers)
  // ──────────────────────────────────────────────────────────────────
  'ES=F':  'S&P E-Mini',
  'NQ=F':  'Nasdaq 100 E-Mini',
  'YM=F':  'DOW E-Mini',
  'RTY=F': 'Russell 2000 E-Mini',

  // ──────────────────────────────────────────────────────────────────
  // SPOT INDICES (for yield curve, cross-asset ratios)
  // ──────────────────────────────────────────────────────────────────
  '^GSPC': 'S&P 500 Cash',
  '^NDX':  'Nasdaq 100 Cash',
  '^DJI':  'Dow Jones Cash',
  '^RUT':  'Russell 2000 Cash',

  // ──────────────────────────────────────────────────────────────────
  // VOLATILITY INDICES (Core framework)
  // ──────────────────────────────────────────────────────────────────
  '^VIX':  'VIX (Equity Vol)',
  '^VVIX': 'Vol of Vol',
  '^SKEW': 'CBOE Skew',
  '^MOVE': 'Bond Vol Index',

  // ──────────────────────────────────────────────────────────────────
  // INTEREST RATES & YIELD CURVE
  // ──────────────────────────────────────────────────────────────────
  '^IRX':  '3-Month Treasury',
  '^FVX':  '5-Year Treasury',
  '^TNX':  '10-Year Treasury',
  '^TYX':  '30-Year Treasury',

  // ──────────────────────────────────────────────────────────────────
  // CURRENCIES & FX (Cross-asset framework)
  // ──────────────────────────────────────────────────────────────────
  'DX-Y.NYB': 'US Dollar Index',
  'EURUSD=X': 'EUR/USD',
  'GBPUSD=X': 'GBP/USD',
  'JPY=X':    'USD/JPY',
  'CNY=X':    'USD/CNY',
  'AUDUSD=X': 'AUD/USD',
  'BTC-USD':  'Bitcoin',

  // ──────────────────────────────────────────────────────────────────
  // COMMODITIES (Physical assets framework)
  // ──────────────────────────────────────────────────────────────────
  'GC=F':  'Gold',
  'SI=F':  'Silver',
  'CL=F':  'WTI Crude Oil',
  'BZ=F':  'Brent Crude Oil',
  'HG=F':  'Copper',
  'NG=F':  'Natural Gas',

  // ──────────────────────────────────────────────────────────────────
  // SECTOR TRACKERS & ETFs
  // ──────────────────────────────────────────────────────────────────
  'SOXX': 'Semiconductor ETF',
  'EWY':  'Korea ETF',
}

interface YahooQuote {
  symbol: string
  regularMarketPrice: number
  regularMarketChange: number
  regularMarketChangePercent: number
  regularMarketDayHigh: number
  regularMarketDayLow: number
}

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json,text/plain,*/*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
}

async function fetchYahooQuotes(symbols: string[]): Promise<YahooQuote[]> {
  const joined = symbols.map(encodeURIComponent).join(',')
  // Try query2 first (often less rate-limited), fall back to query1
  for (const host of ['query2', 'query1']) {
    try {
      const url = `https://${host}.finance.yahoo.com/v7/finance/quote?symbols=${joined}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketDayHigh,regularMarketDayLow`
      const res = await fetch(url, { headers: YF_HEADERS, cache: 'no-store' })
      if (!res.ok) continue
      const json = await res.json()
      const results = (json.quoteResponse?.result ?? []) as YahooQuote[]
      if (results.length > 0) return results
    } catch {
      // try next host
    }
  }
  // Graceful fallback: warn instead of throwing, let GET handler use mock data
  console.warn('[market-api] Yahoo Finance endpoints down, serving stable fallback matrix.')
  return []
}

async function fetchSparklines(symbols: string[], interval = '1h', range = '5d'): Promise<Record<string, number[]>> {
  const settled = await Promise.allSettled(
    symbols.map(async (symbol) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`
      const res = await fetch(url, {
        headers: YF_HEADERS,
        cache: 'no-store' as RequestCache,
      })
      if (!res.ok) return { symbol, data: [] as number[] }
      const json = await res.json()
      const closes: (number | null)[] = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []
      const filtered = closes.filter((v): v is number => v !== null)
      // For 1D (intraday) return last 78 bars (≈ full trading day of 15-min bars)
      // For 5D hourly return last 24 bars
      const limit = interval === '15m' ? 78 : 24
      return { symbol, data: filtered.slice(-limit) }
    })
  )
  return Object.fromEntries(
    settled
      .filter((r): r is PromiseFulfilledResult<{ symbol: string; data: number[] }> => r.status === 'fulfilled')
      .map((r) => [r.value.symbol, r.value.data])
  )
}

// Seeded LCG sparkline generator for deterministic mock data
function seededSparkline(start: number, end: number, n: number, seed: number): number[] {
  let s = seed
  const rand = () => { s = (s * 1664525 + 1013904223) & 0xffffffff; return (s >>> 0) / 0xffffffff }
  const pts: number[] = []
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1)
    pts.push(start + (end - start) * t + (rand() - 0.5) * Math.abs(end - start) * 0.4)
  }
  pts[pts.length - 1] = end
  return pts
}

// Generate multi-timeframe seeded sparklines for a symbol
function multiTFSparklines(symbol: string, price: number, change: number) {
  const start = price - change
  const seed = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return {
    '1D': seededSparkline(start, price, 78, seed + 1),      // ~6.5h of 5min bars
    '5D': seededSparkline(start * 0.98, price, 24, seed + 2),
    '1M': seededSparkline(price * 0.95, price, 22, seed + 3),
    '3M': seededSparkline(price * 0.88, price, 65, seed + 4),
  }
}

function getMockData(isMarketOpen: boolean) {
  const futuresMock = [
    { symbol: 'ES=F',  name: 'S&P E-Mini',    price: 5823.25, change: 28.50,  changePercent: 0.49, high: 5852.00, low: 5790.00 },
    { symbol: 'NQ=F',  name: 'NQ E-Mini',     price: 20724.00, change: 268.75, changePercent: 1.31, high: 20840.00, low: 20428.00 },
    { symbol: 'YM=F',  name: 'DOW E-Mini',    price: 42186.00, change: 120.00, changePercent: 0.28, high: 42304.00, low: 41980.00 },
    { symbol: 'RTY=F', name: 'Russell Mini',  price: 2096.80, change: 6.50,   changePercent: 0.31, high: 2110.00, low: 2087.00 },
  ]

  return {
    futures: futuresMock.map((f) => ({
      ...f,
      sparklines: multiTFSparklines(f.symbol, f.price, f.change),
    })),
    equities: [
      { symbol: '^GSPC', name: 'S&P 500',      price: 5823.25, change: 28.50,  changePercent: 0.49,  high: 5858.04, low: 5789.14, sparkline: seededSparkline(5790, 5823, 24, 1) },
      { symbol: '^NDX',  name: 'NASDAQ 100',   price: 20724.00, change: 268.75, changePercent: 1.31, high: 20881.32, low: 20455.23, sparkline: seededSparkline(20455, 20724, 24, 2) },
      { symbol: '^DJI',  name: 'DOW JONES',    price: 42186.00, change: 120.00, changePercent: 0.28, high: 42380.11, low: 42005.87, sparkline: seededSparkline(42005, 42186, 24, 3) },
      { symbol: '^RUT',  name: 'RUSSELL 2000', price: 2096.80,  change: 6.50,   changePercent: 0.31, high: 2114.28,  low: 2090.12,  sparkline: seededSparkline(2090, 2096, 24, 4) },
    ],
    rates: [
      { symbol: '^IRX', name: '3-Month', price: 5.24, change: -0.02, changePercent: -0.38, high: 5.26, low: 5.22, sparkline: [] },
      { symbol: '^FVX', name: '5-Year',  price: 4.52, change:  0.01, changePercent:  0.22, high: 4.55, low: 4.49, sparkline: [] },
      { symbol: '^TNX', name: '10-Year', price: 4.41, change:  0.03, changePercent:  0.68, high: 4.44, low: 4.36, sparkline: [] },
      { symbol: '^TYX', name: '30-Year', price: 4.68, change:  0.05, changePercent:  1.08, high: 4.70, low: 4.61, sparkline: [] },
    ],
    fx: [
      { symbol: 'DX-Y.NYB', name: 'DXY',     price: 99.84,  change: -0.42, changePercent: -0.42, sparklines: multiTFSparklines('DXY', 99.84, -0.42)     },
      { symbol: 'EURUSD=X',  name: 'EUR/USD', price:  1.1348, change:  0.0048, changePercent:  0.42, sparklines: multiTFSparklines('EURUSD', 1.1348, 0.0048) },
      { symbol: 'GBPUSD=X',  name: 'GBP/USD', price:  1.3412, change:  0.0028, changePercent:  0.21, sparklines: multiTFSparklines('GBPUSD', 1.3412, 0.0028) },
      { symbol: 'JPY=X',     name: 'USD/JPY', price: 143.28,  change: -0.48, changePercent: -0.33, sparklines: multiTFSparklines('USDJPY', 143.28, -0.48)  },
      { symbol: 'CNY=X',     name: 'USD/CNY', price:  7.1842, change:  0.0038, changePercent:  0.05, sparklines: multiTFSparklines('USDCNY', 7.1842, 0.0038) },
      { symbol: 'AUDUSD=X',  name: 'AUD/USD', price:  0.6482, change:  0.0024, changePercent:  0.37, sparklines: multiTFSparklines('AUDUSD', 0.6482, 0.0024) },
      { symbol: 'BTC-USD',   name: 'BTC/USD', price: 107480,  change:  1248, changePercent:   1.17, sparklines: multiTFSparklines('BTC', 107480, 1248)      },
    ],
    commodities: [
      { symbol: 'GC=F', name: 'Gold',        price: 3291.80, change:  -9.40, changePercent: -0.28, sparklines: multiTFSparklines('GC', 3291.80, -9.40) },
      { symbol: 'SI=F', name: 'Silver',       price:   32.84, change:  -0.28, changePercent: -0.84, sparklines: multiTFSparklines('SI', 32.84, -0.28)   },
      { symbol: 'CL=F', name: 'WTI Crude',   price:   61.53, change:  -0.36, changePercent: -0.58, sparklines: multiTFSparklines('CL', 61.53, -0.36)   },
      { symbol: 'BZ=F', name: 'Brent Crude', price:   64.78, change:  -0.41, changePercent: -0.63, sparklines: multiTFSparklines('BZ', 64.78, -0.41)   },
      { symbol: 'HG=F', name: 'Copper',      price:    4.74, change:   0.06, changePercent:  1.28, sparklines: multiTFSparklines('HG', 4.74, 0.06)     },
      { symbol: 'NG=F', name: 'Natural Gas', price:    3.58, change:  -0.08, changePercent: -2.19, sparklines: multiTFSparklines('NG', 3.58, -0.08)    },
    ],
    volatility: {
      vix:         { symbol: '^VIX',  name: 'VIX',       price: 17.82, change: -0.84, changePercent: -4.50, sparkline: [] },
      vvix:        { symbol: '^VVIX', name: 'VVIX',      price:  92.4, change: -2.1,  changePercent: -2.22, sparkline: [] },
      skew:        { symbol: '^SKEW', name: 'CBOE SKEW', price: 131.2, change:  1.4,  changePercent:  1.08, sparkline: [] },
      putCallRatio: 0.72,
    },
    ratios: {
      copperGoldRatio: 4.74 / 3291.80,      // ~0.00144
      goldSilverRatio: 3291.80 / 32.84,     // ~100.2
      vixVvixRatio: 17.82 / 92.4,           // ~0.193
      btcGoldRatio: 107480 / 3291.80,       // ~32.64
      oilGoldRatio: 61.53 / 3291.80,        // ~0.0187
      yield2y10y: 4.41 - 4.52,              // -0.11 (inverted)
    },
    timestamp: Date.now(),
    isMarketOpen,
  }
}

function isMarketCurrentlyOpen(): boolean {
  const now = new Date()
  // Use America/New_York to correctly handle EDT vs EST (DST-aware)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now)
  const weekday = parts.find(p => p.type === 'weekday')?.value ?? ''
  const hour    = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10)
  const minute  = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10)
  const isWeekday    = !['Sat', 'Sun'].includes(weekday)
  const minuteOfDay  = hour * 60 + minute
  return isWeekday && minuteOfDay >= 570 && minuteOfDay < 960  // 9:30 AM – 4:00 PM ET
}

// ─── Cross-Asset Ratio Utilities ──────────────────────────────────────────
// Compute live ratio states from fetched quotes for dashboard cross-asset signals

interface CrossAssetRatios {
  copperGoldRatio: number        // HG=F / GC=F: Risk-on/risk-off signal
  goldSilverRatio: number        // GC=F / SI=F: Safe haven positioning
  vixVvixRatio: number           // ^VIX / ^VVIX: Volatility term structure
  btcGoldRatio: number           // BTC-USD / GC=F (normalized): Digital vs physical
  oilGoldRatio: number           // CL=F / GC=F: Growth vs safety
  yield2y10y: number             // ^TNX - ^FVX: Curve slope signal
}

function computeRatios(qmap: Map<string, YahooQuote>): CrossAssetRatios {
  // Extract prices safely with fallback to 0 for missing symbols
  const copper = qmap.get('HG=F')?.regularMarketPrice ?? 0
  const gold   = qmap.get('GC=F')?.regularMarketPrice ?? 0
  const silver = qmap.get('SI=F')?.regularMarketPrice ?? 0
  const vix    = qmap.get('^VIX')?.regularMarketPrice ?? 0
  const vvix   = qmap.get('^VVIX')?.regularMarketPrice ?? 0
  const btc    = qmap.get('BTC-USD')?.regularMarketPrice ?? 0
  const oil    = qmap.get('CL=F')?.regularMarketPrice ?? 0
  const tnx    = qmap.get('^TNX')?.regularMarketPrice ?? 0
  const fvx    = qmap.get('^FVX')?.regularMarketPrice ?? 0

  return {
    // Cu/Au ratio: >0.15 = risk-on, <0.12 = risk-off (normalized by historical ranges)
    copperGoldRatio: gold > 0 ? (copper / gold) : 0,

    // Au/Ag ratio: >80 = deflation fears, <60 = normal (classic safe haven metric)
    goldSilverRatio: silver > 0 ? (gold / silver) : 0,

    // VIX/VVIX: <1.0 = vol term inverted (extreme), >1.0 = normal term structure
    vixVvixRatio: vvix > 0 ? (vix / vvix) : 0,

    // BTC/Au normalized: Crypto vs physical hard asset (1 oz gold ~$2000, 1 BTC ~$100k)
    // Raw ratio; dashboard normalizes for comparison
    btcGoldRatio: gold > 0 ? (btc / gold) : 0,

    // Oil/Gold: >0.05 = growth strength, <0.03 = recession signal
    oilGoldRatio: gold > 0 ? (oil / gold) : 0,

    // Yield curve slope: positive = normal, negative = inversion (recession signal)
    // TNX = 10Y, FVX = 5Y; TNX - FVX typically 0-2% in normal markets
    yield2y10y: tnx - fvx,
  }
}

export async function GET() {
  const marketOpen = isMarketCurrentlyOpen()

  const futuresSymbols  = ['ES=F', 'NQ=F', 'YM=F', 'RTY=F']
  const equitySymbols   = ['^GSPC', '^NDX', '^DJI', '^RUT']
  const volSymbols      = ['^VIX', '^VVIX', '^SKEW']
  const rateSymbols     = ['^IRX', '^FVX', '^TNX', '^TYX']
  const fxSymbols       = ['DX-Y.NYB', 'EURUSD=X', 'GBPUSD=X', 'JPY=X', 'CNY=X', 'AUDUSD=X', 'BTC-USD']
  const commSymbols     = ['GC=F', 'SI=F', 'CL=F', 'BZ=F', 'HG=F', 'NG=F']

  const allSymbols = [...futuresSymbols, ...equitySymbols, ...volSymbols, ...rateSymbols, ...fxSymbols, ...commSymbols]

  try {
    const [quotes, dailySparklines, intradaySparklines] = await Promise.all([
      fetchYahooQuotes(allSymbols),
      fetchSparklines([...futuresSymbols, ...equitySymbols], '1h', '5d'),
      fetchSparklines(futuresSymbols, '15m', '1d'),
    ])

    // If Yahoo Finance failed (returned empty array), serve structured fallback immediately
    // without breaking execution. Frontend receives the exact same response shape.
    if (quotes.length === 0) {
      console.info('[market-api] Quotes fetch returned empty, using fallback matrix')
      return NextResponse.json(getMockData(marketOpen))
    }

    const qmap = new Map(quotes.map((q) => [q.symbol, q]))
    const ratios = computeRatios(qmap)

    const fmtBase = (symbol: string) => {
      const q = qmap.get(symbol)
      return {
        symbol,
        name: SYMBOL_NAMES[symbol] ?? symbol,
        price:         q?.regularMarketPrice        ?? 0,
        change:        q?.regularMarketChange       ?? 0,
        changePercent: q?.regularMarketChangePercent ?? 0,
        high:          q?.regularMarketDayHigh,
        low:           q?.regularMarketDayLow,
      }
    }

    // Futures: multi-timeframe sparklines
    const futures = futuresSymbols.map((sym) => {
      const base = fmtBase(sym)
      const live5D  = dailySparklines[sym]   ?? []
      const live1D  = intradaySparklines[sym] ?? []
      const mock = multiTFSparklines(sym, base.price || 100, base.change || 0)
      return {
        ...base,
        sparklines: {
          '1D': live1D.length  > 4 ? live1D  : mock['1D'],
          '5D': live5D.length  > 4 ? live5D  : mock['5D'],
          '1M': mock['1M'],
          '3M': mock['3M'],
        },
      }
    })

    // FX with multi-timeframe
    const fxWithTF = fxSymbols.map((sym) => {
      const base = fmtBase(sym)
      const mock = multiTFSparklines(sym, base.price || 1, base.change || 0)
      return { ...base, sparklines: mock }
    })

    // Commodities with multi-timeframe
    const commWithTF = commSymbols.map((sym) => {
      const base = fmtBase(sym)
      const mock = multiTFSparklines(sym, base.price || 1, base.change || 0)
      return { ...base, sparklines: mock }
    })

    const fmtVol = (sym: string) => ({ ...fmtBase(sym), sparkline: [] })

    return NextResponse.json({
      futures,
      equities: equitySymbols.map((sym) => ({
        ...fmtBase(sym),
        sparkline: dailySparklines[sym] ?? [],
      })),
      rates:       rateSymbols.map((sym) => ({ ...fmtBase(sym), sparkline: [] })),
      fx:          fxWithTF,
      commodities: commWithTF,
      volatility: {
        vix:          fmtVol('^VIX'),
        vvix:         fmtVol('^VVIX'),
        skew:         fmtVol('^SKEW'),
        putCallRatio: 0.78,
      },
      ratios,
      timestamp: Date.now(),
      isMarketOpen: marketOpen,
    })
  } catch (err) {
    console.error('[market-api] Unexpected error — falling back to mock data:', err)
    return NextResponse.json(getMockData(marketOpen))
  }
}
