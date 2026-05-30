/**
 * Market Data Fetcher Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Orchestrates data fetching, liveness calculation, and node assembly.
 *
 * Data provider: Alpaca Markets (to be wired in — stubs return empty until
 * the Alpaca SDK is initialised).
 *
 * Architecture:
 *   fetchMarketData(category, timeframe)
 *     └─ fetchMarketQuotes(symbols)   ← Alpaca snapshot endpoint (stub)
 *     └─ buildMarketNode(...)         ← liveness + node assembly (live)
 */

import type {
  MarketNode,
  LivenessStatus,
  LivenessMetrics,
  MarketDataSnapshot,
  LivenessContext,
} from '@/lib/types/market'
import { MARKET_REGISTRY } from '@/lib/config/marketRegistry'

// ─── Provider Quote Shape ─────────────────────────────────────────────────────
// Normalised quote object returned by whichever provider is active.
// Alpaca's snapshot API maps cleanly to this shape.

export interface ProviderQuote {
  symbol:        string
  price:         number
  change:        number
  changePercent: number
  timestamp:     number     // Unix ms
  /** Bar close prices ordered oldest→newest, populated by fetchBarsPeriodChange */
  sparkline?:    number[]
}

// ─── Alpaca Data Fetcher ──────────────────────────────────────────────────────
// Two paths depending on timeframe:
//
//   1D  → /api/alpaca proxy (snapshot endpoint) — live intraday price + daily %
//   5D+ → Direct Alpaca call with explicit start date — multi-day period return
//
// Why separate paths?
//   The Alpaca IEX bars endpoint (/v2/stocks/bars?feed=iex) without a `start`
//   date only returns the current intraday session bar (1 bar per symbol).
//   Requesting limit=N without date bounds is unreliable for historical depth.
//   Specifying `start=YYYY-MM-DD` forces Alpaca to return all trading-day bars
//   from that date to now, giving a reliable baseline for period-change math.
//
//   The 1D snapshot path still routes through the proxy because it uses
//   /v2/stocks/snapshots which correctly includes prevDailyBar for daily change.

const ALPACA_PROXY_BASE = process.env.NEXT_PUBLIC_BASE_URL
  ? `${process.env.NEXT_PUBLIC_BASE_URL}/api/alpaca`
  : 'http://localhost:3000/api/alpaca'

// ─── Direct Alpaca credentials (server-side only) ────────────────────────────
// marketFetcher.ts is exclusively server-side (consumed by /api/market-nodes).
// Reading credentials here eliminates the HTTP proxy round-trip for bar fetches.
const ALPACA_KEY_ID   = process.env.ALPACA_API_KEY_ID?.trim()  ?? ''
const ALPACA_SECRET   = process.env.ALPACA_SECRET_KEY?.trim()  ?? ''
const ALPACA_DATA_URL = 'https://data.alpaca.markets'

/** Raw daily bar shape as returned by Alpaca's /v2/stocks/bars endpoint */
interface RawAlpacaBar {
  t: string   // RFC-3339 timestamp of bar open (e.g. "2026-05-20T04:00:00Z")
  o: number   // open
  h: number   // high
  l: number   // low
  c: number   // close
  v: number   // volume
  vw?: number // VWAP
}

/**
 * Filter a symbol list to only those Alpaca can actually serve.
 * Alpaca supports:
 *   us_equity  — plain tickers: SPY, GLD, NVDA, …
 *   crypto     — slash-pair tickers: BTC/USD, ETH/USD, …
 * NOT supported (cause 403 / 400):
 *   Futures    — GC=F, CL=F, ES=F, …  (contain "=")
 *   FX pairs   — EURUSD=X, JPY=X, …   (contain "=")
 *   ICE/NYBOT  — DX-Y.NYB             (ends with .NYB)
 *   Indices    — ^VIX, ^GSPC, …       (start with "^")
 */
function filterAlpacaCompatible(symbols: string[]): string[] {
  return symbols.filter(s =>
    !s.includes('=') &&      // rules out futures (=F) and FX pairs (=X)
    !s.endsWith('.NYB') &&   // rules out DX-Y.NYB (Dollar Index, ICE)
    !s.startsWith('^')       // rules out caret-prefixed cash indices
  )
}

async function fetchMarketQuotes(
  symbols: string[]
): Promise<Map<string, ProviderQuote>> {
  if (symbols.length === 0) return new Map()

  // Drop any symbol formats that Alpaca doesn't support — prevents 403 storms
  const filtered = filterAlpacaCompatible(symbols)
  if (filtered.length === 0) {
    console.debug('[marketFetcher] All symbols filtered as non-Alpaca-compatible; skipping fetch')
    return new Map()
  }

  try {
    // Determine if these are crypto or equity symbols
    const isCrypto = filtered.some(s => s.includes('/'))
    const assetClass = isCrypto ? 'crypto' : 'us_equity'

    const url = `${ALPACA_PROXY_BASE}?type=snapshot&symbols=${encodeURIComponent(filtered.join(','))}&asset_class=${assetClass}`
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!res.ok) {
      console.warn(`[marketFetcher] Alpaca proxy returned ${res.status} for symbols: ${filtered.join(',')}`)
      return new Map()
    }

    const data = await res.json() as { quotes?: Array<{
      symbol: string; price: number | null; change: number | null;
      changePercent: number | null; timestamp: number
    }> }

    const map = new Map<string, ProviderQuote>()
    for (const q of data.quotes ?? []) {
      if (q.price !== null) {
        map.set(q.symbol, {
          symbol:        q.symbol,
          price:         q.price,
          change:        q.change        ?? 0,
          changePercent: q.changePercent ?? 0,
          timestamp:     q.timestamp,
        })
      }
    }
    return map
  } catch {
    return new Map()
  }
}

// ─── Market Hours & Status ────────────────────────────────────────────────────

interface MarketStatus {
  isOpen:      boolean
  nextOpenMs:  number
  nextCloseMs: number
}

function calculateMarketStatus(nowDate: Date): MarketStatus {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday:  'short',
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  })

  const parts     = formatter.formatToParts(nowDate)
  const weekday   = parts.find(p => p.type === 'weekday')?.value ?? 'Mon'
  const hour      = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10)
  const minute    = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10)
  const dayNum    = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday)
  const minuteOfDay = hour * 60 + minute

  // US Equity: Mon–Fri 09:30–16:00 ET
  const equityOpen = [1, 2, 3, 4, 5].includes(dayNum) && minuteOfDay >= 570 && minuteOfDay < 960
  // Futures/FX: nearly 24/5 — approximate as Sun–Fri 17:00 prev day to 16:00
  const fxOpen = dayNum !== 6 && !(dayNum === 5 && minuteOfDay >= 1020)

  return {
    isOpen:      equityOpen || fxOpen,
    nextOpenMs:  0, // TODO: compute from market calendar
    nextCloseMs: 0,
  }
}

// ─── Liveness Calculator ──────────────────────────────────────────────────────

export function calculateLiveness(
  lastUpdateMs:     number,
  maxAgeMs:         number,
  context:          LivenessContext,
  feedHealthPercent: number
): LivenessStatus {
  const ageMs      = context.nowMs - lastUpdateMs
  const ageSeconds = Math.round(ageMs / 1000)
  void ageSeconds

  if (ageMs > 1_800_000 || feedHealthPercent < 20) return 'FEED_DISCONNECTED'
  if (!context.marketOpenState.isOpen && ageMs > maxAgeMs) return 'MARKET_CLOSED_STALE'
  if (context.marketOpenState.isOpen && ageMs < 300_000)   return 'LIVE_INTRADAY'
  if (!context.marketOpenState.isOpen && ageMs <= maxAgeMs) return 'LIVE_INTRADAY'
  return 'MARKET_CLOSED_STALE'
}

function getLivenessMessage(
  status:        LivenessStatus,
  ageSeconds:    number,
  isMarketOpen:  boolean
): string {
  switch (status) {
    case 'LIVE_INTRADAY':
      if (ageSeconds < 60)  return `🟢 Live (${ageSeconds}s ago)`
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

// ─── Market Node Builder ──────────────────────────────────────────────────────

export function buildMarketNode(
  marketId:          string,
  price:             number | null,
  change:            number | null,
  changePercent:     number | null,
  timestamp:         number,
  context:           LivenessContext,
  feedHealthPercent: number,
  dataSource:        'alpaca' | 'fred' | 'fallback' = 'alpaca',
  sparkline?:        number[]
): MarketNode | null {
  const config = MARKET_REGISTRY[marketId]
  if (!config) {
    console.warn(`[marketFetcher] Unknown market ID: ${marketId}`)
    return null
  }

  const ageSeconds = Math.round((context.nowMs - timestamp) / 1000)
  const maxAgeMs   = config.primarySource.maxAgeMs
  const status     = calculateLiveness(timestamp, maxAgeMs, context, feedHealthPercent)
  const message    = getLivenessMessage(status, ageSeconds, context.marketOpenState.isOpen)

  const liveness: LivenessMetrics = {
    status,
    lastUpdateMs:     timestamp,
    ageSeconds,
    isMarketOpen:     context.marketOpenState.isOpen,
    feedHealthPercent,
    dataSource,
    message,
  }

  return {
    id:          marketId,
    displayName: config.displayName,
    category:    config.category,
    sources: [
      {
        type:             config.primarySource.type,
        symbol:           config.primarySource.symbol,
        priority:         1,
        refreshIntervalMs: config.primarySource.refreshIntervalMs,
        maxAgeMs:         config.primarySource.maxAgeMs,
        lastSuccessMs:    timestamp,
      },
      ...(config.secondarySource
        ? [{
            type:             config.secondarySource.type,
            symbol:           config.secondarySource.symbol,
            priority:         2,
            refreshIntervalMs: config.secondarySource.refreshIntervalMs,
            maxAgeMs:         config.secondarySource.maxAgeMs,
            lastSuccessMs:    timestamp,
          }]
        : []),
    ],
    price,
    change,
    changePercent,
    timestamp,
    sparkline,
    liveness,
    decimals:     config.decimals,
    unit:         config.unit,
    exchangeCode: config.exchangeCode,
  }
}

// ─── Period start-date helper ─────────────────────────────────────────────────
//
// Returns an ISO YYYY-MM-DD date far enough in the past to guarantee enough
// trading-day bars for the requested timeframe, even accounting for weekends,
// public holidays, and Alpaca's date rounding.
//
// Calendar-day buffers (≈1.5× of trading days needed):
//   5D  →  14 calendar days back  (guarantees ≥5 trading-day bars)
//   1M  →  40 calendar days back  (guarantees ≥22 trading-day bars)
//   3M  → 100 calendar days back  (guarantees ≥65 trading-day bars)
//
// WHY date-based instead of limit-based:
//   Alpaca's IEX feed (/v2/stocks/bars?feed=iex) without a `start` date
//   returns only the current session's intraday bar (1 bar per symbol).
//   `limit=N` without a date window is silently ignored for historical depth
//   on the IEX feed tier.  Supplying an explicit `start` forces Alpaca to
//   scan the full historical range and return every trading-day bar in it.

function periodStartDate(timeframe: '5D' | '1M' | '3M'): string {
  const calendarDays =
    timeframe === '5D' ?  14 :
    timeframe === '1M' ?  40 :
    /* 3M */              100
  const d = new Date()
  d.setDate(d.getDate() - calendarDays)
  return d.toISOString().split('T')[0]   // YYYY-MM-DD
}

// ─── Period-Change Bar Fetcher ────────────────────────────────────────────────
//
// Calls Alpaca's /v2/stocks/bars directly (no proxy round-trip) with an
// explicit start date.  Returns:
//
//   price         = bars[-1].c  (most recent session close)
//   change        = bars[-1].c − bars[0].c  (period open → latest close)
//   changePercent = change / bars[0].c × 100
//
// Symbols with < 2 bars returned are silently skipped — the caller's
// buildMarketNode receives price=null and renders "--" instead of "+0.00%".
// This is far better than falsely displaying a 0% change.

async function fetchBarsPeriodChange(
  symbols:   string[],
  startDate: string,   // YYYY-MM-DD
): Promise<Map<string, ProviderQuote>> {
  const filtered = filterAlpacaCompatible(symbols)
  if (filtered.length === 0) {
    console.debug('[marketFetcher] All symbols non-Alpaca-compatible; skipping period bars')
    return new Map()
  }
  if (!ALPACA_KEY_ID || !ALPACA_SECRET) {
    console.debug('[marketFetcher] Alpaca credentials not configured; skipping period bars')
    return new Map()
  }

  try {
    // Request all 1Day bars from startDate to now, sorted oldest→newest.
    // limit=300 is a safety cap well above 3M (~65 bars); Alpaca stops at `now`.
    const params = new URLSearchParams({
      symbols:    filtered.join(','),
      timeframe:  '1Day',
      start:      startDate,
      sort:       'asc',
      adjustment: 'split',
      feed:       'iex',
      limit:      '300',
    })

    const res = await fetch(`${ALPACA_DATA_URL}/v2/stocks/bars?${params}`, {
      headers: {
        'APCA-API-KEY-ID':     ALPACA_KEY_ID,
        'APCA-API-SECRET-KEY': ALPACA_SECRET,
        Accept:                'application/json',
      },
      cache:  'no-store',
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      console.warn(`[marketFetcher] Alpaca bars ${res.status} for period start=${startDate}: ${body.slice(0, 200)}`)
      return new Map()
    }

    const data = await res.json() as { bars?: Record<string, RawAlpacaBar[]> }
    const map  = new Map<string, ProviderQuote>()

    for (const sym of filtered) {
      const bars = data.bars?.[sym] ?? []

      if (bars.length < 2) {
        // Too few bars — could be a holiday gap, IEX coverage gap, or newly-listed.
        // Skip so the node renders "--" rather than a misleading "+0.00%".
        if (bars.length > 0) {
          console.debug(
            `[marketFetcher] ${sym}: only ${bars.length} bar(s) since ${startDate} ` +
            `(IEX coverage gap?) — skipping period change`
          )
        }
        continue
      }

      const baseClose    = bars[0].c                    // period start close
      const currentClose = bars[bars.length - 1].c     // latest session close
      const change        = currentClose - baseClose
      const changePercent = baseClose !== 0 ? (change / baseClose) * 100 : 0

      // Timestamp: use now (time of successful fetch) rather than the bar's
      // close time.  Bar closes are 1–100 days old by design — using them as
      // the "data freshness" marker would make the liveness calculator see every
      // node as FEED_DISCONNECTED, poisoning the health counters.  The bar date
      // is recorded in sparkline[0] implicitly and is not the right signal here.
      const fetchedAtMs = Date.now()

      // Extract daily close prices as the sparkline array (oldest → newest).
      // This gives real historical shape for the 5D / 1M / 3M visual traces
      // instead of the seeded-LCG synthetic placeholders used elsewhere.
      const sparkline = bars.map(b => b.c)

      map.set(sym, {
        symbol:        sym,
        price:         currentClose,
        change:        parseFloat(change.toFixed(8)),
        changePercent: parseFloat(changePercent.toFixed(4)),
        timestamp:     fetchedAtMs,
        sparkline,
      })
    }

    console.info(
      `[marketFetcher] period bars start=${startDate} | ` +
      `${map.size}/${filtered.length} symbols priced`
    )
    return map

  } catch (err) {
    console.warn('[marketFetcher] fetchBarsPeriodChange error:', err instanceof Error ? err.message : err)
    return new Map()
  }
}

// ─── Main Fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetch market data for a category and timeframe.
 *
 * Timeframe routing:
 *   1D  → Alpaca snapshot endpoint  (proxy)   — live intraday price + daily % chg
 *   5D  → Alpaca bars (start: -14 cal days)   — period return: bars[0].c → bars[-1].c
 *   1M  → Alpaca bars (start: -40 cal days)   — period return: bars[0].c → bars[-1].c
 *   3M  → Alpaca bars (start: -100 cal days)  — period return: bars[0].c → bars[-1].c
 */
export async function fetchMarketData(
  category:  'fx' | 'commodity' | 'index',
  timeframe: '1D' | '5D' | '1M' | '3M' = '1D'
): Promise<MarketDataSnapshot> {
  const startTime = Date.now()
  const nowMs     = Date.now()

  const marketConfigs = Object.entries(MARKET_REGISTRY).filter(
    ([, config]) => config.category === category
  )

  const symbols = marketConfigs.map(([, config]) => config.primarySource.symbol)

  // ── Fetch quotes from provider ───────────────────────────────────────────
  //
  // 1D:   snapshot path — live intraday price + daily change vs prevDailyBar
  // 5D+:  direct Alpaca bars with explicit start date — period return calculation
  let quoteMap: Map<string, ProviderQuote> = new Map()
  let providerHealthPercent = 0
  let providerError: string | undefined

  try {
    quoteMap = timeframe === '1D'
      ? await fetchMarketQuotes(symbols)
      : await fetchBarsPeriodChange(symbols, periodStartDate(timeframe))
    providerHealthPercent = quoteMap.size > 0
      ? Math.round((quoteMap.size / symbols.length) * 100)
      : 0
  } catch (err) {
    providerError         = err instanceof Error ? err.message : String(err)
    providerHealthPercent = 0
    console.warn(`[marketFetcher] Provider fetch error: ${providerError}`)
  }

  // ── Liveness context ─────────────────────────────────────────────────────
  const marketStatus    = calculateMarketStatus(new Date(nowMs))
  const livenessContext: LivenessContext = {
    nowMs,
    marketOpenState:   marketStatus,
    feedHealthPercent: providerHealthPercent,
  }

  // ── Build nodes ───────────────────────────────────────────────────────────
  const nodes:            Record<string, MarketNode> = {}
  let liveCount          = 0
  let staleCount         = 0
  let disconnectedCount  = 0

  for (const [marketId, config] of marketConfigs) {
    const symbol = config.primarySource.symbol
    const quote  = quoteMap.get(symbol)

    const node = buildMarketNode(
      marketId,
      quote?.price         ?? null,
      quote?.change        ?? null,
      quote?.changePercent ?? null,
      quote?.timestamp     ?? nowMs,
      livenessContext,
      quote ? providerHealthPercent : 0,
      quote ? 'alpaca' : 'fallback',
      quote?.sparkline          // real bar closes for 5D/1M/3M; undefined for 1D snapshots
    )

    if (node) {
      nodes[marketId] = node
      if (node.liveness.status === 'LIVE_INTRADAY')      liveCount++
      else if (node.liveness.status === 'MARKET_CLOSED_STALE') staleCount++
      else disconnectedCount++
    }
  }

  const totalNodes    = Object.keys(nodes).length
  const healthPercent = totalNodes > 0
    ? ((liveCount + staleCount) / totalNodes) * 100
    : 0

  const elapsed = Date.now() - startTime
  console.info(
    `[marketFetcher] ${category} (${timeframe}) in ${elapsed}ms | ` +
    `Live: ${liveCount}  Stale: ${staleCount}  Disconnected: ${disconnectedCount}`
  )

  return {
    timestamp: nowMs,
    nodes,
    health: { totalNodes, liveCount, staleCount, disconnectedCount, healthPercent },
    sources: {
      alpaca: {
        healthy:       providerHealthPercent >= 80,
        lastSuccessMs: quoteMap.size > 0 ? nowMs : 0,
        errorMsg:      providerError,
      },
      fred: {
        healthy:       true,
        lastSuccessMs: 0,
      },
    },
  }
}

/**
 * Fetch data for all categories in parallel.
 */
export async function fetchAllMarketData(
  timeframes?: {
    fx?:        '1D' | '5D' | '1M' | '3M'
    commodity?: '1D' | '5D' | '1M' | '3M'
    index?:     '1D' | '5D' | '1M' | '3M'
  }
): Promise<Record<string, MarketDataSnapshot>> {
  const [fxData, commodityData, indexData] = await Promise.all([
    fetchMarketData('fx',        timeframes?.fx        ?? '1D'),
    fetchMarketData('commodity', timeframes?.commodity ?? '1D'),
    fetchMarketData('index',     timeframes?.index     ?? '1D'),
  ])
  return { fx: fxData, commodity: commodityData, index: indexData }
}
