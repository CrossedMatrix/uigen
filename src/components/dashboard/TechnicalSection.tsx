'use client'

import { useId, type ReactNode } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface TechnicalRow {
  symbol: string
  shortName: string
  price: number
  support2: number
  support1: number
  resistance1: number
  resistance2: number
  ma50: number
  ma200: number
  rsi14: number
}

export interface RatioCard {
  id: string
  name: string
  subtitle: string
  /** null when the ratio cannot be computed (e.g. 429 rate-limit on a constituent) */
  value: number | null
  /** Pre-formatted string; '--' when value is null */
  displayValue: string
  change: number
  status: string
  signal: 'bullish' | 'bearish' | 'warning' | 'neutral'
  sparkline: number[]
  note: string
  /**
   * Data provenance badge shown beneath the ratio name.
   * 'live_futures' → "● Live Futures" (green) — IBKR/primary feed
   * 'alpaca_etf'   → "◈ Alpaca ETF Proxy" (amber) — ETF fallback active
   * 'derived'      → "~ Derived" (slate) — β-projected / computed
   * Omit (undefined) to show no badge.
   */
  source?: 'live_futures' | 'alpaca_etf' | 'derived'
}

// ─── Mock Data JSON ───────────────────────────────────────────────────────────
//
// Structure overview:
// {
//   technicals: TechnicalRow[]   — one entry per tracked asset
//   ratios: RatioCard[]          — cross-asset macro indicators
// }
//
// Prices are kept at the mocked values below; the dashboard page
// overlays real-time prices from the /api/market endpoint before
// passing data down to this component.

export const TECHNICALS_MOCK: TechnicalRow[] = [
  {
    symbol: '^NDX',
    shortName: 'NDX',
    price: 20842.65,
    support2: 19500,
    support1: 20200,
    resistance1: 21050,  // ~1.0% above current price → triggers proximity pulse
    resistance2: 22000,
    ma50: 19920,
    ma200: 18340,
    rsi14: 62.4,
  },
  {
    symbol: '^GSPC',
    shortName: 'SPX',
    price: 5847.32,
    support2: 5500,
    support1: 5700,
    resistance1: 5960,
    resistance2: 6200,
    ma50: 5580,
    ma200: 5210,
    rsi14: 58.2,
  },
  {
    symbol: 'GC=F',
    shortName: 'GOLD',
    price: 3328.40,
    support2: 3100,
    support1: 3200,
    resistance1: 3400,
    resistance2: 3600,
    ma50: 3150,
    ma200: 2850,
    rsi14: 68.4,
  },
  {
    symbol: 'SI=F',
    shortName: 'SILVER',
    price: 32.84,
    support2: 28.00,
    support1: 32.52,  // ~0.98% below current price → triggers proximity pulse
    resistance1: 34.50,
    resistance2: 37.00,
    ma50: 31.20,
    ma200: 28.40,
    rsi14: 65.3,
  },
  {
    symbol: 'HG=F',
    shortName: 'COPPER',
    price: 4.58,
    support2: 4.00,
    support1: 4.30,
    resistance1: 4.80,
    resistance2: 5.20,
    ma50: 4.42,
    ma200: 4.15,
    rsi14: 54.7,
  },
  {
    symbol: 'DX-Y.NYB',
    shortName: 'DXY',
    price: 104.23,
    support2: 100.00,
    support1: 102.50,
    resistance1: 106.00,
    resistance2: 108.00,
    ma50: 104.80,
    ma200: 105.20,  // Death Cross: MA50 < MA200
    rsi14: 46.8,
  },
  {
    symbol: 'CL=F',
    shortName: 'CRUDE',
    price: 61.84,
    support2: 55.00,
    support1: 58.00,
    resistance1: 65.00,
    resistance2: 70.00,
    ma50: 63.20,
    ma200: 71.40,   // MA50 < MA200 → Death Cross
    rsi14: 41.8,
  },
  {
    symbol: 'SOXX',
    shortName: 'SOXX',
    price: 218.40,
    support2: 195.00,
    support1: 208.00,
    resistance1: 225.00,
    resistance2: 240.00,
    ma50: 211.20,
    ma200: 196.80,
    rsi14: 61.4,
  },
  {
    symbol: 'EWY',
    shortName: 'KOREA',
    price: 58.72,
    support2: 52.00,
    support1: 56.00,
    resistance1: 61.50,
    resistance2: 66.00,
    ma50: 56.80,
    ma200: 58.10,   // MA50 < MA200 → Death Cross
    rsi14: 52.3,
  },
]

// Sparkline arrays: 15 daily data points (approx 3 trading weeks)
const _spark = {
  copperGold: [
    0.001380, 0.001395, 0.001385, 0.001402, 0.001410,
    0.001405, 0.001415, 0.001408, 0.001420, 0.001412,
    0.001418, 0.001421, 0.001419, 0.001423, 0.001424,
  ],
  goldSilver: [
    99.8, 99.2, 99.5, 98.9, 99.1,
    98.6, 98.4, 98.7, 98.2, 97.9,
    98.1, 97.8, 98.0, 97.7, 97.9,
  ],
  ndxSpx: [
    3.482, 3.498, 3.510, 3.525, 3.518,
    3.534, 3.548, 3.541, 3.556, 3.548,
    3.562, 3.554, 3.558, 3.562, 3.565,
  ],
  riskScore: [
    68, 65, 62, 60, 63,
    58, 55, 57, 53, 56,
    51, 54, 50, 49, 48,
  ],
}

export const RATIOS_MOCK: RatioCard[] = [
  {
    id: 'copper_gold',
    name: 'Copper / Gold',
    subtitle: 'Growth vs. Safe-Haven',
    value: 0.001424,
    displayValue: '0.001424',
    change: +0.71,
    status: 'Risk On',
    signal: 'bullish',
    sparkline: _spark.copperGold,
    note: 'Rising ratio favors growth over safety. Sustained move above 0.0016 signals reflationary regime shift.',
  },
  {
    id: 'gold_silver',
    name: 'Gold / Silver',
    subtitle: 'Monetary vs. Industrial',
    value: 97.9,
    displayValue: '97.9',
    change: -0.31,
    status: 'Risk Off',
    signal: 'warning',
    sparkline: _spark.goldSilver,
    note: 'Ratio above 80 signals elevated monetary demand. Compression toward 50 = industrial / risk-on euphoria.',
  },
  {
    id: 'ndx_spx',
    name: 'NDX / SPX',
    subtitle: 'Tech vs. Broad Market',
    value: 3.565,
    displayValue: '3.565×',
    change: +1.22,
    status: 'Tech Dominance',
    signal: 'bullish',
    sparkline: _spark.ndxSpx,
    note: 'At cycle highs. AI infrastructure capex driving sustained mega-cap tech outperformance vs. equal weight.',
  },
  {
    id: 'risk_regime',
    name: 'VIX / Curve Signal',
    subtitle: 'Combined Risk Regime',
    value: 48,
    displayValue: 'MODERATE',
    change: -4.50,
    status: 'Curve Inverted',
    signal: 'warning',
    sparkline: _spark.riskScore,
    note: 'VIX 17.8 = low fear. Inverted yield curve (−0.83%) = latent recession tail risk persists.',
  },
]

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(' ')
}

function fmtLevel(n: number): string {
  if (n >= 10000) return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
  if (n >= 1000)  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })
  if (n >= 10)    return n.toFixed(2)
  return n.toFixed(4)
}

function fmtLivePrice(n: number): string {
  if (n >= 10000) return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (n >= 1000)  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (n >= 10)    return n.toFixed(2)
  return n.toFixed(4)
}

/** Returns true if |price - level| / price ≤ threshold (default 1%) */
function isNear(price: number, level: number, threshold = 0.01): boolean {
  return Math.abs(price - level) / price <= threshold
}

const SIG = {
  bullish: { text: 'text-[#4db8a8]', bg: 'bg-emerald-400/10', border: 'border-emerald-400/30' },
  bearish: { text: 'text-[#b87070]',     bg: 'bg-red-400/10',     border: 'border-red-400/30'     },
  warning: { text: 'text-amber-400',   bg: 'bg-amber-400/10',   border: 'border-amber-400/30'   },
  neutral: { text: 'text-slate-400',   bg: 'bg-slate-700/30',   border: 'border-slate-500/40'   },
} as const

// ─── Mini Sparkline ───────────────────────────────────────────────────────────

function MiniSparkline({
  data,
  signal,
  w = 72,
  h = 28,
}: {
  data: number[]
  signal: RatioCard['signal']
  w?: number
  h?: number
}) {
  const uid = useId()
  const gid = `tsg${uid.replace(/:/g, '')}`

  if (data.length < 2) return <div style={{ width: w, height: h }} className="rounded bg-slate-800/40" />

  const min = Math.min(...data)
  const max = Math.max(...data)
  const rng = max - min || 1
  const pad = 2

  const pts = data.map((v, i) => ({
    x: (i / (data.length - 1)) * w,
    y: h - pad - ((v - min) / rng) * (h - pad * 2),
  }))

  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const area = `M${pts[0].x},${h} ${pts.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} L${pts[pts.length - 1].x},${h} Z`

  const color =
    signal === 'bullish' ? '#34d399' :
    signal === 'bearish' ? '#f87171' :
    signal === 'warning' ? '#fbbf24' :
    '#94a3b8'

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible shrink-0">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0"    />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r="2" fill={color} />
    </svg>
  )
}

// ─── Level Bar ────────────────────────────────────────────────────────────────
// Visual strip: S2 ──[S1]──●PRICE──[R1]── R2

function LevelBar({
  price, s2, s1, r1, r2,
}: {
  price: number; s2: number; s1: number; r1: number; r2: number
}) {
  const total = r2 - s2
  const clamp = (v: number) => Math.max(2, Math.min(98, ((v - s2) / total) * 100))

  const pricePos = clamp(price)
  const s1Pos    = clamp(s1)
  const r1Pos    = clamp(r1)

  const nearR = isNear(price, r1) || isNear(price, r2)
  const nearS = isNear(price, s1) || isNear(price, s2)

  return (
    <div className="relative w-full h-5 flex items-center">
      <div className="relative w-full h-[3px] rounded-full bg-slate-800">
        {/* Support zone tint */}
        <div
          className="absolute h-full rounded-l-full bg-cyan-900/50"
          style={{ left: 0, width: `${s1Pos}%` }}
        />
        {/* Resistance zone tint */}
        <div
          className="absolute h-full rounded-r-full bg-red-900/40"
          style={{ left: `${r1Pos}%`, right: 0 }}
        />
        {/* S1 tick */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-px h-3 bg-cyan-500/50"
          style={{ left: `${s1Pos}%` }}
        />
        {/* R1 tick */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-px h-3 bg-amber-500/50"
          style={{ left: `${r1Pos}%` }}
        />
        {/* Price dot */}
        <div
          className={cn(
            'absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full border-2 border-[#0c1221] transition-all',
            nearR ? 'bg-amber-400 animate-pulse' :
            nearS ? 'bg-cyan-400 animate-pulse'  : 'bg-slate-300',
          )}
          style={{
            left: `${pricePos}%`,
            boxShadow: nearR
              ? '0 0 8px 1px rgba(251,191,36,0.7)'
              : nearS
              ? '0 0 8px 1px rgba(34,211,238,0.7)'
              : undefined,
          }}
        />
      </div>
    </div>
  )
}

// ─── Level Cell ───────────────────────────────────────────────────────────────

function LevelCell({
  price, level, type,
}: {
  price: number
  level: number
  type: 'support' | 'resistance'
}) {
  const near = isNear(price, level)
  return (
    <div
      className={cn(
        'font-mono text-xs tabular-nums px-1.5 py-0.5 rounded border text-right transition-all',
        near && type === 'resistance'
          ? 'text-amber-300 border-amber-400/50 bg-amber-400/10 animate-pulse'
          : near && type === 'support'
          ? 'text-cyan-300 border-cyan-400/50 bg-cyan-400/10 animate-pulse'
          : 'text-slate-300 border-transparent',
      )}
    >
      {fmtLevel(level)}
    </div>
  )
}

// ─── Cross Badge ──────────────────────────────────────────────────────────────

function CrossBadge({ ma50, ma200 }: { ma50: number; ma200: number }) {
  const golden = ma50 > ma200
  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 text-[10px] font-mono font-bold px-1.5 py-0.5 rounded border whitespace-nowrap',
        golden
          ? 'text-amber-300 bg-amber-400/10 border-amber-400/25'
          : 'text-[#b87070] bg-red-400/10 border-red-400/25',
      )}
    >
      <span style={{ fontSize: '11px' }}>{golden ? '⊕' : '⊗'}</span>
      <span>{golden ? 'GC' : 'DC'}</span>
    </div>
  )
}

// ─── RSI Badge ────────────────────────────────────────────────────────────────

function RSIBadge({ rsi }: { rsi: number }) {
  const ob = rsi > 70
  const os = rsi < 30
  return (
    <div
      className={cn(
        'font-mono text-xs tabular-nums px-1.5 py-0.5 rounded border inline-flex items-center gap-1',
        ob ? 'text-[#b87070] bg-red-400/10 border-red-400/25' :
        os ? 'text-[#4db8a8] bg-emerald-400/10 border-emerald-400/25' :
        'text-slate-400 border-transparent',
      )}
    >
      {rsi.toFixed(1)}
      {ob && <span className="text-[12px] opacity-60">OB</span>}
      {os && <span className="text-[12px] opacity-60">OS</span>}
    </div>
  )
}

// ─── Technical Table Row ──────────────────────────────────────────────────────

const COL_TEMPLATE = '3.5rem 5.5rem 4rem 4rem 1fr 4rem 4rem 3.5rem 4.5rem'

function TechRow({ row }: { row: TechnicalRow }) {
  const nearR = isNear(row.price, row.resistance1) || isNear(row.price, row.resistance2)
  const nearS = isNear(row.price, row.support1)    || isNear(row.price, row.support2)

  return (
    <div
      className={cn(
        'grid items-center gap-2 px-3 py-2 rounded-lg border transition-all',
        nearR ? 'border-amber-400/20 bg-amber-400/[0.04]' :
        nearS ? 'border-cyan-400/20 bg-cyan-400/[0.04]'   : 'border-transparent hover:bg-slate-800/20',
      )}
      style={{ gridTemplateColumns: COL_TEMPLATE }}
    >
      {/* Asset */}
      <div className="text-[10px] font-mono text-amber-400/80 tracking-widest uppercase leading-none">
        {row.shortName}
      </div>

      {/* Price */}
      <div className="font-mono text-sm text-slate-100 tabular-nums text-right">
        {fmtLivePrice(row.price)}
      </div>

      {/* S2 */}
      <LevelCell price={row.price} level={row.support2}    type="support"     />

      {/* S1 */}
      <LevelCell price={row.price} level={row.support1}    type="support"     />

      {/* Level bar */}
      <div className="px-1">
        <LevelBar
          price={row.price}
          s2={row.support2} s1={row.support1}
          r1={row.resistance1} r2={row.resistance2}
        />
      </div>

      {/* R1 */}
      <LevelCell price={row.price} level={row.resistance1} type="resistance"  />

      {/* R2 */}
      <LevelCell price={row.price} level={row.resistance2} type="resistance"  />

      {/* MA Cross */}
      <CrossBadge ma50={row.ma50} ma200={row.ma200} />

      {/* RSI */}
      <div className="flex justify-end">
        <RSIBadge rsi={row.rsi14} />
      </div>
    </div>
  )
}

// ─── MA Tooltip Row ───────────────────────────────────────────────────────────

function MARow({ row }: { row: TechnicalRow }) {
  const golden = row.ma50 > row.ma200
  return (
    <div
      className={cn(
        'grid items-center gap-2 px-3 py-1',
      )}
      style={{ gridTemplateColumns: COL_TEMPLATE }}
    >
      <div />
      <div className="text-[10px] text-slate-400 font-mono text-right">MA details</div>
      <div className="col-span-2 text-right">
        <span className="text-[10px] text-slate-400 font-mono">
          50d: <span className="text-slate-500">{fmtLevel(row.ma50)}</span>
        </span>
      </div>
      <div />
      <div className="col-span-2 text-right">
        <span className="text-[10px] text-slate-400 font-mono">
          200d: <span className="text-slate-500">{fmtLevel(row.ma200)}</span>
        </span>
      </div>
      <div />
      <div />
    </div>
  )
}

// ─── Ratio Card ───────────────────────────────────────────────────────────────

/** Inline source-provenance chip for ratio cards. */
function RatioSourceBadge({ source }: { source: RatioCard['source'] }) {
  if (!source) return null
  const cfg = {
    live_futures: { label: '● Live Futures',     color: '#34d399', border: 'rgba(52,211,153,0.28)', bg: 'rgba(52,211,153,0.08)' },
    alpaca_etf:   { label: '◈ Alpaca ETF Proxy', color: '#fbbf24', border: 'rgba(251,191,36,0.28)', bg: 'rgba(251,191,36,0.07)' },
    derived:      { label: '~ Derived',          color: '#94a3b8', border: 'rgba(148,163,184,0.20)', bg: 'rgba(100,116,139,0.07)' },
  }[source]
  return (
    <span
      className="inline-flex items-center text-[9px] font-mono font-semibold tracking-wide px-1.5 py-0.5 rounded border leading-none"
      style={{ color: cfg.color, borderColor: cfg.border, backgroundColor: cfg.bg }}
    >
      {cfg.label}
    </span>
  )
}

function RatioCardComponent({ ratio }: { ratio: RatioCard }) {
  const col = SIG[ratio.signal]
  const isRisk   = ratio.id === 'risk_regime'
  const isNull   = ratio.value === null   // data unavailable (rate-limited constituent)

  // Risk-card labels — only meaningful when value is non-null
  const regimeLabel = isRisk && !isNull
    ? ratio.value! < 25 ? 'RISK ON'
    : ratio.value! < 50 ? 'MODERATE'
    : ratio.value! < 75 ? 'ELEVATED'
    : 'RISK OFF'
    : null

  const regimeColor = isRisk && !isNull
    ? ratio.value! < 25  ? '#34d399'
    : ratio.value! < 50  ? '#fbbf24'
    : ratio.value! < 75  ? '#f97316'
    : '#f87171'
    : null

  return (
    <div className={cn('bg-[#0c1221] border rounded-2xl p-4 flex flex-col gap-3', col.border)}>
      {/* Header */}
      <div>
        <div className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest mb-0.5">
          {ratio.name}
        </div>
        <div className="text-[11px] text-slate-300">{ratio.subtitle}</div>
        {ratio.source && (
          <div className="mt-1">
            <RatioSourceBadge source={ratio.source} />
          </div>
        )}
      </div>

      {/* Value row — fixed structural height maintained whether data is present or null */}
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          {isNull ? (
            // Null zero-state: double-dash at fixed height, no units, low-opacity gray
            <>
              <div className="font-mono text-2xl font-semibold leading-none text-slate-500/60 tabular-nums">
                --
              </div>
              {/* Preserve sub-label height so the card doesn't collapse */}
              <div className="font-mono text-[11px] mt-1 text-slate-600/50">
                {isRisk ? 'Score --/100' : '--'}
              </div>
            </>
          ) : isRisk ? (
            <>
              <div
                className="font-mono text-xl font-bold tracking-widest leading-none"
                style={{ color: regimeColor ?? '#94a3b8' }}
              >
                {regimeLabel}
              </div>
              <div className="font-mono text-[11px] text-slate-300 mt-1">
                Score {(ratio.value as number).toFixed(0)}/100
              </div>
            </>
          ) : (
            <>
              <div className={cn('font-mono text-2xl font-semibold tabular-nums leading-none', col.text)}>
                {ratio.displayValue}
              </div>
              {/* Spacer keeps card height consistent with risk card's two-line layout */}
              <div className="font-mono text-[11px] mt-1 invisible" aria-hidden="true">·</div>
            </>
          )}
          {/* Change percentage — muted dash when null */}
          <div
            className={cn(
              'font-mono text-[11px] mt-1',
              isNull ? 'text-slate-600/50' : ratio.change >= 0 ? 'text-[#4db8a8]' : 'text-[#b87070]',
            )}
          >
            {isNull ? '--' : `${ratio.change >= 0 ? '+' : ''}${ratio.change.toFixed(2)}%`}
          </div>
        </div>

        <MiniSparkline data={ratio.sparkline} signal={ratio.signal} />
      </div>

      {/* Status + regime bar (for risk card) */}
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            'text-[10px] font-mono font-semibold tracking-wider px-2 py-0.5 rounded-md border',
            isNull ? 'text-slate-600/50 bg-slate-800/20 border-slate-700/30' : cn(col.text, col.bg, col.border),
          )}
        >
          {isNull ? '--' : ratio.status}
        </span>

        {isRisk && !isNull && (
          <div className="flex gap-0.5">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-1.5 w-5 rounded-full transition-all"
                style={{
                  backgroundColor:
                    (ratio.value as number) / 25 > i ? (regimeColor ?? '#94a3b8') : '#1e293b',
                  opacity: (ratio.value as number) / 25 > i ? 1 : 0.35,
                }}
              />
            ))}
          </div>
        )}

        {/* Keep regime bar space when null so layout doesn't shift */}
        {isRisk && isNull && <div className="flex gap-0.5">{[0,1,2,3].map(i => (
          <div key={i} className="h-1.5 w-5 rounded-full bg-[#1e293b] opacity-35" />
        ))}</div>}
      </div>

      {/* Note */}
      <p className="text-[10px] text-slate-400 leading-snug border-t border-[#1a2540] pt-2">
        {ratio.note}
      </p>
    </div>
  )
}

// ─── Ratios Panel (exportable) ────────────────────────────────────────────────

export function RatiosPanel({
  ratios     = RATIOS_MOCK,
  statusBadge,
}: {
  ratios?:      RatioCard[]
  /** Optional badge rendered inline with the panel heading (e.g. WaitingBadge / StatusBadge) */
  statusBadge?: ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <div className="text-[10px] font-mono text-slate-300 uppercase tracking-widest">
          Cross-Asset Ratios · Macro Dynamics
        </div>
        {statusBadge}
      </div>
      <div className={cn(
        'grid grid-cols-1 sm:grid-cols-2 gap-3',
        ratios.length >= 5 ? 'lg:grid-cols-5' : 'lg:grid-cols-4',
      )}>
        {ratios.map((ratio) => (
          <RatioCardComponent key={ratio.id} ratio={ratio} />
        ))}
      </div>
    </div>
  )
}

// ─── Public Props ─────────────────────────────────────────────────────────────

export interface TechnicalSectionProps {
  technicals?: TechnicalRow[]
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function TechnicalSection({
  technicals = TECHNICALS_MOCK,
}: TechnicalSectionProps) {
  return (
    <section className="space-y-4">
      {/* ── Asset Technicals ────────────────────────────────────────────── */}
      <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4">
        {/* Section header */}
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
            Individual Asset Technicals
          </h3>
          <div className="flex items-center gap-4 text-[10px] text-slate-400 font-mono">
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-px bg-cyan-600/70" />
              S1/S2 Support
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-block w-3 h-px bg-amber-600/70" />
              R1/R2 Resistance
            </span>
            <span className="flex items-center gap-1">
              <span className="inline-block w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_5px_#fbbf24]" />
              Within 1% of level
            </span>
          </div>
        </div>

        {/* Horizontal scroll wrapper for narrow viewports */}
        <div className="overflow-x-auto">
          <div style={{ minWidth: '680px' }}>
            {/* Column headers */}
            <div
              className="grid items-center gap-2 px-3 pb-2.5 border-b border-[#1a2540] mb-0.5"
              style={{ gridTemplateColumns: COL_TEMPLATE }}
            >
              {[
                ['Asset',     'text-left'],
                ['Price',     'text-right'],
                ['S2',        'text-right'],
                ['S1',        'text-right'],
                ['Level Map', 'text-center'],
                ['R1',        'text-right'],
                ['R2',        'text-right'],
                ['Cross',     'text-left'],
                ['RSI 14',    'text-right'],
              ].map(([label, align]) => (
                <div key={label} className={cn('text-[12px] font-mono text-slate-400 uppercase tracking-widest', align)}>
                  {label}
                </div>
              ))}
            </div>

            {/* Data rows */}
            <div>
              {technicals.map((row) => (
                <TechRow key={row.symbol} row={row} />
              ))}
            </div>
          </div>
        </div>

        {/* Legend */}
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 mt-4 pt-3 border-t border-[#1a2540] text-[10px] font-mono text-slate-400">
          <span className="flex items-center gap-1.5">
            <span className="text-amber-300 bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.5 rounded text-[12px] font-bold">
              ⊕ GC
            </span>
            Golden Cross — MA50 &gt; MA200 (bullish)
          </span>
          <span className="flex items-center gap-1.5">
            <span className="text-[#b87070] bg-red-400/10 border border-red-400/20 px-1.5 py-0.5 rounded text-[12px] font-bold">
              ⊗ DC
            </span>
            Death Cross — MA50 &lt; MA200 (bearish)
          </span>
          <span className="ml-auto flex items-center gap-3">
            <span>
              <span className="text-[#b87070]">RSI &gt; 70</span> = Overbought
            </span>
            <span>
              <span className="text-[#4db8a8]">RSI &lt; 30</span> = Oversold
            </span>
          </span>
        </div>
      </div>

    </section>
  )
}
