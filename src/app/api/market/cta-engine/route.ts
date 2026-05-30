/**
 * /api/market/cta-engine — Systematic Trend & CTA Positioning
 * ─────────────────────────────────────────────────────────────────────────────
 * Returns one row per core asset with:
 *   - 50/200d EMA + EMA spread (clustering signal)
 *   - 14d MACD + ADX (momentum + trend strength)
 *   - Systematic regime label
 *   - CTA Trend-Intensity positioning score (0-100), derived PURELY from the
 *     asset's own historical daily bars (EMA ribbon) — no CFTC / external data.
 *
 * Data sources (historical daily bars only):
 *   • Alpaca v2 stocks/bars — start-dated ~400-day window per ETF (EMA200 floor)
 *   • IBKR CP API / FMP historical EOD — fallbacks when Alpaca is short
 *   • Alpaca snapshot — live price fallback (LIVE_TRACKING proxy) for empty bars
 *
 * Cache:
 *   In-memory module cache, 4 h TTL; ETF bars revalidate intraday.  Reused
 *   across requests in the same Node process.
 */

import { NextResponse } from 'next/server'
import {
  buildAssetRow,
  buildStaleRow,
  buildLiveProxyRow,
  type CTAAssetRow,
  type DailyBar,
  type LiveSnapshot,
} from '@/lib/market/ctaEngine'
import { fetchIBKRBarsMulti } from '@/lib/services/ibkrFetcher'
import { fetchFMPHistoricalBars, type FMPBar } from '@/lib/services/fmpFetcher'
import type { AlpacaBar, AlpacaProxyResponse } from '@/app/api/alpaca/route'

// ─── Config ───────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 4 * 60 * 60 * 1000  // 4h

// ─── Asset Universe ───────────────────────────────────────────────────────────
//
// Pure CTA trend matrix: each row is an Alpaca ETF proxy whose positioning is
// derived entirely from its own historical daily bars (EMA ribbon trend
// intensity).  No CFTC / external positioning data is involved.

interface CTAAssetConfig {
  asset: string   // display id (= ETF symbol)
  name:  string   // full label
  etf:   string   // Alpaca symbol
}

const CTA_UNIVERSE: CTAAssetConfig[] = [
  // ── Index ETFs ──────────────────────────────────────────────────────────
  { asset: 'SPY', name: 'S&P 500 ETF',          etf: 'SPY' },
  { asset: 'QQQ', name: 'Nasdaq-100 ETF',       etf: 'QQQ' },
  { asset: 'IWM', name: 'Russell 2000 ETF',     etf: 'IWM' },
  // ── Treasuries ──────────────────────────────────────────────────────────
  { asset: 'TLT', name: '20+ Year Treasuries',  etf: 'TLT' },
  // ── Commodities ─────────────────────────────────────────────────────────
  { asset: 'GLD', name: 'Gold ETF',             etf: 'GLD' },
  { asset: 'USO', name: 'WTI Crude Oil ETF',    etf: 'USO' },
]

// ─── In-memory cache ──────────────────────────────────────────────────────────

// Response rows carry the resolved bar provenance so the UI can flag rows that
// are running on synthetic fallback bars (PLACEHOLDER) rather than live data.
type CTAResponseRow = CTAAssetRow & { source: BarSource }

interface CacheEntry { rows: CTAResponseRow[]; timestamp: number }
declare global {
  // eslint-disable-next-line no-var
  var __ctaEngineCache: CacheEntry | undefined
}

// ─── Alpaca bar fetch ─────────────────────────────────────────────────────────

/**
 * Compute an ISO-8601 date string `daysBack` days in the past.
 * Single helper used to derive both `start` (deep lookback) and `end`
 * (latest queryable session) so the windowing math has one source of truth.
 */
function isoDateDaysAgo(daysBack: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - daysBack)
  return d.toISOString().slice(0, 10)
}

/** Months helper kept for readability — converts to days at 30/mo. */
function isoDateMonthsAgo(monthsBack: number): string {
  return isoDateDaysAgo(monthsBack * 30)
}

// ─── IBKR bar fetch ───────────────────────────────────────────────────────────

async function fetchBars(symbols: string[]): Promise<Record<string, DailyBar[]>> {
  const cleanedSymbols = [...new Set(symbols.map(s => s.trim().toUpperCase()).filter(Boolean))]
  return fetchIBKRBarsMulti(cleanedSymbols, 300)
}

// ─── Per-symbol bar cache ─────────────────────────────────────────────────────
//
// Caches the resolved DailyBar array per ETF symbol for BAR_CACHE_TTL_MS.
// Separate from the full-row __ctaEngineCache so bar data survives partial
// failures (e.g. CFTC timeout) and is reused on the next request without
// re-hitting Alpaca or FMP.

const BAR_CACHE_TTL_MS       = 60 * 60 * 1_000   // 1 hour — real data
const SYNTHETIC_CACHE_TTL_MS =  5 * 60 * 1_000   // 5 min  — retry providers quickly

type BarSource = 'alpaca' | 'ibkr' | 'fmp' | 'synthetic'

// ─── Alpaca historical-bars fetch ──────────────────────────────────────────────
//
// Primary source for daily bars.  Alpaca's us_equity IEX feed serves all of the
// CTA universe ETFs (SPY/QQQ/IWM/TLT/GLD/USO) on the live credentials, so every
// row computes real 50/200d EMA + ADX identically — no more synthetic flat bars
// or hard-coded placeholder prices for the non-SPY tickers.

const ALPACA_PROXY_BASE = process.env.NEXT_PUBLIC_BASE_URL
  ? `${process.env.NEXT_PUBLIC_BASE_URL}/api/alpaca`
  : 'http://localhost:3000/api/alpaca'

/** ~400 daily bars per symbol — comfortably exceeds the 200-bar EMA200/ADX floor. */
const ALPACA_BAR_LIMIT = 400

/**
 * Fetch one symbol's daily bars from the Alpaca proxy (us_equity, 1Day).
 * Returns [] on any failure so the caller can fall through to IBKR → FMP.
 *
 * ⚠ Per-symbol, NOT batched.  Alpaca's /v2/stocks/bars treats `limit` as a
 * total shared across every symbol in the request page — batching all six ETFs
 * into one call with limit=300 starves each to ~50 bars, far below the 200-bar
 * EMA200/ADX floor, which silently forced every row onto the fallback path.
 * Fetching each symbol independently guarantees each ETF its own full history.
 */
async function fetchAlpacaBarsForSymbol(symbol: string): Promise<DailyBar[]> {
  try {
    // Explicit 400-day window — without `start`, Alpaca returns only the latest
    // day (the "0/1 priced" bug).  400 calendar days ≈ 275 trading sessions,
    // comfortably above the 200-bar EMA200/ADX floor.
    const start = isoDateDaysAgo(400)
    const url =
      `${ALPACA_PROXY_BASE}?type=bars` +
      `&symbols=${encodeURIComponent(symbol)}` +
      `&asset_class=us_equity&timeframe=1Day&limit=${ALPACA_BAR_LIMIT}` +
      `&start=${start}`
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8_000) })
    if (!res.ok) {
      console.warn(`[cta-engine] Alpaca bars proxy returned ${res.status} for ${symbol}`)
      return []
    }
    const data = await res.json() as AlpacaProxyResponse
    const q    = data.quotes?.find(x => x.symbol === symbol) ?? data.quotes?.[0]
    const bars = q?.bars ?? []
    return bars.map((b: AlpacaBar) => ({
      t: b.t.slice(0, 10),   // RFC-3339 → YYYY-MM-DD
      o: b.o, h: b.h, l: b.l, c: b.c, v: b.v,
    }))
  } catch (err) {
    console.warn(`[cta-engine] Alpaca bars fetch failed for ${symbol}:`, err instanceof Error ? err.message : err)
    return []
  }
}

/**
 * Fetch LIVE snapshot quotes (price + day open/close boundaries) for the whole
 * universe in one proxy round-trip.  This is the fallback price source when an
 * asset's historical bars come back empty — the snapshot endpoint reliably
 * prices all 6 ETFs even when the daily-bar history does not.  Never throws;
 * symbols that don't price are simply absent from the returned map.
 */
async function fetchAlpacaSnapshots(symbols: string[]): Promise<Record<string, LiveSnapshot>> {
  if (symbols.length === 0) return {}
  try {
    const url =
      `${ALPACA_PROXY_BASE}?type=snapshot` +
      `&symbols=${encodeURIComponent(symbols.join(','))}` +
      `&asset_class=us_equity`
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8_000) })
    if (!res.ok) {
      console.warn(`[cta-engine] Alpaca snapshot proxy returned ${res.status}`)
      return {}
    }
    const data = await res.json() as AlpacaProxyResponse
    const out: Record<string, LiveSnapshot> = {}
    for (const q of data.quotes ?? []) {
      if (q.price == null) continue
      out[q.symbol] = {
        price:     q.price,
        open:      q.open ?? null,
        // Prior session close ≈ price − session change (when change is known).
        prevClose: q.change != null ? q.price - q.change : null,
      }
    }
    return out
  } catch (err) {
    console.warn('[cta-engine] Alpaca snapshot fetch failed:', err instanceof Error ? err.message : err)
    return {}
  }
}

interface BarCacheEntry {
  bars:      DailyBar[]
  expiresAt: number
  source:    BarSource
}

// NOTE: The old FALLBACK_PRICES map and makeFlatBars() synthetic-bar generator
// were removed.  They fabricated flat daily candles at hardcoded prices
// ($450 QQQ / $200 IWM / $90 TLT / $220 GLD / $70 USO), which rendered as
// "PLACEHOLDER" rows with $0.00-style metrics.  Every row now hydrates from the
// live Alpaca per-symbol feed; if a provider is briefly unavailable the row
// degrades to whatever real partial history exists (authentic last price) and
// is flagged DATA_STALE — never a fabricated price.

declare global {
  // eslint-disable-next-line no-var
  var __ctaBarsCache: Map<string, BarCacheEntry> | undefined
}

function getBarsCache(): Map<string, BarCacheEntry> {
  if (!globalThis.__ctaBarsCache) globalThis.__ctaBarsCache = new Map()
  return globalThis.__ctaBarsCache
}

// ─── Circuit breaker ──────────────────────────────────────────────────────────
//
// When IBKR times out or FMP returns 429, every subsequent request would block
// for 1.5 s (IBKR race) + FMP call × 6 symbols ≈ 9 s before reaching synthetic
// bars.  The circuit breaker short-circuits that loop:
//
//   IBKR breaker — trips on timeout; open for 10 min → skip IBKR batch call
//   FMP  breaker — trips on 429;    open for 10 min → skip all FMP calls
//
// When both are open the per-symbol loop jumps straight to synthetic flat bars,
// dropping response time from ~9 s to <200 ms.
//
// State lives on globalThis so it persists across Next.js hot-reloads and is
// shared across concurrent requests in the same Node process.

const CB_OPEN_MS = 10 * 60 * 1_000   // 10 minutes

declare global {
  // eslint-disable-next-line no-var
  var __ctaCB: { ibkrOpenUntil: number; fmpOpenUntil: number } | undefined
}

function getCB() {
  if (!globalThis.__ctaCB) globalThis.__ctaCB = { ibkrOpenUntil: 0, fmpOpenUntil: 0 }
  return globalThis.__ctaCB
}

function ibkrCBOpen(): boolean { return Date.now() < getCB().ibkrOpenUntil }
function fmpCBOpen():  boolean { return Date.now() < getCB().fmpOpenUntil  }

function tripIBKR(reason: string) {
  const until = Date.now() + CB_OPEN_MS
  getCB().ibkrOpenUntil = until
  console.warn(`[cta-engine] IBKR circuit OPEN for 10 min — ${reason}`)
}
function tripFMP(reason: string) {
  const until = Date.now() + CB_OPEN_MS
  getCB().fmpOpenUntil = until
  console.warn(`[cta-engine] FMP circuit OPEN for 10 min — ${reason}`)
}

// ─── fetchBarsWithFallback ────────────────────────────────────────────────────
//
// Resolution order per symbol (priority chain):
//   1. Per-symbol bar cache  (globalThis.__ctaBarsCache, 1h TTL)
//   2. IBKR CP API           (FIRST — localhost:4002, when the gateway is up)
//   3. FMP historical EOD    (SECOND — when the plan allows & not circuit-broken)
//   4. Alpaca daily bars     (THIRD / fallback — start-dated us_equity IEX feed)
//
// No synthetic/fabricated bars: if every live provider is short of 200 bars the
// longest real partial history is kept (authentic last price) and the row simply
// degrades to a DATA_STALE regime — which the route then hydrates into a live
// snapshot proxy (never a hardcoded placeholder price).

interface BarsWithSources {
  bars:    Record<string, DailyBar[]>
  sources: Record<string, BarSource>
}

async function fetchBarsWithFallback(symbols: string[]): Promise<BarsWithSources> {
  const barsCache = getBarsCache()
  const now       = Date.now()
  const result: Record<string, DailyBar[]> = {}
  const sources: Record<string, BarSource> = {}
  const needFetch: string[] = []

  for (const sym of symbols) {
    const entry = barsCache.get(sym)
    if (entry && entry.expiresAt > now) {
      result[sym]  = entry.bars
      sources[sym] = entry.source
      console.info(
        `[cta-engine] ${sym}: bar cache HIT (${entry.source}, ${entry.bars.length} bars)`,
      )
    } else {
      needFetch.push(sym)
    }
  }

  if (needFetch.length === 0) return { bars: result, sources }

  const startDate = isoDateMonthsAgo(18)
  const endDate   = isoDateDaysAgo(1)
  const expiresAt = now + BAR_CACHE_TTL_MS

  // ── 1. FIRST PRIORITY — IBKR CP API (batch) — 5 000 ms hard deadline ──────
  // Each historical-bars request has a 15 s internal timeout; racing against
  // 5 000 ms means we fall through to FMP / Alpaca in < 5 s when the CP Gateway
  // is unreachable.  Circuit breaker: skip the batch entirely if IBKR tripped
  // recently (timeout) so we don't burn 5 s on a gateway we know is down.
  let ibkrBars: Record<string, DailyBar[]> | null = null
  if (ibkrCBOpen()) {
    console.info('[cta-engine] IBKR circuit OPEN — skipping batch fetch')
  } else {
    try {
      // Hold a reference to the IBKR promise so we can silence its background
      // rejection after the timeout wins the race (avoids an unhandled
      // rejection warning when the internal AbortError eventually fires).
      const ibkrBarsPromise = fetchBars(needFetch)
      ibkrBarsPromise.catch(() => { /* background rejection silenced */ })

      ibkrBars = await Promise.race([
        ibkrBarsPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('IBKR bars timeout (5000ms)')), 5_000),
        ),
      ])
    } catch (ibkrErr) {
      const msg = ibkrErr instanceof Error ? ibkrErr.message : String(ibkrErr)
      console.warn(`[cta-engine] IBKR fetch failed: ${msg}`)
      if (msg.includes('timeout') || msg.includes('Timeout')) {
        tripIBKR(msg)
      }
    }
  }

  // ── 2. Per-symbol resolution: IBKR → FMP → Alpaca → longest partial ───────
  for (const sym of needFetch) {
    // ── FIRST: IBKR bars ────────────────────────────────────────────────────
    const ibkrResult = ibkrBars?.[sym] ?? []
    if (ibkrResult.length >= 200) {
      result[sym]  = ibkrResult
      sources[sym] = 'ibkr'
      barsCache.set(sym, { bars: ibkrResult, expiresAt, source: 'ibkr' })
      console.info(`[cta-engine] ${sym}: IBKR bars — ${ibkrResult.length} bars`)
      continue
    }

    // ── SECOND: FMP historical EOD (skip if circuit-broken on 429) ──────────
    let fmpBars: FMPBar[] | null = null
    if (fmpCBOpen()) {
      console.info(`[cta-engine] ${sym}: FMP circuit OPEN — skipping FMP fetch`)
    } else {
      try {
        fmpBars = await fetchFMPHistoricalBars(sym, startDate, endDate)
      } catch (fmpErr) {
        const msg = fmpErr instanceof Error ? fmpErr.message : String(fmpErr)
        console.warn(`[cta-engine] ${sym}: FMP historical bars failed: ${msg}`)
        if (msg.includes('429')) {
          tripFMP(msg)
        }
      }
    }
    const fmpMapped: DailyBar[] = fmpBars
      ? fmpBars.map(b => ({ t: b.date, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume }))
      : []
    if (fmpMapped.length >= 200) {
      result[sym]  = fmpMapped
      sources[sym] = 'fmp'
      barsCache.set(sym, { bars: fmpMapped, expiresAt, source: 'fmp' })
      console.info(`[cta-engine] ${sym}: FMP fallback — ${fmpMapped.length} bars`)
      continue
    }

    // ── THIRD / FALLBACK: Alpaca daily bars (start-dated per-symbol) ─────────
    // The reliable last-resort when IBKR is disconnected and FMP is unavailable
    // or rate-limited.  Parses the returned bar array's closing prices into the
    // 200-bar series the EMA50/EMA200 clustering needs.
    const alpacaResult = await fetchAlpacaBarsForSymbol(sym)
    if (alpacaResult.length >= 200) {
      result[sym]  = alpacaResult
      sources[sym] = 'alpaca'
      barsCache.set(sym, { bars: alpacaResult, expiresAt, source: 'alpaca' })
      console.info(`[cta-engine] ${sym}: Alpaca fallback bars — ${alpacaResult.length} bars`)
      continue
    }

    // ── No provider returned ≥ 200 bars ─────────────────────────────────────
    // Keep the longest real partial history (authentic last price); the route
    // then hydrates a LIVE_TRACKING snapshot proxy from it.  Never fabricated.
    const partials: Array<{ bars: DailyBar[]; src: BarSource }> = [
      { bars: ibkrResult,   src: 'ibkr'   },
      { bars: fmpMapped,    src: 'fmp'    },
      { bars: alpacaResult, src: 'alpaca' },
    ]
    const best = partials.reduce((a, b) => (b.bars.length > a.bars.length ? b : a))
    result[sym]  = best.bars
    sources[sym] = best.src
    // Short TTL so the live providers are retried quickly once they recover.
    barsCache.set(sym, { bars: best.bars, expiresAt: now + SYNTHETIC_CACHE_TTL_MS, source: best.src })
    console.warn(
      `[cta-engine] ${sym}: no provider returned ≥200 bars ` +
      `(IBKR: ${ibkrResult.length}, FMP: ${fmpMapped.length}, Alpaca: ${alpacaResult.length}) — ` +
      `using longest real partial (${best.bars.length} bars from ${best.src}); row → snapshot proxy`,
    )
  }

  return { bars: result, sources }
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET() {
  // Serve cached payload within TTL window.
  const cached = globalThis.__ctaEngineCache
  const age    = cached ? Date.now() - cached.timestamp : Infinity
  if (cached && age < CACHE_TTL_MS) {
    return NextResponse.json(
      { rows: cached.rows, cached: true, ageSeconds: Math.round(age / 1000) },
      { headers: { 'Cache-Control': 'no-store', 'X-Cache': 'HIT' } },
    )
  }

  try {
    // Parallel — historical bars (Alpaca → IBKR → FMP) + live snapshots (price
    // fallback for empty-bar assets).  Positioning is pure trend intensity from
    // the bars — no CFTC fetch.
    const etfSymbols = CTA_UNIVERSE.map(c => c.etf)
    const [{ bars: barsMap, sources }, snapshots] = await Promise.all([
      fetchBarsWithFallback(etfSymbols),
      fetchAlpacaSnapshots(etfSymbols),
    ])

    const rows: CTAResponseRow[] = []
    let computedCount = 0
    for (let i = 0; i < CTA_UNIVERSE.length; i++) {
      const cfg  = CTA_UNIVERSE[i]
      const bars = barsMap[cfg.etf] ?? []
      // Every symbol resolves to a real provider ('alpaca' | 'ibkr' | 'fmp') in
      // fetchBarsWithFallback — synthetic flat bars were removed.  The 'alpaca'
      // default here is only a defensive fallback that never triggers in practice.
      const source: BarSource = sources[cfg.etf] ?? 'alpaca'
      try {
        let row = buildAssetRow({
          asset: cfg.asset,
          name:  cfg.name,
          bars,
        })

        // Insufficient bar history would emit a DATA_STALE stub.  If a live
        // Alpaca snapshot priced this symbol (the common case), hydrate a
        // LIVE_TRACKING proxy row from the day's open/close boundaries instead
        // of returning an empty/dead row.
        if (row.regime === 'DATA_STALE_OR_MISSING' && snapshots[cfg.etf]) {
          row = buildLiveProxyRow({
            asset:    cfg.asset,
            name:     cfg.name,
            snapshot: snapshots[cfg.etf],
          })
          console.info(`[cta-engine] ${cfg.asset}: LIVE PROXY from snapshot @ ${snapshots[cfg.etf].price}`)
        }

        rows.push({ ...row, source })
        // LIVE_TRACKING proxy rows carry real live numbers — count them as
        // computed so the payload caches and isn't flagged all-stale.
        if (row.regime !== 'DATA_STALE_OR_MISSING') computedCount++
        else console.warn(`[cta-engine] ${cfg.asset} stub row (${bars.length} bars, no snapshot)`)
      } catch (err) {
        // Defensive: any unexpected throw still degrades to a stub row
        // so the response stays 200 and the row stays visible.
        console.error(`[cta-engine] ${cfg.asset} unexpected error → stub row:`, err)
        rows.push({ ...buildStaleRow({ asset: cfg.asset, name: cfg.name, bars }), source })
      }
    }

    // We always return a 200 with whatever rows we have — even if every
    // row is a stub.  Empty rows array would only happen if CTA_UNIVERSE
    // is itself empty, which would be a deployment-time misconfiguration.
    if (rows.length === 0) {
      return NextResponse.json(
        { rows: [], error: 'CTA universe is empty', cached: false },
        { status: 200, headers: { 'Cache-Control': 'no-store', 'X-Cache': 'EMPTY' } },
      )
    }

    // Only persist to cache when at least one row has real EMA/MACD data —
    // otherwise the next request would see an all-stub payload as a fresh
    // HIT and we'd serve degraded data for the full TTL window.
    if (computedCount === 0) {
      console.warn('[cta-engine] all rows are stubs — skipping cache write')
      return NextResponse.json(
        { rows, cached: false, allStale: true },
        { headers: { 'Cache-Control': 'no-store', 'X-Cache': 'STUB' } },
      )
    }

    globalThis.__ctaEngineCache = { rows, timestamp: Date.now() }

    return NextResponse.json(
      { rows, cached: false },
      { headers: { 'Cache-Control': 'no-store', 'X-Cache': 'MISS' } },
    )
  } catch (err) {
    console.error('[cta-engine]', err)
    // Serve stale cache (if any) on hard failure.
    if (cached) {
      return NextResponse.json(
        { rows: cached.rows, cached: true, stale: true, ageSeconds: Math.round(age / 1000) },
        { headers: { 'Cache-Control': 'no-store', 'X-Cache': 'STALE' } },
      )
    }
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err), rows: [] },
      { status: 502 },
    )
  }
}
