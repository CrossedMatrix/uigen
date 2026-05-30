/**
 * /api/alpaca — Alpaca Markets Secure Data Proxy
 * ─────────────────────────────────────────────────────────────────────────────
 * This Next.js API route acts as a server-side proxy to Alpaca's Data API.
 * The browser never touches Alpaca directly — credentials stay server-side.
 *
 * Supported query parameters:
 *   ?type=bars      — Historical daily bars for one or more symbols
 *   ?type=snapshot  — Latest trade + quote snapshot for one or more symbols
 *   ?type=quotes    — Latest quote only (bid/ask) for one or more symbols
 *
 * Common parameters:
 *   ?symbols=BTC/USD,ETH/USD   — comma-separated symbols (required)
 *   ?feed=iex                  — data feed for us_equity (default: "iex" — free real-time IEX feed)
 *                               Use "sip" only if you have an Alpaca Unlimited subscription.
 *                               Crypto always uses the "us" feed (no feed param sent).
 *   ?limit=100                 — number of bars (bars only, default 30)
 *   ?timeframe=1Day            — bar timeframe (1Min|5Min|15Min|1Hour|1Day, default 1Day)
 *   ?asset_class=crypto        — "crypto" (default) or "us_equity"
 *
 * Examples:
 *   GET /api/alpaca?type=bars&symbols=BTC/USD,ETH/USD
 *   GET /api/alpaca?type=snapshot&symbols=BTC/USD,ETH/USD
 *   GET /api/alpaca?type=bars&symbols=AAPL,TSLA&asset_class=us_equity&limit=30
 *
 * Environment variables (set in .env.local):
 *   ALPACA_API_KEY_ID   — your Alpaca key ID
 *   ALPACA_SECRET_KEY   — your Alpaca secret key
 *   ALPACA_BASE_URL     — trading base (e.g. https://paper-api.alpaca.markets)
 *                         Data API always uses https://data.alpaca.markets
 */

import { type NextRequest, NextResponse } from 'next/server'

// ─── Config ───────────────────────────────────────────────────────────────────

const ALPACA_KEY_ID    = process.env.ALPACA_API_KEY_ID?.trim() ?? ''
const ALPACA_SECRET    = process.env.ALPACA_SECRET_KEY?.trim()  ?? ''
const DATA_API_BASE    = 'https://data.alpaca.markets'

if (!ALPACA_KEY_ID || !ALPACA_SECRET) {
  console.warn('[alpaca] ALPACA_API_KEY_ID or ALPACA_SECRET_KEY not set in environment')
}

// ─── Auth Headers ─────────────────────────────────────────────────────────────

const AUTH_HEADERS = {
  'APCA-API-KEY-ID':     ALPACA_KEY_ID,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Accept':              'application/json',
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AlpacaBar {
  t: string    // RFC-3339 timestamp
  o: number    // open
  h: number    // high
  l: number    // low
  c: number    // close
  v: number    // volume
  vw?: number  // volume-weighted avg price
  n?: number   // number of trades
}

export interface AlpacaSnapshot {
  symbol:        string
  latestTrade?:  { p: number; s: number; t: string; c?: string[] }
  latestQuote?:  { ap: number; as: number; bp: number; bs: number; t: string }
  dailyBar?:     AlpacaBar
  prevDailyBar?: AlpacaBar
  minuteBar?:    AlpacaBar
}

export interface AlpacaBarsResponse {
  bars:          Record<string, AlpacaBar[]>
  next_page_token?: string | null
}

export interface AlpacaSnapshotResponse {
  snapshots: Record<string, AlpacaSnapshot>
}

/** Normalised single-symbol quote shape returned to the frontend */
export interface AlpacaQuote {
  symbol:        string
  price:         number | null
  change:        number | null
  changePercent: number | null
  /**
   * Session open price from the current daily bar (`dailyBar.o`).
   * Use this to compute an intraday-only change for commodities and FX spots:
   *   dailyChangeDollars = price − open
   *   dailyChangePercent = (dailyChangeDollars / open) × 100
   * Avoids mixing in historical contract-rollover gaps that appear when
   * comparing against `prevDailyBar.c`.
   */
  open?:         number
  bid?:          number
  ask?:          number
  volume?:       number
  timestamp:     number
  bars?:         AlpacaBar[]
}

export interface AlpacaProxyResponse {
  quotes:    AlpacaQuote[]
  timestamp: number
  error?:    string
}

// ─── Fetch Helpers ────────────────────────────────────────────────────────────

async function alpacaFetch(path: string, signal?: AbortSignal): Promise<unknown> {
  const url = `${DATA_API_BASE}${path}`
  const res = await fetch(url, {
    headers: AUTH_HEADERS as Record<string, string>,
    cache:   'no-store',
    signal:  signal ?? AbortSignal.timeout(10_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Alpaca API ${res.status}: ${text.slice(0, 200)}`)
  }

  return res.json()
}

// ─── Verified Crypto Symbol Set ───────────────────────────────────────────────
// Alpaca's crypto/us endpoint only accepts these slash-format pairs.
// Any symbol passed with asset_class=crypto that is NOT in this list is rejected
// with HTTP 400 before any outbound fetch — stops the 404/502 retry loop for
// equity tickers accidentally tagged as crypto by callers.

const VERIFIED_CRYPTO_SYMBOLS = new Set([
  'BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD', 'DOGE/USD',
  'LINK/USD', 'LTC/USD', 'BCH/USD', 'XRP/USD',
  'AAVE/USD', 'UNI/USD', 'DOT/USD', 'ATOM/USD',
  'ALGO/USD', 'MATIC/USD', 'CRV/USD', 'MKR/USD',
])

// ─── Forex Symbol Set ─────────────────────────────────────────────────────────
// Precious-metal spots (XAUUSD = Gold, XAGUSD = Silver) and FX pairs must NOT
// be routed through the crypto endpoint — they are classified as forex by Alpaca
// and live under /v1beta1/forex/*.  Auto-detected even when asset_class=crypto is
// passed by the caller so callers don't need to update their query strings.

const FOREX_SYMBOLS = new Set([
  'XAUUSD', 'XAGUSD',                          // spot Gold / Silver
  'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD',      // major FX pairs
  'USDCAD', 'USDCHF', 'NZDUSD',
])

// ─── Forex Snapshots ──────────────────────────────────────────────────────────
// Alpaca forex endpoint: /v1beta1/forex/snapshots?currency_pairs=XAUUSD,XAGUSD
// Response shape: { "XAUUSD": { latestQuote, dailyBar, minuteBar, ... }, ... }
// We wrap it in { snapshots: { ... } } to reuse normaliseSnapshot unchanged.

async function fetchForexSnapshots(pairs: string[]): Promise<AlpacaSnapshotResponse> {
  const params = new URLSearchParams({ currency_pairs: pairs.join(',') })
  const raw = await alpacaFetch(`/v1beta1/forex/snapshots?${params}`) as Record<string, AlpacaSnapshot>
  return { snapshots: raw ?? {} }
}

// ─── Crypto Bars ──────────────────────────────────────────────────────────────
// Note: Alpaca's crypto/us endpoints do NOT accept a `feed` query parameter.

async function fetchCryptoBars(
  symbols: string[],
  timeframe = '1Day',
  limit = 30,
  start?: string,
  end?:   string,
): Promise<AlpacaBarsResponse> {
  const params = new URLSearchParams({
    symbols:   symbols.join(','),
    timeframe,
    limit:     String(limit),
    sort:      'asc',
  })
  // Without an explicit `start`, Alpaca's bars endpoint returns only the most
  // recent day (0–1 bars) — passing a real window is what yields full history.
  if (start) params.set('start', start)
  if (end)   params.set('end', end)
  return alpacaFetch(`/v1beta3/crypto/us/bars?${params}`) as Promise<AlpacaBarsResponse>
}

// ─── Crypto Snapshots ─────────────────────────────────────────────────────────

async function fetchCryptoSnapshots(symbols: string[]): Promise<AlpacaSnapshotResponse> {
  const params = new URLSearchParams({ symbols: symbols.join(',') })
  return alpacaFetch(`/v1beta3/crypto/us/snapshots?${params}`) as Promise<AlpacaSnapshotResponse>
}

// ─── US Equity Bars ───────────────────────────────────────────────────────────
// feed=iex  — IEX real-time data, available on all Alpaca plans (free tier included).
// feed=sip  — requires an Alpaca Unlimited subscription; returns 403 on free plans.

async function fetchEquityBars(
  symbols: string[],
  timeframe = '1Day',
  limit = 30,
  start?: string,
  end?:   string,
): Promise<AlpacaBarsResponse> {
  const params = new URLSearchParams({
    symbols:    symbols.join(','),
    timeframe,
    limit:      String(limit),
    sort:       'asc',
    feed:       'iex',        // IEX feed — free on all plans, no SIP subscription needed
    adjustment: 'split',
  })
  // Critical: Alpaca's /v2/stocks/bars with `sort=asc` and NO `start` returns
  // only the latest day (0–1 daily bars), which is why callers saw "0/1 priced".
  // Supplying a real `start` window (e.g. 400 days back) returns the full series.
  if (start) params.set('start', start)
  if (end)   params.set('end', end)
  return alpacaFetch(`/v2/stocks/bars?${params}`) as Promise<AlpacaBarsResponse>
}

// ─── US Equity Snapshots ──────────────────────────────────────────────────────
// feed=iex bypasses the SIP 403 restriction without any subscription upgrade.
//
// ⚠ Response-shape note:
//   /v1beta3/crypto/us/snapshots → { "snapshots": { "BTC/USD": {...} } }  — already wrapped
//   /v1beta1/forex/snapshots     → flat { "XAUUSD": {...} }               — needs wrap
//   /v2/stocks/snapshots         → flat { "SPY": {...}, "QQQ": {...} }    — needs wrap
//
// The crypto endpoint wraps its own response; the equity and forex endpoints do not.
// We normalise all three paths to { snapshots: {...} } so the route handler's
// snapData.snapshots?.[sym] lookup works identically for every asset class.

async function fetchEquitySnapshots(symbols: string[]): Promise<AlpacaSnapshotResponse> {
  const params = new URLSearchParams({
    symbols: symbols.join(','),
    feed:    'iex',           // IEX feed — free on all plans
  })
  const raw = await alpacaFetch(`/v2/stocks/snapshots?${params}`) as Record<string, AlpacaSnapshot>
  return { snapshots: raw ?? {} }
}

// ─── Normalise to AlpacaQuote ─────────────────────────────────────────────────

function normaliseSnapshot(
  symbol: string,
  snap: AlpacaSnapshot,
  bars?: AlpacaBar[],
): AlpacaQuote {
  // Price resolution order:
  //   1. latestTrade.p   — most recent IEX print (best during market hours)
  //   2. minuteBar.c     — last 1-min candle close (pre/post market or stale ticks)
  //   3. dailyBar.c      — today's session close  (off-hours fallback)
  //   4. prevDailyBar.c  — previous session close  (last resort — market never opened)
  //   5. bars[-1].c      — last historical bar injected by the snapshot+bars path
  const lastBarClose = bars?.length ? bars[bars.length - 1].c : undefined
  const price =
    snap.latestTrade?.p    ??
    snap.minuteBar?.c      ??
    snap.dailyBar?.c       ??
    snap.prevDailyBar?.c   ??
    lastBarClose           ??
    null

  // Use prevDailyBar as the change baseline (session-over-session % change).
  // Fall back to the oldest historical bar so change is never silently null.
  const firstBarClose = bars?.length ? bars[0].c : undefined
  const prevClose = snap.prevDailyBar?.c ?? firstBarClose ?? null

  const change        = price !== null && prevClose !== null ? price - prevClose : null
  const changePercent = change !== null && prevClose ? (change / prevClose) * 100 : null

  return {
    symbol,
    price:         price !== null ? parseFloat(price.toFixed(8)) : null,
    change:        change !== null ? parseFloat(change.toFixed(8)) : null,
    changePercent: changePercent !== null ? parseFloat(changePercent.toFixed(4)) : null,
    open:          snap.dailyBar?.o,   // session open — use for intraday-only change
    bid:           snap.latestQuote?.bp,
    ask:           snap.latestQuote?.ap,
    volume:        snap.dailyBar?.v,
    timestamp:     Date.now(),
    bars,
  }
}

function normaliseBarsOnly(symbol: string, bars: AlpacaBar[]): AlpacaQuote {
  const latest  = bars[bars.length - 1]
  const prev    = bars[bars.length - 2]
  const price   = latest?.c ?? null
  const prevClose = prev?.c ?? null
  const change        = price !== null && prevClose !== null ? price - prevClose : null
  const changePercent = change !== null && prevClose ? (change / prevClose) * 100 : null

  return {
    symbol,
    price,
    change,
    changePercent: changePercent !== null ? parseFloat(changePercent.toFixed(4)) : null,
    volume:        latest?.v,
    timestamp:     Date.now(),
    bars,
  }
}

// ─── Route Handler ─────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse<AlpacaProxyResponse>> {
  if (!ALPACA_KEY_ID || !ALPACA_SECRET) {
    return NextResponse.json(
      { quotes: [], timestamp: Date.now(), error: 'Alpaca credentials not configured — set ALPACA_API_KEY_ID and ALPACA_SECRET_KEY in .env.local' },
      { status: 503 }
    )
  }

  const { searchParams } = new URL(req.url)
  const type        = searchParams.get('type')        ?? 'snapshot'
  const symbolsRaw  = searchParams.get('symbols')     ?? 'BTC/USD,ETH/USD'
  const assetClass  = searchParams.get('asset_class') ?? 'crypto'
  const timeframe   = searchParams.get('timeframe')   ?? '1Day'
  const limitStr    = searchParams.get('limit')       ?? '30'
  const limit       = Math.min(Math.max(parseInt(limitStr, 10) || 30, 1), 1000)
  // Optional historical window for bars requests (YYYY-MM-DD or RFC-3339).
  const start       = searchParams.get('start')       ?? undefined
  const end         = searchParams.get('end')         ?? undefined

  const symbols = symbolsRaw.split(',').map(s => s.trim()).filter(Boolean)

  if (symbols.length === 0) {
    return NextResponse.json(
      { quotes: [], timestamp: Date.now(), error: 'No symbols provided' },
      { status: 400 }
    )
  }

  // Auto-promote precious metals and FX pairs to forex class regardless of what
  // the caller passed — they fail silently on the crypto endpoint.
  const hasForex  = symbols.some(s => FOREX_SYMBOLS.has(s))
  const isForex   = assetClass === 'forex' || hasForex
  const isCrypto  = !isForex && assetClass === 'crypto'

  // ── Crypto symbol guard ───────────────────────────────────────────────────
  // If the caller explicitly requests asset_class=crypto but sends a symbol
  // that Alpaca's crypto endpoint does not serve (e.g. an equity ticker like
  // "GLD" or an index like "^VIX"), reject immediately with 400 rather than
  // letting the crypto endpoint return 404 and triggering an upstream 502 loop.
  if (isCrypto) {
    const unsupported = symbols.filter(s => !VERIFIED_CRYPTO_SYMBOLS.has(s))
    if (unsupported.length > 0) {
      console.warn(
        `[alpaca] 400 — symbol(s) not supported for asset_class=crypto: ${unsupported.join(', ')}. ` +
        `Supported: ${[...VERIFIED_CRYPTO_SYMBOLS].join(', ')}`
      )
      return NextResponse.json(
        {
          quotes:    [],
          timestamp: Date.now(),
          error:     `Symbol(s) not supported for asset_class=crypto: ${unsupported.join(', ')}. ` +
                     `Use asset_class=us_equity for equities or asset_class=forex for metals/FX.`,
        },
        { status: 400 }
      )
    }
  }

  try {
    let quotes: AlpacaQuote[] = []

    if (type === 'bars') {
      // ── Bars only — no snapshot call ──────────────────────────────────────
      // Forex bars not yet supported by this proxy (Alpaca forex bars require a
      // separate endpoint); fall through to equity bars as a best-effort path.
      const barsData = isCrypto
        ? await fetchCryptoBars(symbols, timeframe, limit, start, end)
        : await fetchEquityBars(symbols, timeframe, limit, start, end)

      quotes = symbols.map(sym => {
        const bars = barsData.bars?.[sym] ?? []
        return normaliseBarsOnly(sym, bars)
      })

    } else {
      // ── Snapshot (+ bars if requested) ────────────────────────────────────
      const [snapData, barsData] = await Promise.all([
        isForex  ? fetchForexSnapshots(symbols)  :
        isCrypto ? fetchCryptoSnapshots(symbols) :
                   fetchEquitySnapshots(symbols),
        type === 'snapshot+bars'
          ? isCrypto
            ? fetchCryptoBars(symbols, timeframe, limit, start, end)
            : fetchEquityBars(symbols, timeframe, limit, start, end)
          : Promise.resolve(null),
      ])

      quotes = symbols.map(sym => {
        const snap = snapData.snapshots?.[sym]
        const bars = barsData?.bars?.[sym] ?? []
        if (!snap) return normaliseBarsOnly(sym, bars)
        return normaliseSnapshot(sym, snap, bars.length > 0 ? bars : undefined)
      })
    }

    const resolvedClass = isForex ? 'forex' : isCrypto ? 'crypto' : 'us_equity'
    console.info(
      `[alpaca] ${type} | ${resolvedClass} | ${symbols.join(',')} | ` +
      `${quotes.filter(q => q.price !== null).length}/${quotes.length} priced`
    )

    return NextResponse.json({ quotes, timestamp: Date.now() })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[alpaca] Fetch error:', message)
    return NextResponse.json(
      { quotes: [], timestamp: Date.now(), error: message },
      { status: 502 }
    )
  }
}
