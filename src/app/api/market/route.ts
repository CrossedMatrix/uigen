import { NextResponse } from 'next/server'

const SYMBOL_NAMES: Record<string, string> = {
  // Futures
  'ES=F':  'S&P E-Mini',
  'NQ=F':  'NQ E-Mini',
  'YM=F':  'DOW E-Mini',
  'RTY=F': 'Russell Mini',
  // Spot indices (kept for yield curve, ratios)
  '^GSPC': 'S&P 500',
  '^NDX':  'NASDAQ 100',
  '^DJI':  'DOW JONES',
  '^RUT':  'RUSSELL 2000',
  // Vol
  '^VIX':  'VIX',
  '^VVIX': 'VVIX',
  '^SKEW': 'CBOE SKEW',
  // Rates
  '^IRX':  '3-Month',
  '^FVX':  '5-Year',
  '^TNX':  '10-Year',
  '^TYX':  '30-Year',
  // FX
  'DX-Y.NYB': 'DXY',
  'EURUSD=X':  'EUR/USD',
  'GBPUSD=X':  'GBP/USD',
  'JPY=X':     'USD/JPY',
  'CNY=X':     'USD/CNY',
  'AUDUSD=X':  'AUD/USD',
  // Commodities
  'GC=F':  'Gold',
  'SI=F':  'Silver',
  'CL=F':  'WTI Crude',
  'BZ=F':  'Brent Crude',
  'HG=F':  'Copper',
  'NG=F':  'Natural Gas',
  // ETFs
  'SOXX':  'Semi ETF',
  'EWY':   'Korea ETF',
}

interface YahooQuote {
  symbol: string
  regularMarketPrice: number
  regularMarketChange: number
  regularMarketChangePercent: number
  regularMarketDayHigh: number
  regularMarketDayLow: number
}

async function fetchYahooQuotes(symbols: string[]): Promise<YahooQuote[]> {
  const joined = symbols.map(encodeURIComponent).join(',')
  const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${joined}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://finance.yahoo.com/',
    },
    next: { revalidate: 30 },
  })
  if (!res.ok) throw new Error(`Yahoo Finance: ${res.status}`)
  const json = await res.json()
  return (json.quoteResponse?.result ?? []) as YahooQuote[]
}

async function fetchSparklines(symbols: string[], interval = '1h', range = '5d'): Promise<Record<string, number[]>> {
  const settled = await Promise.allSettled(
    symbols.map(async (symbol) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://finance.yahoo.com/',
        },
        next: { revalidate: interval === '15m' ? 300 : 3600 },
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
    { symbol: 'ES=F',  name: 'S&P E-Mini',    price: 5841.50, change: 46.75,  changePercent: 0.81, high: 5852.00, low: 5790.00 },
    { symbol: 'NQ=F',  name: 'NQ E-Mini',     price: 20798.50, change: 344.25, changePercent: 1.68, high: 20840.00, low: 20428.00 },
    { symbol: 'YM=F',  name: 'DOW E-Mini',    price: 42248.00, change: 242.00, changePercent: 0.58, high: 42304.00, low: 41980.00 },
    { symbol: 'RTY=F', name: 'Russell Mini',  price: 2104.20, change: 14.30,  changePercent: 0.68, high: 2110.00, low: 2087.00 },
  ]

  return {
    futures: futuresMock.map((f) => ({
      ...f,
      sparklines: multiTFSparklines(f.symbol, f.price, f.change),
    })),
    equities: [
      { symbol: '^GSPC', name: 'S&P 500',      price: 5847.32, change: 52.18,  changePercent: 0.90,  high: 5858.04, low: 5789.14, sparkline: seededSparkline(5790, 5847, 24, 1) },
      { symbol: '^NDX',  name: 'NASDAQ 100',   price: 20842.65, change: 387.42, changePercent: 1.89, high: 20881.32, low: 20455.23, sparkline: seededSparkline(20455, 20842, 24, 2) },
      { symbol: '^DJI',  name: 'DOW JONES',    price: 42318.42, change: 312.84, changePercent: 0.74, high: 42380.11, low: 42005.87, sparkline: seededSparkline(42005, 42318, 24, 3) },
      { symbol: '^RUT',  name: 'RUSSELL 2000', price: 2108.73,  change: 18.42,  changePercent: 0.88, high: 2114.28,  low: 2090.12,  sparkline: seededSparkline(2090, 2108, 24, 4) },
    ],
    rates: [
      { symbol: '^IRX', name: '3-Month', price: 5.24, change: -0.02, changePercent: -0.38, high: 5.26, low: 5.22, sparkline: [] },
      { symbol: '^FVX', name: '5-Year',  price: 4.52, change:  0.01, changePercent:  0.22, high: 4.55, low: 4.49, sparkline: [] },
      { symbol: '^TNX', name: '10-Year', price: 4.41, change:  0.03, changePercent:  0.68, high: 4.44, low: 4.36, sparkline: [] },
      { symbol: '^TYX', name: '30-Year', price: 4.68, change:  0.05, changePercent:  1.08, high: 4.70, low: 4.61, sparkline: [] },
    ],
    fx: [
      { symbol: 'DX-Y.NYB', name: 'DXY',     price: 104.23, change: -0.18, changePercent: -0.17, sparklines: multiTFSparklines('DXY', 104.23, -0.18)    },
      { symbol: 'EURUSD=X',  name: 'EUR/USD', price:  1.0821, change:  0.0015, changePercent:  0.14, sparklines: multiTFSparklines('EURUSD', 1.0821, 0.0015) },
      { symbol: 'GBPUSD=X',  name: 'GBP/USD', price:  1.2748, change:  0.0032, changePercent:  0.25, sparklines: multiTFSparklines('GBPUSD', 1.2748, 0.0032) },
      { symbol: 'JPY=X',     name: 'USD/JPY', price: 155.42,  change:  0.24, changePercent:  0.15, sparklines: multiTFSparklines('USDJPY', 155.42, 0.24)   },
      { symbol: 'CNY=X',     name: 'USD/CNY', price:  7.2438, change:  0.0052, changePercent:  0.07, sparklines: multiTFSparklines('USDCNY', 7.2438, 0.0052) },
      { symbol: 'AUDUSD=X',  name: 'AUD/USD', price:  0.6412, change: -0.0018, changePercent: -0.28, sparklines: multiTFSparklines('AUDUSD', 0.6412, -0.0018) },
    ],
    commodities: [
      { symbol: 'GC=F', name: 'Gold',        price: 3215.40, change:  24.80, changePercent:  0.78, sparklines: multiTFSparklines('GC', 3215.40, 24.80)  },
      { symbol: 'SI=F', name: 'Silver',       price:   32.84, change:   0.42, changePercent:  1.30, sparklines: multiTFSparklines('SI', 32.84, 0.42)     },
      { symbol: 'CL=F', name: 'WTI Crude',   price:   78.24, change:  -0.84, changePercent: -1.06, sparklines: multiTFSparklines('CL', 78.24, -0.84)    },
      { symbol: 'BZ=F', name: 'Brent Crude', price:   82.18, change:  -0.72, changePercent: -0.87, sparklines: multiTFSparklines('BZ', 82.18, -0.72)    },
      { symbol: 'HG=F', name: 'Copper',      price:    4.58, change:   0.03, changePercent:  0.66, sparklines: multiTFSparklines('HG', 4.58, 0.03)      },
      { symbol: 'NG=F', name: 'Natural Gas', price:    2.24, change:   0.08, changePercent:  3.70, sparklines: multiTFSparklines('NG', 2.24, 0.08)      },
    ],
    volatility: {
      vix:         { symbol: '^VIX',  name: 'VIX',       price: 17.82, change: -0.84, changePercent: -4.50, sparkline: [] },
      vvix:        { symbol: '^VVIX', name: 'VVIX',      price:  92.4, change: -2.1,  changePercent: -2.22, sparkline: [] },
      skew:        { symbol: '^SKEW', name: 'CBOE SKEW', price: 131.2, change:  1.4,  changePercent:  1.08, sparkline: [] },
      putCallRatio: 0.72,
    },
    timestamp: Date.now(),
    isMarketOpen,
  }
}

function isMarketCurrentlyOpen(): boolean {
  const now = new Date()
  const day = now.getUTCDay()
  const totalMin = now.getUTCHours() * 60 + now.getUTCMinutes()
  return day >= 1 && day <= 5 && totalMin >= 870 && totalMin < 1260
}

export async function GET() {
  const marketOpen = isMarketCurrentlyOpen()

  const futuresSymbols  = ['ES=F', 'NQ=F', 'YM=F', 'RTY=F']
  const equitySymbols   = ['^GSPC', '^NDX', '^DJI', '^RUT']
  const volSymbols      = ['^VIX', '^VVIX', '^SKEW']
  const rateSymbols     = ['^IRX', '^FVX', '^TNX', '^TYX']
  const fxSymbols       = ['DX-Y.NYB', 'EURUSD=X', 'GBPUSD=X', 'JPY=X', 'CNY=X', 'AUDUSD=X']
  const commSymbols     = ['GC=F', 'SI=F', 'CL=F', 'BZ=F', 'HG=F', 'NG=F']

  const allSymbols = [...futuresSymbols, ...equitySymbols, ...volSymbols, ...rateSymbols, ...fxSymbols, ...commSymbols]

  try {
    const [quotes, dailySparklines, intradaySparklines] = await Promise.all([
      fetchYahooQuotes(allSymbols),
      fetchSparklines([...futuresSymbols, ...equitySymbols], '1h', '5d'),
      fetchSparklines(futuresSymbols, '15m', '1d'),
    ])

    const qmap = new Map(quotes.map((q) => [q.symbol, q]))

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
      timestamp: Date.now(),
      isMarketOpen: marketOpen,
    })
  } catch (err) {
    console.error('Market API error — falling back to mock data:', err)
    return NextResponse.json(getMockData(marketOpen))
  }
}
