'use client'

import { useState, useEffect } from 'react'

// ─── Data-source types ────────────────────────────────────────────────────────

export type MetricSource = 'live' | 'derived' | 'baseline'

export interface DataSourceMap {
  /** VIX = live Alpaca VIXY snapshot */
  vix:          MetricSource
  /** VVIX = β-projected from live VIX % change */
  vvix:         MetricSource
  /** MOVE = β-projected from live VIX % change */
  move:         MetricSource
  /** SKEW = β-projected from live VIX % change */
  skew:         MetricSource
  /** Gamma = synthesised from VIX level thresholds */
  gamma:        MetricSource
  /** P/C ratio = long-run historical mean (no live feed) */
  putCallRatio: MetricSource
  /** Credit stress = live HYG/TLT ratio vs its 50d MA (Alpaca) */
  credit?:      MetricSource
  /** FX dollar stress = live UUP vs its 50d EMA (Alpaca) */
  fx?:          MetricSource
}

// ─── Metric types ─────────────────────────────────────────────────────────────

export interface MacroRiskMetrics {
  vix: {
    price: number
    change: number
    changePercent: number
  }
  vvix: {
    price: number
    change: number
    changePercent: number
    previousClose: number
  }
  move: {
    price: number
    change: number
    changePercent: number
    historicalMean: number
  }
  gamma: {
    price: number
    change: number
    changePercent: number
    regime: 'low' | 'medium' | 'high'
  }
  skew: {
    price: number
    change: number
    changePercent: number
  }
  putCallRatio: number
  /**
   * Credit Stress Spread — live HYG (HY credit) ÷ TLT (duration) ratio vs its
   * 50-day moving average.  `distress` = ratio broke below the 50d MA.
   * `score` is a STRESS score (20 = stable, scales up toward 100 on distress).
   * Optional — only present on live Alpaca responses.
   */
  credit?: {
    ratio:    number
    ma50:     number
    score:    number
    distress: boolean
  }
  /**
   * FX Dollar Stress Proxy — live UUP price vs its 50-day EMA.
   * `extensionPct` = (price − ema50) / ema50 × 100.
   * `squeeze` = extension > 1.5% → dollar-liquidity squeeze warning.
   * Optional — only present on live Alpaca responses.
   */
  fx?: {
    price:        number
    ema50:        number
    extensionPct: number
    squeeze:      boolean
  }
  /**
   * Unix ms timestamp set server-side when the metrics were built.
   * 0 signals a cold-start baseline (never fetched real data yet).
   */
  timestamp: number
  /**
   * Per-metric data-source attribution.
   * Optional — absent on older cached payloads; treated as all-baseline.
   */
  dataSource?: DataSourceMap
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

export const MACRO_RISK_MOCK: MacroRiskMetrics = {
  vix:  { price: 17.82, change: -0.84, changePercent: -4.50 },
  vvix: { price: 92.4,  change: -2.1,  changePercent: -2.22, previousClose: 94.5 },
  move: { price: 129.3, change:  1.2,  changePercent:  0.94, historicalMean: 115 },
  gamma: { price: 0.62, change: 0.08,  changePercent: 14.81, regime: 'medium' },
  skew: { price: 131.2, change:  1.4,  changePercent:  1.08 },
  putCallRatio: 0.72,
  credit: { ratio: 2.31, ma50: 2.28, score: 20, distress: false },
  fx:     { price: 28.40, ema50: 28.10, extensionPct: 1.07, squeeze: false },
  timestamp: 0,   // 0 = mock / no real fetch
  dataSource: {
    vix: 'baseline', vvix: 'baseline', move: 'baseline',
    skew: 'baseline', gamma: 'baseline', putCallRatio: 'baseline',
    credit: 'baseline', fx: 'baseline',
  },
}

// ─── Utility Functions ────────────────────────────────────────────────────────

function changeColor(n: number): string {
  if (n > 0) return 'text-emerald-400'
  if (n < 0) return 'text-red-400'
  return 'text-slate-400'
}

function fmtChange(n: number, dec = 2): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(dec)}`
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(' ')
}

function calculateRiskScore(value: number, minVal: number, maxVal: number, invert = false): number {
  const clampedValue = Math.max(Math.min(value, maxVal), minVal)
  const rawScore     = ((maxVal - clampedValue) / (maxVal - minVal)) * 100
  const score        = invert ? 100 - rawScore : rawScore
  return Math.round(Math.max(0, Math.min(100, score)))
}

/** Format age for the "updated X ago" label */
function fmtAge(seconds: number): string {
  if (seconds < 5)    return 'just now'
  if (seconds < 60)   return `${seconds}s ago`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  return `${Math.floor(seconds / 3600)}h ago`
}

// ─── Source Badge ─────────────────────────────────────────────────────────────
//
// Each source type has a distinct color/label so the user can instantly tell
// whether a metric number is from a live Alpaca snapshot or was projected.
//
//   live     → emerald — direct Alpaca VIXY snapshot
//   derived  → amber   — β-projection from live VIX % change
//   baseline → slate   — long-run historical constant (no feed)

const SOURCE_STYLE: Record<MetricSource, { label: string; color: string; bg: string; border: string }> = {
  live:     { label: '● Live',     color: 'rgba(52,211,153,0.85)',  bg: 'rgba(52,211,153,0.08)',  border: 'rgba(52,211,153,0.28)' },
  derived:  { label: '~ Derived',  color: 'rgba(251,191,36,0.80)',  bg: 'rgba(251,191,36,0.07)',  border: 'rgba(251,191,36,0.22)' },
  baseline: { label: '○ Baseline', color: 'rgba(148,163,184,0.55)', bg: 'rgba(100,116,139,0.07)', border: 'rgba(100,116,139,0.20)' },
}

function SourceBadge({ source, isStale }: { source: MetricSource; isStale: boolean }) {
  const s = isStale && source === 'live'
    ? { label: '⚠ Stale', color: 'rgba(249,115,22,0.90)', bg: 'rgba(249,115,22,0.08)', border: 'rgba(249,115,22,0.30)' }
    : SOURCE_STYLE[source]
  return (
    <span
      className="inline-flex items-center px-1.5 py-0.5 rounded border font-mono text-[8px] tracking-wider uppercase leading-none shrink-0"
      style={{ color: s.color, backgroundColor: s.bg, borderColor: s.border }}
      title={
        isStale && source === 'live'
          ? 'Stale — last Alpaca snapshot >30 s old'
          : source === 'live'    ? 'Live — direct Alpaca VIXY snapshot'
          : source === 'derived' ? 'Derived — β-projected from live VIX Δ%'
          :                        'Baseline — long-run historical constant'
      }
    >
      {s.label}
    </span>
  )
}

// ─── Tooltip Component ────────────────────────────────────────────────────────

function Tooltip({ label, explanation }: { label: string; explanation: string }) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="relative inline-flex items-center gap-1">
      {label && <span className="text-[10px] text-slate-500 font-mono uppercase tracking-wider">{label}</span>}
      <div
        className="relative"
        onMouseEnter={() => setVisible(true)}
        onMouseLeave={() => setVisible(false)}
      >
        <div className="w-4 h-4 rounded-full bg-slate-700 border border-slate-600 flex items-center justify-center cursor-help hover:bg-slate-600 transition-colors">
          <span className="text-[10px] font-mono text-slate-400 leading-none">?</span>
        </div>
        {visible && (
          <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 w-48 bg-[#070b14] border border-slate-600 rounded-lg p-2.5 text-[12px] text-slate-300 font-mono z-50 shadow-lg">
            {explanation}
            <div className="absolute top-full left-1/2 -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-slate-600" />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Stress Badge ─────────────────────────────────────────────────────────────

function StressBadge({ vixPrice, movePrice }: { vixPrice: number; movePrice: number }) {
  const ratio    = movePrice / vixPrice
  const norm     = 6.5
  const level    = ratio > norm * 1.3 ? 'critical' : ratio > norm * 1.15 ? 'elevated' : 'normal'
  const bg       = level === 'critical' ? 'bg-red-500/20 border-red-500/40' : level === 'elevated' ? 'bg-amber-500/20 border-amber-500/40' : 'bg-slate-700/40 border-slate-600/40'
  const tc       = level === 'critical' ? 'text-red-400'   : level === 'elevated' ? 'text-amber-400'  : 'text-slate-400'
  const dot      = level === 'critical' ? '#f87171'        : level === 'elevated' ? '#fbbf24'         : '#94a3b8'
  return (
    <div className={cn('px-2.5 py-1.5 rounded border flex items-center gap-2', bg)}>
      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: dot }} />
      <span className={cn('text-[12px] font-mono font-semibold uppercase tracking-wider', tc)}>
        {level === 'critical' ? 'BOND STRESS' : level === 'elevated' ? 'STRESS WARNING' : 'Stable'}
      </span>
      <span className={cn('text-[11px] font-mono', tc)}>{ratio.toFixed(2)}x</span>
    </div>
  )
}

// ─── Tail Risk Alert ──────────────────────────────────────────────────────────

function TailRiskAlert({ vvixPrice, vvixChange, vixPrice, vixChange }: {
  vvixPrice: number; vvixChange: number; vixPrice: number; vixChange: number
}) {
  const vvixPct = (vvixChange / (vvixPrice - vvixChange)) * 100
  const vixPct  = (vixChange  / (vixPrice  - vixChange))  * 100
  const hasDivergence = vvixPct > 5 && vixPct <= 0
  const bg = hasDivergence ? 'bg-orange-500/20 border-orange-500/40' : 'bg-slate-700/40 border-slate-600/40'
  const tc = hasDivergence ? 'text-orange-400' : 'text-slate-400'
  return (
    <div className={cn('px-2.5 py-1.5 rounded border flex items-center gap-2', bg)}>
      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: hasDivergence ? '#fb923c' : '#94a3b8' }} />
      <span className={cn('text-[12px] font-mono font-semibold uppercase tracking-wider', tc)}>
        {hasDivergence ? 'TAIL HEDGING' : 'No Divergence'}
      </span>
      {hasDivergence && <span className={cn('text-[11px] font-mono', tc)}>{vvixPct.toFixed(1)}%↑</span>}
    </div>
  )
}

// ─── MOVE / VIXY Divergence Card ──────────────────────────────────────────────
//
// FIX: No longer makes its own Alpaca fetch.
// VIXY is already fetched by /api/vol-risk and stored in metrics.vix
// (the route comments confirm: "VIX = VIXY snapshot from Alpaca").
// We receive the price + timestamp as props so the card is always in sync
// with the rest of the matrix and never shows "--" due to a second cold-start.

interface MoveVixyDivergenceCardProps {
  movePrice:      number
  /** VIXY price — sourced from metrics.vix.price (same Alpaca snapshot) */
  vixyPrice:      number | null
  /** VIXY % change — from metrics.vix.changePercent */
  vixyChangePct:  number
  isStale:        boolean
  updatedAt:      string
}

function MoveVixyDivergenceCard({
  movePrice,
  vixyPrice,
  vixyChangePct,
  isStale,
  updatedAt,
}: MoveVixyDivergenceCardProps) {
  const ratio           = vixyPrice && vixyPrice > 0 ? movePrice / vixyPrice : null
  // MOVE (~115) ÷ VIX (~17.5, now normalized to the cash-VIX scale upstream)
  // ≈ 6.5 in a balanced regime — matching the StressBadge norm.  (The old 17.5
  // here was a mis-set norm that, combined with the un-normalized VIXY share
  // price, drove the deviation off-scale and clamped the score to 0.)
  const HISTORICAL_NORM = 6.5
  const deviationPct    = ratio !== null ? ((ratio - HISTORICAL_NORM) / HISTORICAL_NORM) * 100 : 0
  const absDeviation    = Math.abs(deviationPct)

  const regime =
    ratio === null    ? 'LOADING'   :
    absDeviation < 8  ? 'ALIGNED'   :
    absDeviation < 18 ? 'DIVERGENT' : 'EXTREME'

  const regimeColor =
    regime === 'EXTREME'   ? (isStale ? '#f97316' : '#f87171') :
    regime === 'DIVERGENT' ? '#fbbf24' :
    regime === 'ALIGNED'   ? '#34d399' : '#94a3b8'

  const regimeBg =
    regime === 'EXTREME'   ? 'bg-red-400/10  border-red-400/30'   :
    regime === 'DIVERGENT' ? 'bg-amber-400/10 border-amber-400/30' :
    regime === 'ALIGNED'   ? 'bg-emerald-400/10 border-emerald-400/30' :
                             'bg-slate-700/30 border-slate-500/40'

  const directionLabel =
    ratio === null   ? '—'                    :
    deviationPct > 0 ? 'BOND > EQUITY STRESS' :
    deviationPct < 0 ? 'EQUITY > BOND STRESS' : 'BALANCED'

  const score = ratio === null
    ? 50
    : Math.max(0, Math.min(100, 100 - (absDeviation / 30) * 100))

  // Stale border
  const borderStyle = isStale
    ? { borderColor: 'rgba(249,115,22,0.35)', backgroundColor: '#0c1221' }
    : { borderColor: '#1a2540',               backgroundColor: '#0c1221' }

  return (
    <div className="rounded-xl p-3 flex flex-col gap-2 border" style={borderStyle}>
      {/* Header */}
      <div className="flex items-start justify-between gap-1">
        <div>
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-[12px] font-mono text-amber-400/80 uppercase tracking-widest">
              MOVE / VIXY
            </span>
            {/* Source badge — live because VIXY is from Alpaca snapshot */}
            <SourceBadge source="live" isStale={isStale} />
          </div>
          <div className="text-[10px] text-slate-300">Cross-Vol Divergence</div>
        </div>
        <Tooltip
          label=""
          explanation="Bond vol (MOVE) vs equity vol (VIX, from the VIXY ETF proxy normalized to the cash-VIX scale) ratio. Norm ≈6.5. Wide divergence flags one market pricing stress the other isn't — leading indicator for cross-asset repricings."
        />
      </div>

      {/* Values */}
      <div className="flex items-end justify-between gap-1">
        <div className="min-w-0 flex-1">
          <div
            className="font-mono text-xl font-semibold tabular-nums leading-none"
            style={{ color: isStale ? '#f97316' : undefined }}
          >
            {ratio !== null ? ratio.toFixed(2) : (vixyPrice === null ? '--' : '…')}
            <span className="text-xs text-slate-500 ml-1">x</span>
          </div>
          <div className="font-mono text-[12px] mt-0.5" style={{ color: regimeColor }}>
            {ratio !== null
              ? `${deviationPct >= 0 ? '+' : ''}${deviationPct.toFixed(1)}% vs norm`
              : 'VIXY via Alpaca/VIXY'}
          </div>
        </div>
      </div>

      {/* Regime + score */}
      <div className="flex items-center justify-between gap-1">
        <span
          className={cn('text-[11px] font-mono font-semibold tracking-wider px-1.5 py-0.5 rounded border', regimeBg)}
          style={{ color: regimeColor }}
        >
          {regime}
        </span>
        <span
          className="text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded border bg-slate-700/30 border-slate-500/40"
          style={{ color: regimeColor }}
        >
          {score.toFixed(0)}
        </span>
      </div>

      {/* Detail row */}
      <p className="text-[11px] text-slate-400 leading-tight">
        {directionLabel}
        {ratio !== null && vixyPrice !== null && (
          <>
            {' · '}MOVE {movePrice.toFixed(1)} / VIXY ${vixyPrice.toFixed(2)}
            <span className={cn('ml-1', vixyChangePct >= 0 ? 'text-emerald-400/70' : 'text-red-400/70')}>
              ({vixyChangePct >= 0 ? '+' : ''}{vixyChangePct.toFixed(2)}%)
            </span>
          </>
        )}
      </p>

      {/* Timestamp */}
      <div className="text-[9px] font-mono leading-none" style={{ color: isStale ? 'rgba(249,115,22,0.60)' : 'rgba(100,116,139,0.55)' }}>
        {isStale ? '⚠ ' : ''}updated {updatedAt}
      </div>
    </div>
  )
}

// ─── Credit Stress tile (HYG / TLT) ───────────────────────────────────────────

function CreditStressCard({
  credit, source, isStale, updatedAt,
}: {
  credit: NonNullable<MacroRiskMetrics['credit']>
  source: MetricSource
  isStale: boolean
  updatedAt: string
}) {
  const tileStale = isStale && source === 'live'
  // Distress = HY credit broke below its 50d MA → spreads widening / squeeze risk.
  const color   = credit.distress ? '#f87171' : '#34d399'
  const regime  = credit.distress ? 'CREDIT DISTRESS · SQUEEZE' : 'CREDIT STABLE'
  const devPct  = credit.ma50 > 0 ? ((credit.ratio - credit.ma50) / credit.ma50) * 100 : 0
  return (
    <div className="bg-[#0c1221] rounded-xl p-2 flex flex-col gap-1.5 border" style={{ borderColor: tileStale ? 'rgba(249,115,22,0.30)' : '#1a2540' }}>
      <div className="flex items-start justify-between gap-1">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
            <span className="text-[12px] font-mono text-amber-400/80 uppercase tracking-widest">CREDIT</span>
            <SourceBadge source={source} isStale={tileStale} />
          </div>
          <div className="text-[10px] text-slate-300">HYG / TLT Spread</div>
        </div>
        <Tooltip label="" explanation="HY credit (HYG) ÷ duration (TLT) vs its 50d MA. Holding above the MA = spreads benign (stable). A break below = credit distress / short-squeeze risk; the stress score scales up with the gap below the MA." />
      </div>
      <div className="flex items-end justify-between gap-1">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-xl font-semibold tabular-nums leading-none" style={{ color: tileStale ? '#f97316' : undefined }}>
            {credit.ratio.toFixed(3)}
          </div>
          <div className="font-mono text-[12px] mt-0.5" style={{ color }}>
            {devPct >= 0 ? '+' : ''}{devPct.toFixed(2)}% vs 50d MA
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-1">
        <span className="text-[11px] font-mono font-semibold tracking-wider px-1.5 py-0.5 rounded border whitespace-nowrap"
          style={{ color, borderColor: `${color}4d`, backgroundColor: `${color}1a` }}>
          {regime}
        </span>
        <span className="text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded border bg-slate-700/30 border-slate-500/40" style={{ color }}>
          {credit.score.toFixed(0)}
        </span>
      </div>
      <p className="text-[11px] text-slate-400 leading-tight">
        {credit.distress
          ? 'HY credit breaking below its 50d MA — spreads widening, short-squeeze risk building.'
          : 'HY credit holding above its 50d MA — credit conditions benign.'}
      </p>
      <div className="text-[9px] font-mono leading-none" style={{ color: tileStale ? 'rgba(249,115,22,0.60)' : 'rgba(100,116,139,0.50)' }}>
        {tileStale ? '⚠ stale · ' : ''}{updatedAt}
      </div>
    </div>
  )
}

// ─── FX Dollar Stress tile (UUP) ───────────────────────────────────────────────

function FxStressCard({
  fx, source, isStale, updatedAt,
}: {
  fx: NonNullable<MacroRiskMetrics['fx']>
  source: MetricSource
  isStale: boolean
  updatedAt: string
}) {
  const tileStale = isStale && source === 'live'
  // > +1.5% above the 50d EMA → dollar-liquidity squeeze (orange warning).
  const color  = fx.squeeze ? '#f97316' : fx.extensionPct >= 0 ? '#34d399' : '#94a3b8'
  const regime = fx.squeeze ? 'DOLLAR LIQUIDITY SQUEEZE' : 'USD STABLE'
  return (
    <div className="bg-[#0c1221] rounded-xl p-2 flex flex-col gap-1.5 border" style={{ borderColor: fx.squeeze ? 'rgba(249,115,22,0.45)' : tileStale ? 'rgba(249,115,22,0.30)' : '#1a2540' }}>
      <div className="flex items-start justify-between gap-1">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
            <span className="text-[12px] font-mono text-amber-400/80 uppercase tracking-widest">USD</span>
            <SourceBadge source={source} isStale={tileStale} />
          </div>
          <div className="text-[10px] text-slate-300">Dollar Stress · UUP</div>
        </div>
        <Tooltip label="" explanation="Dollar proxy ETF (UUP) extension above/below its 50d EMA. > +1.5% flags a dollar-liquidity squeeze — global FX cross-currents that tighten financial conditions for risk assets." />
      </div>
      <div className="flex items-end justify-between gap-1">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-xl font-semibold tabular-nums leading-none" style={{ color: fx.squeeze ? '#f97316' : tileStale ? '#f97316' : undefined }}>
            ${fx.price.toFixed(2)}
          </div>
          <div className="font-mono text-[12px] mt-0.5" style={{ color }}>
            {fx.extensionPct >= 0 ? '+' : ''}{fx.extensionPct.toFixed(2)}% vs 50d EMA
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-1">
        <span className="text-[11px] font-mono font-semibold tracking-wider px-1.5 py-0.5 rounded border whitespace-nowrap"
          style={{ color, borderColor: `${color}4d`, backgroundColor: `${color}1a` }}>
          {regime}
        </span>
      </div>
      <p className="text-[11px] text-slate-400 leading-tight">
        {fx.squeeze
          ? 'UUP > 1.5% above its 50d EMA — dollar-liquidity squeeze; global currency cross-current stress.'
          : 'Dollar trading within a normal band of its 50d EMA — FX conditions stable.'}
      </p>
      <div className="text-[9px] font-mono leading-none" style={{ color: tileStale ? 'rgba(249,115,22,0.60)' : 'rgba(100,116,139,0.50)' }}>
        {tileStale ? '⚠ stale · ' : ''}{updatedAt}
      </div>
    </div>
  )
}

// ─── Main Macro Risk Matrix Component ────────────────────────────────────────

export interface MacroRiskMatrixProps {
  metrics: MacroRiskMetrics
}

export function MacroRiskMatrix({ metrics }: MacroRiskMatrixProps) {
  const { vix, vvix, move, gamma, skew, putCallRatio, dataSource, timestamp, credit, fx } = metrics

  // ── Stale detection ───────────────────────────────────────────────────────
  // Recompute age every 5 seconds so the UI responds within one tick of going stale.
  // timestamp === 0 is the cold-start sentinel → never treat as stale (no real data age).
  const [ageSeconds, setAgeSeconds] = useState<number>(
    timestamp === 0 ? 0 : Math.floor((Date.now() - timestamp) / 1000),
  )

  useEffect(() => {
    if (timestamp === 0) return          // baseline — no polling needed
    const tick = () => setAgeSeconds(Math.floor((Date.now() - timestamp) / 1000))
    tick()                               // sync immediately when timestamp changes
    const t = setInterval(tick, 5_000)
    return () => clearInterval(t)
  }, [timestamp])

  // Stale threshold must exceed the live update cadence, otherwise a healthy
  // feed false-flags ⚠ STALE between polls.  useVolRisk polls every 300s and the
  // /api/vol-risk cache serves data up to 60s old, so a fresh VIXY snapshot can
  // legitimately read ~360s of age right before the next poll.  420s (7 min)
  // adds a small buffer — only a genuine multi-cycle outage trips the badge.
  const STALE_AFTER_S = 420
  const isStale   = timestamp > 0 && ageSeconds > STALE_AFTER_S
  const updatedAt = timestamp === 0 ? 'baseline' : fmtAge(ageSeconds)

  // Resolve per-metric sources (treat absent dataSource as all-baseline)
  const src: DataSourceMap = dataSource ?? {
    vix: 'baseline', vvix: 'baseline', move: 'baseline',
    skew: 'baseline', gamma: 'baseline', putCallRatio: 'baseline',
  }

  // ── Risk scores ───────────────────────────────────────────────────────────
  const vixScore     = calculateRiskScore(vix.price,      12,   35)
  const moveScore    = calculateRiskScore(move.price,     60,  160)
  const vvixScore    = calculateRiskScore(vvix.price,     75,  130)
  const skewScore    = calculateRiskScore(skew.price,    115,  155)
  const putCallScore = calculateRiskScore(putCallRatio, 0.45, 1.15)
  const gammaScore   = gamma.regime === 'low' ? 100 : gamma.regime === 'medium' ? 50 : 0
  const avgScore     = (vixScore + moveScore + vvixScore + skewScore + putCallScore + gammaScore) / 6

  const regimeLabel = avgScore < 33.33 ? 'RISK OFF' : avgScore < 66.67 ? 'NEUTRAL' : 'RISK ON'
  const regimeColor = avgScore < 33.33 ? '#f87171'  : avgScore < 66.67 ? '#fbbf24' : '#34d399'

  const SIG = {
    bullish: { text: 'text-emerald-400', bg: 'bg-emerald-400/10', border: 'border-emerald-400/30' },
    bearish: { text: 'text-red-400',     bg: 'bg-red-400/10',     border: 'border-red-400/30'     },
    warning: { text: 'text-amber-400',   bg: 'bg-amber-400/10',   border: 'border-amber-400/30'   },
    neutral: { text: 'text-slate-400',   bg: 'bg-slate-700/30',   border: 'border-slate-500/40'   },
  }

  // ── ScoreCard (inline) ────────────────────────────────────────────────────
  // Accepts source + isStale so each card can self-style.
  interface ScoreCardProps {
    title: string; subtitle: string
    value: string; change: string; changePct: string
    score: number; regime: string; note: string; explanation: string
    source: MetricSource
    /** Optional sub-label, e.g. "VIXY proxy" */
    proxyLabel?: string
  }

  const ScoreCard = ({
    title, subtitle, value, change, score, regime, note, explanation, source, proxyLabel,
  }: ScoreCardProps) => {
    // Stale only degrades live metrics; derived/baseline are never "stale"
    const tileStale   = isStale && source === 'live'
    const valueColor  = tileStale ? '#f97316' : undefined
    const borderColor = tileStale ? 'rgba(249,115,22,0.30)' : '#1a2540'

    return (
      <div
        className="bg-[#0c1221] rounded-xl p-2 flex flex-col gap-1.5 border transition-colors duration-300"
        style={{ borderColor }}
      >
        {/* Header row: title + source badge */}
        <div className="flex items-start justify-between gap-1">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
              <span className="text-[12px] font-mono text-amber-400/80 uppercase tracking-widest">{title}</span>
              <SourceBadge source={source} isStale={tileStale} />
            </div>
            <div className="text-[10px] text-slate-300">
              {subtitle}
              {proxyLabel && (
                <span className="ml-1 text-slate-500">· {proxyLabel}</span>
              )}
            </div>
          </div>
          <Tooltip label="" explanation={explanation} />
        </div>

        {/* Value + change */}
        <div className="flex items-end justify-between gap-1">
          <div className="min-w-0 flex-1">
            <div
              className="font-mono text-xl font-semibold tabular-nums leading-none transition-colors duration-300"
              style={{ color: valueColor }}
            >
              {value}
            </div>
            <div
              className="font-mono text-[12px] mt-0.5 transition-colors duration-300"
              style={{ color: tileStale ? '#f97316' : (change.startsWith('+') ? '#f87171' : '#34d399') }}
            >
              {change}
            </div>
          </div>
        </div>

        {/* Regime pill + score */}
        <div className="flex items-center justify-between gap-1">
          <span className={cn(
            'text-[11px] font-mono font-semibold tracking-wider px-1.5 py-0.5 rounded border',
            score > 66.67 ? `${SIG.bullish.text} ${SIG.bullish.bg} ${SIG.bullish.border}`
            : score > 33.33 ? `${SIG.neutral.text} ${SIG.neutral.bg} ${SIG.neutral.border}`
            : `${SIG.bearish.text} ${SIG.bearish.bg} ${SIG.bearish.border}`,
          )}>
            {regime}
          </span>
          <span
            className="text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded border bg-slate-700/30 border-slate-500/40"
            style={{ color: score > 66.67 ? '#34d399' : score > 33.33 ? '#fbbf24' : '#f87171' }}
          >
            {score.toFixed(0)}
          </span>
        </div>

        {/* Note */}
        <p className="text-[11px] text-slate-400 leading-tight">{note}</p>

        {/* Per-tile timestamp */}
        <div
          className="text-[9px] font-mono leading-none transition-colors duration-300"
          style={{ color: tileStale ? 'rgba(249,115,22,0.60)' : 'rgba(100,116,139,0.50)' }}
        >
          {tileStale ? '⚠ stale · ' : ''}{updatedAt}
        </div>
      </div>
    )
  }

  return (
    <div>
      {/* ── Section header with data-age timestamp ── */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
          Macro Risk Matrix &amp; Cross-Asset Volatility
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Source legend */}
          <span className="hidden sm:flex items-center gap-2 text-[9px] font-mono text-slate-500">
            <span style={{ color: SOURCE_STYLE.live.color    }}>● live</span>
            <span style={{ color: SOURCE_STYLE.derived.color }}>~ derived</span>
            <span style={{ color: SOURCE_STYLE.baseline.color}}>○ baseline</span>
          </span>
          {/* Age indicator */}
          <span
            className="text-[9px] font-mono px-1.5 py-0.5 rounded border"
            style={{
              color:           isStale ? 'rgba(249,115,22,0.85)' : 'rgba(100,116,139,0.60)',
              borderColor:     isStale ? 'rgba(249,115,22,0.30)' : 'rgba(100,116,139,0.20)',
              backgroundColor: isStale ? 'rgba(249,115,22,0.06)' : 'transparent',
            }}
            title={timestamp === 0 ? 'Cold-start baseline — no live data yet' : `Alpaca snapshot age: ${ageSeconds}s`}
          >
            {isStale ? '⚠ ' : ''}{timestamp === 0 ? 'no data' : `↻ ${updatedAt}`}
          </span>
        </div>
      </div>

      {/* ── Metric tiles grid — 6 skinny cards in a single row ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 mb-3">
        {/* Row 1: VIX · MOVE · SKEW */}
        <ScoreCard
          title="VIX"
          subtitle="Equity Volatility"
          proxyLabel="VIXY ETF"
          source={src.vix}
          value={vix.price.toFixed(2)}
          change={fmtChange(vix.change, 2)}
          changePct={vix.changePercent.toFixed(1) + '%'}
          score={vixScore}
          regime={vixScore > 66.67 ? 'RISK ON' : vixScore > 33.33 ? 'NEUTRAL' : 'RISK OFF'}
          note={vix.price < 15 ? 'Market complacency' : vix.price < 20 ? 'Normal environment' : vix.price < 30 ? 'Heightened uncertainty' : 'Elevated panic'}
          explanation="VIX (via VIXY ETF, Alpaca live). Equity 30d implied vol. Low=calm, High=stress."
        />
        <ScoreCard
          title="MOVE"
          subtitle="Bond Volatility"
          source={src.move}
          value={move.price.toFixed(1)}
          change={fmtChange(move.change, 2)}
          changePct={move.changePercent.toFixed(1) + '%'}
          score={moveScore}
          regime={moveScore > 66.67 ? 'CALM' : moveScore > 33.33 ? 'MODERATE' : 'STRESS'}
          note={move.price > 150 ? 'Rate volatility spike' : move.price > 130 ? 'Rising rate uncertainty' : 'Stable bond market'}
          explanation="ICE BofA MOVE index — bond market implied vol. Derived: baseline 115 × (1 + VIX_change% × 0.30)."
        />
        <ScoreCard
          title="SKEW"
          subtitle="Tail Risk Premium"
          source={src.skew}
          value={skew.price.toFixed(1)}
          change={fmtChange(skew.change, 2)}
          changePct={skew.changePercent.toFixed(1) + '%'}
          score={skewScore}
          regime={skewScore > 66.67 ? 'CHEAP' : skewScore > 33.33 ? 'NORMAL' : 'EXPENSIVE'}
          note={skew.price > 145 ? 'Expensive downside hedges' : skew.price < 120 ? 'Compressed tail risk' : 'Normal tail pricing'}
          explanation="CBOE SKEW index. Derived: baseline 130 × (1 + VIX_change% × 0.20)."
        />
        {/* Row 2: PUT/CALL · CREDIT · USD */}
        <ScoreCard
          title="PUT/CALL"
          subtitle="Options Flow Sentiment"
          source={src.putCallRatio}
          value={putCallRatio.toFixed(2)}
          change={putCallRatio > 0.7 ? 'Hedging' : 'Calls'}
          changePct={putCallRatio > 0.9 ? 'Active' : 'Neutral'}
          score={putCallScore}
          regime={putCallScore > 66.67 ? 'CALL' : putCallScore > 33.33 ? 'NEUTRAL' : 'PUT'}
          note={putCallRatio > 0.9 ? 'Put hedging active' : putCallRatio > 0.75 ? 'Balanced bias' : 'Call demand dominant'}
          explanation="CBOE Equity P/C ratio. Baseline: long-run mean 0.78 — no clean β to VIX available."
        />
        {credit && (
          <CreditStressCard
            credit={credit}
            source={src.credit ?? 'live'}
            isStale={isStale && (src.credit ?? 'live') === 'live'}
            updatedAt={updatedAt}
          />
        )}
        {fx && (
          <FxStressCard
            fx={fx}
            source={src.fx ?? 'live'}
            isStale={isStale && (src.fx ?? 'live') === 'live'}
            updatedAt={updatedAt}
          />
        )}
      </div>

      {/* ── Combined regime bar ── */}
      <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest mb-0.5">
              Combined Regime
            </div>
            <div className="text-[11px] text-slate-300">Macro volatility assessment</div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="font-mono text-3xl font-bold leading-none" style={{ color: regimeColor }}>
                {regimeLabel}
              </div>
              <div className="font-mono text-[11px] mt-1 text-slate-400">
                Score: {avgScore.toFixed(0)}/100
              </div>
            </div>
          </div>
        </div>
        <div className="flex gap-0.5 mt-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="flex-1 h-2 rounded-full transition-all"
              style={{
                backgroundColor: avgScore > (i + 0.5) * (100 / 6) ? regimeColor : '#1e293b',
                opacity:         avgScore > (i + 0.5) * (100 / 6) ? 1 : 0.3,
              }}
            />
          ))}
        </div>
        {/* Row: stress badge + tail risk + attribution note */}
        <div className="flex items-center gap-2 mt-3 flex-wrap">
          <StressBadge vixPrice={vix.price} movePrice={move.price} />
          <TailRiskAlert
            vvixPrice={vvix.price}  vvixChange={vvix.change}
            vixPrice={vix.price}   vixChange={vix.change}
          />
          <span className="text-[9px] font-mono text-slate-600 ml-auto">
            VIX via Alpaca/VIXY · MOVE/VVIX/SKEW β-projected · Gamma synthesised
          </span>
        </div>
      </div>
    </div>
  )
}
