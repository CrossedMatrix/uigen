import { NextResponse } from 'next/server'
import type { MacroRiskMetrics, DataSourceMap } from '@/components/dashboard/MacroRiskMatrix'
import { ema } from '@/lib/market/ctaEngine'

// NOTE: FMP was removed from this route in Nov 2026 to eliminate the 429
// rate-limit cascade.  Vol metrics now resolve as follows:
//
//   VIX        → VIXY snapshot from Alpaca (1-month VIX futures ETF —
//                same vol regime as ^VIX, traded on Alpaca's free IEX feed)
//   VVIX/MOVE/SKEW/PCCE → derived baselines (Alpaca's equity tape does not
//                carry these CBOE/ICE indices).  Marked `dataSource: 'derived'`
//                so the UI can flag them distinctly from the live VIX number.

/**
 * Volatility & Risk Indicators API Route
 * ─────────────────────────────────────────────────────────────────────────────
 * Fetches VIX, VVIX, MOVE, SKEW, and CBOE Equity Put/Call Ratio.
 * Derives the gamma field from VIX level (no direct market index exists for dealer
 * gamma — it is synthesized from VIX regime thresholds).
 *
 * Data provider: Alpaca Markets (stub returns empty until SDK is initialised).
 *
 * SWR caching strategy (mirrors /api/market-nodes):
 *   - Weekday: 60s TTL  — vol indices update in near real-time during market hours
 *   - Weekend: 4h TTL   — indices don't move on weekends; re-timestamp on stale hit
 *
 * Symbols fetched:
 *   ^VIX   — CBOE Volatility Index (equity 30d implied vol)
 *   ^VVIX  — Vol of Vol Index (implied vol of VIX options)
 *   ^MOVE  — ICE BofA MOVE Index (bond market implied vol)
 *   ^SKEW  — CBOE Skew Index (tail-risk premium in SPX options)
 *   ^PCCE  — CBOE Equity Put/Call Ratio (daily, updated post-close)
 */

// ─── TTL constants ─────────────────────────────────────────────────────────────
const TTL_WEEKDAY_MS = 60_000          // 1 minute during market hours
const TTL_WEEKEND_MS = 14_400_000      // 4 hours on weekends

// ─── Cold-start fallback ───────────────────────────────────────────────────────
// Returned as 200 OK when FMP is unreachable AND no prior cache entry exists.
// Values are plausible historical medians — clearly non-zero so the UI renders
// a meaningful baseline rather than blank gauges.  The dashboard consumer
// (useVolRisk) treats any valid MacroRiskMetrics shape as live-ish data and
// will silently replace it once the first real FMP fetch succeeds.
// All-baseline dataSource for fallback payloads
const BASELINE_SOURCE: DataSourceMap = {
  vix: 'baseline', vvix: 'baseline', move: 'baseline',
  skew: 'baseline', gamma: 'baseline', putCallRatio: 'baseline',
}

// dataSource when VIXY is live and everything else is β-derived
const LIVE_SOURCE: DataSourceMap = {
  vix:          'live',     // direct Alpaca VIXY snapshot
  vvix:         'derived',  // retained for type compat — not rendered
  move:         'derived',  // baseline × (1 + VIX_pct × 0.30)
  skew:         'derived',  // baseline × (1 + VIX_pct × 0.20)
  gamma:        'derived',  // retained for type compat — not rendered
  putCallRatio: 'baseline', // no live feed — long-run mean 0.78
}

const COLD_START_FALLBACK: MacroRiskMetrics = {
  vix:  { price: 18.0,  change: 0, changePercent: 0 },
  vvix: { price: 90.0,  change: 0, changePercent: 0, previousClose: 90.0 },
  move: { price: 115.0, change: 0, changePercent: 0, historicalMean: 115 },
  gamma: { price: 0.45, change: 0, changePercent: 0, regime: 'medium' },
  skew: { price: 130.0, change: 0, changePercent: 0 },
  putCallRatio: 0.78,
  timestamp: 0,            // 0 signals "no real data yet" to consumers
  dataSource: BASELINE_SOURCE,
}

// ─── Cache ─────────────────────────────────────────────────────────────────────
interface CacheEntry {
  data:      MacroRiskMetrics
  timestamp: number
}

declare global {
  // eslint-disable-next-line no-var
  var __volRiskCache: CacheEntry | undefined
}

// ─── Weekend detection (matches market-nodes strategy) ────────────────────────
function isWeekendWindow(): boolean {
  const now  = new Date()
  const day  = now.getUTCDay()
  const hour = now.getUTCHours()
  return (
    day === 6 ||                         // Saturday (all day)
    day === 0 ||                         // Sunday (all day)
    (day === 5 && hour >= 22) ||         // Friday after 22:00 UTC (~5pm ET close)
    (day === 1 && hour < 1)              // Monday before 01:00 UTC (buffer)
  )
}

// ─── Provider Quote ───────────────────────────────────────────────────────────
// VIX comes from Alpaca's snapshot of VIXY (1-month VIX futures ETF).
// We hit the same /api/alpaca proxy the rest of the dashboard uses so
// credentials stay server-side and Alpaca's own caching applies.

interface VolQuote {
  symbol:                    string
  regularMarketPrice:        number
  regularMarketChange:       number
  regularMarketChangePercent: number
}

const ALPACA_PROXY_BASE = process.env.NEXT_PUBLIC_BASE_URL
  ? `${process.env.NEXT_PUBLIC_BASE_URL}/api/alpaca`
  : 'http://localhost:3000/api/alpaca'

// VIXY (1-month VIX-futures ETF) trades on its own share-price scale (~$23.30),
// NOT the cash-VIX implied-vol scale (~17-18).  Surfacing the raw $23.30 as the
// VIX value distorted every downstream calc that expects implied-vol units:
//   • gamma thresholds (vix < 15 / < 25)
//   • the MOVE/VIX stress ratio (norm 6.5×)
//   • the MOVE/VIXY cross-vol divergence score
// Normalize the nominal ETF price onto the cash-VIX baseline (≈ the route's own
// COLD_START vix: 18).  0.75 maps VIXY $23.30 → VIX ≈ 17.5.  Percentage moves are
// scale-invariant, so changePercent passes through unchanged.
const VIXY_TO_VIX_SCALE = 0.75

/**
 * Pull live VIXY data from Alpaca (no FMP).  Returns a single-entry map
 * keyed by `^VIX` so the downstream metrics builder can keep its existing
 * key shape — only the data origin changes.
 */
async function fetchVolQuotes(_symbols: string[]): Promise<Map<string, VolQuote>> {
  const result = new Map<string, VolQuote>()

  try {
    const url = `${ALPACA_PROXY_BASE}?type=snapshot&symbols=VIXY&asset_class=us_equity`
    const res = await fetch(url, {
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    })
    if (!res.ok) {
      console.warn(`[vol-risk] Alpaca VIXY snapshot returned ${res.status}`)
      return result
    }
    const data = await res.json() as {
      quotes?: Array<{
        symbol: string
        price: number | null
        change: number | null
        changePercent: number | null
      }>
    }
    const vixy = data.quotes?.find(q => q.symbol === 'VIXY' && q.price !== null)
    if (vixy && vixy.price !== null) {
      // VIXY tracks the same volatility regime as ^VIX, but on a different
      // numeric scale ($23.30 share price vs ~17.5 index level).  Normalize it
      // onto the cash-VIX implied-vol scale before surfacing it under the ^VIX
      // key the metrics builder expects.
      result.set('^VIX', {
        symbol:                     '^VIX',
        regularMarketPrice:         parseFloat((vixy.price * VIXY_TO_VIX_SCALE).toFixed(2)),
        regularMarketChange:        parseFloat(((vixy.change ?? 0) * VIXY_TO_VIX_SCALE).toFixed(2)),
        regularMarketChangePercent: vixy.changePercent ?? 0,   // % is scale-invariant
      })
    }
  } catch (e) {
    console.warn('[vol-risk] Alpaca VIXY fetch failed:', e)
  }

  return result
}

// ─── Credit & FX stress (Alpaca ETF daily bars) ────────────────────────────────
// Two institutional cross-asset stress gauges, both from the live Alpaca tape:
//   Credit Stress → HYG (HY credit) ÷ TLT (duration) ratio vs its 50d MA.
//   FX Dollar    → UUP (dollar proxy) extension above/below its 50d EMA.

/** Fetch ascending daily closes for one symbol from the Alpaca proxy. */
async function fetchDailyCloses(symbol: string): Promise<number[]> {
  try {
    const start = new Date(Date.now() - 130 * 86_400_000).toISOString().slice(0, 10)
    const url =
      `${ALPACA_PROXY_BASE}?type=bars&symbols=${encodeURIComponent(symbol)}` +
      `&asset_class=us_equity&timeframe=1Day&limit=130&start=${start}`
    const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(8_000) })
    if (!res.ok) {
      console.warn(`[vol-risk] Alpaca bars ${symbol} → ${res.status}`)
      return []
    }
    const data = await res.json() as {
      quotes?: Array<{ symbol: string; bars?: Array<{ c: number }> }>
    }
    const q = data.quotes?.find(x => x.symbol === symbol) ?? data.quotes?.[0]
    return (q?.bars ?? []).map(b => b.c)
  } catch (e) {
    console.warn(`[vol-risk] Alpaca bars ${symbol} fetch failed:`, e)
    return []
  }
}

/** Compute the Credit Stress + FX Dollar Stress metrics; fields are undefined
 *  when bar history is insufficient so the rest of the payload is unaffected. */
async function fetchCreditFxMetrics(): Promise<{
  credit: MacroRiskMetrics['credit']
  fx:     MacroRiskMetrics['fx']
}> {
  const [hyg, tlt, uup] = await Promise.all([
    fetchDailyCloses('HYG'),
    fetchDailyCloses('TLT'),
    fetchDailyCloses('UUP'),
  ])

  // ── Credit Stress: HYG / TLT ratio vs its 50-day moving average ──
  let credit: MacroRiskMetrics['credit']
  if (hyg.length >= 50 && tlt.length >= 50) {
    const n = Math.min(hyg.length, tlt.length)
    const series: number[] = []
    for (let i = 0; i < n; i++) {
      const h = hyg[hyg.length - n + i]
      const t = tlt[tlt.length - n + i]
      if (t > 0) series.push(h / t)
    }
    if (series.length >= 50) {
      const ratio  = series[series.length - 1]
      const last50 = series.slice(-50)
      const ma50   = last50.reduce((a, b) => a + b, 0) / last50.length
      const distress = ratio < ma50
      // Stress score: 20 = stable; scales up with how far the ratio sits below
      // its 50d MA (a sharp break lower = credit distress / squeeze).
      const belowPct = ((ma50 - ratio) / ma50) * 100        // positive when below
      const score = distress ? Math.round(Math.min(100, 20 + Math.max(0, belowPct) * 16)) : 20
      credit = {
        ratio:    parseFloat(ratio.toFixed(4)),
        ma50:     parseFloat(ma50.toFixed(4)),
        score,
        distress,
      }
    }
  }

  // ── FX Dollar Stress: UUP extension vs its 50-day EMA ──
  let fx: MacroRiskMetrics['fx']
  if (uup.length >= 50) {
    const price = uup[uup.length - 1]
    const ema50 = ema(uup, 50)
    if (Number.isFinite(ema50) && ema50 > 0) {
      const extensionPct = ((price - ema50) / ema50) * 100
      fx = {
        price:        parseFloat(price.toFixed(2)),
        ema50:        parseFloat(ema50.toFixed(2)),
        extensionPct: parseFloat(extensionPct.toFixed(2)),
        squeeze:      extensionPct > 1.5,
      }
    }
  }

  return { credit, fx }
}

// ─── Gamma Derivation ─────────────────────────────────────────────────────────
/**
 * Synthesize dealer gamma exposure from VIX level.
 * Low VIX → dealers are short gamma (options they sold are close to expiry)
 *          → explosive, non-mean-reverting intraday moves
 * High VIX → dealers are long gamma (buying from panicked sellers)
 *          → mean-reverting, vol-selling environment
 *
 * price is normalized to 0–1 so the MacroRiskMatrix bar renders correctly:
 *   0.00 = VIX = 0  (impossible in practice, but consistent with UI contract)
 *   1.00 = VIX ≥ 40 (extreme stress / crisis territory)
 */
function deriveGamma(
  vix:              number,
  vixChange:        number,
  vixChangePercent: number,
): MacroRiskMetrics['gamma'] {
  const price    = parseFloat(Math.min(Math.max(vix / 40, 0), 1).toFixed(4))
  const regime: 'low' | 'medium' | 'high' =
    vix < 15 ? 'low' : vix < 25 ? 'medium' : 'high'
  const change        = parseFloat((vixChange / 40).toFixed(4))
  const changePercent = parseFloat(vixChangePercent.toFixed(2))
  return { price, change, changePercent, regime }
}

// ─── Baseline constants for FMP-less derived metrics ─────────────────────────
// VVIX is retained in the type contract for backward compat with cached payloads
// but is no longer rendered in the UI (removed from the Top-6 grid).
const BASELINE = {
  vvix:        90.0,
  move:        115.0,
  skew:        130.0,
  putCall:     0.78,
} as const

const VOL_BETA = {
  vvix: 0.50,
  move: 0.30,
  skew: 0.20,
} as const

// ─── Metrics Builder ──────────────────────────────────────────────────────────
function buildMetrics(qmap: Map<string, VolQuote>): MacroRiskMetrics {
  const vixQ = qmap.get('^VIX')

  // ── Live values from Alpaca (VIXY proxy) ─────────────────────────────────
  const vixPrice  = vixQ?.regularMarketPrice         ?? 0
  const vixChange = vixQ?.regularMarketChange        ?? 0
  const vixPct    = vixQ?.regularMarketChangePercent ?? 0

  // ── Derive related vol metrics from VIX % change × β coefficient ─────────
  // The baseline is preserved when VIX is flat; spikes propagate to VVIX/
  // MOVE/SKEW proportionally so the matrix doesn't sit frozen during
  // intraday stress events.
  const deriveLevel = (base: number, beta: number) =>
    parseFloat((base * (1 + (vixPct / 100) * beta)).toFixed(2))
  const deriveChangePct = (beta: number) =>
    parseFloat((vixPct * beta).toFixed(2))

  const vvixPrice = deriveLevel(BASELINE.vvix, VOL_BETA.vvix)
  const vvixPct   = deriveChangePct(VOL_BETA.vvix)
  const vvixChange = parseFloat((vvixPrice - BASELINE.vvix).toFixed(2))

  const movePrice = deriveLevel(BASELINE.move, VOL_BETA.move)
  const movePct   = deriveChangePct(VOL_BETA.move)
  const moveChange = parseFloat((movePrice - BASELINE.move).toFixed(2))

  const skewPrice = deriveLevel(BASELINE.skew, VOL_BETA.skew)
  const skewPct   = deriveChangePct(VOL_BETA.skew)
  const skewChange = parseFloat((skewPrice - BASELINE.skew).toFixed(2))

  return {
    vix: {
      price:         vixPrice,
      change:        parseFloat(vixChange.toFixed(2)),
      changePercent: parseFloat(vixPct.toFixed(2)),
    },
    vvix: {
      price:         vvixPrice,
      change:        vvixChange,
      changePercent: vvixPct,
      previousClose: parseFloat((vvixPrice - vvixChange).toFixed(2)),
    },
    move: {
      price:         movePrice,
      change:        moveChange,
      changePercent: movePct,
      historicalMean: 115,
    },
    gamma: deriveGamma(vixPrice, vixChange, vixPct),
    skew: {
      price:         skewPrice,
      change:        skewChange,
      changePercent: skewPct,
    },
    // P/C ratio has no clean β to VIX; hold at historical mean (FMP was the
    // only realistic upstream and we've cut it).
    putCallRatio: BASELINE.putCall,
    timestamp:    Date.now(),
    // Attribution metadata — lets the UI badge each metric correctly
    dataSource:   LIVE_SOURCE,
  }
}

// ─── Route Handler ─────────────────────────────────────────────────────────────
export async function GET() {
  const cached       = globalThis.__volRiskCache
  const ageMs        = cached ? Date.now() - cached.timestamp : Infinity
  const weekend      = isWeekendWindow()
  const effectiveTTL = weekend ? TTL_WEEKEND_MS : TTL_WEEKDAY_MS

  // ── Cache hit ──────────────────────────────────────────────────────────────
  if (cached && ageMs < effectiveTTL) {
    const ageS = Math.round(ageMs / 1000)
    console.info(
      `[vol-risk] CACHE HIT ` +
      `(age ${ageS}s / TTL ${effectiveTTL / 1000}s${weekend ? ' WEEKEND' : ''})`
    )
    return NextResponse.json(cached.data, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type':  'application/json',
        'X-Cache':       'HIT',
        'X-Cache-Age':   String(ageS),
      },
    })
  }

  // ── Cache miss — fetch fresh data ──────────────────────────────────────────
  console.info(
    `[vol-risk] CACHE MISS ` +
    `(${cached ? `expired ${Math.round(ageMs / 1000)}s ago` : 'cold start'})`
  )

  // The legacy symbol list is retained for log/diagnostic clarity, but
  // fetchVolQuotes() now only honours `^VIX` and resolves it from
  // Alpaca's VIXY snapshot.  Everything else is derived.
  const volSymbols = ['^VIX']

  try {
    const qmap    = await fetchVolQuotes(volSymbols)
    const hasData = qmap.size > 0

    // ── Path A: live data — write to cache and return ────────────────────────
    if (hasData) {
      const base = buildMetrics(qmap)
      // Institutional cross-asset stress gauges (live Alpaca ETF bars).
      const { credit, fx } = await fetchCreditFxMetrics()
      const metrics: MacroRiskMetrics = {
        ...base,
        credit,
        fx,
        dataSource: {
          ...base.dataSource!,
          credit: credit ? 'live' : 'baseline',
          fx:     fx     ? 'live' : 'baseline',
        },
      }
      globalThis.__volRiskCache = { data: metrics, timestamp: Date.now() }
      console.info(
        `[vol-risk] FRESH (Alpaca/VIXY) — VIX=${metrics.vix.price} ` +
        `VVIX=${metrics.vvix.price}* MOVE=${metrics.move.price}* ` +
        `SKEW=${metrics.skew.price}* PCR=${metrics.putCallRatio}*` +
        `  CREDIT=${credit ? credit.ratio.toFixed(3) + (credit.distress ? '⚠' : '') : '—'}` +
        `  USD=${fx ? fx.extensionPct.toFixed(2) + '%' + (fx.squeeze ? '⚠' : '') : '—'}` +
        `  (* = derived from VIX β-projection)`
      )
      return NextResponse.json(metrics, {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
          'Content-Type':  'application/json',
          'X-Cache':       'MISS',
        },
      })
    }

    // ── Path B: rate-limited + prior cache exists ────────────────────────────
    if (cached) {
      if (weekend) {
        // Re-timestamp so next request is a cache HIT (avoids hammering Yahoo)
        globalThis.__volRiskCache = { data: cached.data, timestamp: Date.now() }
        console.info(
          `[vol-risk] WEEKEND STALE: TTL extended +${TTL_WEEKEND_MS / 3_600_000}h`
        )
      }
      const ageS = Math.round((Date.now() - cached.timestamp) / 1000)
      console.warn(`[vol-risk] STALE — provider unavailable (cache age ${ageS}s)`)
      return NextResponse.json(cached.data, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type':  'application/json',
          'X-Cache':       'STALE',
          'X-Cache-Age':   String(ageS),
          'X-Stale-Reason': 'provider-unavailable (all-null quotes)',
        },
      })
    }

    // ── Path C: cold start + provider unavailable — serve fallback baseline ───
    // Return 200 with COLD_START_FALLBACK so the dashboard renders immediately
    // rather than crashing. The timestamp=0 field signals that this is a
    // synthetic baseline; the client will replace it on the next successful poll.
    console.warn(
      `[vol-risk] Cold start with no data — serving cold-start fallback baseline. ` +
      `MacroRiskMatrix will show live data once FMP responds.`
    )
    return NextResponse.json(COLD_START_FALLBACK, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type':  'application/json',
        'X-Cache':       'FALLBACK',
        'X-Stale-Reason': 'cold-start: provider unavailable',
      },
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[vol-risk] Fetch error: ${message}`)

    if (cached) {
      if (weekend) {
        globalThis.__volRiskCache = { data: cached.data, timestamp: Date.now() }
      }
      const ageS = Math.round((Date.now() - cached.timestamp) / 1000)
      return NextResponse.json(cached.data, {
        headers: {
          'Cache-Control': 'no-store',
          'Content-Type':  'application/json',
          'X-Cache':       'STALE',
          'X-Cache-Age':   String(ageS),
          'X-Stale-Reason': `fetch error: ${message}`,
        },
      })
    }

    // No stale cache — return fallback baseline so the app doesn't crash
    console.warn(`[vol-risk] No cache + fetch error — serving cold-start fallback`)
    return NextResponse.json(COLD_START_FALLBACK, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type':  'application/json',
        'X-Cache':       'FALLBACK',
        'X-Stale-Reason': `fetch error: ${message}`,
      },
    })
  }
}
