import { NextResponse } from 'next/server'

const SYMBOL_NAMES: Record<string, string> = {
  '^GSPC': 'S&P 500',
  '^NDX': 'NASDAQ 100',
  '^DJI': 'DOW JONES',
  '^RUT': 'RUSSELL 2000',
  '^VIX': 'VIX',
  '^VVIX': 'VVIX',
  '^SKEW': 'CBOE SKEW',
  '^IRX': '3-Month',
  '^FVX': '5-Year',
  '^TNX': '10-Year',
  '^TYX': '30-Year',
  'DX-Y.NYB': 'DXY',
  'EURUSD=X': 'EUR/USD',
  'GBPUSD=X': 'GBP/USD',
  'JPY=X': 'USD/JPY',
  'CNY=X': 'USD/CNY',
  'AUDUSD=X': 'AUD/USD',
  'GC=F': 'Gold',
  'SI=F': 'Silver',
  'CL=F': 'WTI Crude',
  'BZ=F': 'Brent Crude',
  'HG=F': 'Copper',
  'NG=F': 'Natural Gas',
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

async function fetchSparklines(symbols: string[]): Promise<Record<string, number[]>> {
  const settled = await Promise.allSettled(
    symbols.map(async (symbol) => {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1h&range=5d`
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://finance.yahoo.com/',
        },
        next: { revalidate: 3600 },
      })
      if (!res.ok) return { symbol, data: [] as number[] }
      const json = await res.json()
      const closes: (number | null)[] = json.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? []
      return { symbol, data: closes.filter((v): v is number => v !== null).slice(-24) }
    })
  )
  return Object.fromEntries(
    settled
      .filter((r): r is PromiseFulfilledResult<{ symbol: string; data: number[] }> => r.status === 'fulfilled')
      .map((r) => [r.value.symbol, r.value.data])
  )
}

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

function getMockData(isMarketOpen: boolean) {
  return {
    equities: [
      { symbol: '^GSPC', name: 'S&P 500', price: 5847.32, change: 52.18, changePercent: 0.90, high: 5858.04, low: 5789.14, sparkline: seededSparkline(5790, 5847, 24, 1) },
      { symbol: '^NDX', name: 'NASDAQ 100', price: 20842.65, change: 387.42, changePercent: 1.89, high: 20881.32, low: 20455.23, sparkline: seededSparkline(20455, 20842, 24, 2) },
      { symbol: '^DJI', name: 'DOW JONES', price: 42318.42, change: 312.84, changePercent: 0.74, high: 42380.11, low: 42005.87, sparkline: seededSparkline(42005, 42318, 24, 3) },
      { symbol: '^RUT', name: 'RUSSELL 2000', price: 2108.73, change: 18.42, changePercent: 0.88, high: 2114.28, low: 2090.12, sparkline: seededSparkline(2090, 2108, 24, 4) },
    ],
    rates: [
      { symbol: '^IRX', name: '3-Month', price: 5.24, change: -0.02, changePercent: -0.38, high: 5.26, low: 5.22, sparkline: [] },
      { symbol: '^FVX', name: '5-Year', price: 4.52, change: 0.01, changePercent: 0.22, high: 4.55, low: 4.49, sparkline: [] },
      { symbol: '^TNX', name: '10-Year', price: 4.41, change: 0.03, changePercent: 0.68, high: 4.44, low: 4.36, sparkline: [] },
      { symbol: '^TYX', name: '30-Year', price: 4.68, change: 0.05, changePercent: 1.08, high: 4.70, low: 4.61, sparkline: [] },
    ],
    fx: [
      { symbol: 'DX-Y.NYB', name: 'DXY', price: 104.23, change: -0.18, changePercent: -0.17, sparkline: [] },
      { symbol: 'EURUSD=X', name: 'EUR/USD', price: 1.0821, change: 0.0015, changePercent: 0.14, sparkline: [] },
      { symbol: 'GBPUSD=X', name: 'GBP/USD', price: 1.2748, change: 0.0032, changePercent: 0.25, sparkline: [] },
      { symbol: 'JPY=X', name: 'USD/JPY', price: 155.42, change: 0.24, changePercent: 0.15, sparkline: [] },
      { symbol: 'CNY=X', name: 'USD/CNY', price: 7.2438, change: 0.0052, changePercent: 0.07, sparkline: [] },
      { symbol: 'AUDUSD=X', name: 'AUD/USD', price: 0.6412, change: -0.0018, changePercent: -0.28, sparkline: [] },
    ],
    commodities: [
      { symbol: 'GC=F', name: 'Gold', price: 3215.40, change: 24.80, changePercent: 0.78, sparkline: [] },
      { symbol: 'SI=F', name: 'Silver', price: 32.84, change: 0.42, changePercent: 1.30, sparkline: [] },
      { symbol: 'CL=F', name: 'WTI Crude', price: 78.24, change: -0.84, changePercent: -1.06, sparkline: [] },
      { symbol: 'BZ=F', name: 'Brent Crude', price: 82.18, change: -0.72, changePercent: -0.87, sparkline: [] },
      { symbol: 'HG=F', name: 'Copper', price: 4.58, change: 0.03, changePercent: 0.66, sparkline: [] },
      { symbol: 'NG=F', name: 'Natural Gas', price: 2.24, change: 0.08, changePercent: 3.70, sparkline: [] },
    ],
    volatility: {
      vix: { symbol: '^VIX', name: 'VIX', price: 17.82, change: -0.84, changePercent: -4.50, sparkline: [] },
      vvix: { symbol: '^VVIX', name: 'VVIX', price: 92.4, change: -2.1, changePercent: -2.22, sparkline: [] },
      skew: { symbol: '^SKEW', name: 'CBOE SKEW', price: 131.2, change: 1.4, changePercent: 1.08, sparkline: [] },
      putCallRatio: 0.72,
    },
    timestamp: Date.now(),
    isMarketOpen,
  }
}

function isMarketCurrentlyOpen(): boolean {
  const now = new Date()
  const day = now.getUTCDay() // 0=Sun, 1=Mon..5=Fri, 6=Sat
  const hour = now.getUTCHours()
  const min = now.getUTCMinutes()
  const totalMin = hour * 60 + min
  // NYSE: Mon-Fri 9:30am-4:00pm ET = 14:30-21:00 UTC
  return day >= 1 && day <= 5 && totalMin >= 870 && totalMin < 1260
}

export async function GET() {
  const marketOpen = isMarketCurrentlyOpen()

  const allSymbols = [
    '^GSPC', '^NDX', '^DJI', '^RUT',
    '^VIX', '^VVIX', '^SKEW',
    '^IRX', '^FVX', '^TNX', '^TYX',
    'DX-Y.NYB', 'EURUSD=X', 'GBPUSD=X', 'JPY=X', 'CNY=X', 'AUDUSD=X',
    'GC=F', 'SI=F', 'CL=F', 'BZ=F', 'HG=F', 'NG=F',
  ]
  const equitySymbols = ['^GSPC', '^NDX', '^DJI', '^RUT']

  try {
    const [quotes, sparklines] = await Promise.all([
      fetchYahooQuotes(allSymbols),
      fetchSparklines(equitySymbols),
    ])

    const qmap = new Map(quotes.map((q) => [q.symbol, q]))

    const fmt = (symbol: string) => {
      const q = qmap.get(symbol)
      return {
        symbol,
        name: SYMBOL_NAMES[symbol] ?? symbol,
        price: q?.regularMarketPrice ?? 0,
        change: q?.regularMarketChange ?? 0,
        changePercent: q?.regularMarketChangePercent ?? 0,
        high: q?.regularMarketDayHigh,
        low: q?.regularMarketDayLow,
        sparkline: sparklines[symbol] ?? [],
      }
    }

    return NextResponse.json({
      equities: equitySymbols.map(fmt),
      rates: ['^IRX', '^FVX', '^TNX', '^TYX'].map(fmt),
      fx: ['DX-Y.NYB', 'EURUSD=X', 'GBPUSD=X', 'JPY=X', 'CNY=X', 'AUDUSD=X'].map(fmt),
      commodities: ['GC=F', 'SI=F', 'CL=F', 'BZ=F', 'HG=F', 'NG=F'].map(fmt),
      volatility: {
        vix: fmt('^VIX'),
        vvix: fmt('^VVIX'),
        skew: fmt('^SKEW'),
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
