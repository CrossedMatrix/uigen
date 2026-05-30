/**
 * FMP (Financial Modeling Prep) Quote Service
 * ─────────────────────────────────────────────────────────────────────────────
 * Server-side quote fetcher with a per-symbol 30-minute in-memory cache.
 * Multiple API routes share the same globalThis cache to prevent duplicate
 * upstream calls and protect the 250 daily-call budget on free/starter plans.
 *
 * Supported FMP symbol formats:
 *   Volatility  : ^VIX, ^VVIX, ^MOVE, ^SKEW, ^PCCE
 *   Spot indices: ^GSPC, ^NDX, ^DJI, ^RUT
 *   Rates       : ^IRX, ^FVX, ^TNX, ^TYX
 *   FX          : EURUSD, GBPUSD, USDJPY, AUDUSD
 *   Crypto      : BTCUSD, ETHUSD
 *
 * ── Commodity quotes are NOT routed through FMP ──
 *   Commodity exposure (GLD / SLV / USO / BNO / CPER / UNG) is served by
 *   Alpaca's us_equity feed.  Spot symbols (GCUSD / XAGUSD / CLUSD) were
 *   decommissioned in Nov 2026 because each market-page render burned three
 *   calls against the FMP daily quota and produced cascade 429s.
 *
 * Environment variables (set in .env.local):
 *   FMP_API_KEY — your Financial Modeling Prep API key
 *                 Get one free at https://financialmodelingprep.com/developer/docs
 *
 * Cache design:
 *   - Symbol-level TTL: each symbol cached for TTL_MS independently
 *   - Batch fetch: only stale/missing symbols hit the network per request
 *   - Stale-on-error: expired entries returned as fallback when FMP is down
 *   - globalThis: survives hot-module-reload in dev, shared between route handlers
 */

import { logSystemError } from '@/lib/errorLog'

const FMP_API_KEY        = process.env.FMP_API_KEY?.trim() ?? ''
// Stable (non-legacy) base — replaces the deprecated api/v3 path-param style.
// New format: GET /stable/quote?symbol=AAPL,^VIX&apikey=KEY
// Old format: GET /api/v3/quote/AAPL,^VIX?apikey=KEY  ← deprecated Aug 2025
const FMP_BASE           = 'https://financialmodelingprep.com/stable'
const TTL_MS             = 30 * 60 * 1_000   // 30-minute quote cache window
const FMP_402_BACKOFF_MS = 10 * 60 * 1_000   // 10-minute 402 circuit-breaker window

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface FMPQuote {
  symbol:            string
  price:             number
  change:            number
  changesPercentage: number   // e.g. -4.5 means -4.5%
  previousClose:     number
  dayHigh:           number
  dayLow:            number
  volume:            number | null
  marketCap:         number | null
  timestamp:         number   // JS milliseconds (FMP returns UNIX seconds; we convert)
}

// ─── Internal Cache ───────────────────────────────────────────────────────────

interface FMPCacheEntry {
  quote:     FMPQuote
  expiresAt: number   // Date.now() + TTL_MS at fetch time
}

declare global {
  // eslint-disable-next-line no-var
  var __fmpCache: Map<string, FMPCacheEntry> | undefined
  /**
   * 402 circuit-breaker: maps symbol → expiry timestamp (Date.now() + 10 min).
   * Symbols are blocked until their expiry passes, then automatically unblocked
   * so the system retries after the backoff window — unlike a permanent Set,
   * this self-heals if the FMP plan is upgraded or the 402 was transient.
   */
  // eslint-disable-next-line no-var
  var __fmpSkippedSymbols: Map<string, number> | undefined
  // eslint-disable-next-line no-var
  var __fmp402Logged: boolean | undefined
}

/**
 * Returns the 402 circuit-breaker map (symbol → expiresAt timestamp).
 * Expired entries are pruned on every call so the map stays compact.
 */
function getSkippedSymbols(): Map<string, number> {
  if (!globalThis.__fmpSkippedSymbols) globalThis.__fmpSkippedSymbols = new Map()
  const map = globalThis.__fmpSkippedSymbols
  const now = Date.now()
  // Prune expired entries so cleared symbols are retried automatically
  for (const [sym, exp] of map) {
    if (exp <= now) map.delete(sym)
  }
  return map
}

function getCache(): Map<string, FMPCacheEntry> {
  if (!globalThis.__fmpCache) {
    globalThis.__fmpCache = new Map()
  }
  return globalThis.__fmpCache
}

// ─── Main Fetcher ─────────────────────────────────────────────────────────────

/**
 * Fetch quotes for the given symbols from FMP, honouring the 30-min cache.
 *
 * Only stale or absent symbols trigger a network request — fresh entries are
 * returned directly from the in-memory cache. This means multiple Next.js
 * route handlers (vol-risk, market, …) can all call this function without
 * multiplying upstream API usage.
 *
 * @param symbols — FMP-format symbol strings (e.g. ['^VIX', '^TNX'])
 * @returns       — Map keyed by symbol string; missing symbols omitted
 */
export async function fetchFMPQuotes(
  symbols: string[],
): Promise<Map<string, FMPQuote>> {
  if (symbols.length === 0) return new Map()

  if (!FMP_API_KEY) {
    console.warn('[fmpFetcher] FMP_API_KEY not set — skipping FMP fetch')
    return new Map()
  }

  // ── Drop symbols blocked by the 402 circuit-breaker ─────────────────────
  // getSkippedSymbols() prunes expired entries, so symbols whose 10-min backoff
  // has elapsed are automatically re-admitted on the next poll cycle.
  const skipped = getSkippedSymbols()
  const now     = Date.now()
  const active  = symbols.filter(s => {
    const exp = skipped.get(s)
    return exp === undefined || exp <= now   // undefined = never blocked, or expired
  })
  if (active.length < symbols.length) {
    const blocked = symbols.filter(s => (skipped.get(s) ?? 0) > now)
    const remainSec = Math.ceil(((skipped.get(blocked[0]) ?? now) - now) / 1_000)
    console.info(
      `[fmpFetcher] Skipping ${blocked.length} 402-blocked symbol(s) ` +
      `(~${remainSec}s remaining): ${blocked.join(', ')}`
    )
  }
  if (active.length === 0) return new Map()

  const cache   = getCache()
  const result  = new Map<string, FMPQuote>()
  const missing: string[] = []

  // ── Partition: cached (fresh) vs. missing (stale or never fetched) ─────────
  for (const sym of active) {
    const entry = cache.get(sym)
    if (entry && entry.expiresAt > now) {
      result.set(sym, entry.quote)
    } else {
      missing.push(sym)
    }
  }

  if (missing.length === 0) {
    const ageS = Math.round((now - (cache.get(symbols[0])!.expiresAt - TTL_MS)) / 1_000)
    console.info(
      `[fmpFetcher] CACHE HIT — ${symbols.length} symbol(s) (approx ${ageS}s old)`
    )
    return result
  }

  // ── Network fetch for stale/missing symbols ────────────────────────────────
  console.info(
    `[fmpFetcher] Fetching ${missing.length}/${symbols.length} stale/missing symbol(s) from FMP`
  )

  // Stable API: symbols are a comma-separated query param, not a path segment.
  // Symbols containing special chars (^, /) are percent-encoded individually.
  const encoded = missing.map(encodeURIComponent).join(',')
  const url     = `${FMP_BASE}/quote?symbol=${encoded}&apikey=${FMP_API_KEY}`

  try {
    const res = await fetch(url, {
      cache:  'no-store',
      signal: AbortSignal.timeout(10_000),
    })

    if (res.status === 402) {
      // 402 = Payment Required — these symbols need a higher FMP plan tier.
      // Block for FMP_402_BACKOFF_MS (10 min) then auto-retry.  Log once per
      // backoff window so the console never floods with repeated 402 messages.
      const blockedUntil = Date.now() + FMP_402_BACKOFF_MS
      if (!globalThis.__fmp402Logged) {
        globalThis.__fmp402Logged = true
        const msg =
          `FMP 402 — plan limit. Circuit-breaking ${missing.length} symbol(s) ` +
          `for ${FMP_402_BACKOFF_MS / 60_000} min: ${missing.join(', ')}. ` +
          `They will retry automatically after the backoff window.`
        console.error(`[fmpFetcher] ${msg}`)
        logSystemError('fmp', 402, msg)
        // Auto-clear the "logged" flag after the backoff so the next 402
        // (if the plan is still limited) emits a fresh log entry.
        setTimeout(() => { globalThis.__fmp402Logged = false }, FMP_402_BACKOFF_MS)
      }
      for (const sym of missing) skipped.set(sym, blockedUntil)
      return result   // return whatever cache entries we already have
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      const msg  = `FMP API ${res.status}: ${text.slice(0, 200)}`
      logSystemError('fmp', res.status, msg)
      throw new Error(msg)
    }

    const raw = (await res.json()) as Array<Record<string, unknown>>
    const expiresAt = now + TTL_MS

    for (const item of raw) {
      const sym = String(item.symbol ?? '')
      if (!sym) continue

      const quote: FMPQuote = {
        symbol:            sym,
        price:             Number(item.price             ?? 0),
        change:            Number(item.change            ?? 0),
        changesPercentage: Number(item.changesPercentage ?? 0),
        previousClose:     Number(item.previousClose     ?? 0),
        dayHigh:           Number(item.dayHigh           ?? 0),
        dayLow:            Number(item.dayLow            ?? 0),
        volume:            item.volume    != null ? Number(item.volume)    : null,
        marketCap:         item.marketCap != null ? Number(item.marketCap) : null,
        // FMP timestamps are UNIX seconds; convert to JS milliseconds
        timestamp:         Number(item.timestamp ?? 0) * 1_000,
      }

      cache.set(sym, { quote, expiresAt })
      result.set(sym, quote)
    }

    console.info(
      `[fmpFetcher] FRESH — ${raw.length}/${missing.length} symbol(s) returned` +
      ` | cache expires in ${TTL_MS / 60_000}min`
    )

    return result

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[fmpFetcher] Fetch error: ${message}`)

    // ── Stale-on-error: return expired cache entries rather than nothing ─────
    for (const sym of missing) {
      const stale = cache.get(sym)
      if (stale) {
        result.set(sym, stale.quote)
        console.warn(`[fmpFetcher] Serving stale entry for ${sym} after fetch failure`)
      }
    }

    return result
  }
}

// ─── Historical Daily Bars ────────────────────────────────────────────────────
//
// Separate cache from quote cache — bars are bulkier and have a 1-hour TTL
// (quotes need 30-min freshness; bars for EMA200 only need daily resolution).
//
// Endpoint: GET /stable/historical-price-eod/full?symbol=SPY&from=...&to=...&apikey=KEY
// Response: { historical: [{ date, open, high, low, close, volume, ... }] }
//           OR [{ symbol, historical: [...] }] in batch mode (handled below).

export interface FMPBar {
  date:   string   // YYYY-MM-DD
  open:   number
  high:   number
  low:    number
  close:  number
  volume: number
}

const HIST_TTL_MS = 60 * 60 * 1_000   // 1-hour cache for EOD bar data

interface FMPHistCacheEntry {
  bars:      FMPBar[]
  expiresAt: number
}

declare global {
  // eslint-disable-next-line no-var
  var __fmpHistCache: Map<string, FMPHistCacheEntry> | undefined
}

function getHistCache(): Map<string, FMPHistCacheEntry> {
  if (!globalThis.__fmpHistCache) {
    globalThis.__fmpHistCache = new Map()
  }
  return globalThis.__fmpHistCache
}

/**
 * Fetch historical EOD daily bars for a single equity/ETF symbol from FMP.
 * Results are cached in-process for 1 hour (HIST_TTL_MS) to protect the
 * daily API quota during local-dev refreshes.
 *
 * Throws on 429 or missing API key — callers should catch and fall back to
 * synthetic mock data.  On other HTTP errors, stale cache is returned if
 * available, otherwise re-throws.
 */
export async function fetchFMPHistoricalBars(
  symbol:    string,
  startDate: string,   // YYYY-MM-DD  (inclusive)
  endDate:   string,   // YYYY-MM-DD  (inclusive)
): Promise<FMPBar[]> {
  if (!FMP_API_KEY) {
    throw new Error('[fmpFetcher] FMP_API_KEY not set — cannot fetch historical bars')
  }

  const cacheKey = `${symbol}:${startDate}:${endDate}`
  const cache    = getHistCache()
  const now      = Date.now()
  const entry    = cache.get(cacheKey)

  if (entry && entry.expiresAt > now) {
    console.info(`[fmpFetcher] HIST HIT — ${symbol} (${entry.bars.length} bars cached)`)
    return entry.bars
  }

  const url =
    `${FMP_BASE}/historical-price-eod/full` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&from=${startDate}&to=${endDate}` +
    `&apikey=${FMP_API_KEY}`

  const res = await fetch(url, {
    cache:  'no-store',
    signal: AbortSignal.timeout(12_000),
  })

  if (res.status === 429) {
    throw new Error(`[fmpFetcher] FMP 429 — rate limited for ${symbol}`)
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err  = new Error(`[fmpFetcher] FMP ${res.status} for ${symbol}: ${text.slice(0, 200)}`)
    if (entry) {
      console.warn(`[fmpFetcher] ${symbol}: HTTP ${res.status} — returning stale bars`)
      return entry.bars
    }
    throw err
  }

  const raw = await res.json()

  // Handle both single-symbol { historical: [...] } and batch [{ symbol, historical: [...] }]
  const historical: Array<Record<string, unknown>> = Array.isArray(raw)
    ? ((raw[0]?.historical as Array<Record<string, unknown>>) ?? [])
    : ((raw.historical     as Array<Record<string, unknown>>) ?? [])

  const bars: FMPBar[] = historical
    .map(b => ({
      date:   String(b.date   ?? ''),
      open:   Number(b.open   ?? 0),
      high:   Number(b.high   ?? 0),
      low:    Number(b.low    ?? 0),
      close:  Number(b.close  ?? 0),
      volume: Number(b.volume ?? 0),
    }))
    .filter(b => b.date.length === 10 && Number.isFinite(b.close) && b.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date))   // oldest → newest

  cache.set(cacheKey, { bars, expiresAt: now + HIST_TTL_MS })
  console.info(
    `[fmpFetcher] HIST FRESH — ${symbol}: ${bars.length} bars ` +
    `(${startDate} → ${endDate}), cached ${HIST_TTL_MS / 60_000}min`,
  )
  return bars
}
