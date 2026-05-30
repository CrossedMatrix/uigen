'use client'

/**
 * SYSTEMATIC & CTA EXPOSURE ENGINE
 * ─────────────────────────────────────────────────────────────────────────────
 * Renders one row per asset from /api/market/cta-engine.
 * Each row:
 *   1. Asset name
 *   2. Regime state badge — MAX LONG / TREND CLIPPED / SHORT EXPANSION /
 *      MAX CROWDED SHORT / NEUTRAL
 *   3. 50d / 200d EMA clustering bar — visual expansion/compression indicator
 *   4. Historical positioning score — 0-100 meter from CFTC TFF data
 */

import { useEffect, useState } from 'react'
import { StatusBadge } from '@/components/dashboard/StatusBadge'
import { useAlpacaData } from '@/hooks/useAlpacaData'

// Mirror server-side types (we deliberately avoid `import type`
// from a route handler since the route bundles into a different chunk).
type CTARegime =
  | 'MAX_LONG'
  | 'TREND_CLIPPED'
  | 'NEUTRAL'
  | 'SHORT_EXPANSION'
  | 'MAX_CROWDED_SHORT'
  | 'DATA_STALE_OR_MISSING'
  // Client-only state: the historical-bar pipeline returned no usable series,
  // so the row is hydrated from the live Alpaca snapshot price against a static
  // EMA baseline instead of a rolling 200-bar calculation.
  | 'LIVE_TRACKING'

type EMAClustering = 'EXPANDING_UP' | 'EXPANDING_DOWN' | 'COMPRESSED' | 'NEUTRAL'

/** Provenance of the daily bars a row was computed from (see /api/market/cta-engine). */
type BarSource = 'alpaca' | 'ibkr' | 'fmp' | 'synthetic'

interface CTAAssetRow {
  asset:            string
  name:             string
  currentPrice:     number
  ema50:            number
  ema200:           number
  ema50vsPricePct:  number
  emaSpreadPct:     number
  clustering:       EMAClustering
  macd:             number
  signal:           number
  histogram:        number
  adx:              number
  regime:           CTARegime
  /** CTA Trend Intensity 0-100 (50 neutral, >75 bullish breakout, <25 breakdown). */
  positioningScore: number
  /** Signed trend-intensity distance off the breakout level (%), e.g. +5.8 / −1.5. */
  trendIntensityPct: number
  /** Date of the latest processed daily bar (YYYY-MM-DD) — the positioning timestamp. */
  positioningDate:  string
  /** Optional for forward-compat with payloads cached before provenance shipped. */
  source?:          BarSource
}

interface CTAResponse {
  rows:       CTAAssetRow[]
  cached?:    boolean
  stale?:     boolean
  ageSeconds?: number
  error?:     string
}

// ─── Regime palette ───────────────────────────────────────────────────────────

const REGIME_STYLE: Record<CTARegime, { label: string; color: string; bg: string; border: string }> = {
  MAX_LONG:          { label: 'MAX LONG',                   color: '#34d399', bg: 'rgba(52,211,153,0.12)',  border: 'rgba(52,211,153,0.45)' },
  TREND_CLIPPED:     { label: 'TREND CLIPPED · DE-LEVERAGING', color: '#fbbf24', bg: 'rgba(251,191,36,0.12)', border: 'rgba(251,191,36,0.45)' },
  NEUTRAL:           { label: 'NEUTRAL',                    color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.25)' },
  SHORT_EXPANSION:   { label: 'SHORT EXPANSION',            color: '#fb923c', bg: 'rgba(251,146,60,0.12)',  border: 'rgba(251,146,60,0.45)' },
  MAX_CROWDED_SHORT: { label: 'MAX CROWDED SHORT',          color: '#f87171', bg: 'rgba(248,113,113,0.14)', border: 'rgba(248,113,113,0.5)'  },
  DATA_STALE_OR_MISSING: { label: 'DATA STALE / MISSING',   color: '#64748b', bg: 'rgba(100,116,139,0.10)', border: 'rgba(100,116,139,0.35)' },
  LIVE_TRACKING:     { label: 'LIVE TRACKING',              color: '#38bdf8', bg: 'rgba(56,189,248,0.12)',  border: 'rgba(56,189,248,0.45)' },
}

// ─── Static EMA baselines & live-snapshot fallback ─────────────────────────────
//
// Alpaca's free IEX feed can return a short (or empty) daily-bar history for some
// ETFs, which leaves the server engine unable to compute a 200-bar EMA and emits
// a DATA_STALE_OR_MISSING row.  Rather than render a dead stub — or freeze a
// hardcoded EMA baseline — the component derives LIVE PROXY trend values purely
// from the Alpaca snapshot's own day boundaries:
//   • 50d proxy  = the session OPEN price   (today's intraday anchor)
//   • 200d proxy = the prior session CLOSE  (price − change)
//   • "vs 50d"   = price drift off the open  (live intraday %)
//   • clustering = open vs prior close       (the daily open/close boundary move)
// Everything floats with the live tick — no frozen numbers.
const CTA_SYMBOLS = ['SPY', 'QQQ', 'IWM', 'TLT', 'GLD', 'USO'] as const

/** Percentage distance of `value` from a `ref` anchor; 0 when ref is 0. */
function distancePct(value: number, ref: number): number {
  return ref !== 0 ? ((value - ref) / ref) * 100 : 0
}

/** Mirror of the server engine's clustering classifier (|spread%| bands). */
function classifyClustering(spreadPct: number): EMAClustering {
  const abs = Math.abs(spreadPct)
  if (abs < 1) return 'COMPRESSED'
  if (abs < 3) return 'NEUTRAL'
  return spreadPct > 0 ? 'EXPANDING_UP' : 'EXPANDING_DOWN'
}

const CLUSTER_STYLE: Record<EMAClustering, { label: string; color: string }> = {
  EXPANDING_UP:   { label: 'EXPANDING ↑',   color: '#34d399' },
  EXPANDING_DOWN: { label: 'EXPANDING ↓',   color: '#f87171' },
  COMPRESSED:     { label: 'COMPRESSED',    color: '#fbbf24' },
  NEUTRAL:        { label: 'NEUTRAL',       color: '#94a3b8' },
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ClusteringIndicator({ row }: { row: CTAAssetRow }) {
  const style = CLUSTER_STYLE[row.clustering]
  // Width of the spread bar reflects expansion intensity, clamped to 100%.
  // 0% = tight cluster (compressed), 100% = wide divergence.
  const widthPct = Math.min(100, Math.abs(row.emaSpreadPct) * 6)
  const isUp = row.emaSpreadPct > 0

  // LIVE PROXY rows have no rolling-EMA history — ema50/ema200 carry the live
  // session OPEN / prior-CLOSE anchors instead, so relabel them honestly.
  const isProxy = row.regime === 'LIVE_TRACKING'

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-center justify-between text-[10px] font-mono">
        <span className="text-slate-400">{isProxy ? 'Live Proxy' : '50d / 200d'}</span>
        <span style={{ color: style.color }} className="font-bold">{style.label}</span>
      </div>
      <div className="relative h-2 bg-[#050810] rounded-full overflow-hidden border border-[#0e1626]">
        {/* Centre line — represents the 200d EMA reference */}
        <div className="absolute top-0 bottom-0 left-1/2 w-px bg-slate-700" />
        {/* Spread bar — extends from centre outward in the direction of the trend */}
        <div
          className="absolute top-0 bottom-0 rounded-full transition-all duration-300"
          style={{
            backgroundColor: style.color,
            opacity:         0.75,
            width:           `${widthPct / 2}%`,
            left:            isUp ? '50%' : `${50 - widthPct / 2}%`,
            boxShadow:       `0 0 6px ${style.color}80`,
          }}
        />
      </div>
      <div className="flex justify-between text-[10px] font-mono text-slate-500 tabular-nums">
        <span>{isProxy ? 'OPEN' : 'EMA50'} {row.ema50.toFixed(2)}</span>
        <span style={{ color: row.emaSpreadPct >= 0 ? '#34d399' : '#f87171' }}>
          {row.emaSpreadPct >= 0 ? '+' : ''}{row.emaSpreadPct.toFixed(2)}%
        </span>
        <span>{isProxy ? 'PREV' : 'EMA200'} {row.ema200.toFixed(2)}</span>
      </div>
    </div>
  )
}

// ─── Trend-positioning freshness helpers ───────────────────────────────────────
// Positioning is now pure CTA trend intensity off the latest Alpaca daily bar,
// so "fresh" means the bar date is within the last week.  A run on a partial /
// snapshot proxy uses today's date and is always fresh.
const POSITIONING_STALE_DAYS = 7

/** Age in days of a positioning (bar) date; null when absent/unparseable. */
function positioningAgeDays(date?: string | null): number | null {
  if (!date) return null
  const t = new Date(date).getTime()
  if (!Number.isFinite(t)) return null
  return (Date.now() - t) / 86_400_000
}

/** "2026-05-29T00:00:00.000" → "2026-05-29"; "—" when absent. */
function shortDate(date?: string | null): string {
  return date ? date.slice(0, 10) : '—'
}

/** Positioning is "live" when its bar date is within the stale window. */
function isPositioningLive(date?: string | null): boolean {
  const age = positioningAgeDays(date)
  return age !== null && age <= POSITIONING_STALE_DAYS
}

function PositioningMeter({
  score, vsEma50Pct, date,
}: { score: number; vsEma50Pct: number; date: string }) {
  // Colour gradient: red below 25 (max short), green above 75 (max long),
  // amber in the neutral band.
  const color =
    score >= 75 ? '#34d399' :
    score >= 55 ? '#a3e635' :
    score >= 45 ? '#fbbf24' :
    score >= 25 ? '#fb923c' : '#f87171'

  // Directional state badge — driven by the Trend Intensity score so it always
  // agrees with the number above:  > 75 ⇒ LONG (green), < 25 ⇒ SHORT (red),
  // otherwise NEUTRAL (slate).
  const state =
    score > 75 ? { label: 'LONG',    cls: 'text-emerald-400 bg-emerald-400/10 border-emerald-400/40' } :
    score < 25 ? { label: 'SHORT',   cls: 'text-red-400 bg-red-400/10 border-red-400/40' } :
                 { label: 'NEUTRAL', cls: 'text-slate-400 bg-slate-400/10 border-slate-400/30' }

  const age   = positioningAgeDays(date)
  const stale = age === null || age > POSITIONING_STALE_DAYS
  const shown = shortDate(date)
  // Intensity = signed % distance of price vs its 50-day EMA (negative when
  // price trades below the 50d line, e.g. −1.39%).
  const intensity = `${vsEma50Pct >= 0 ? '+' : ''}${vsEma50Pct.toFixed(2)}% Intensity`

  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <div className="flex items-center justify-between text-[10px] font-mono">
        <span className="text-slate-400">Trend Intensity</span>
        <span className="font-bold tabular-nums" style={{ color }}>
          {score.toFixed(0)}<span className="text-slate-500 text-[10px]">/100</span>
        </span>
      </div>
      <div className="relative h-2 bg-[#050810] rounded-full overflow-hidden border border-[#0e1626]">
        {/* Quartile gridlines for instant visual calibration */}
        {[25, 50, 75].map(q => (
          <div key={q} className="absolute top-0 bottom-0 w-px bg-slate-800" style={{ left: `${q}%` }} />
        ))}
        <div
          className="absolute top-0 bottom-0 rounded-full transition-all duration-300"
          style={{ width: `${score}%`, backgroundColor: color, boxShadow: `0 0 6px ${color}80` }}
        />
      </div>
      <div className="flex items-center justify-between text-[10px] font-mono text-slate-500 gap-1">
        {/* Leading state badge — LONG / SHORT / NEUTRAL from the score. */}
        <span className={`shrink-0 px-1 rounded border font-bold tracking-wide ${state.cls}`}>
          {state.label}
        </span>
        {stale ? (
          // Stale bar date → amber warning treatment with the bar's age.
          <span
            className="truncate text-amber-500"
            title={`Bar ${shown} is ${age !== null ? Math.round(age) : '—'}d old — STALE / COLD START`}
          >
            ⚠ {intensity} · {shown}
          </span>
        ) : (
          // Fresh → high-contrast text with a live green dot + active bar date.
          <span className="truncate text-slate-200" title={`Live trend · bar ${shown}`}>
            <span className="text-emerald-400">●</span> {intensity} · {shown}
          </span>
        )}
      </div>
    </div>
  )
}

/** Cold-load placeholder that mirrors the 4-column row grid while the
 *  server resolves the IBKR socket / FMP fallback asynchronously. */
function SkeletonRow() {
  return (
    <div className="grid grid-cols-12 gap-2 items-center py-2 px-2 rounded-md border border-[#10182a] bg-[#080d18] animate-pulse">
      {/* 1 · Asset name */}
      <div className="col-span-3 min-w-0 space-y-1.5">
        <div className="h-2 w-10 rounded bg-slate-700/60" />
        <div className="h-2 w-24 rounded bg-slate-800" />
        <div className="h-2 w-16 rounded bg-slate-800" />
      </div>
      {/* 2 · Regime badge */}
      <div className="col-span-3 flex flex-col gap-1.5 items-start">
        <div className="h-5 w-28 rounded bg-slate-800" />
        <div className="h-2 w-20 rounded bg-slate-800" />
      </div>
      {/* 3 · EMA clustering */}
      <div className="col-span-3 space-y-1.5">
        <div className="h-2 w-full rounded bg-slate-800" />
        <div className="h-2 w-full rounded-full bg-slate-800" />
        <div className="h-2 w-2/3 rounded bg-slate-800" />
      </div>
      {/* 4 · Positioning */}
      <div className="col-span-3 space-y-1.5">
        <div className="h-2 w-full rounded bg-slate-800" />
        <div className="h-2 w-full rounded-full bg-slate-800" />
        <div className="h-2 w-1/2 rounded bg-slate-800" />
      </div>
    </div>
  )
}

function RegimeBadge({ regime }: { regime: CTARegime }) {
  const s = REGIME_STYLE[regime]
  return (
    <div
      className="inline-flex items-center px-2 py-1 rounded border text-[10px] font-mono font-bold tracking-wide whitespace-nowrap"
      style={{ color: s.color, backgroundColor: s.bg, borderColor: s.border }}
    >
      {s.label}
    </div>
  )
}

/**
 * Positioning-derived regime badge for LIVE TRACKING rows (no rolling-EMA
 * history available).  Maps the CFTC Managed-Money positioning percentile onto
 * an actionable squeeze/exhaustion state instead of a static "LIVE TRACKING"
 * string.  Same badge layout as <RegimeBadge> so the column stays uniform.
 */
function PositioningRegimeBadge({ score }: { score: number }) {
  const { label, className } =
    score >= 85 ? { label: '▲ EXHAUSTION LONG', className: 'text-red-400 bg-red-400/10 border-red-400/40' } :
    score <= 15 ? { label: '⚡ SQUEEZE ALARM',  className: 'text-green-400 bg-green-400/10 border-green-400/40' } :
                  { label: '⚪ NEUTRAL',         className: 'text-slate-400 bg-slate-400/10 border-slate-400/30' }
  return (
    <div className={`inline-flex items-center px-2 py-1 rounded border text-[10px] font-mono font-bold tracking-wide whitespace-nowrap ${className}`}>
      {label}
    </div>
  )
}

function CTAAssetRowView({ row }: { row: CTAAssetRow }) {
  return (
    <div className="grid grid-cols-12 gap-2 items-center py-2 px-2 rounded-md border border-[#10182a] bg-[#080d18] hover:border-[#2a3f64] transition-colors">
      {/* 1 · Asset name */}
      <div className="col-span-3 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] font-mono text-amber-400/80 tracking-widest uppercase">{row.asset}</span>
        </div>
        <div className="text-[10px] text-slate-300 truncate">{row.name}</div>
        <div className="text-[10px] font-mono text-slate-500 tabular-nums mt-0.5">
          ${row.currentPrice.toFixed(2)}{' '}
          <span className={row.ema50vsPricePct >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}>
            ({row.ema50vsPricePct >= 0 ? '+' : ''}{row.ema50vsPricePct.toFixed(2)}% {row.regime === 'LIVE_TRACKING' ? 'vs open' : 'vs 50d'})
          </span>
        </div>
      </div>

      {/* 2 · Regime state — positioning-derived for LIVE TRACKING rows,
              otherwise the server-computed trend regime. */}
      <div className="col-span-3 flex items-center">
        {row.regime === 'LIVE_TRACKING'
          ? <PositioningRegimeBadge score={row.positioningScore} />
          : <RegimeBadge regime={row.regime} />}
      </div>

      {/* 3 · EMA clustering */}
      <div className="col-span-3">
        <ClusteringIndicator row={row} />
      </div>

      {/* 4 · Positioning score */}
      <div className="col-span-3">
        <PositioningMeter score={row.positioningScore} vsEma50Pct={row.ema50vsPricePct} date={row.positioningDate} />
      </div>
    </div>
  )
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function CTAExposureEngine() {
  const [data, setData]       = useState<CTAResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/market/cta-engine', { cache: 'no-store' })
        const body = await res.json()
        if (!alive) return
        if (!res.ok && !body?.rows?.length) {
          setError(body?.error ?? `Failed to load CTA engine (${res.status})`)
          setData(null)
        } else {
          setData(body as CTAResponse)
          setError(null)
        }
      } catch (e) {
        if (!alive) return
        setError(e instanceof Error ? e.message : 'Network error')
      } finally {
        if (alive) setLoading(false)
      }
    }
    load()
    // Refresh on the same 4h cadence as the server cache, plus a token
    // 1h heartbeat so the UI doesn't drift if the server cache rolls.
    const id = setInterval(load, 60 * 60 * 1000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  // Live Alpaca snapshot for the CTA universe — the same proxy/feed driving the
  // top ticker tape.  Used to (a) keep currentPrice fresh on healthy rows and
  // (b) hydrate the price for rows whose historical bars came back empty.
  const { quoteMap } = useAlpacaData({
    symbols:      [...CTA_SYMBOLS],
    assetClass:   'us_equity',
    type:         'snapshot',
    pollInterval: 30_000,
  })

  // Build the rows actually rendered: real EMA data is used as-is (with the live
  // price overlaid); rows the server couldn't compute (empty/short bar history)
  // become LIVE PROXY rows derived entirely from the snapshot's day boundaries —
  // no hardcoded EMA baselines.
  const rows: CTAAssetRow[] = (data?.rows ?? []).map(routeRow => {
    const quote       = quoteMap.get(routeRow.asset)
    const livePrice   = quote?.price ?? null
    const hasRealBars = routeRow.regime !== 'DATA_STALE_OR_MISSING' && routeRow.ema50 > 0

    if (hasRealBars) {
      // Healthy row — overlay the live price so the distance proxy ticks with
      // the ticker tape; fall back to the bar close when no live quote yet.
      return livePrice != null
        ? { ...routeRow, currentPrice: livePrice, ema50vsPricePct: distancePct(livePrice, routeRow.ema50) }
        : routeRow
    }

    // Stale/empty bars → LIVE PROXY hydrated from the snapshot's own boundaries:
    //   50d proxy  = session OPEN, 200d proxy = prior CLOSE (price − change).
    // No frozen baselines: every figure floats with the live tick.
    const price       = livePrice ?? (routeRow.currentPrice > 0 ? routeRow.currentPrice : 0)
    const prevClose   = (quote?.price != null && quote?.change != null) ? quote.price - quote.change : null
    const openAnchor  = quote?.open ?? null
    const ema50Proxy  = openAnchor ?? price                       // today's intraday anchor
    const ema200Proxy = prevClose ?? openAnchor ?? price          // prior-session anchor
    const emaSpreadPct = distancePct(ema50Proxy, ema200Proxy)     // open vs prior close
    return {
      ...routeRow,
      currentPrice:    price,
      ema50:           ema50Proxy,                                // relabelled "OPEN" in the UI
      ema200:          ema200Proxy,                               // relabelled "PREV" in the UI
      ema50vsPricePct: distancePct(price, ema50Proxy),            // live drift off the open
      emaSpreadPct,
      clustering:      classifyClustering(emaSpreadPct),
      regime:          'LIVE_TRACKING',
      source:          'alpaca',
    }
  })
  const hasRows = rows.length > 0

  // Aggregate trend-positioning freshness for the column-header badge: LIVE when
  // at least one row's bar date is within the 7-day window; else AWAITING SYNC.
  const trendColumnLive = rows.some(r => isPositioningLive(r.positioningDate))

  return (
    <section
      className="bg-[#0c1221] border rounded-2xl p-4 transition-colors duration-500"
      style={{
        borderColor: hasRows ? '#34d39930' : '#1a2540',
      }}
    >
      {/* ── Header ── */}
      <div className="flex items-start justify-between mb-3 gap-2">
        <div className="min-w-0">
          <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
            Systematic &amp; CTA Exposure Engine
          </h3>
          <p className="text-[12px] text-slate-400 font-mono mt-1">
            Trend regime · 50/200d EMA clustering · CTA trend-intensity positioning
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {loading && (
            <span className="text-[11px] font-mono text-slate-500 animate-pulse">
              calculating…
            </span>
          )}
          {data?.stale && (
            <StatusBadge variant="awaiting" label="STALE CACHE" title="Showing cached data — live recalculation pending" />
          )}
          {data && !data.stale && hasRows && (
            <StatusBadge variant="live" label="LIVE" title="Live Alpaca daily-bar data (SPY · QQQ · IWM · TLT · GLD · USO)" />
          )}
        </div>
      </div>

      {/* ── Column headers ── (shown for both live rows and the cold-load skeleton) */}
      {(hasRows || loading) ? (
        <div className="grid grid-cols-12 gap-2 px-2 mb-1.5 text-[10px] font-mono text-slate-600 uppercase tracking-widest">
          <div className="col-span-3">Asset</div>
          <div className="col-span-3">Regime State</div>
          <div className="col-span-3">EMA Clustering</div>
          <div className="col-span-3 flex items-center gap-1.5">
            <span>Trend Positioning</span>
            {hasRows && (
              trendColumnLive
                ? <span className="text-emerald-400 normal-case tracking-normal" title="Trend positioning computed from the latest Alpaca daily bar (within 7 days)">● LIVE TREND</span>
                : <span className="text-amber-400/80 normal-case tracking-normal" title="Trend positioning bar is stale — awaiting the next daily bar sync">⚠ AWAITING SYNC</span>
            )}
          </div>
        </div>
      ) : null}

      {/* ── Body ── */}
      {error && !hasRows && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-center">
          <div className="text-amber-300 text-[12px] font-mono">{error}</div>
          <div className="text-slate-500 text-[10px] font-mono mt-1">
            CTA engine requires Alpaca credentials + CFTC PRE network access.
          </div>
        </div>
      )}

      {hasRows ? (
        <div className="space-y-1.5">
          {rows.map(row => (
            <CTAAssetRowView key={row.asset} row={row} />
          ))}
        </div>
      ) : loading ? (
        // Cold-load skeleton while the background IBKR socket resolves.
        <div className="space-y-1.5" aria-busy="true" aria-label="Loading CTA exposure rows">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      ) : (
        !error && (
          <div className="rounded-lg border border-[#1a2540] bg-[#070b14] p-3 text-center text-[12px] font-mono text-slate-500">
            No CTA engine rows available.
          </div>
        )
      )}
    </section>
  )
}
