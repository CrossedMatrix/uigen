'use client'

import { useId } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface COTAsset {
  asset: string
  symbol: string
  /** Positive = net long, negative = net short (in contracts) */
  leveragedNet: number
  leveragedChange1W: number
  commercialNet: number
  /** Consecutive weeks at an extreme positioning level */
  weeksAtExtreme: number
  trend3W: 'building_longs' | 'reducing_longs' | 'building_shorts' | 'reducing_shorts' | 'stabilizing'
  priceChange4W: number
  meanReversionAlert: boolean
}

export interface CTAGaugeRow {
  label: string
  /** -100 to +100. Positive = net long, negative = net short */
  exposure: number
  prevExposure: number
  signal: 'neutral' | 'exhaustion_risk' | 'bearish' | 'bullish'
}

export interface SkewTicker {
  ticker: string
  /** 0–100. Percentage of open interest / premium skewed toward calls */
  callPct: number
  /** 100 - callPct */
  putPct: number
  /** Weekly implied move (%) derived from ATM options */
  impliedMove: number
  signal: 'upside_demand' | 'balanced' | 'hedging'
}

export interface BottleneckSide {
  label: string
  tickers: string[]
  peRatio: number
  revenueGrowthPct: number
  return30dPct: number
}

export interface BottleneckData {
  infra: BottleneckSide
  software: BottleneckSide
  /** infra basket / software basket — 1.0 = parity */
  ratio: number
  ratioTrend: 'infra_outperforming' | 'software_outperforming' | 'converging'
  ratioChange30d: number
  sparkline: number[]
}

export interface FlowsData {
  cot: COTAsset[]
  ctaGauges: CTAGaugeRow[]
  techSkew: SkewTicker[]
  bottleneck: BottleneckData
}

// ─── Mock Data JSON ───────────────────────────────────────────────────────────
//
// Full structure:
// {
//   cot:        COTAsset[]    — CFTC Commitments of Traders data
//   ctaGauges:  CTAGaugeRow[] — CTA/systematic fund exposure by asset class
//   techSkew:   SkewTicker[]  — options call/put skew for mega-cap tech
//   bottleneck: BottleneckData — AI infra vs software capital rotation ratio
// }

export const FLOWS_MOCK: FlowsData = {
  cot: [
    {
      asset: '10Y Treasuries',
      symbol: '^TNX',
      leveragedNet: -245000,     // extreme net short
      leveragedChange1W: +18200, // covering shorts (positive = reducing short)
      commercialNet: +312000,
      weeksAtExtreme: 8,
      trend3W: 'stabilizing',    // shorts no longer growing → triggers MR alert
      priceChange4W: -0.12,
      meanReversionAlert: true,  // -245K extreme AND stabilizing → MEAN REVERSION SETUP
    },
    {
      asset: 'Crude Oil (WTI)',
      symbol: 'CL=F',
      leveragedNet: +182000,
      leveragedChange1W: -12400,
      commercialNet: -198000,
      weeksAtExtreme: 3,
      trend3W: 'reducing_longs',
      priceChange4W: +2.4,
      meanReversionAlert: false,
    },
    {
      asset: 'Copper',
      symbol: 'HG=F',
      leveragedNet: +42000,
      leveragedChange1W: +8100,
      commercialNet: -55000,
      weeksAtExtreme: 2,
      trend3W: 'building_longs',
      priceChange4W: +5.2,
      meanReversionAlert: false,
    },
  ],

  ctaGauges: [
    { label: 'Global Equities',  exposure: 87,  prevExposure: 79, signal: 'exhaustion_risk' },
    { label: 'Emerging Markets', exposure: 34,  prevExposure: 28, signal: 'neutral'         },
    { label: 'US Fixed Income',  exposure: -22, prevExposure: -18, signal: 'bearish'        },
    { label: 'Commodities',      exposure: 61,  prevExposure: 65, signal: 'neutral'         },
  ],

  techSkew: [
    { ticker: 'NVDA', callPct: 68, putPct: 32, impliedMove: 4.2, signal: 'upside_demand' },
    { ticker: 'META', callPct: 58, putPct: 42, impliedMove: 2.8, signal: 'balanced'      },
    { ticker: 'AAPL', callPct: 45, putPct: 55, impliedMove: 1.9, signal: 'hedging'       },
  ],

  bottleneck: {
    infra: {
      label: 'AI Infra & Energy',
      tickers: ['NVDA', 'VST', 'CEG', 'GEV', 'SMR', 'ASTS'],
      peRatio: 42.1,
      revenueGrowthPct: 28.4,
      return30dPct: 12.8,
    },
    software: {
      label: 'Software Providers',
      tickers: ['MSFT', 'GOOGL', 'AMZN', 'ORCL', 'CRM', 'NOW'],
      peRatio: 28.6,
      revenueGrowthPct: 16.2,
      return30dPct: 4.2,
    },
    ratio: 1.47,
    ratioTrend: 'infra_outperforming',
    ratioChange30d: +0.29,
    // 15 daily data points — rising ratio = infra outperforming
    sparkline: [1.08, 1.12, 1.15, 1.18, 1.20, 1.24, 1.28, 1.31, 1.35, 1.38, 1.41, 1.44, 1.45, 1.46, 1.47],
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(' ')
}

function fmtK(n: number): string {
  const sign = n >= 0 ? '+' : '−'
  return `${sign}${Math.abs(Math.round(n / 1000)).toLocaleString()}K`
}

const TREND_CONFIG = {
  building_longs:  { label: '▲ BUILDING',  color: '#34d399' },
  reducing_longs:  { label: '▼ REDUCING',  color: '#fbbf24' },
  building_shorts: { label: '▼ SHORTING',  color: '#f87171' },
  reducing_shorts: { label: '▲ COVERING',  color: '#34d399' },
  stabilizing:     { label: '→ STABLE',    color: '#94a3b8' },
} as const

// ─── Ratio Sparkline SVG ──────────────────────────────────────────────────────

function RatioSparkline({ data, color, h = 44 }: { data: number[]; color: string; h?: number }) {
  const uid = useId()
  const gid = `rsg${uid.replace(/:/g, '')}`

  if (data.length < 2) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  const rng = max - min || 0.01
  const pad = 3

  const pts = data.map((v, i) => ({
    x: (i / (data.length - 1)) * 100, // use viewBox 0-100 width
    y: h - pad - ((v - min) / rng) * (h - pad * 2),
  }))

  const line = pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
  const area = `M0,${h} ${pts.map((p) => `L${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')} L100,${h} Z`

  return (
    <svg width="100%" height={h} viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" className="overflow-visible">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.20" />
          <stop offset="100%" stopColor={color} stopOpacity="0"    />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={pts[pts.length-1].x} cy={pts[pts.length-1].y} r="2.5" fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// ─── COT Center-Origin Bar ────────────────────────────────────────────────────

const COT_MAX_SCALE = 320_000 // contracts — extreme level reference

function COTBar({ net }: { net: number }) {
  const isLong = net >= 0
  // fillPct as % of one half-bar (0–50 of total width)
  const fillPct = Math.min(50, (Math.abs(net) / COT_MAX_SCALE) * 50)

  return (
    <div className="relative h-2 w-full bg-[#111827] rounded-full overflow-hidden">
      {/* Center marker */}
      <div className="absolute left-1/2 top-0 w-px h-full bg-slate-600 z-10" />
      {isLong ? (
        <div
          className="absolute left-1/2 top-0 h-full rounded-r"
          style={{ width: `${fillPct}%`, backgroundColor: '#38bdf8', opacity: 0.85 }}
        />
      ) : (
        <div
          className="absolute right-1/2 top-0 h-full rounded-l"
          style={{ width: `${fillPct}%`, backgroundColor: '#f87171', opacity: 0.85 }}
        />
      )}
    </div>
  )
}

// ─── COT Row ─────────────────────────────────────────────────────────────────

const COT_COLS = '9rem 5.5rem 1fr 5.5rem 7.5rem 5.5rem 6.5rem'

function COTRow({ row }: { row: COTAsset }) {
  const trend = TREND_CONFIG[row.trend3W]
  const isLong = row.leveragedNet >= 0
  const netColor = isLong ? '#38bdf8' : '#f87171'

  return (
    <div
      className={cn(
        'grid items-center gap-3 px-3 py-2.5 rounded-lg border transition-all',
        row.meanReversionAlert
          ? 'border-amber-400/25 bg-amber-400/[0.04]'
          : 'border-transparent hover:bg-slate-800/20',
      )}
      style={{ gridTemplateColumns: COT_COLS }}
    >
      {/* Asset name */}
      <div>
        <div className="text-xs text-slate-200 font-mono">{row.asset}</div>
        {row.weeksAtExtreme > 0 && (
          <div className="text-[9px] text-slate-700 font-mono mt-0.5">
            {row.weeksAtExtreme}w at extreme
          </div>
        )}
      </div>

      {/* Leveraged Net */}
      <div className="text-right">
        <div className="font-mono text-sm tabular-nums font-semibold" style={{ color: netColor }}>
          {fmtK(row.leveragedNet)}
        </div>
        <div
          className={cn(
            'font-mono text-[10px] tabular-nums mt-0.5',
            row.leveragedChange1W >= 0 ? 'text-emerald-400' : 'text-red-400',
          )}
        >
          {row.leveragedChange1W >= 0 ? '+' : ''}{fmtK(row.leveragedChange1W)}/wk
        </div>
      </div>

      {/* COT bar */}
      <div className="px-1">
        <COTBar net={row.leveragedNet} />
        <div className="flex justify-between text-[8px] text-slate-800 font-mono mt-0.5">
          <span>MAX SHORT</span>
          <span>0</span>
          <span>MAX LONG</span>
        </div>
      </div>

      {/* 4W Price change */}
      <div
        className={cn(
          'font-mono text-xs tabular-nums text-right',
          row.priceChange4W >= 0 ? 'text-emerald-400' : 'text-red-400',
        )}
      >
        {row.priceChange4W >= 0 ? '+' : ''}{row.priceChange4W.toFixed(1)}% 4W
      </div>

      {/* 3W Trend */}
      <div
        className="font-mono text-[11px] font-semibold tracking-wider"
        style={{ color: trend.color }}
      >
        {trend.label}
      </div>

      {/* Commercial Net */}
      <div
        className={cn(
          'font-mono text-xs tabular-nums text-right',
          row.commercialNet >= 0 ? 'text-sky-400/70' : 'text-rose-400/70',
        )}
      >
        {fmtK(row.commercialNet)}
      </div>

      {/* Mean Reversion Alert */}
      <div className="flex justify-end">
        {row.meanReversionAlert ? (
          <div
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border text-[9px] font-mono font-bold tracking-widest animate-pulse"
            style={{
              color: '#fbbf24',
              borderColor: 'rgba(251,191,36,0.5)',
              backgroundColor: 'rgba(251,191,36,0.12)',
              boxShadow: '0 0 12px rgba(251,191,36,0.25)',
            }}
          >
            <span>⚡</span>
            <span>MR SETUP</span>
          </div>
        ) : (
          <span className="text-[9px] font-mono text-slate-800">—</span>
        )}
      </div>
    </div>
  )
}

// ─── COT Matrix ───────────────────────────────────────────────────────────────

function COTMatrix({ cot }: { cot: COTAsset[] }) {
  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
          CFTC / COT — Leveraged Fund Positioning Matrix
        </h3>
        <div className="flex items-center gap-3 text-[10px] text-slate-700 font-mono">
          <span className="flex items-center gap-1">
            <span className="inline-block w-6 h-1.5 rounded bg-sky-400/70" /> Net Long
          </span>
          <span className="flex items-center gap-1">
            <span className="inline-block w-6 h-1.5 rounded bg-red-400/70" /> Net Short
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <div style={{ minWidth: '680px' }}>
          {/* Column headers */}
          <div
            className="grid items-center gap-3 px-3 pb-2.5 border-b border-[#1a2540] mb-0.5"
            style={{ gridTemplateColumns: COT_COLS }}
          >
            {[
              ['Asset',          'text-left'],
              ['Lev. Funds Net', 'text-right'],
              ['Positioning Scale','text-center'],
              ['4W Price',       'text-right'],
              ['3W Trend',       'text-left'],
              ['Commercial Net', 'text-right'],
              ['Signal',         'text-right'],
            ].map(([lbl, align]) => (
              <div key={lbl} className={cn('text-[9px] font-mono text-slate-700 uppercase tracking-widest', align)}>
                {lbl}
              </div>
            ))}
          </div>

          {/* Data rows */}
          <div>
            {cot.map((row) => <COTRow key={row.symbol} row={row} />)}
          </div>
        </div>
      </div>

      {/* MR condition footnote */}
      <p className="text-[9px] text-slate-800 font-mono mt-3 pt-3 border-t border-[#1a2540]">
        ⚡ Mean-Reversion Setup triggered when Leveraged Funds hold an extreme position for 6+ weeks AND the 3-week trend is stabilizing or reversing — historically a high-probability contrarian signal.
      </p>
    </div>
  )
}

// ─── CTA Gauge Row ────────────────────────────────────────────────────────────

function CTAGauge({ row }: { row: CTAGaugeRow }) {
  const { label, exposure, prevExposure, signal } = row
  const isNegative = exposure < 0
  const pctAbs = Math.abs(exposure)

  // For 0–100 gauges: direct fill. For negative: fill from right.
  const barColor =
    signal === 'exhaustion_risk' ? '#f87171' :
    signal === 'bearish'         ? '#f87171' :
    pctAbs > 70                  ? '#fbbf24' : '#34d399'

  const delta = exposure - prevExposure
  const deltaColor = delta > 0 ? '#34d399' : delta < 0 ? '#f87171' : '#94a3b8'
  const deltaArrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '→'

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-300 font-mono">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono" style={{ color: deltaColor }}>
            {deltaArrow} {Math.abs(delta).toFixed(0)}pp
          </span>
          <span className="font-mono text-sm font-semibold tabular-nums" style={{ color: barColor }}>
            {exposure > 0 ? '+' : ''}{exposure.toFixed(0)}%
          </span>
          {signal === 'exhaustion_risk' && (
            <span
              className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border animate-pulse"
              style={{ color: '#f87171', borderColor: 'rgba(248,113,113,0.4)', backgroundColor: 'rgba(248,113,113,0.12)', boxShadow: '0 0 8px rgba(248,113,113,0.3)' }}
            >
              EXHAUSTION
            </span>
          )}
        </div>
      </div>

      {/* Bar track */}
      {isNegative ? (
        // Net short: bar fills from right, background = full track
        <div className="relative h-2 bg-[#111827] rounded-full overflow-hidden">
          <div className="absolute left-1/2 top-0 w-px h-full bg-slate-700 z-10" />
          <div
            className="absolute right-1/2 top-0 h-full rounded-l transition-all"
            style={{ width: `${pctAbs / 2}%`, backgroundColor: barColor, opacity: 0.8 }}
          />
        </div>
      ) : (
        // Net long: bar fills from left, full range = 0–100
        <div className="relative h-2 bg-[#111827] rounded-full overflow-hidden">
          {/* Exhaustion threshold line at 85% */}
          {signal === 'exhaustion_risk' && (
            <div
              className="absolute top-0 w-px h-full bg-red-400/60 z-10"
              style={{ left: '85%' }}
            />
          )}
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${pctAbs}%`, backgroundColor: barColor, opacity: 0.85 }}
          />
        </div>
      )}

      {/* Scale labels */}
      {isNegative ? (
        <div className="flex justify-between text-[8px] text-slate-800 font-mono">
          <span>−100%</span>
          <span>0%</span>
          <span>+100%</span>
        </div>
      ) : (
        <div className="flex justify-between text-[8px] text-slate-800 font-mono">
          <span>0%</span>
          {signal === 'exhaustion_risk' && <span style={{ color: 'rgba(248,113,113,0.5)' }}>85% ←</span>}
          <span>100%</span>
        </div>
      )}
    </div>
  )
}

// ─── CTA Gauges Panel ─────────────────────────────────────────────────────────

function CTAGaugesPanel({ gauges }: { gauges: CTAGaugeRow[] }) {
  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
          CTA / Systematic Exposure
        </h3>
        <span className="text-[9px] font-mono text-slate-700">Est. % of max allocation</span>
      </div>

      <div className="space-y-5">
        {gauges.map((g) => <CTAGauge key={g.label} row={g} />)}
      </div>

      <p className="text-[9px] text-slate-800 font-mono border-t border-[#1a2540] pt-3">
        Estimated CTA / trend-follower positioning derived from futures open interest and managed-money flows. Not a direct CFTC data point.
      </p>
    </div>
  )
}

// ─── Options Skew Bar ─────────────────────────────────────────────────────────

function SkewBar({ row }: { row: SkewTicker }) {
  const { ticker, callPct, putPct, impliedMove, signal } = row

  const signalConfig = {
    upside_demand: { label: 'UPSIDE DEMAND', color: '#38bdf8',  bg: 'rgba(56,189,248,0.12)',  border: 'rgba(56,189,248,0.35)' },
    balanced:      { label: 'BALANCED',      color: '#94a3b8',  bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.25)' },
    hedging:       { label: 'HEDGING',       color: '#fbbf24',  bg: 'rgba(251,191,36,0.12)',  border: 'rgba(251,191,36,0.35)' },
  }[signal]

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-slate-100 font-semibold w-12">{ticker}</span>
          <span
            className="text-[9px] font-mono font-bold px-1.5 py-0.5 rounded border"
            style={{ color: signalConfig.color, backgroundColor: signalConfig.bg, borderColor: signalConfig.border }}
          >
            {signalConfig.label}
          </span>
        </div>
        <div className="text-[10px] font-mono text-slate-600">
          ±{impliedMove.toFixed(1)}% wk IV
        </div>
      </div>

      {/* Call / Put split bar */}
      <div className="relative h-2.5 w-full bg-[#111827] rounded-full overflow-hidden flex">
        {/* Put side (amber) */}
        <div
          className="h-full rounded-l"
          style={{ width: `${putPct}%`, backgroundColor: '#fbbf24', opacity: 0.7 }}
        />
        {/* Call side (sky) */}
        <div
          className="h-full rounded-r"
          style={{ width: `${callPct}%`, backgroundColor: '#38bdf8', opacity: 0.8 }}
        />
      </div>

      <div className="flex justify-between text-[9px] font-mono">
        <span style={{ color: '#fbbf2499' }}>Puts {putPct}%</span>
        <span style={{ color: '#38bdf899' }}>Calls {callPct}%</span>
      </div>
    </div>
  )
}

// ─── Tech Skew Panel ──────────────────────────────────────────────────────────

function TechSkewPanel({ skew }: { skew: SkewTicker[] }) {
  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
          High-Beta Tech Options Skew
        </h3>
        <div className="flex items-center gap-2 text-[9px] font-mono">
          <span style={{ color: 'rgba(251,191,36,0.6)' }}>■ Puts</span>
          <span style={{ color: 'rgba(56,189,248,0.7)' }}>■ Calls</span>
        </div>
      </div>

      <div className="space-y-5">
        {skew.map((s) => <SkewBar key={s.ticker} row={s} />)}
      </div>

      {/* Aggregate interpretation */}
      <div className="mt-auto border border-[#1a2540] bg-[#080d18] rounded-xl p-3 space-y-1">
        <div className="text-[9px] font-mono text-slate-700 uppercase tracking-widest">Aggregate Skew Signal</div>
        <div className="text-[11px] font-mono text-slate-400">
          NVDA call skew elevated — institutions positioning for upside variance.
          AAPL put dominance signals defensive hedging ahead of macro event risk.
        </div>
      </div>

      <p className="text-[9px] text-slate-800 font-mono border-t border-[#1a2540] pt-3">
        Call/put skew derived from OI and premium distribution across ATM ± 5% strikes. Weekly expiry.
      </p>
    </div>
  )
}

// ─── Bottleneck Side Card ─────────────────────────────────────────────────────

function BottleneckSideCard({
  side,
  accentColor,
}: {
  side: BottleneckSide
  accentColor: string
}) {
  return (
    <div
      className="rounded-xl border p-3 space-y-2.5"
      style={{ borderColor: `${accentColor}22`, backgroundColor: `${accentColor}08` }}
    >
      {/* Header */}
      <div className="flex items-center gap-2">
        <div className="w-1 h-4 rounded-full shrink-0" style={{ backgroundColor: accentColor }} />
        <span className="text-[10px] font-mono font-semibold uppercase tracking-widest" style={{ color: accentColor }}>
          {side.label}
        </span>
      </div>

      {/* Ticker pills */}
      <div className="flex flex-wrap gap-1">
        {side.tickers.map((t) => (
          <span
            key={t}
            className="text-[9px] font-mono px-1.5 py-0.5 rounded border"
            style={{ color: accentColor, borderColor: `${accentColor}30`, backgroundColor: `${accentColor}10` }}
          >
            {t}
          </span>
        ))}
      </div>

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-3 pt-1 border-t border-[#1a2540]">
        <div>
          <div className="text-[9px] text-slate-700 font-mono mb-0.5">P/E</div>
          <div className="font-mono text-sm text-slate-200">{side.peRatio.toFixed(1)}×</div>
        </div>
        <div>
          <div className="text-[9px] text-slate-700 font-mono mb-0.5">Rev Growth</div>
          <div className="font-mono text-sm text-emerald-400">+{side.revenueGrowthPct.toFixed(1)}%</div>
        </div>
        <div>
          <div className="text-[9px] text-slate-700 font-mono mb-0.5">30d Return</div>
          <div
            className="font-mono text-sm"
            style={{ color: side.return30dPct >= 0 ? '#34d399' : '#f87171' }}
          >
            {side.return30dPct >= 0 ? '+' : ''}{side.return30dPct.toFixed(1)}%
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Bottleneck Panel ─────────────────────────────────────────────────────────

function BottleneckPanel({ data }: { data: BottleneckData }) {
  const { infra, software, ratio, ratioTrend, ratioChange30d, sparkline } = data

  const INFRA_COLOR    = '#60a5fa'  // neon blue  → hard assets / power
  const SOFTWARE_COLOR = '#fbbf24'  // amber      → software multiples

  const ratioColor =
    ratioTrend === 'infra_outperforming'    ? INFRA_COLOR :
    ratioTrend === 'software_outperforming' ? SOFTWARE_COLOR : '#94a3b8'

  const ratioLabel =
    ratioTrend === 'infra_outperforming'    ? '↗ INFRA OUTPERFORMING' :
    ratioTrend === 'software_outperforming' ? '↘ SOFTWARE OUTPERFORMING' : '→ CONVERGING'

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
          Physical AI Infra & Energy vs. Software — Bottleneck Ratio
        </h3>
        <div
          className="text-[10px] font-mono font-bold px-2.5 py-1 rounded-lg border"
          style={{ color: ratioColor, borderColor: `${ratioColor}40`, backgroundColor: `${ratioColor}12` }}
        >
          {ratioLabel}
        </div>
      </div>

      {/* Two sides */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <BottleneckSideCard side={infra}    accentColor={INFRA_COLOR}    />
        <BottleneckSideCard side={software} accentColor={SOFTWARE_COLOR} />
      </div>

      {/* Ratio strip */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 rounded-xl border border-[#1a2540] bg-[#080d18] p-4">
        {/* Big number */}
        <div className="shrink-0">
          <div className="text-[9px] font-mono text-slate-700 uppercase tracking-widest mb-1">
            Infra / Software Ratio
          </div>
          <div className="flex items-baseline gap-2.5">
            <span className="font-mono text-4xl font-bold tabular-nums" style={{ color: ratioColor }}>
              {ratio.toFixed(2)}
              <span className="text-2xl">×</span>
            </span>
            <div>
              <div
                className="font-mono text-xs"
                style={{ color: ratioChange30d >= 0 ? '#34d399' : '#f87171' }}
              >
                {ratioChange30d >= 0 ? '+' : ''}{ratioChange30d.toFixed(2)} 30d
              </div>
              <div className="text-[9px] text-slate-700 font-mono">
                {ratio >= 1 ? `Infra +${((ratio - 1) * 100).toFixed(0)}% vs Software` : `Software +${((1 / ratio - 1) * 100).toFixed(0)}% vs Infra`}
              </div>
            </div>
          </div>
        </div>

        {/* Sparkline */}
        <div className="flex-1 min-w-0 w-full">
          <div className="text-[9px] font-mono text-slate-700 mb-1">15-Day Trend</div>
          <RatioSparkline data={sparkline} color={ratioColor} h={44} />
        </div>

        {/* Interpretation */}
        <div className="shrink-0 max-w-[220px] border-l border-[#1a2540] pl-4 hidden lg:block">
          <div className="text-[9px] font-mono text-slate-700 uppercase tracking-widest mb-1">Thesis</div>
          <p className="text-[10px] text-slate-500 font-mono leading-relaxed">
            {ratioTrend === 'infra_outperforming'
              ? 'Capital rotating into power generation & compute substrate — the physical layer enabling AI at scale. Watch for mean reversion when software catches up on earnings.'
              : ratioTrend === 'software_outperforming'
              ? 'Software multiple expansion outpacing hard-asset capex cycle. Bottleneck thesis may be discounting infrastructure spend.'
              : 'Parity between infra and software capital flows. No clear rotation signal.'}
          </p>
        </div>
      </div>
    </div>
  )
}

// ─── Public Props ─────────────────────────────────────────────────────────────

export interface InstitutionalFlowsSectionProps {
  data?: FlowsData
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function InstitutionalFlowsSection({ data = FLOWS_MOCK }: InstitutionalFlowsSectionProps) {
  return (
    <section className="space-y-4">
      {/* 1 · CFTC / COT Matrix */}
      <COTMatrix cot={data.cot} />

      {/* 2 · CTA Gauges + Tech Skew */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <CTAGaugesPanel gauges={data.ctaGauges} />
        <TechSkewPanel  skew={data.techSkew}   />
      </div>

      {/* 3 · Bottleneck Ratio */}
      <BottleneckPanel data={data.bottleneck} />
    </section>
  )
}
