import { NextResponse } from 'next/server'
import { fetchIBKRSnapshotQuotes, type IBKRSnapshotQuote } from '@/lib/services/ibkrFetcher'
import { fetchFMPQuotes, type FMPQuote } from '@/lib/services/fmpFetcher'
import {
  calculateMacroSignals,
  type YieldCurveSignal,
  type YieldObservation,
} from '@/lib/market/macroSignals'
import { getMacroSignal, type MacroSignal } from '@/lib/macro-engine'

// ─── Market Data API Route ────────────────────────────────────────────────────
// Assembles the main dashboard market payload: futures, equities, rates, FX,
// commodities, volatility indices, and cross-asset ratios.
//
// Data providers:
//   Alpaca Markets — crypto (BTC/USD), US equity ETFs (GLD, SLV, USO, BNO,
//                    CPER, UNG, …) — **all commodity exposure**
//   FMP            — vol indices (^VIX, ^VVIX, ^SKEW), spot indices (^GSPC…),
//                    rates (^TNX…)
// NB: FMP commodity-spot symbols (GCUSD/XAGUSD/CLUSD) were decommissioned
//     to stop their daily quota from triggering 429 rate-limit blocks.  The
//     commodity ETF tickers above carry all our commodity pricing now.

const SYMBOL_NAMES: Record<string, string> = {
  // INDEX ETF PROXIES — replaces legacy /ES /NQ /YM /RTY futures symbols.
  // Alpaca serves these as us_equity snapshots (IEX feed, free tier).
  // Names mirror ETF_DISPLAY_NAMES in dashboard/page.tsx for consistent labels.
  'SPY': 'S&P 500',
  'QQQ': 'Nasdaq 100',
  'DIA': 'Dow Jones',
  'IWM': 'Russell 2000',
  // SPOT INDICES
  '^GSPC': 'S&P 500 Cash',
  '^NDX':  'Nasdaq 100 Cash',
  '^DJI':  'Dow Jones Cash',
  '^RUT':  'Russell 2000 Cash',
  // VOLATILITY
  '^VIX':  'VIX (Equity Vol)',
  '^VVIX': 'Vol of Vol',
  '^SKEW': 'CBOE Skew',
  '^MOVE': 'Bond Vol Index',
  // RATES
  '^IRX':  '3-Month Treasury',
  '^FVX':  '5-Year Treasury',
  '^TNX':  '10-Year Treasury',
  '^TYX':  '30-Year Treasury',
  // FX / CRYPTO
  'DX-Y.NYB': 'US Dollar Index',
  'EURUSD=X': 'EUR/USD',
  'GBPUSD=X': 'GBP/USD',
  'JPY=X':    'USD/JPY',
  'CNY=X':    'USD/CNY',
  'AUDUSD=X': 'AUD/USD',
  'BTC/USD':  'Bitcoin',
  // COMMODITY ETFs (Alpaca us_equity — GLD/SLV/USO/BNO/CPER/UNG)
  'GLD':  'Gold (GLD)',
  'SLV':  'Silver (SLV)',
  'USO':  'WTI Oil (USO)',
  'BNO':  'Brent Oil (BNO)',
  'CPER': 'Copper (CPER)',
  'UNG':  'NatGas (UNG)',
  // SECTOR ETFs
  'SOXX': 'Semiconductor ETF',
  'EWY':  'Korea ETF',
  // (FMP commodity-spot entries removed — see route header.  Commodity
  // ratios now resolve exclusively against the Alpaca ETF proxies above.)
}

// ─── Provider Quote (provider-agnostic shape used inside this route) ──────────

interface ProviderQuote {
  symbol:                string
  price:                 number
  change:                number
  changePercent:         number
  high?:                 number
  low?:                  number
}

// ─── FMP → ProviderQuote adapter ──────────────────────────────────────────────

function fmpToProvider(q: FMPQuote): ProviderQuote {
  return {
    symbol:        q.symbol,
    price:         q.price,
    change:        q.change,
    changePercent: q.changesPercentage,   // FMP uses %, matches our schema
    high:          q.dayHigh || undefined,
    low:           q.dayLow  || undefined,
  }
}

// ─── FMP symbol set — anything Alpaca cannot serve ────────────────────────────
// Vol indices: ^VIX, ^VVIX, ^SKEW (Alpaca rejects ^ prefix)
// Spot indices: ^GSPC, ^NDX, ^DJI, ^RUT
// Rates       : ^IRX, ^FVX, ^TNX, ^TYX (FMP maps these correctly)
//
// ── Commodity spot (GCUSD / XAGUSD / CLUSD) was REMOVED in Nov 2026 ──
//   Every market-page render fired three commodity-spot calls into FMP,
//   eating the daily 250-call quota in well under an hour and producing
//   cascade 429 errors that blanked the whole dashboard.
//   We now lean entirely on the Alpaca commodity-ETF feed (GLD / SLV /
//   USO / BNO / CPER / UNG) — same trading-cost-of-carry exposure, no
//   third-party quota.

const FMP_SYMBOLS = [
  // Vol surface
  '^VIX', '^VVIX', '^SKEW',
  // Put/Call Equity Ratio (CBOE, updates post-close daily)
  '^PCCE',
  // Spot indices
  '^GSPC', '^NDX', '^DJI', '^RUT',
  // Rates
  '^IRX', '^FVX', '^TNX', '^TYX',
  // (commodity spot symbols intentionally absent — see header note above)
] as const

// ─── Alpaca Data Fetcher ──────────────────────────────────────────────────────
// Calls the /api/alpaca proxy (credentials stay server-side).
// Alpaca supports: crypto (BTC/USD, ETH/USD) and US equities (SPY, QQQ, etc.)
// Not supported: index futures (ES=F), VIX/MOVE/SKEW, FX rates, Treasury rates.

const ALPACA_PROXY_BASE = process.env.NEXT_PUBLIC_BASE_URL
  ? `${process.env.NEXT_PUBLIC_BASE_URL}/api/alpaca`
  : 'http://localhost:3000/api/alpaca'

async function fetchQuotes(symbols: string[]): Promise<ProviderQuote[]> {
  if (symbols.length === 0) return []

  // Crypto: slash-format only (e.g. BTC/USD, ETH/USD)
  const cryptoSymbols  = symbols.filter(s => s.includes('/'))

  // Equity: plain uppercase tickers that Alpaca's us_equity endpoint accepts.
  // Explicitly exclude:
  //   ^  — cash indices (^VIX, ^GSPC)  — not available on Alpaca
  //   =F — futures (ES=F, GC=F)         — not available on Alpaca
  //   =X — FX pairs (EURUSD=X, JPY=X)  — not available on Alpaca
  //   .  — dotted suffixes (.NYB, .NYQ) — not available on Alpaca
  //   -  — Yahoo-style crypto (BTC-USD) — use slash format instead (BTC/USD)
  const equitySymbols  = symbols.filter(
    s => !s.includes('/') &&
         !s.startsWith('^') &&
         !s.includes('=') &&    // catches =F, =X, any other = variants
         !s.includes('.') &&    // catches .NYB, .NYQ
         !s.includes('-')       // catches BTC-USD, ETH-USD (Yahoo-format crypto)
  )

  const results: ProviderQuote[] = []

  const fetchGroup = async (syms: string[], assetClass: string) => {
    if (syms.length === 0) return
    try {
      const url = `${ALPACA_PROXY_BASE}?type=snapshot&symbols=${encodeURIComponent(syms.join(','))}&asset_class=${assetClass}`
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8000) })
      if (!res.ok) return
      const data = await res.json() as { quotes?: ProviderQuote[] }
      for (const q of data.quotes ?? []) {
        if (q.price !== null) results.push(q)
      }
    } catch { /* provider unavailable */ }
  }

  await Promise.all([
    fetchGroup(cryptoSymbols, 'crypto'),
    fetchGroup(equitySymbols, 'us_equity'),
  ])

  return results
}

// ─── Sparkline Generators ─────────────────────────────────────────────────────

// Seeded LCG for deterministic synthetic sparklines (shape only — not prices).
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

function multiTFSparklines(symbol: string, price: number, change: number) {
  const start = price - change
  const seed  = symbol.split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return {
    '1D': seededSparkline(start, price, 78, seed + 1),
    '5D': seededSparkline(start * 0.98, price, 24, seed + 2),
    '1M': seededSparkline(price * 0.95, price, 22, seed + 3),
    '3M': seededSparkline(price * 0.88, price, 65, seed + 4),
  }
}

// ─── Unavailable-data skeleton ────────────────────────────────────────────────

function getUnavailableData(isMarketOpen: boolean) {
  const nullInstrument = (symbol: string, name: string) => ({
    symbol, name,
    price: null, change: null, changePercent: null,
    sparkline: [], sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] },
  })

  return {
    futures: [
      { ...nullInstrument('SPY', 'S&P 500'),     sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
      { ...nullInstrument('QQQ', 'Nasdaq 100'),  sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
      { ...nullInstrument('DIA', 'Dow Jones'),   sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
      { ...nullInstrument('IWM', 'Russell 2000'),sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
    ],
    equities: [
      nullInstrument('^GSPC', 'S&P 500'),
      nullInstrument('^NDX',  'NASDAQ 100'),
      nullInstrument('^DJI',  'DOW JONES'),
      nullInstrument('^RUT',  'RUSSELL 2000'),
    ],
    rates: [
      nullInstrument('^IRX', '3-Month'),
      nullInstrument('^FVX', '5-Year'),
      nullInstrument('^TNX', '10-Year'),
      nullInstrument('^TYX', '30-Year'),
    ],
    fx: [
      { ...nullInstrument('DX-Y.NYB', 'DXY'),     sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
      { ...nullInstrument('EURUSD=X', 'EUR/USD'),  sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
      { ...nullInstrument('GBPUSD=X', 'GBP/USD'),  sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
      { ...nullInstrument('JPY=X',    'USD/JPY'),  sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
      { ...nullInstrument('CNY=X',    'USD/CNY'),  sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
      { ...nullInstrument('AUDUSD=X', 'AUD/USD'),  sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
      { ...nullInstrument('BTC/USD',  'Bitcoin'),  sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
    ],
    commodities: [
      { ...nullInstrument('GLD',  'Gold (GLD)'),     sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
      { ...nullInstrument('SLV',  'Silver (SLV)'),   sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
      { ...nullInstrument('USO',  'WTI Oil (USO)'),  sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
      { ...nullInstrument('BNO',  'Brent (BNO)'),    sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
      { ...nullInstrument('CPER', 'Copper (CPER)'),  sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
      { ...nullInstrument('UNG',  'NatGas (UNG)'),   sparklines: { '1D': [], '5D': [], '1M': [], '3M': [] } },
    ],
    volatility: {
      vix:          { symbol: '^VIX',  name: 'VIX',       price: null, change: null, changePercent: null, sparkline: [] },
      vvix:         { symbol: '^VVIX', name: 'VVIX',      price: null, change: null, changePercent: null, sparkline: [] },
      skew:         { symbol: '^SKEW', name: 'CBOE SKEW', price: null, change: null, changePercent: null, sparkline: [] },
      putCallRatio: 0.72,
    },
    ratios: {
      copperGoldRatio: 0,
      goldSilverRatio: 0,
      vixVvixRatio:    0,
      btcGoldRatio:    0,
      oilGoldRatio:    0,
      yield2y10y:      0,
    },
    timestamp: Date.now(),
    isMarketOpen,
  }
}

// ─── Market Hours ─────────────────────────────────────────────────────────────

function isMarketCurrentlyOpen(): boolean {
  const now   = new Date()
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now)
  const weekday     = parts.find(p => p.type === 'weekday')?.value ?? ''
  const hour        = parseInt(parts.find(p => p.type === 'hour')?.value   ?? '0', 10)
  const minute      = parseInt(parts.find(p => p.type === 'minute')?.value ?? '0', 10)
  const isWeekday   = !['Sat', 'Sun'].includes(weekday)
  const minuteOfDay = hour * 60 + minute
  return isWeekday && minuteOfDay >= 570 && minuteOfDay < 960
}

// ─── Cross-Asset Ratios ────────────────────────────────────────────────────────

interface CrossAssetRatios {
  copperGoldRatio: number
  goldSilverRatio: number
  vixVvixRatio:    number
  btcGoldRatio:    number
  oilGoldRatio:    number
  yield2y10y:      number
}

function computeRatios(qmap: Map<string, ProviderQuote>): CrossAssetRatios {
  const p = (sym: string) => qmap.get(sym)?.price ?? 0

  // Cross-asset ratios now resolve exclusively against the Alpaca ETF
  // proxies.  GCUSD / XAGUSD / CLUSD spot symbols were removed from the
  // FMP basket — see route header.  The ETF prices track underlying spot
  // closely enough for the relative-value ratios we render.
  const gold   = p('GLD')
  const silver = p('SLV')
  const oil    = p('USO')
  const copper = p('CPER')

  const vix  = p('^VIX')
  const vvix = p('^VVIX')
  const btc  = p('BTC/USD')
  const tnx  = p('^TNX')
  const fvx  = p('^FVX')

  return {
    copperGoldRatio: gold   > 0 ? copper / gold   : 0,
    goldSilverRatio: silver > 0 ? gold   / silver  : 0,
    vixVvixRatio:    vvix   > 0 ? vix    / vvix    : 0,
    btcGoldRatio:    gold   > 0 ? btc    / gold    : 0,
    oilGoldRatio:    gold   > 0 ? oil    / gold    : 0,
    yield2y10y:      tnx - fvx,
  }
}

// ─── FRED yield-history mini-fetch ───────────────────────────────────────────
//
// Fetches the last 16 daily observations of DGS10 and DGS2 from the FRED API
// to power the macro signal engine.  16 obs gives a clean 5-day SMA baseline
// plus 14 day-over-day changes for the velocity-shock calculation.
//
// FRED response is sorted descending (newest first); we reverse to oldest→newest
// before passing to calculateMacroSignals.
//
// Key design choices:
//   • Runs in parallel with the existing Alpaca/IBKR/FMP fetches — zero added
//     latency on the critical path.
//   • Uses Next.js `next: { revalidate: 900 }` (15 min) so the CDN absorbs
//     the FRED round-trip on the vast majority of requests.
//   • Races against a 3 000 ms hard deadline; on timeout returns null so the
//     route still delivers a full market payload — yieldCurveSignal is just null.
//   • Falls back to null when FRED_API_KEY is absent (demo mode).

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations'

interface FredObs { date: string; value: string }

async function fetchFredYieldHistory(
  seriesId: string,
  limit = 16,
): Promise<YieldObservation[]> {
  const apiKey = process.env.FRED_API_KEY?.trim()
  if (!apiKey) return []

  const params = new URLSearchParams({
    series_id:  seriesId,
    api_key:    apiKey,
    file_type:  'json',
    sort_order: 'desc',
    limit:      String(limit),
  })

  const res = await fetch(`${FRED_BASE}?${params}`, {
    next: { revalidate: 900 },   // 15-min CDN cache — FRED updates once/day
  })

  if (!res.ok) throw new Error(`FRED ${seriesId} → HTTP ${res.status}`)

  const json = await res.json()
  if (json.error_message) throw new Error(`FRED ${seriesId} → ${json.error_message}`)

  // Filter FRED's '.' sentinel (weekends / holidays) and reverse to ascending
  const valid: YieldObservation[] = (json.observations as FredObs[])
    .filter(o => o.value !== '.' && o.value.trim() !== '')
    .map(o  => ({ date: o.date, rate: parseFloat(o.value) }))
    .filter(o => Number.isFinite(o.rate))
    .reverse()   // oldest → newest for SMA / velocity calculations

  return valid
}

/**
 * Fetch DGS10 + DGS2 in parallel, compute the macro yield-curve signal.
 * Returns null if either series is unavailable or the combined fetch times out.
 */
async function fetchYieldCurveSignal(): Promise<YieldCurveSignal | null> {
  try {
    const [yield10y, yield2y] = await Promise.all([
      fetchFredYieldHistory('DGS10', 16),
      fetchFredYieldHistory('DGS2',  16),
    ])

    if (yield10y.length === 0 || yield2y.length === 0) return null

    return calculateMacroSignals({ yield10y, yield2y })
  } catch (err) {
    console.warn(
      '[market-api] FRED yield-curve signal failed:',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

// ─── WALCL Momentum Fetcher ───────────────────────────────────────────────────
//
// Fetches ~17 weekly WALCL observations from FRED to derive a rolling
// 14-day (≈2-week) momentum direction.  Weekly FRED data means 2 obs span
// ~14 calendar days; we use the most recent vs. the one 2 obs ago.
//
// Returns a typed object ready to pass straight into getMacroSignal().

interface WalclMomentum {
  liquidityDirection:   'expanding' | 'contracting' | 'flat'
  liquidityMomentum14d: number
}

async function fetchWalclMomentum(): Promise<WalclMomentum> {
  const FLAT_THRESHOLD = 0.05 // 0.05 % — treat as flat when change is tiny

  try {
    const obs = await fetchFredYieldHistory('WALCL', 17)
    // WALCL is weekly; 2 obs back ≈ 14 calendar days
    if (obs.length < 3) {
      return { liquidityDirection: 'flat', liquidityMomentum14d: 0 }
    }

    const latest = obs[obs.length - 1].rate
    const prior  = obs[obs.length - 3].rate  // ~14 days ago (2 weekly obs)

    if (!Number.isFinite(latest) || !Number.isFinite(prior) || prior === 0) {
      return { liquidityDirection: 'flat', liquidityMomentum14d: 0 }
    }

    const momentum14d = ((latest - prior) / prior) * 100

    const liquidityDirection: 'expanding' | 'contracting' | 'flat' =
      Math.abs(momentum14d) < FLAT_THRESHOLD
        ? 'flat'
        : momentum14d > 0
          ? 'expanding'
          : 'contracting'

    return { liquidityDirection, liquidityMomentum14d: momentum14d }
  } catch {
    return { liquidityDirection: 'flat', liquidityMomentum14d: 0 }
  }
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET() {
  const marketOpen = isMarketCurrentlyOpen()

  // Index ETF proxies — Alpaca us_equity (IEX feed, free tier).
  // Replaces the old /ES /NQ /YM /RTY futures symbols that Alpaca cannot serve.
  // SPY ≈ S&P 500, QQQ ≈ Nasdaq-100, DIA ≈ Dow Jones, IWM ≈ Russell 2000.
  const etfSymbols     = ['SPY', 'QQQ', 'DIA', 'IWM']
  // Spot indices and vol/rate symbols are fetched via FMP (Alpaca rejects ^ prefix)
  const equitySymbols  = ['^GSPC', '^NDX', '^DJI', '^RUT']
  const volSymbols     = ['^VIX', '^VVIX', '^SKEW']
  const rateSymbols    = ['^IRX', '^FVX', '^TNX', '^TYX']
  // BTC/USD — Alpaca crypto format (slash, not Yahoo's BTC-USD)
  const fxSymbols      = ['DX-Y.NYB', 'EURUSD=X', 'GBPUSD=X', 'JPY=X', 'CNY=X', 'AUDUSD=X', 'BTC/USD']
  // Commodity ETF proxies (Alpaca us_equity) — GC=F/SI=F/CL=F formats rejected by Alpaca
  const commSymbols    = ['GLD', 'SLV', 'USO', 'BNO', 'CPER', 'UNG']
  const allSymbols     = [...etfSymbols, ...equitySymbols, ...volSymbols, ...rateSymbols, ...fxSymbols, ...commSymbols]

  try {
    // Primary: Alpaca (equities/crypto/ETFs) + IBKR snapshot (^-prefixed indices,
    // vol, rates) — both in parallel, both honour their own server-side caches.
    // Race IBKR snapshot against a 1 500 ms hard deadline.  The CP Gateway's
    // internal warm-up sequence (5 s POST + 600 ms wait + 10 s GET) blocks for
    // ~16 s when the gateway is unreachable.  Losing the race immediately falls
    // back to FMP so the market route returns in < 1.5 s instead of 16 s.
    // The IBKR promise is kept in a separate variable so we can attach a
    // .catch() to it.  Without this, when the 1500ms timeout wins the race the
    // IBKR promise is still running in the background; its eventual rejection
    // (e.g. Cancel: AbortError from the internal 5s sub-controller) would reach
    // Node.js with no handler → UnhandledPromiseRejectionWarning.
    const ibkrSnapshotPromise = fetchIBKRSnapshotQuotes([...FMP_SYMBOLS])
    ibkrSnapshotPromise.catch(() => { /* background rejection silenced */ })

    const ibkrSnapshotWithTimeout = Promise.race([
      ibkrSnapshotPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('IBKR snapshot timeout (1500ms)')), 1500),
      ),
    ])

    // FRED yield-curve signal + WALCL momentum — both race in parallel so they
    // add zero latency to the critical Alpaca/IBKR path.  Hard deadline of
    // 3 000 ms; on timeout or key-absent the signal keys are null/degraded
    // and the rest of the payload is unaffected.
    const FRED_DEADLINE_MS = 3000
    const yieldCurveSignalPromise = Promise.race([
      fetchYieldCurveSignal(),
      new Promise<null>(resolve => setTimeout(() => resolve(null), FRED_DEADLINE_MS)),
    ])
    const walclMomentumPromise = Promise.race([
      fetchWalclMomentum(),
      new Promise<WalclMomentum>(resolve =>
        setTimeout(() => resolve({ liquidityDirection: 'flat', liquidityMomentum14d: 0 }), FRED_DEADLINE_MS),
      ),
    ])

    const [alpacaQuotes, ibkrMap, yieldCurveSignal, walclMomentum] = await Promise.all([
      fetchQuotes(allSymbols),
      ibkrSnapshotWithTimeout.catch((err: unknown) => {
        console.warn(
          '[market-api] IBKR snapshot unavailable, falling back to FMP: ' +
          (err instanceof Error ? err.message : String(err)),
        )
        return new Map<string, IBKRSnapshotQuote>()
      }),
      yieldCurveSignalPromise,
      walclMomentumPromise,
    ])

    // FMP fallback: only fetch symbols IBKR didn't return (gateway down / warm-up)
    const missingFromIBKR = FMP_SYMBOLS.filter(s => !ibkrMap.has(s))
    const fmpMap = missingFromIBKR.length > 0
      ? await fetchFMPQuotes(missingFromIBKR).catch(() => new Map<string, FMPQuote>())
      : new Map<string, FMPQuote>()

    // Merge priority: Alpaca → IBKR → FMP
    const qmap = new Map(alpacaQuotes.map(q => [q.symbol, q]))
    for (const [sym, iq] of ibkrMap) {
      qmap.set(sym, {
        symbol:        sym,
        price:         iq.price,
        change:        iq.change,
        changePercent: iq.changePercent,
        high:          iq.high  || undefined,
        low:           iq.low   || undefined,
      })
    }
    for (const [sym, fq] of fmpMap) {
      if (!qmap.has(sym)) {
        qmap.set(sym, fmpToProvider(fq))
      }
    }

    const hasAnyData = qmap.size > 0

    // No quotes returned — provider not yet configured; serve null-price skeleton.
    if (!hasAnyData) {
      console.info('[market-api] No quotes from either provider — serving unavailable skeleton')
      return NextResponse.json(getUnavailableData(marketOpen))
    }

    // Unified macro signal — combines WALCL liquidity momentum with the
    // yield-curve regime into a single institutional bias + explanation.
    // Always produces a value (getMacroSignal never throws); degrades to
    // CAUTIOUS_GROWTH / flat when FRED data is unavailable.
    const macroSignal: MacroSignal = getMacroSignal({
      liquidityDirection:   walclMomentum.liquidityDirection,
      liquidityMomentum14d: walclMomentum.liquidityMomentum14d,
      yieldCurveSignal,
    })

    const ratios = computeRatios(qmap)

    const fmtBase = (symbol: string) => {
      const q = qmap.get(symbol)
      return {
        symbol,
        name:          SYMBOL_NAMES[symbol] ?? symbol,
        price:         q?.price         ?? null,
        change:        q?.change        ?? null,
        changePercent: q?.changePercent ?? null,
        high:          q?.high,
        low:           q?.low,
      }
    }

    // Build the "futures" payload from ETF symbols so the tape and grid
    // both receive live Alpaca prices.  The field stays named "futures" for
    // backward compat with the dashboard MarketData type.
    const futures = etfSymbols.map(sym => {
      const base = fmtBase(sym)
      const mock = base.price !== null
        ? multiTFSparklines(sym, base.price, base.change ?? 0)
        : { '1D': [], '5D': [], '1M': [], '3M': [] }
      return { ...base, sparklines: mock }
    })

    const fxWithTF = fxSymbols.map(sym => {
      const base = fmtBase(sym)
      const mock = base.price !== null
        ? multiTFSparklines(sym, base.price, base.change ?? 0)
        : { '1D': [], '5D': [], '1M': [], '3M': [] }
      return { ...base, sparklines: mock }
    })

    const commWithTF = commSymbols.map(sym => {
      const base = fmtBase(sym)
      const mock = base.price !== null
        ? multiTFSparklines(sym, base.price, base.change ?? 0)
        : { '1D': [], '5D': [], '1M': [], '3M': [] }
      return { ...base, sparklines: mock }
    })

    const fmtVol = (sym: string) => ({ ...fmtBase(sym), sparkline: [] })

    return NextResponse.json({
      futures,
      equities:    equitySymbols.map(sym => ({ ...fmtBase(sym), sparkline: [] })),
      rates:       rateSymbols.map(sym   => ({ ...fmtBase(sym), sparkline: [] })),
      fx:          fxWithTF,
      commodities: commWithTF,
      volatility: {
        vix:          fmtVol('^VIX'),
        vvix:         fmtVol('^VVIX'),
        skew:         fmtVol('^SKEW'),
        // ^PCCE = CBOE Equity Put/Call Ratio; updates daily post-close.
        // Fall back to 0.78 (historical neutral) when FMP is unconfigured.
        putCallRatio: qmap.get('^PCCE')?.price ?? 0.78,
      },
      ratios,
      // Macro yield-curve signal — null when FRED_API_KEY is absent or the
      // FRED fetch timed out.  Consumers should guard: signal?.regime ?? 'NEUTRAL'
      yieldCurveSignal,
      // Unified macro signal — liquidity × curve matrix.  Always present;
      // degrades gracefully to CAUTIOUS_GROWTH when FRED data is unavailable.
      macroSignal,
      timestamp:    Date.now(),
      isMarketOpen: marketOpen,
    })
  } catch (err) {
    console.error('[market-api] Unexpected error:', err)
    return NextResponse.json(getUnavailableData(marketOpen))
  }
}
