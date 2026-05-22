'use client'

import { useId } from 'react'

// ─── Types ───────────────────────────────────────────────────────────────────

interface ExpirationEvent {
  id: string
  label: string
  date: string
  daysAway: number
  type: 'zerodte' | 'weekly' | 'monthly' | 'quarterly'
}

export interface SkewPoint {
  label: string
  iv: number
}

export interface IndexSkewData {
  symbol: string
  name: string
  shortName: string
  currentPrice: number
  atmIV: number
  ivRank: number        // 0–100 percentile vs 1-year range
  skewSlope: number     // put25 – call25 IV in vols
  impMove1W: number     // ±% implied move nearest weekly
  impMove1M: number     // ±% implied move nearest monthly
  curve: SkewPoint[]
  callWall: number
  putWall: number
  maxPain: number
  signal: 'heavy_skew' | 'elevated' | 'neutral' | 'complacent'
}

export interface OIBar {
  strike: number
  callOI: number   // thousands of contracts
  putOI: number
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(' ')
}

function fmtStrike(n: number): string {
  if (n >= 10000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

// ─── Expiration Calendar ──────────────────────────────────────────────────────

function getExpirations(): ExpirationEvent[] {
  const now = new Date()
  const dayMs = 86_400_000
  const events: ExpirationEvent[] = []
  const dow = now.getUTCDay()

  if (dow >= 1 && dow <= 5) {
    events.push({
      id: 'zerodte',
      label: '0DTE',
      date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      daysAway: 0,
      type: 'zerodte',
    })
  }

  function thirdFriday(y: number, m: number): Date {
    const d = new Date(Date.UTC(y, m, 1))
    let n = 0
    while (n < 3) {
      if (d.getUTCDay() === 5) n++
      if (n < 3) d.setUTCDate(d.getUTCDate() + 1)
    }
    return d
  }

  const dF = ((5 - dow + 7) % 7) || 7
  const wFri = new Date(now.getTime() + dF * dayMs)
  events.push({
    id: 'weekly',
    label: 'Weekly OPEX',
    date: wFri.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    daysAway: dF,
    type: 'weekly',
  })

  const thisOpex = thirdFriday(now.getUTCFullYear(), now.getUTCMonth())
  const mTarget = thisOpex > now
    ? thisOpex
    : thirdFriday(now.getUTCFullYear(), now.getUTCMonth() + 1)
  const dM = Math.round((mTarget.getTime() - now.getTime()) / dayMs)
  if (dM > dF) {
    events.push({
      id: 'monthly',
      label: 'Monthly OPEX',
      date: mTarget.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      daysAway: dM,
      type: 'monthly',
    })
  }

  let qDate: Date | null = null
  for (const m of [2, 5, 8, 11]) {
    const y = now.getUTCMonth() > m ? now.getUTCFullYear() + 1 : now.getUTCFullYear()
    const d = thirdFriday(y, m)
    if (d > now && (!qDate || d < qDate)) qDate = d
  }
  if (qDate) {
    const dQ = Math.round((qDate.getTime() - now.getTime()) / dayMs)
    if (dQ !== dM) {
      events.push({
        id: 'quarterly',
        label: 'Quarterly OPEX',
        date: qDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        daysAway: dQ,
        type: 'quarterly',
      })
    }
  }

  return events.sort((a, b) => a.daysAway - b.daysAway)
}

function ExpirationCalendar() {
  const events = getExpirations()

  const chipStyle = (e: ExpirationEvent): { border: string; bg: string; text: string; glow?: string; pulse: boolean } => {
    if (e.type === 'zerodte') return { border: '#fbbf24', bg: 'rgba(251,191,36,0.12)', text: '#fbbf24', glow: '0 0 12px rgba(251,191,36,0.4)', pulse: true }
    if (e.type === 'weekly' && e.daysAway <= 2) return { border: '#f97316', bg: 'rgba(249,115,22,0.12)', text: '#f97316', glow: '0 0 10px rgba(249,115,22,0.3)', pulse: true }
    if (e.type === 'weekly') return { border: 'rgba(249,115,22,0.4)', bg: 'rgba(249,115,22,0.07)', text: '#f97316', pulse: false }
    if (e.type === 'monthly' && e.daysAway <= 7) return { border: '#f87171', bg: 'rgba(248,113,113,0.12)', text: '#f87171', glow: '0 0 8px rgba(248,113,113,0.3)', pulse: true }
    if (e.type === 'monthly') return { border: 'rgba(56,189,248,0.3)', bg: 'rgba(56,189,248,0.07)', text: '#38bdf8', pulse: false }
    return { border: 'rgba(167,139,250,0.35)', bg: 'rgba(167,139,250,0.08)', text: '#a78bfa', pulse: false }
  }

  const icon = (type: ExpirationEvent['type']) => {
    if (type === 'zerodte') return '⚡'
    if (type === 'weekly') return '📅'
    if (type === 'monthly') return '🗓'
    return '🔷'
  }

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-[10px] font-mono text-amber-400/70 uppercase tracking-widest shrink-0 mr-1">
          Expiration Calendar
        </span>
        {events.map((e) => {
          const s = chipStyle(e)
          return (
            <div
              key={e.id}
              className={cn('inline-flex items-center gap-2 px-3 py-1.5 rounded-lg border text-[11px] font-mono', e.type === 'zerodte' || s.pulse ? 'animate-pulse' : '')}
              style={{
                borderColor: s.border,
                backgroundColor: s.bg,
                color: s.text,
                boxShadow: s.glow,
              }}
            >
              <span>{icon(e.type)}</span>
              <span className="font-bold">{e.label}</span>
              <span className="opacity-70">—</span>
              <span>{e.date}</span>
              {e.daysAway === 0
                ? <span className="opacity-60 text-[9px]">TODAY</span>
                : <span className="opacity-60 text-[9px]">{e.daysAway}d</span>
              }
            </div>
          )
        })}
        <span className="ml-auto text-[9px] font-mono text-slate-700 hidden lg:block">
          SPX, NDX, RUT standard expirations · 0DTE = daily S&amp;P options
        </span>
      </div>
    </div>
  )
}

// ─── Skew Curve SVG ───────────────────────────────────────────────────────────

function SkewCurveSVG({ curve }: { curve: SkewPoint[] }) {
  const uid = useId()
  const gid = `skc${uid.replace(/:/g, '')}`
  const W = 160
  const H = 52
  const pad = 6

  const ivs = curve.map((p) => p.iv)
  const minIV = Math.min(...ivs)
  const maxIV = Math.max(...ivs)
  const rng = maxIV - minIV || 1

  const pts = curve.map((p, i) => ({
    x: pad + (i / (curve.length - 1)) * (W - pad * 2),
    y: H - pad - ((p.iv - minIV) / rng) * (H - pad * 2),
    label: p.label,
    iv: p.iv,
  }))

  const atmIdx = curve.findIndex((p) => p.label === 'ATM')
  const atmPt = pts[atmIdx]

  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  return (
    <div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="overflow-visible">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#fbbf24" stopOpacity="0.18" />
            <stop offset="100%" stopColor="#fbbf24" stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Fill under curve */}
        <path
          d={`M${pts[0].x},${H} ${pts.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} L${pts[pts.length - 1].x},${H} Z`}
          fill={`url(#${gid})`}
        />
        {/* ATM vertical dashed line */}
        {atmPt && (
          <line
            x1={atmPt.x} y1={pad / 2}
            x2={atmPt.x} y2={H}
            stroke="rgba(148,163,184,0.25)" strokeWidth="1" strokeDasharray="2,2"
          />
        )}
        {/* Smile curve */}
        <polyline
          points={line}
          fill="none"
          stroke="#fbbf24"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* IV dots */}
        {pts.map((p) => (
          <circle
            key={p.label}
            cx={p.x} cy={p.y} r={p.label === 'ATM' ? 3 : 2}
            fill={p.label === 'ATM' ? '#fbbf24' : 'rgba(251,191,36,0.5)'}
          />
        ))}
      </svg>
      {/* X-axis labels */}
      <div className="flex justify-between px-1.5 mt-0.5">
        {curve.map((p) => (
          <span
            key={p.label}
            className="text-[9px] font-mono"
            style={{ color: p.label === 'ATM' ? '#fbbf24' : 'rgba(100,116,139,0.8)' }}
          >
            {p.label}
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Index Skew Card ──────────────────────────────────────────────────────────

const SIGNAL_CONFIG = {
  heavy_skew: { label: 'HEAVY PUT SKEW', color: '#f87171', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.35)' },
  elevated:   { label: 'ELEVATED SKEW',  color: '#fbbf24', bg: 'rgba(251,191,36,0.12)',  border: 'rgba(251,191,36,0.35)' },
  neutral:    { label: 'NEUTRAL',        color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.25)' },
  complacent: { label: 'CALL DEMAND',    color: '#38bdf8', bg: 'rgba(56,189,248,0.12)',  border: 'rgba(56,189,248,0.35)' },
} as const

function IndexSkewCard({ data }: { data: IndexSkewData }) {
  const sig = SIGNAL_CONFIG[data.signal]
  const ivRankColor =
    data.ivRank > 70 ? '#f87171' :
    data.ivRank > 40 ? '#fbbf24' : '#34d399'

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 flex flex-col gap-3 hover:border-[#2a3f64] transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] font-mono text-amber-400/80 tracking-widest uppercase">{data.shortName}</div>
          <div className="text-[11px] text-slate-500">{data.name}</div>
        </div>
        <div
          className="text-[9px] font-mono font-bold px-2 py-0.5 rounded border whitespace-nowrap"
          style={{ color: sig.color, backgroundColor: sig.bg, borderColor: sig.border }}
        >
          {sig.label}
        </div>
      </div>

      {/* ATM IV + IV Rank */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[9px] text-slate-700 font-mono">ATM IV</div>
          <div className="font-mono text-xl font-semibold text-slate-100 tabular-nums">{data.atmIV.toFixed(1)}%</div>
        </div>
        <div className="text-right">
          <div className="text-[9px] text-slate-700 font-mono">IV Rank</div>
          <div className="font-mono text-lg font-semibold tabular-nums" style={{ color: ivRankColor }}>
            {data.ivRank}
            <span className="text-sm opacity-60">/100</span>
          </div>
        </div>
      </div>

      {/* Skew curve */}
      <SkewCurveSVG curve={data.curve} />

      {/* IV values row */}
      <div className="flex justify-between">
        {data.curve.map((p) => (
          <div key={p.label} className="text-center">
            <div className="font-mono text-[11px] tabular-nums text-slate-300">{p.iv.toFixed(1)}</div>
          </div>
        ))}
      </div>

      {/* Skew slope + implied moves */}
      <div className="grid grid-cols-3 gap-2 pt-2 border-t border-[#1a2540]">
        <div>
          <div className="text-[9px] text-slate-700 font-mono">Put Skew</div>
          <div className="font-mono text-xs text-amber-400">+{data.skewSlope.toFixed(1)} vol</div>
        </div>
        <div>
          <div className="text-[9px] text-slate-700 font-mono">Imp. Move 1W</div>
          <div className="font-mono text-xs text-slate-300">±{data.impMove1W.toFixed(2)}%</div>
        </div>
        <div>
          <div className="text-[9px] text-slate-700 font-mono">Imp. Move 1M</div>
          <div className="font-mono text-xs text-slate-300">±{data.impMove1M.toFixed(1)}%</div>
        </div>
      </div>

      {/* Walls */}
      <div className="grid grid-cols-3 gap-1 text-[9px] font-mono">
        <div>
          <span className="text-slate-700">Call Wall </span>
          <span className="text-sky-400">{fmtStrike(data.callWall)}</span>
        </div>
        <div>
          <span className="text-slate-700">Max Pain </span>
          <span className="text-slate-400">{fmtStrike(data.maxPain)}</span>
        </div>
        <div className="text-right">
          <span className="text-slate-700">Put Wall </span>
          <span className="text-amber-400">{fmtStrike(data.putWall)}</span>
        </div>
      </div>
    </div>
  )
}

// ─── OI Wall Chart ────────────────────────────────────────────────────────────

function OIWallChart({ title, bars, currentPrice, maxPain, callWall, putWall }: {
  title: string
  bars: OIBar[]
  currentPrice: number
  maxPain: number
  callWall: number
  putWall: number
}) {
  const maxOI = Math.max(...bars.flatMap((b) => [b.callOI, b.putOI]))

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">{title} — OI Walls</h3>
        <div className="flex items-center gap-3 text-[9px] font-mono">
          <span style={{ color: 'rgba(251,191,36,0.7)' }}>■ Puts</span>
          <span style={{ color: 'rgba(56,189,248,0.8)' }}>■ Calls</span>
          <span className="text-slate-700">▬ Max Pain</span>
        </div>
      </div>

      <div className="space-y-0.5 overflow-y-auto" style={{ maxHeight: '280px' }}>
        {[...bars].reverse().map((bar) => {
          const callW = (bar.callOI / maxOI) * 100
          const putW  = (bar.putOI  / maxOI) * 100
          const isCurrent  = Math.abs(bar.strike - currentPrice) / currentPrice < 0.005
          const isMaxPain  = bar.strike === maxPain
          const isCallWall = bar.strike === callWall
          const isPutWall  = bar.strike === putWall

          return (
            <div
              key={bar.strike}
              className={cn(
                'flex items-center gap-2 px-1 py-0.5 rounded transition-colors text-[10px] font-mono',
                isCurrent  ? 'bg-slate-700/20' : '',
                isCallWall ? 'bg-sky-400/5'    : '',
                isPutWall  ? 'bg-amber-400/5'  : '',
              )}
            >
              {/* Put bar (left, fills right-to-left) */}
              <div className="w-24 flex justify-end">
                <div className="relative h-3 w-full flex items-center justify-end">
                  <div
                    className="h-full rounded-l"
                    style={{ width: `${putW}%`, backgroundColor: isPutWall ? '#f59e0b' : 'rgba(251,191,36,0.5)', minWidth: putW > 0 ? '2px' : 0 }}
                  />
                </div>
              </div>

              {/* Strike label */}
              <div
                className={cn(
                  'w-16 text-center tabular-nums shrink-0',
                  isCurrent  ? 'text-slate-100 font-semibold' :
                  isMaxPain  ? 'text-slate-400' :
                  isCallWall ? 'text-sky-400' :
                  isPutWall  ? 'text-amber-400' : 'text-slate-700',
                )}
              >
                {fmtStrike(bar.strike)}
                {isCurrent  && <span className="ml-1 text-[8px] text-slate-500">←</span>}
                {isMaxPain  && <span className="ml-1 text-[8px] text-slate-600">MP</span>}
                {isCallWall && <span className="ml-1 text-[8px] text-sky-500">CW</span>}
                {isPutWall  && <span className="ml-1 text-[8px] text-amber-500">PW</span>}
              </div>

              {/* Call bar (right) */}
              <div className="w-24">
                <div
                  className="h-3 rounded-r"
                  style={{ width: `${callW}%`, backgroundColor: isCallWall ? '#38bdf8' : 'rgba(56,189,248,0.55)', minWidth: callW > 0 ? '2px' : 0 }}
                />
              </div>

              {/* OI numbers */}
              <div className="hidden xl:flex gap-2 text-[8px] text-slate-800 tabular-nums ml-1">
                <span>{bar.putOI}K</span>
                <span>/</span>
                <span>{bar.callOI}K</span>
              </div>
            </div>
          )
        })}
      </div>

      <div className="flex justify-between mt-3 pt-2 border-t border-[#1a2540] text-[9px] font-mono text-slate-700">
        <span>← Puts (OI in thousands)</span>
        <span>Calls (OI in thousands) →</span>
      </div>
    </div>
  )
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

export const INDEX_SKEW_MOCK: IndexSkewData[] = [
  {
    symbol: '^GSPC', name: 'S&P 500', shortName: 'SPX',
    currentPrice: 5847, atmIV: 14.8, ivRank: 28, skewSlope: 4.2,
    impMove1W: 0.82, impMove1M: 2.4,
    curve: [{ label: '25P', iv: 19.2 }, { label: '10P', iv: 17.1 }, { label: 'ATM', iv: 14.8 }, { label: '10C', iv: 12.9 }, { label: '25C', iv: 11.4 }],
    callWall: 5900, putWall: 5750, maxPain: 5820, signal: 'elevated',
  },
  {
    symbol: '^NDX', name: 'NASDAQ 100', shortName: 'NDX',
    currentPrice: 20843, atmIV: 16.4, ivRank: 32, skewSlope: 5.1,
    impMove1W: 1.12, impMove1M: 3.1,
    curve: [{ label: '25P', iv: 21.8 }, { label: '10P', iv: 19.2 }, { label: 'ATM', iv: 16.4 }, { label: '10C', iv: 14.1 }, { label: '25C', iv: 12.4 }],
    callWall: 21000, putWall: 20500, maxPain: 20800, signal: 'elevated',
  },
  {
    symbol: '^DJI', name: 'DOW JONES', shortName: 'DJI',
    currentPrice: 42318, atmIV: 12.2, ivRank: 22, skewSlope: 3.1,
    impMove1W: 0.64, impMove1M: 1.8,
    curve: [{ label: '25P', iv: 15.8 }, { label: '10P', iv: 14.1 }, { label: 'ATM', iv: 12.2 }, { label: '10C', iv: 11.0 }, { label: '25C', iv: 9.8 }],
    callWall: 43000, putWall: 42000, maxPain: 42200, signal: 'neutral',
  },
  {
    symbol: '^RUT', name: 'RUSSELL 2000', shortName: 'RUT',
    currentPrice: 2109, atmIV: 19.8, ivRank: 44, skewSlope: 6.8,
    impMove1W: 1.48, impMove1M: 4.2,
    curve: [{ label: '25P', iv: 27.2 }, { label: '10P', iv: 23.8 }, { label: 'ATM', iv: 19.8 }, { label: '10C', iv: 16.4 }, { label: '25C', iv: 13.8 }],
    callWall: 2200, putWall: 2050, maxPain: 2100, signal: 'heavy_skew',
  },
]

const SPX_WALLS: OIBar[] = [
  { strike: 5600, callOI: 12, putOI: 48 }, { strike: 5650, callOI: 18, putOI: 42 },
  { strike: 5700, callOI: 24, putOI: 68 }, { strike: 5750, callOI: 32, putOI: 92 },
  { strike: 5800, callOI: 45, putOI: 62 }, { strike: 5820, callOI: 38, putOI: 45 },
  { strike: 5850, callOI: 52, putOI: 38 }, { strike: 5900, callOI: 108, putOI: 22 },
  { strike: 5950, callOI: 72, putOI: 14 }, { strike: 6000, callOI: 88, putOI: 8 },
  { strike: 6050, callOI: 45, putOI: 4 },  { strike: 6100, callOI: 28, putOI: 2 },
]

const NDX_WALLS: OIBar[] = [
  { strike: 19500, callOI: 8,   putOI: 42 }, { strike: 19800, callOI: 12,  putOI: 58 },
  { strike: 20000, callOI: 18,  putOI: 72 }, { strike: 20200, callOI: 28,  putOI: 88 },
  { strike: 20500, callOI: 35,  putOI: 98 }, { strike: 20700, callOI: 42,  putOI: 62 },
  { strike: 20843, callOI: 48,  putOI: 48 }, { strike: 21000, callOI: 118, putOI: 28 },
  { strike: 21200, callOI: 85,  putOI: 18 }, { strike: 21500, callOI: 65,  putOI: 8  },
  { strike: 22000, callOI: 45,  putOI: 4  }, { strike: 22500, callOI: 28,  putOI: 2  },
]

// ─── Public Props ─────────────────────────────────────────────────────────────

export interface OptionsSectionProps {
  skewData?: IndexSkewData[]
}

// ─── Main Export ──────────────────────────────────────────────────────────────

export function OptionsSection({ skewData = INDEX_SKEW_MOCK }: OptionsSectionProps) {
  return (
    <section className="space-y-4">
      {/* Expiration Calendar */}
      <ExpirationCalendar />

      {/* Index Skew Cards */}
      <div>
        <div className="text-[10px] font-mono text-slate-600 uppercase tracking-widest mb-2">
          Index Options Skew · Put / Call Implied Volatility
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {skewData.map((d) => (
            <IndexSkewCard key={d.symbol} data={d} />
          ))}
        </div>
      </div>

      {/* Put/Call OI Walls */}
      <div>
        <div className="text-[10px] font-mono text-slate-600 uppercase tracking-widest mb-2">
          Put / Call Open Interest Walls · CW = Call Wall · PW = Put Wall · MP = Max Pain
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <OIWallChart
            title="SPX"
            bars={SPX_WALLS}
            currentPrice={INDEX_SKEW_MOCK[0].currentPrice}
            maxPain={INDEX_SKEW_MOCK[0].maxPain}
            callWall={INDEX_SKEW_MOCK[0].callWall}
            putWall={INDEX_SKEW_MOCK[0].putWall}
          />
          <OIWallChart
            title="NDX"
            bars={NDX_WALLS}
            currentPrice={INDEX_SKEW_MOCK[1].currentPrice}
            maxPain={INDEX_SKEW_MOCK[1].maxPain}
            callWall={INDEX_SKEW_MOCK[1].callWall}
            putWall={INDEX_SKEW_MOCK[1].putWall}
          />
        </div>
      </div>
    </section>
  )
}
