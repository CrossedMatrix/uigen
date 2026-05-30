'use client'

import { useCallback, useEffect, useId, useState } from 'react'
import { useAlpacaData } from '@/hooks/useAlpacaData'

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
  ivRank: number
  skewSlope: number
  impMove1W: number
  impMove1M: number
  curve: SkewPoint[]
  callWall: number
  putWall: number
  maxPain: number
  signal: 'heavy_skew' | 'elevated' | 'neutral' | 'complacent'
}

export interface OIBar {
  strike: number
  callOI: number
  putOI: number
}

// ─── OI Analytics ─────────────────────────────────────────────────────────────

/**
 * Call Wall — strike with the highest aggregate call open interest.
 * Resistance level: dealers must buy underlying as price approaches this strike
 * (delta hedging), creating a gravitational "ceiling" on near-term price action.
 */
export function computeCallWall(bars: OIBar[]): number {
  if (bars.length === 0) return 0
  return bars.reduce((best, bar) => (bar.callOI > best.callOI ? bar : best), bars[0]).strike
}

/**
 * Put Wall — strike with the highest aggregate put open interest.
 * Support level: heavy put buying concentrates at this strike, acting as a
 * price floor because dealers short gamma must sell as price falls through it.
 */
export function computePutWall(bars: OIBar[]): number {
  if (bars.length === 0) return 0
  return bars.reduce((best, bar) => (bar.putOI > best.putOI ? bar : best), bars[0]).strike
}

/**
 * Max Pain — expiration price that minimises total payout to all option holders.
 * Calculated as: for each candidate strike K, sum the intrinsic value of every
 * in-the-money call (strike < K) and every in-the-money put (strike > K) using
 * open interest as the notional weight.  The strike with the smallest total
 * payout is "max pain" — the price at which option sellers lose the least.
 *
 * @param bars — OI bars sorted in any order (function handles internally)
 */
export function computeMaxPain(bars: OIBar[]): number {
  if (bars.length === 0) return 0
  const strikes = bars.map(b => b.strike).sort((a, b) => a - b)
  let minPain = Infinity
  let maxPainStrike = strikes[0]

  for (const k of strikes) {
    let pain = 0
    for (const bar of bars) {
      // In-the-money calls: buyer profits (K - strike) × callOI at price K
      if (bar.strike < k) pain += (k - bar.strike) * bar.callOI
      // In-the-money puts: buyer profits (strike - K) × putOI at price K
      if (bar.strike > k) pain += (bar.strike - k) * bar.putOI
    }
    if (pain < minPain) {
      minPain = pain
      maxPainStrike = k
    }
  }

  return maxPainStrike
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(' ')
}

function fmtStrike(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}

// ─── Expiration Calendar ──────────────────────────────────────────────────────

function getExpirations(): ExpirationEvent[] {
  const now = new Date()
  const dayMs = 86_400_000
  const events: ExpirationEvent[] = []
  const dow = now.getUTCDay()

  if (dow >= 1 && dow <= 5) {
    events.push({ id: 'zerodte', label: '0DTE', date: now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), daysAway: 0, type: 'zerodte' })
  }

  function thirdFriday(y: number, m: number): Date {
    const d = new Date(Date.UTC(y, m, 1)); let n = 0
    while (n < 3) { if (d.getUTCDay() === 5) n++; if (n < 3) d.setUTCDate(d.getUTCDate() + 1) }
    return d
  }

  const dF = ((5 - dow + 7) % 7) || 7
  const wFri = new Date(now.getTime() + dF * dayMs)
  events.push({ id: 'weekly', label: 'Weekly OPEX', date: wFri.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), daysAway: dF, type: 'weekly' })

  const mTarget = thirdFriday(now.getUTCFullYear(), now.getUTCMonth()) > now
    ? thirdFriday(now.getUTCFullYear(), now.getUTCMonth())
    : thirdFriday(now.getUTCFullYear(), now.getUTCMonth() + 1)
  const dM = Math.round((mTarget.getTime() - now.getTime()) / dayMs)
  if (dM > dF) events.push({ id: 'monthly', label: 'Monthly OPEX', date: mTarget.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), daysAway: dM, type: 'monthly' })

  let qDate: Date | null = null
  for (const m of [2, 5, 8, 11]) {
    const y = now.getUTCMonth() > m ? now.getUTCFullYear() + 1 : now.getUTCFullYear()
    const d = thirdFriday(y, m)
    if (d > now && (!qDate || d < qDate)) qDate = d
  }
  if (qDate) {
    const dQ = Math.round((qDate.getTime() - now.getTime()) / dayMs)
    if (dQ !== dM) events.push({ id: 'quarterly', label: 'Quarterly OPEX', date: qDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }), daysAway: dQ, type: 'quarterly' })
  }

  return events.sort((a, b) => a.daysAway - b.daysAway)
}

export function ExpirationCalendarBanner() {
  const events = getExpirations()
  const chipStyle = (e: ExpirationEvent) => {
    if (e.type === 'zerodte') return { border: '#fbbf24', bg: 'rgba(251,191,36,0.12)', text: '#fbbf24', glow: '0 0 12px rgba(251,191,36,0.4)', pulse: true }
    if (e.type === 'weekly' && e.daysAway <= 2) return { border: '#f97316', bg: 'rgba(249,115,22,0.12)', text: '#f97316', glow: '0 0 10px rgba(249,115,22,0.3)', pulse: true }
    if (e.type === 'weekly') return { border: 'rgba(249,115,22,0.4)', bg: 'rgba(249,115,22,0.07)', text: '#f97316', pulse: false }
    if (e.type === 'monthly' && e.daysAway <= 7) return { border: '#f87171', bg: 'rgba(248,113,113,0.12)', text: '#f87171', glow: '0 0 8px rgba(248,113,113,0.3)', pulse: true }
    if (e.type === 'monthly') return { border: 'rgba(56,189,248,0.3)', bg: 'rgba(56,189,248,0.07)', text: '#38bdf8', pulse: false }
    return { border: 'rgba(167,139,250,0.35)', bg: 'rgba(167,139,250,0.08)', text: '#a78bfa', pulse: false }
  }
  const icon = (t: ExpirationEvent['type']) => t === 'zerodte' ? '⚡' : t === 'weekly' ? '📅' : t === 'monthly' ? '🗓' : '🔷'

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-xl px-4 py-2.5 flex flex-wrap items-center gap-2.5">
      <span className="text-[10px] font-mono text-amber-400/70 uppercase tracking-widest shrink-0">Exp. Calendar</span>
      {events.map((e) => {
        const s = chipStyle(e)
        return (
          <div key={e.id} className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-mono', s.pulse ? 'animate-pulse' : '')}
            style={{ borderColor: s.border, backgroundColor: s.bg, color: s.text, boxShadow: (s as { glow?: string }).glow }}>
            <span>{icon(e.type)}</span>
            <span className="font-bold">{e.label}</span>
            <span className="opacity-60">{e.date}</span>
            <span className="opacity-50 text-[12px]">{e.daysAway === 0 ? 'TODAY' : `${e.daysAway}d`}</span>
          </div>
        )
      })}
    </div>
  )
}

// ─── Skew Curve SVG ───────────────────────────────────────────────────────────

function SkewCurveSVG({ curve }: { curve: SkewPoint[] }) {
  const uid = useId()
  const gid = `skc${uid.replace(/:/g, '')}`
  const W = 160, H = 52, pad = 6
  const ivs = curve.map((p) => p.iv)
  const minIV = Math.min(...ivs), maxIV = Math.max(...ivs), rng = maxIV - minIV || 1
  const pts = curve.map((p, i) => ({
    x: pad + (i / (curve.length - 1)) * (W - pad * 2),
    y: H - pad - ((p.iv - minIV) / rng) * (H - pad * 2),
    label: p.label, iv: p.iv,
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
        <path d={`M${pts[0].x},${H} ${pts.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} L${pts[pts.length-1].x},${H} Z`} fill={`url(#${gid})`} />
        {atmPt && <line x1={atmPt.x} y1={pad/2} x2={atmPt.x} y2={H} stroke="rgba(148,163,184,0.2)" strokeWidth="1" strokeDasharray="2,2" />}
        <polyline points={line} fill="none" stroke="#fbbf24" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        {pts.map((p) => <circle key={p.label} cx={p.x} cy={p.y} r={p.label === 'ATM' ? 3 : 2} fill={p.label === 'ATM' ? '#fbbf24' : 'rgba(251,191,36,0.5)'} />)}
      </svg>
      <div className="flex justify-between px-1.5 mt-0.5">
        {curve.map((p) => (
          <span key={p.label} className="text-[12px] font-mono" style={{ color: p.label === 'ATM' ? '#fbbf24' : 'rgba(100,116,139,0.8)' }}>{p.label}</span>
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
  const ivRankColor = data.ivRank > 70 ? '#f87171' : data.ivRank > 40 ? '#fbbf24' : '#34d399'

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-xl p-3 flex flex-col gap-2.5 hover:border-[#2a3f64] transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between gap-1">
        <div>
          <div className="text-[10px] font-mono text-amber-400/80 tracking-widest uppercase">{data.shortName}</div>
          <div className="text-[10px] text-slate-300">{data.name}</div>
        </div>
        <div className="text-[11px] font-mono font-bold px-1.5 py-0.5 rounded border whitespace-nowrap" style={{ color: sig.color, backgroundColor: sig.bg, borderColor: sig.border }}>{sig.label}</div>
      </div>

      {/* ATM IV + Rank */}
      <div className="flex gap-3">
        <div>
          <div className="text-[11px] text-slate-400 font-mono">ATM IV</div>
          <div className="font-mono text-lg font-semibold text-slate-100 tabular-nums leading-tight">{data.atmIV.toFixed(1)}%</div>
        </div>
        <div>
          <div className="text-[11px] text-slate-400 font-mono">IV Rank</div>
          <div className="font-mono text-lg font-semibold tabular-nums leading-tight" style={{ color: ivRankColor }}>{data.ivRank}<span className="text-xs opacity-50">/100</span></div>
        </div>
        <div className="ml-auto text-right">
          <div className="text-[11px] text-slate-400 font-mono">Put Skew</div>
          <div className="font-mono text-xs text-amber-400">+{data.skewSlope.toFixed(1)}v</div>
          <div className="text-[11px] text-slate-400 font-mono mt-0.5">Imp ±{data.impMove1W.toFixed(2)}%</div>
        </div>
      </div>

      {/* Skew curve */}
      <SkewCurveSVG curve={data.curve} />

      {/* ── Walls strip — visually prominent ── */}
      <div className="rounded-lg border border-[#1a2540] bg-[#070b14] p-2 space-y-1.5">
        {/* Call Wall */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: '#38bdf8' }} />
            <span className="text-[12px] font-mono text-slate-500">Call Wall</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="font-mono text-sm font-bold tabular-nums"
              style={{ color: '#38bdf8', textShadow: '0 0 8px rgba(56,189,248,0.6)' }}
            >
              {fmtStrike(data.callWall)}
            </span>
            <span className="text-[11px] font-mono text-sky-400/50">
              +{(((data.callWall - data.currentPrice) / data.currentPrice) * 100).toFixed(1)}%
            </span>
          </div>
        </div>

        {/* Max Pain — bold emphasis */}
        <div className="flex items-center justify-between rounded border border-amber-400/25 bg-amber-400/[0.06] px-1.5 py-1">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full animate-pulse" style={{ backgroundColor: '#fbbf24' }} />
            <span className="text-[12px] font-mono text-amber-400 font-bold tracking-wide">MAX PAIN</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="font-mono text-sm font-bold tabular-nums"
              style={{ color: '#fbbf24', textShadow: '0 0 10px rgba(251,191,36,0.7)' }}
            >
              {fmtStrike(data.maxPain)}
            </span>
            <span className="text-[11px] font-mono text-amber-400/50">
              {data.maxPain > data.currentPrice ? '+' : ''}{(((data.maxPain - data.currentPrice) / data.currentPrice) * 100).toFixed(1)}%
            </span>
          </div>
        </div>

        {/* Put Wall */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-sm" style={{ backgroundColor: '#fbbf24', opacity: 0.7 }} />
            <span className="text-[12px] font-mono text-slate-500">Put Wall</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="font-mono text-sm font-bold tabular-nums"
              style={{ color: '#f59e0b', textShadow: '0 0 6px rgba(245,158,11,0.5)' }}
            >
              {fmtStrike(data.putWall)}
            </span>
            <span className="text-[11px] font-mono text-amber-500/50">
              {(((data.putWall - data.currentPrice) / data.currentPrice) * 100).toFixed(1)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

export function IndexSkewGrid({ skewData }: { skewData: IndexSkewData[] }) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
      {skewData.map((d) => <IndexSkewCard key={d.symbol} data={d} />)}
    </div>
  )
}

// ─── Index Skew Heads (Simplified) ────────────────────────────────────────────

const SKEW_SIGNAL_COLORS = {
  heavy_skew: { label: 'HEAVY SKEW', color: '#f87171', bg: 'rgba(248,113,113,0.12)', border: 'rgba(248,113,113,0.35)' },
  elevated:   { label: 'ELEVATED',   color: '#fbbf24', bg: 'rgba(251,191,36,0.12)',  border: 'rgba(251,191,36,0.35)' },
  neutral:    { label: 'NEUTRAL',    color: '#94a3b8', bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.25)' },
  complacent: { label: 'COMPLACENT', color: '#38bdf8', bg: 'rgba(56,189,248,0.12)',  border: 'rgba(56,189,248,0.35)' },
} as const

export function IndexSkewHeads({ skewData }: { skewData: IndexSkewData[] }) {
  return (
    <div className="flex flex-wrap gap-2 items-center">
      {skewData.map((d) => {
        const sig = SKEW_SIGNAL_COLORS[d.signal]
        return (
          <div key={d.symbol} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border bg-[#0c1221] hover:border-[#2a3f64] transition-colors"
            style={{ borderColor: sig.border }}>
            <span className="text-[10px] font-mono font-bold text-slate-100 uppercase">{d.shortName}</span>
            <span className="text-[11px] font-mono px-1.5 py-0.5 rounded border whitespace-nowrap"
              style={{ color: sig.color, backgroundColor: sig.bg, borderColor: sig.border }}>
              {sig.label}
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ─── OI Wall Chart ────────────────────────────────────────────────────────────

function OIWallChart({ title, bars, currentPrice, maxPain, callWall, putWall }: {
  title: string; bars: OIBar[]
  currentPrice: number; maxPain: number; callWall: number; putWall: number
}) {
  const maxOI = Math.max(...bars.flatMap((b) => [b.callOI, b.putOI]))

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-xl p-3">
      {/* Header with summary strip */}
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">{title} — OI Walls</h3>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 px-2 py-1 rounded border border-sky-400/30 bg-sky-400/8">
            <span className="text-[11px] font-mono text-slate-500">CALL WALL</span>
            <span className="font-mono text-xs font-bold" style={{ color: '#38bdf8', textShadow: '0 0 6px rgba(56,189,248,0.5)' }}>{fmtStrike(callWall)}</span>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded border border-amber-400/40 bg-amber-400/10">
            <div className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            <span className="text-[11px] font-mono text-amber-400/70">MAX PAIN</span>
            <span className="font-mono text-xs font-bold" style={{ color: '#fbbf24', textShadow: '0 0 8px rgba(251,191,36,0.6)' }}>{fmtStrike(maxPain)}</span>
          </div>
          <div className="flex items-center gap-1.5 px-2 py-1 rounded border border-amber-500/25 bg-amber-500/6">
            <span className="text-[11px] font-mono text-slate-500">PUT WALL</span>
            <span className="font-mono text-xs font-bold text-amber-500">{fmtStrike(putWall)}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between text-[12px] font-mono text-slate-400 mb-1 px-1">
        <span>← Puts</span>
        <span className="text-slate-500">Strike</span>
        <span>Calls →</span>
      </div>

      <div className="space-y-0.5 overflow-y-auto" style={{ maxHeight: '260px' }}>
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
              className={cn('relative flex items-center gap-1.5 px-1 py-[2px] rounded text-[10px] font-mono',
                isCallWall ? 'bg-sky-400/10 border border-sky-400/40' :
                isMaxPain  ? 'bg-amber-400/10 border border-amber-400/30' :
                isPutWall  ? 'bg-amber-500/10 border border-amber-500/40' :
                isCurrent  ? 'bg-slate-700/15 border border-transparent' : 'border border-transparent'
              )}
              style={
                isCallWall
                  ? { boxShadow: 'inset 3px 0 0 0 #38bdf8, 0 0 6px rgba(56,189,248,0.25)' }
                  : isPutWall
                    ? { boxShadow: 'inset 3px 0 0 0 #f59e0b, 0 0 6px rgba(245,158,11,0.25)' }
                    : undefined
              }
            >
              {/* Put bar */}
              <div className="w-28 flex justify-end">
                <div className="h-3.5 flex items-center justify-end" style={{ width: '100%' }}>
                  {putW > 0 && (
                    <div className="h-full rounded-l" style={{
                      width: `${putW}%`,
                      backgroundColor: isPutWall ? '#f59e0b' : 'rgba(251,191,36,0.45)',
                      boxShadow: isPutWall ? '0 0 6px rgba(245,158,11,0.5)' : undefined,
                    }} />
                  )}
                </div>
              </div>

              {/* Strike label */}
              <div className={cn('w-[4.5rem] text-center shrink-0 tabular-nums',
                isCurrent  ? 'text-slate-200 font-bold' :
                isMaxPain  ? 'text-amber-400 font-bold' :
                isCallWall ? 'text-sky-400 font-bold'   :
                isPutWall  ? 'text-amber-500 font-bold' : 'text-slate-400'
              )}>
                {fmtStrike(bar.strike)}
                {isCallWall && <span className="ml-0.5 text-[10px] text-sky-500"> CW</span>}
                {isMaxPain  && <span className="ml-0.5 text-[10px] text-amber-400"> ★</span>}
                {isPutWall  && <span className="ml-0.5 text-[10px] text-amber-500"> PW</span>}
                {isCurrent  && <span className="ml-0.5 text-[10px] text-slate-500"> ←</span>}
              </div>

              {/* Call bar */}
              <div className="w-28">
                {callW > 0 && (
                  <div className="h-3.5 rounded-r" style={{
                    width: `${callW}%`,
                    backgroundColor: isCallWall ? '#38bdf8' : 'rgba(56,189,248,0.5)',
                    boxShadow: isCallWall ? '0 0 8px rgba(56,189,248,0.6)' : undefined,
                  }} />
                )}
              </div>

              {/* OI labels on wide screens */}
              <div className="hidden 2xl:flex gap-1 text-[11px] text-slate-800 tabular-nums ml-0.5 shrink-0">
                <span>{bar.putOI}K</span><span>/</span><span>{bar.callOI}K</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export interface OIWallsGridProps {
  selectedAssets?: string[]
  onAssetsChange?: (assets: string[]) => void
}

// ─── ETF → Index price scaling ────────────────────────────────────────────────
// Alpaca serves SPY/QQQ/DIA/IWM via the us_equity endpoint (free, IEX feed).
// We scale the ETF price to an approximate index level so the "current price"
// marker in OI charts aligns with the strike range displayed.
//
// Scaling factors (approximate, updated periodically):
//   SPX  ≈ SPY  × 10      (SPX ~5800, SPY ~580)
//   NDX  ≈ QQQ  × 40      (NDX ~20800, QQQ ~520)
//   DJI  ≈ DIA  × 100     (DJI ~42000, DIA ~420)
//   RUT  ≈ IWM  × 10      (RUT ~2100, IWM ~210)

const ASSET_ETF_MAP: Record<string, { etf: string; scale: number }> = {
  SPX: { etf: 'SPY', scale: 10  },
  NDX: { etf: 'QQQ', scale: 40  },
  DJI: { etf: 'DIA', scale: 100 },
  RUT: { etf: 'IWM', scale: 10  },
}

const INDEX_ETF_SYMBOLS = ['SPY', 'QQQ', 'DIA', 'IWM'] as const

export function OIWallsGrid({ selectedAssets = ['SPX', 'NDX'], onAssetsChange }: OIWallsGridProps) {
  // Live ETF prices as a proxy for index currentPrice in OI charts.
  const { quoteMap: etfMap } = useAlpacaData({
    symbols:      [...INDEX_ETF_SYMBOLS],
    assetClass:   'us_equity',
    type:         'snapshot',
    pollInterval: 300_000,
  })

  /** Resolve the "current price" for an asset — live ETF-scaled or mock fallback */
  function getLiveCurrentPrice(asset: string, mockPrice: number): number {
    const mapping = ASSET_ETF_MAP[asset]
    if (!mapping) return mockPrice
    const etfQuote = etfMap.get(mapping.etf)
    if (!etfQuote?.price) return mockPrice
    return parseFloat((etfQuote.price * mapping.scale).toFixed(0))
  }

  const getOIDataForAsset = (asset: string) => {
    // ── Standard index assets — use real OI bar data with computed analytics ──
    if (asset === 'SPX') {
      const bars        = SPX_WALLS
      const currentPrice = getLiveCurrentPrice('SPX', INDEX_SKEW_MOCK[0].currentPrice)
      return {
        bars,
        currentPrice,
        callWall: computeCallWall(bars),
        putWall:  computePutWall(bars),
        maxPain:  computeMaxPain(bars),
      }
    }
    if (asset === 'NDX') {
      const bars        = NDX_WALLS
      const currentPrice = getLiveCurrentPrice('NDX', INDEX_SKEW_MOCK[1].currentPrice)
      return {
        bars,
        currentPrice,
        callWall: computeCallWall(bars),
        putWall:  computePutWall(bars),
        maxPain:  computeMaxPain(bars),
      }
    }
    if (asset === 'DJI') {
      const bars        = NDX_WALLS
      const currentPrice = getLiveCurrentPrice('DJI', INDEX_SKEW_MOCK[2].currentPrice)
      return {
        bars,
        currentPrice,
        callWall: computeCallWall(bars),
        putWall:  computePutWall(bars),
        maxPain:  computeMaxPain(bars),
      }
    }
    if (asset === 'RUT') {
      const bars        = SPX_WALLS
      const currentPrice = getLiveCurrentPrice('RUT', INDEX_SKEW_MOCK[3].currentPrice)
      return {
        bars,
        currentPrice,
        callWall: computeCallWall(bars),
        putWall:  computePutWall(bars),
        maxPain:  computeMaxPain(bars),
      }
    }

    // ── Custom stock ticker — generate seeded mock bars + live ETF price ──────
    const charCode  = asset.charCodeAt(0)
    const mockPrice = 50 + (charCode % 200)

    // Use Alpaca live quote if we happen to have it (the quoteMap may include
    // custom tickers if TechSkewPanel has fetched them separately)
    const livePrice = etfMap.get(asset)?.price ?? mockPrice

    const mockBars: OIBar[] = [
      { strike: mockPrice - 20, callOI: 5,  putOI: 45 },
      { strike: mockPrice - 15, callOI: 12, putOI: 38 },
      { strike: mockPrice - 10, callOI: 22, putOI: 65 },
      { strike: mockPrice - 5,  callOI: 35, putOI: 75 },
      { strike: mockPrice,      callOI: 48, putOI: 52 },
      { strike: mockPrice + 5,  callOI: 65, putOI: 28 },
      { strike: mockPrice + 10, callOI: 85, putOI: 15 },
      { strike: mockPrice + 15, callOI: 45, putOI: 8  },
      { strike: mockPrice + 20, callOI: 25, putOI: 3  },
    ]

    return {
      bars:         mockBars,
      currentPrice: livePrice,
      callWall:     computeCallWall(mockBars),
      putWall:      computePutWall(mockBars),
      maxPain:      computeMaxPain(mockBars),
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Asset selector search bar */}
      <OIWallAssetSelector currentAssets={selectedAssets} onAssetsChange={onAssetsChange} />

      {/* OI Walls in 3-column grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {selectedAssets.map((asset) => {
          const data = getOIDataForAsset(asset)
          return (
            <OIWallChart
              key={asset}
              title={asset}
              bars={data.bars}
              currentPrice={data.currentPrice}
              maxPain={data.maxPain}
              callWall={data.callWall}
              putWall={data.putWall}
            />
          )
        })}
      </div>
    </div>
  )
}

// ─── OI Wall Asset Selector ────────────────────────────────────────────────────

const AVAILABLE_OI_ASSETS = [
  { symbol: 'SPX', name: 'S&P 500', color: '#3b82f6' },
  { symbol: 'NDX', name: 'NASDAQ 100', color: '#8b5cf6' },
  { symbol: 'DJI', name: 'Dow Jones', color: '#ec4899' },
  { symbol: 'RUT', name: 'Russell 2000', color: '#f59e0b' },
] as const

function OIWallAssetSelector({ currentAssets, onAssetsChange }: { currentAssets: string[]; onAssetsChange?: (assets: string[]) => void }) {
  const toggleAsset = (asset: string) => {
    let newAssets: string[]
    if (currentAssets.includes(asset.toUpperCase())) {
      newAssets = currentAssets.filter((a) => a !== asset.toUpperCase())
    } else {
      newAssets = [...currentAssets, asset.toUpperCase()].sort()
    }
    onAssetsChange?.(newAssets)
  }

  const removeAsset = (asset: string) => {
    const newAssets = currentAssets.filter((a) => a !== asset)
    onAssetsChange?.(newAssets)
  }

  const getAssetColor = (symbol: string) => {
    const found = AVAILABLE_OI_ASSETS.find((a) => a.symbol === symbol)
    if (found) return found.color
    // Generate a consistent color for custom stocks based on their symbol
    const charCode = symbol.charCodeAt(0)
    const colors = ['#06b6d4', '#10b981', '#f59e0b', '#ef4444', '#a78bfa', '#ec4899', '#14b8a6', '#f97316']
    return colors[charCode % colors.length]
  }

  return (
    <div className="flex items-center gap-2 p-2.5 bg-[#0c1221]/50 rounded-lg border border-[#1a2540]/50">
      {/* Label */}
      <span className="text-[12px] font-mono text-slate-300 uppercase tracking-widest shrink-0 whitespace-nowrap">OI Walls:</span>

      {/* Quick index buttons */}
      <div className="flex gap-1 shrink-0">
        {AVAILABLE_OI_ASSETS.map((asset) => (
          <button
            key={asset.symbol}
            onClick={() => toggleAsset(asset.symbol)}
            className={cn(
              'px-1.5 py-0.5 rounded border text-[12px] font-mono font-semibold uppercase transition-all cursor-pointer hover:opacity-80 whitespace-nowrap',
              currentAssets.includes(asset.symbol)
                ? 'border-current bg-current/15 text-current'
                : 'border-slate-600/30 bg-slate-700/10 text-slate-500 hover:border-slate-500/50'
            )}
            style={currentAssets.includes(asset.symbol) ? {
              borderColor: asset.color,
              backgroundColor: `${asset.color}15`,
              color: asset.color
            } : undefined}
            title={asset.name}
          >
            {asset.symbol}
          </button>
        ))}
      </div>

      {/* Selected custom stocks */}
      <div className="flex gap-1 flex-wrap shrink-0">
        {currentAssets.filter((a) => !AVAILABLE_OI_ASSETS.find((idx) => idx.symbol === a)).map((symbol) => (
          <div
            key={symbol}
            className="flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[12px] font-mono font-semibold uppercase whitespace-nowrap"
            style={{
              borderColor: getAssetColor(symbol),
              backgroundColor: `${getAssetColor(symbol)}15`,
              color: getAssetColor(symbol)
            }}
          >
            <span>{symbol}</span>
            <button
              onClick={() => removeAsset(symbol)}
              className="ml-0.5 hover:opacity-70 transition-opacity"
              title={`Remove ${symbol}`}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {/* Search input for custom stocks */}
      <input
        type="text"
        placeholder="Add Stock"
        onKeyDown={(e) => {
          const input = e.currentTarget as HTMLInputElement
          if (e.key === 'Enter' && input.value.trim()) {
            const ticker = input.value.trim().toUpperCase()
            if (ticker.length <= 5 && /^[A-Z0-9]+$/.test(ticker)) {
              toggleAsset(ticker)
              input.value = ''
            }
          }
        }}
        className="ml-auto px-2 py-0.5 rounded border border-[#1a2540] bg-[#0c1221] text-slate-200 text-[12px] font-mono placeholder-slate-400 focus:outline-none focus:border-slate-500 transition-colors w-48"
      />
    </div>
  )
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

export const INDEX_SKEW_MOCK: IndexSkewData[] = [
  {
    symbol: '^GSPC', name: 'S&P 500', shortName: 'SPX', currentPrice: 5823,
    atmIV: 14.8, ivRank: 28, skewSlope: 4.2, impMove1W: 0.82, impMove1M: 2.4,
    curve: [{ label: '25P', iv: 19.2 }, { label: '10P', iv: 17.1 }, { label: 'ATM', iv: 14.8 }, { label: '10C', iv: 12.9 }, { label: '25C', iv: 11.4 }],
    callWall: 5900, putWall: 5700, maxPain: 5800, signal: 'elevated',
  },
  {
    symbol: '^NDX', name: 'NASDAQ 100', shortName: 'NDX', currentPrice: 20724,
    atmIV: 16.4, ivRank: 32, skewSlope: 5.1, impMove1W: 1.12, impMove1M: 3.1,
    curve: [{ label: '25P', iv: 21.8 }, { label: '10P', iv: 19.2 }, { label: 'ATM', iv: 16.4 }, { label: '10C', iv: 14.1 }, { label: '25C', iv: 12.4 }],
    callWall: 21000, putWall: 20500, maxPain: 20750, signal: 'elevated',
  },
  {
    symbol: '^DJI', name: 'DOW JONES', shortName: 'DJI', currentPrice: 42186,
    atmIV: 12.2, ivRank: 22, skewSlope: 3.1, impMove1W: 0.64, impMove1M: 1.8,
    curve: [{ label: '25P', iv: 15.8 }, { label: '10P', iv: 14.1 }, { label: 'ATM', iv: 12.2 }, { label: '10C', iv: 11.0 }, { label: '25C', iv: 9.8 }],
    callWall: 43000, putWall: 42000, maxPain: 42200, signal: 'neutral',
  },
  {
    symbol: '^RUT', name: 'RUSSELL 2000', shortName: 'RUT', currentPrice: 2097,
    atmIV: 19.8, ivRank: 44, skewSlope: 6.8, impMove1W: 1.48, impMove1M: 4.2,
    curve: [{ label: '25P', iv: 27.2 }, { label: '10P', iv: 23.8 }, { label: 'ATM', iv: 19.8 }, { label: '10C', iv: 16.4 }, { label: '25C', iv: 13.8 }],
    callWall: 2150, putWall: 2050, maxPain: 2100, signal: 'heavy_skew',
  },
]

const SPX_WALLS: OIBar[] = [
  { strike: 5600, callOI: 10, putOI: 52 }, { strike: 5650, callOI: 16, putOI: 44 },
  { strike: 5700, callOI: 22, putOI: 72 }, { strike: 5750, callOI: 30, putOI: 88 },
  { strike: 5800, callOI: 42, putOI: 58 }, { strike: 5823, callOI: 36, putOI: 42 },
  { strike: 5850, callOI: 50, putOI: 34 }, { strike: 5900, callOI: 115, putOI: 20 },
  { strike: 5950, callOI: 68, putOI: 12 }, { strike: 6000, callOI: 82, putOI: 8 },
  { strike: 6050, callOI: 44, putOI: 4 },  { strike: 6100, callOI: 26, putOI: 2 },
]

const NDX_WALLS: OIBar[] = [
  { strike: 19500, callOI: 7,   putOI: 44 }, { strike: 19800, callOI: 11,  putOI: 60 },
  { strike: 20000, callOI: 16,  putOI: 78 }, { strike: 20200, callOI: 25,  putOI: 92 },
  { strike: 20500, callOI: 33,  putOI: 102}, { strike: 20724, callOI: 46,  putOI: 52 },
  { strike: 20750, callOI: 48,  putOI: 46 }, { strike: 21000, callOI: 124, putOI: 26 },
  { strike: 21200, callOI: 80,  putOI: 16 }, { strike: 21500, callOI: 60,  putOI: 7  },
  { strike: 22000, callOI: 42,  putOI: 3  }, { strike: 22500, callOI: 25,  putOI: 1  },
]

// ─── Dynamic Options Skew Panel ───────────────────────────────────────────────
//
// Replaces the hardcoded high-beta-tech tickers with a user-driven input.
// Default state: NVDA so the panel never renders empty on first load.
//
// Flow:
//   1. User types ticker → presses Enter or "Load Ticker" button.
//   2. Hits /api/market/options-skew?ticker=XYZ which calls Alpaca's
//      /v1beta1/options/snapshots/{ticker} and computes:
//        • ATM IV (avg of 50Δ call + 50Δ put)
//        • 25Δ put / 25Δ call skew curve
//        • Delta-skew %  (25Δ put IV − 25Δ call IV)
//        • Call Wall / Put Wall / Max Pain on the front-week chain
//   3. UI renders the same SkewCurveSVG + OIWallChart visual stack used by
//      the index panels — single source of truth for styling.
//   4. Errors surface as "No active options chain found for [Ticker]"
//      instead of crashing the dashboard.

export interface OptionsSkewApiResponse {
  ticker: string
  spot: number | null
  expiry: string
  atmIV: number
  skewPct: number
  callWall: number
  putWall: number
  maxPain: number
  curve: SkewPoint[]
  openInterestData: OIBar[]
  contractCount: number
  /** 30d annualised realised vol of the underlying — 0..1 fraction */
  hv30: number | null
  /** atmIV / hv30 — > 1 means IV richer than realised */
  vrpRatio: number | null
  /** CHEAP / FAIR / RICH / UNKNOWN — drives the Volatility Premium badge */
  vrpLabel: 'CHEAP' | 'FAIR' | 'RICH' | 'UNKNOWN'
  source: string
  timestamp: number
}

// ─── Volatility Premium Badge ─────────────────────────────────────────────────
// IV (implied) vs HV (realised, 30d) tells us whether the front-week chain
// is overpaying for vol (RICH → sell premium) or underpricing it
// (CHEAP → buy premium).
function VolPremiumBadge({ data }: { data: OptionsSkewApiResponse }) {
  const ivPct = (data.atmIV * 100).toFixed(1)
  const hvPct = data.hv30 != null ? (data.hv30 * 100).toFixed(1) : null
  const ratio = data.vrpRatio
  const tone =
    data.vrpLabel === 'RICH'  ? { color: '#f87171', bg: 'bg-red-400/10',     border: 'border-red-400/30',     glyph: '↑' } :
    data.vrpLabel === 'CHEAP' ? { color: '#34d399', bg: 'bg-emerald-400/10', border: 'border-emerald-400/30', glyph: '↓' } :
    data.vrpLabel === 'FAIR'  ? { color: '#fbbf24', bg: 'bg-amber-400/10',   border: 'border-amber-400/30',   glyph: '≈' } :
                                { color: '#94a3b8', bg: 'bg-slate-700/30',   border: 'border-slate-500/40',   glyph: '?' }
  const pricing =
    data.vrpLabel === 'RICH'  ? 'Options pricing: RICH [IV > HV]'  :
    data.vrpLabel === 'CHEAP' ? 'Options pricing: CHEAP [IV < HV]' :
    data.vrpLabel === 'FAIR'  ? 'Options pricing: FAIR [IV ≈ HV]'  :
                                'Options pricing: UNKNOWN'

  return (
    <div
      className={cn(
        'inline-flex flex-col items-start gap-0.5 px-2.5 py-1.5 rounded border font-mono',
        tone.bg, tone.border,
      )}
      title={`ATM IV ${ivPct}% vs HV30 ${hvPct ?? '—'}% → ratio ${ratio ?? '—'}`}
    >
      <span
        className="text-[12px] font-bold tracking-wider uppercase"
        style={{ color: tone.color }}
      >
        {tone.glyph} {pricing}
      </span>
      <span className="text-[10px] text-slate-400">
        IV {ivPct}% · HV30 {hvPct ?? '—'}%
        {ratio != null && (
          <span style={{ color: tone.color }}> · {ratio.toFixed(2)}×</span>
        )}
      </span>
    </div>
  )
}

export function DynamicOptionsSkewPanel({ defaultTicker = 'NVDA' }: { defaultTicker?: string }) {
  const [inputValue, setInputValue]   = useState(defaultTicker)
  const [activeTicker, setActiveTicker] = useState(defaultTicker)
  const [data, setData]               = useState<OptionsSkewApiResponse | null>(null)
  const [error, setError]             = useState<string | null>(null)
  const [loading, setLoading]         = useState(false)

  const loadTicker = useCallback(async (ticker: string) => {
    const symbol = ticker.trim().toUpperCase()
    if (!symbol) return
    setActiveTicker(symbol)
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/market/options-skew?ticker=${encodeURIComponent(symbol)}`, {
        cache: 'no-store',
      })
      const body = await res.json()
      if (!res.ok) {
        // Backend returns `{ error: "No active options chain found for XYZ" }` on 404.
        setData(null)
        setError(body?.error ?? `No active options chain found for ${symbol}`)
        return
      }
      setData(body as OptionsSkewApiResponse)
    } catch (e) {
      setData(null)
      setError(`No active options chain found for ${symbol}`)
      console.warn('[DynamicOptionsSkewPanel] fetch failed:', e)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial load — fetch default ticker exactly once on mount.
  useEffect(() => {
    loadTicker(defaultTicker)
  }, [defaultTicker, loadTicker])

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    loadTicker(inputValue)
  }

  const livePrice = data?.spot ?? null
  const skewSignal: IndexSkewData['signal'] =
    data == null ? 'neutral' :
    data.skewPct > 8  ? 'heavy_skew' :
    data.skewPct > 3  ? 'elevated'   :
    data.skewPct < -2 ? 'complacent' : 'neutral'

  const cardData: IndexSkewData | null = data && {
    symbol:       data.ticker,
    name:         `${data.ticker} · Front-week ${data.expiry}`,
    shortName:    data.ticker,
    currentPrice: livePrice ?? 0,
    atmIV:        data.atmIV * 100,
    ivRank:       Math.min(100, Math.max(0, Math.round(data.atmIV * 100 * 1.5))),
    skewSlope:    data.skewPct,
    impMove1W:    parseFloat((data.atmIV * 100 / Math.sqrt(52)).toFixed(2)),
    impMove1M:    parseFloat((data.atmIV * 100 / Math.sqrt(12)).toFixed(2)),
    curve:        data.curve,
    callWall:     data.callWall,
    putWall:      data.putWall,
    maxPain:      data.maxPain,
    signal:       skewSignal,
  }

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-xl p-3 space-y-3">
      {/* ── Header + input ────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
            Options Skew &amp; Sentiment
          </h3>
          <p className="text-[12px] text-slate-400 font-mono">
            Live Alpaca chain · dynamic ticker
          </p>
        </div>

        <form onSubmit={onSubmit} className="flex items-center gap-1.5 shrink-0">
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value.toUpperCase().slice(0, 6))}
            placeholder="Enter ticker"
            spellCheck={false}
            autoCapitalize="characters"
            className="w-28 px-2 py-1 rounded border border-[#1a2540] bg-[#070b14] text-slate-100 text-xs font-mono uppercase tracking-wider focus:outline-none focus:border-sky-500/60 transition-colors"
          />
          <button
            type="submit"
            disabled={loading || !inputValue.trim()}
            className={cn(
              'px-2 py-1 rounded border text-[12px] font-mono uppercase tracking-wider transition-colors',
              loading
                ? 'border-slate-700 bg-slate-800/40 text-slate-500 cursor-wait'
                : 'border-sky-700 bg-sky-700/15 text-sky-300 hover:bg-sky-700/25 cursor-pointer',
            )}
          >
            {loading ? 'Loading…' : 'Load Ticker'}
          </button>
        </form>
      </div>

      {/* ── Body ──────────────────────────────────────────────────────────── */}
      {error && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/8 p-3 text-center">
          <div className="text-amber-300 text-[12px] font-mono">{error}</div>
          <div className="text-slate-500 text-[12px] font-mono mt-1">
            Try a liquid optionable ticker (e.g. NVDA, TSLA, AMD, AAPL, SPY).
          </div>
        </div>
      )}

      {!error && !data && loading && (
        <div className="rounded-lg border border-[#1a2540] bg-[#070b14] p-3 text-center">
          <div className="text-slate-400 text-[12px] font-mono animate-pulse">
            Fetching {activeTicker} chain…
          </div>
        </div>
      )}

      {!error && cardData && (
        <>
          {/* ── Volatility-Risk-Premium strip — sits ABOVE the walls so the
              CHEAP / RICH context frames the strike data the user is about
              to read.  Renders inline with the call/put wall summary. ── */}
          <div className="flex flex-wrap items-center gap-2 px-1">
            <VolPremiumBadge data={data!} />
            <div className="text-[10px] font-mono text-slate-500">
              vs walls →
              <span className="text-sky-400 ml-1.5">CW {fmtStrike(cardData.callWall)}</span>
              <span className="text-amber-400 mx-1.5">MP {fmtStrike(cardData.maxPain)}</span>
              <span className="text-amber-500">PW {fmtStrike(cardData.putWall)}</span>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <IndexSkewCard data={cardData} />
            <OIWallChart
              title={cardData.shortName}
              bars={data!.openInterestData}
              currentPrice={cardData.currentPrice}
              callWall={cardData.callWall}
              putWall={cardData.putWall}
              maxPain={cardData.maxPain}
            />
          </div>
        </>
      )}

      {data && (
        <div className="flex items-center justify-between text-[10px] font-mono text-slate-500 px-1">
          <span>
            {data.contractCount} contracts · spot $
            {livePrice != null ? livePrice.toFixed(2) : '--'}
          </span>
          <span>
            ATM IV {(data.atmIV * 100).toFixed(1)}% · Δ-skew {data.skewPct >= 0 ? '+' : ''}{data.skewPct}pp
          </span>
        </div>
      )}
    </div>
  )
}

// ─── Public Props / Main Export ───────────────────────────────────────────────

export interface OptionsSectionProps {
  skewData?: IndexSkewData[]
}

export function OptionsSection({ skewData = INDEX_SKEW_MOCK }: OptionsSectionProps) {
  return (
    <section className="space-y-3">
      <ExpirationCalendarBanner />
      <IndexSkewGrid skewData={skewData} />
      <DynamicOptionsSkewPanel defaultTicker="NVDA" />
      <OIWallsGrid />
    </section>
  )
}
