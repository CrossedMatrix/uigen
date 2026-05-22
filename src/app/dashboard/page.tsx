'use client'

import { useState, useEffect, useId, useCallback } from 'react'
import {
  TechnicalSection,
  TECHNICALS_MOCK,
  RATIOS_MOCK,
  type TechnicalRow,
  type RatioCard,
} from '@/components/dashboard/TechnicalSection'
import { InstitutionalFlowsSection } from '@/components/dashboard/InstitutionalFlowsSection'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Instrument {
  symbol: string
  name: string
  price: number
  change: number
  changePercent: number
  high?: number
  low?: number
  sparkline: number[]
}

interface VolatilityData {
  vix: Instrument
  vvix: Instrument
  skew: Instrument
  putCallRatio: number
}

interface MarketData {
  equities: Instrument[]
  rates: Instrument[]
  fx: Instrument[]
  commodities: Instrument[]
  volatility: VolatilityData
  timestamp: number
  isMarketOpen: boolean
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(' ')
}

function fmtPrice(price: number): string {
  if (!price) return '—'
  if (price > 10000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (price > 100) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (price > 10) return price.toFixed(2)
  if (price > 1) return price.toFixed(4)
  return price.toFixed(4)
}

function fmtChange(n: number, dec = 2): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(dec)}`
}

function fmtPct(n: number): string {
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function changeColor(n: number) {
  if (n > 0) return 'text-emerald-400'
  if (n < 0) return 'text-red-400'
  return 'text-slate-400'
}

function changeBg(n: number) {
  if (n > 0) return 'bg-emerald-400/10 text-emerald-400'
  if (n < 0) return 'bg-red-400/10 text-red-400'
  return 'bg-slate-700/50 text-slate-400'
}

// ─── Sparkline ────────────────────────────────────────────────────────────────

function Sparkline({
  data,
  positive,
  w = 120,
  h = 40,
}: {
  data: number[]
  positive: boolean
  w?: number
  h?: number
}) {
  const uid = useId()
  const gid = `sg${uid.replace(/:/g, '')}`

  if (data.length < 2) {
    return <div style={{ width: w, height: h }} className="rounded bg-slate-800/40" />
  }

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const pad = 2

  const pts = data.map((v, i) => ({
    x: (i / (data.length - 1)) * w,
    y: h - pad - ((v - min) / range) * (h - pad * 2),
  }))

  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const area = `M${pts[0].x},${h} ${pts.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} L${pts[pts.length - 1].x},${h} Z`
  const color = positive ? '#34d399' : '#f87171'
  const last = pts[pts.length - 1]

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last.x} cy={last.y} r="2.5" fill={color} />
    </svg>
  )
}

// ─── Live Clock ───────────────────────────────────────────────────────────────

function LiveClock() {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  const time = now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const date = now.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <div className="text-right hidden sm:block">
      <div className="font-mono text-sm text-slate-200 tracking-wider">
        {time} <span className="text-slate-600 text-xs">ET</span>
      </div>
      <div className="text-[10px] text-slate-600">{date}</div>
    </div>
  )
}

// ─── Ticker Tape ──────────────────────────────────────────────────────────────

function TickerTape({ data }: { data: MarketData | null }) {
  if (!data) return <div className="h-7 bg-[#080c15] border-b border-[#1a2540]" />

  const items = [
    ...data.equities,
    ...data.fx.slice(0, 4),
    ...data.commodities,
    data.volatility.vix,
  ]
  const doubled = [...items, ...items]

  return (
    <div className="border-b border-[#1a2540] bg-[#080c15] overflow-hidden h-7 flex items-center">
      <div
        className="flex items-center gap-6 whitespace-nowrap text-[11px] font-mono px-4"
        style={{ animation: 'ticker 90s linear infinite' }}
      >
        {doubled.map((item, i) => (
          <span key={i} className="flex items-center gap-1.5 shrink-0">
            <span className="text-amber-400/80 text-[10px] uppercase tracking-wider">{item.name}</span>
            <span className="text-slate-300">{fmtPrice(item.price)}</span>
            <span className={item.changePercent >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              {fmtPct(item.changePercent)}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Equity Card ──────────────────────────────────────────────────────────────

function EquityCard({ inst }: { inst: Instrument }) {
  const up = inst.changePercent >= 0

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 hover:border-[#2a3f64] transition-colors flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[10px] font-mono text-amber-400/80 tracking-widest uppercase mb-0.5">
            {inst.symbol.replace('^', '')}
          </div>
          <div className="text-xs text-slate-400">{inst.name}</div>
        </div>
        <span className={cn('text-[11px] font-mono px-1.5 py-0.5 rounded-md font-medium', changeBg(inst.changePercent))}>
          {fmtPct(inst.changePercent)}
        </span>
      </div>

      <div>
        <div className="font-mono text-2xl font-semibold text-slate-100 tabular-nums leading-none">
          {fmtPrice(inst.price)}
        </div>
        <div className={cn('text-xs font-mono mt-0.5 tabular-nums', changeColor(inst.change))}>
          {fmtChange(inst.change)}
        </div>
      </div>

      <Sparkline data={inst.sparkline} positive={up} w={140} h={36} />

      {inst.high != null && inst.low != null && (
        <div className="flex justify-between text-[10px] text-slate-700 font-mono">
          <span>L {fmtPrice(inst.low)}</span>
          <span>H {fmtPrice(inst.high)}</span>
        </div>
      )}
    </div>
  )
}

// ─── Yield Curve ──────────────────────────────────────────────────────────────

function YieldCurveSection({ rates }: { rates: Instrument[] }) {
  const svgW = 220
  const svgH = 64
  const pad = 10

  const mn = Math.min(...rates.map((r) => r.price))
  const mx = Math.max(...rates.map((r) => r.price))
  const rng = mx - mn || 0.5

  const pts = rates.map((r, i) => ({
    x: pad + (i / Math.max(rates.length - 1, 1)) * (svgW - pad * 2),
    y: svgH - pad - ((r.price - mn) / rng) * (svgH - pad * 2),
  }))

  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')

  const rate10 = rates.find((r) => r.symbol === '^TNX')
  const rate3m = rates.find((r) => r.symbol === '^IRX')
  const inverted = rate10 && rate3m && rate10.price < rate3m.price
  const curveColor = inverted ? '#f87171' : '#60a5fa'

  const spread = rate10 && rate3m ? (rate10.price - rate3m.price).toFixed(2) : null

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">Yield Curve</h3>
        <div className="flex items-center gap-2">
          {spread && (
            <span className="text-[10px] text-slate-600 font-mono">10Y-3M: {spread}%</span>
          )}
          {inverted && (
            <span className="text-[10px] bg-red-400/20 text-red-400 border border-red-400/20 px-1.5 py-0.5 rounded font-mono">
              INVERTED
            </span>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        {rates.map((r) => (
          <div key={r.symbol} className="flex items-center gap-2">
            <span className="text-[11px] text-slate-500 w-14 shrink-0">{r.name}</span>
            <div className="flex-1 h-px bg-[#1a2540]" />
            <span className="font-mono text-sm text-slate-200 w-12 text-right tabular-nums">
              {r.price.toFixed(2)}%
            </span>
            <span className={cn('font-mono text-[11px] w-16 text-right tabular-nums flex items-center justify-end gap-0.5', changeColor(r.change))}>
              <span className="text-[9px]">{r.change >= 0 ? '▲' : '▼'}</span>
              {Math.abs(r.change).toFixed(3)}
            </span>
          </div>
        ))}
      </div>

      <div className="pt-2 border-t border-[#1a2540]">
        <svg width="100%" viewBox={`0 0 ${svgW} ${svgH}`} className="overflow-visible">
          <polyline
            points={line}
            fill="none"
            stroke={curveColor}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {pts.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="3" fill={curveColor} />
          ))}
          {rates.map((r, i) => (
            <text
              key={i}
              x={pts[i].x}
              y={svgH}
              textAnchor="middle"
              className="fill-slate-600"
              style={{ fontSize: 8 }}
            >
              {r.name.split('-')[0]}
            </text>
          ))}
        </svg>
      </div>
    </div>
  )
}

// ─── FX Table ─────────────────────────────────────────────────────────────────

const FLAG: Record<string, string> = {
  'EUR/USD': '🇪🇺',
  'GBP/USD': '🇬🇧',
  'USD/JPY': '🇯🇵',
  'USD/CNY': '🇨🇳',
  'AUD/USD': '🇦🇺',
  'DXY': '🇺🇸',
}

function FXTable({ fx }: { fx: Instrument[] }) {
  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4">
      <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest mb-3">FX Markets</h3>

      <div className="divide-y divide-[#1a2540]/60">
        {fx.map((pair) => (
          <div key={pair.symbol} className="flex items-center py-2 gap-2">
            <span className="text-base w-6">{FLAG[pair.name] ?? '🌐'}</span>
            <span className="text-xs text-slate-300 font-mono flex-1">{pair.name}</span>
            <span className="font-mono text-sm text-slate-100 tabular-nums">{fmtPrice(pair.price)}</span>
            <span className={cn('font-mono text-xs w-16 text-right tabular-nums', changeColor(pair.changePercent))}>
              {fmtPct(pair.changePercent)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Commodities Table ────────────────────────────────────────────────────────

const COMM_ICON: Record<string, string> = {
  'GC=F': '🥇',
  'SI=F': '🥈',
  'CL=F': '🛢️',
  'BZ=F': '⛽',
  'HG=F': '🔶',
  'NG=F': '🔥',
}

const COMM_UNIT: Record<string, string> = {
  'GC=F': '$/oz',
  'SI=F': '$/oz',
  'CL=F': '$/bbl',
  'BZ=F': '$/bbl',
  'HG=F': '$/lb',
  'NG=F': '$/MMBtu',
}

function CommodityTable({ commodities }: { commodities: Instrument[] }) {
  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4">
      <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest mb-3">Commodities</h3>

      <div className="divide-y divide-[#1a2540]/60">
        {commodities.map((c) => (
          <div key={c.symbol} className="flex items-center py-2 gap-2">
            <span className="text-base w-6">{COMM_ICON[c.symbol] ?? '•'}</span>
            <div className="flex-1 min-w-0">
              <div className="text-xs text-slate-300 font-mono">{c.name}</div>
              <div className="text-[10px] text-slate-700">{COMM_UNIT[c.symbol]}</div>
            </div>
            <span className="font-mono text-sm text-slate-100 tabular-nums">{fmtPrice(c.price)}</span>
            <span className={cn('font-mono text-xs w-16 text-right tabular-nums', changeColor(c.changePercent))}>
              {fmtPct(c.changePercent)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── VIX Regime Gauge ────────────────────────────────────────────────────────

function VixGauge({ vix }: { vix: Instrument }) {
  const { price, change, changePercent } = vix
  const regime =
    price < 15 ? { label: 'RISK ON', color: '#34d399', bg: '#34d39920' }
    : price < 20 ? { label: 'LOW VOL', color: '#fbbf24', bg: '#fbbf2420' }
    : price < 28 ? { label: 'CAUTION', color: '#f97316', bg: '#f9731620' }
    : { label: 'RISK OFF', color: '#f87171', bg: '#f8717120' }

  const pct = Math.min(100, (price / 45) * 100)

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-slate-500 font-mono uppercase tracking-wider">VIX</span>
        <span
          className="text-[10px] font-mono px-2 py-0.5 rounded border font-semibold tracking-wider"
          style={{ color: regime.color, backgroundColor: regime.bg, borderColor: `${regime.color}30` }}
        >
          {regime.label}
        </span>
      </div>
      <div className="font-mono text-3xl font-semibold text-slate-100 tabular-nums leading-none mb-1">
        {price.toFixed(2)}
      </div>
      <div className={cn('text-xs font-mono mb-3', changeColor(change))}>
        {fmtChange(change)} ({fmtPct(changePercent)})
      </div>
      <div className="space-y-1">
        <div className="h-2 bg-[#111827] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${pct}%`, backgroundColor: regime.color }}
          />
        </div>
        <div className="flex justify-between text-[9px] text-slate-700 font-mono">
          <span>0</span>
          <span>15</span>
          <span>28</span>
          <span>45+</span>
        </div>
      </div>
    </div>
  )
}

// ─── Put/Call Ratio ───────────────────────────────────────────────────────────

function PutCallGauge({ ratio }: { ratio: number }) {
  const sentiment =
    ratio > 1.1 ? { label: 'BEARISH', color: '#f87171' }
    : ratio > 0.85 ? { label: 'NEUTRAL', color: '#94a3b8' }
    : ratio > 0.7 ? { label: 'NEUTRAL', color: '#94a3b8' }
    : { label: 'BULLISH', color: '#34d399' }

  const pct = Math.min(100, (ratio / 1.6) * 100)

  return (
    <div>
      <div className="text-[10px] text-slate-500 font-mono uppercase tracking-wider mb-1">Put/Call Ratio</div>
      <div className="font-mono text-3xl font-semibold tabular-nums leading-none mb-1" style={{ color: sentiment.color }}>
        {ratio.toFixed(2)}
      </div>
      <div className="text-xs font-mono mb-3" style={{ color: sentiment.color }}>
        {sentiment.label}
      </div>
      <div className="space-y-1">
        <div className="h-2 bg-[#111827] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${pct}%`, backgroundColor: sentiment.color }}
          />
        </div>
        <div className="flex justify-between text-[9px] text-slate-700 font-mono">
          <span>Bullish 0.5</span>
          <span>Neutral 0.85</span>
          <span>Bearish 1.2+</span>
        </div>
      </div>
    </div>
  )
}

// ─── Risk Section ─────────────────────────────────────────────────────────────

function RiskSection({ vol }: { vol: VolatilityData }) {
  const { vix, vvix, skew, putCallRatio } = vol

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4">
      <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest mb-4">
        Risk &amp; Volatility Indicators
      </h3>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
        <VixGauge vix={vix} />

        <div>
          <div className="text-[10px] text-slate-500 font-mono uppercase tracking-wider mb-1">VVIX</div>
          <div className="font-mono text-3xl font-semibold text-slate-100 tabular-nums leading-none mb-1">
            {vvix.price.toFixed(1)}
          </div>
          <div className={cn('text-xs font-mono mb-2', changeColor(vvix.change))}>
            {fmtChange(vvix.change, 1)} ({fmtPct(vvix.changePercent)})
          </div>
          <div className="text-[10px] text-slate-700 leading-snug">
            Volatility of VIX.
            <br />
            {vvix.price > 100 ? '⚠ Elevated VIX uncertainty' : 'Normal range'}
          </div>
        </div>

        <div>
          <div className="text-[10px] text-slate-500 font-mono uppercase tracking-wider mb-1">CBOE SKEW</div>
          <div
            className={cn(
              'font-mono text-3xl font-semibold tabular-nums leading-none mb-1',
              skew.price > 145 ? 'text-orange-400' : 'text-slate-100'
            )}
          >
            {skew.price.toFixed(1)}
          </div>
          <div className={cn('text-xs font-mono mb-2', changeColor(skew.change))}>
            {fmtChange(skew.change, 1)} ({fmtPct(skew.changePercent)})
          </div>
          <div className="text-[10px] text-slate-700 leading-snug">
            Tail risk premium.
            <br />
            {skew.price > 145 ? '⚠ Elevated left-tail risk' : skew.price < 120 ? 'Compressed tails' : 'Normal skew'}
          </div>
        </div>

        <PutCallGauge ratio={putCallRatio} />
      </div>
    </div>
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Pulse({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-slate-800/50', className)} />
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 space-y-3">
            <Pulse className="h-3 w-20" />
            <Pulse className="h-7 w-32" />
            <Pulse className="h-3 w-16" />
            <Pulse className="h-9 w-full" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 space-y-3">
            <Pulse className="h-3 w-24" />
            {[0, 1, 2, 3].map((j) => <Pulse key={j} className="h-5 w-full" />)}
          </div>
        ))}
      </div>
      <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 space-y-3">
        <Pulse className="h-3 w-32" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <Pulse className="h-3 w-16" />
              <Pulse className="h-8 w-24" />
              <Pulse className="h-3 w-20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Live Technical Data Builders ────────────────────────────────────────────

function buildLiveTechnicals(data: MarketData): TechnicalRow[] {
  const priceOf = (sym: string): number | undefined =>
    data.equities.find((e) => e.symbol === sym)?.price ??
    data.commodities.find((c) => c.symbol === sym)?.price ??
    data.fx.find((f) => f.symbol === sym)?.price

  return TECHNICALS_MOCK.map((row) => ({ ...row, price: priceOf(row.symbol) ?? row.price }))
}

function buildLiveRatios(data: MarketData): RatioCard[] {
  const ndx    = data.equities.find((e) => e.symbol === '^NDX')?.price    ?? 20842.65
  const spx    = data.equities.find((e) => e.symbol === '^GSPC')?.price   ?? 5847.32
  const gold   = data.commodities.find((c) => c.symbol === 'GC=F')?.price ?? 3215.40
  const silver = data.commodities.find((c) => c.symbol === 'SI=F')?.price ?? 32.84
  const copper = data.commodities.find((c) => c.symbol === 'HG=F')?.price ?? 4.58
  const vix    = data.volatility.vix.price
  const rate10 = data.rates.find((r) => r.symbol === '^TNX')?.price ?? 4.41
  const rate3m = data.rates.find((r) => r.symbol === '^IRX')?.price ?? 5.24

  const cuGold = copper / gold
  const auAg   = gold / silver
  const nSpx   = ndx / spx
  const spread = rate10 - rate3m

  // Composite risk score 0–100: VIX contribution (0–50) + inverted-curve contribution (0–50)
  const vixScore   = Math.max(0, Math.min(50, ((vix - 10) / 30) * 50))
  const curveScore = spread < 0 ? Math.min(50, (Math.abs(spread) / 2) * 50) : 0
  const risk       = Math.round(vixScore + curveScore)
  const regimeLbl  = risk < 25 ? 'RISK ON' : risk < 50 ? 'MODERATE' : risk < 75 ? 'ELEVATED' : 'RISK OFF'

  return [
    {
      ...RATIOS_MOCK[0],
      value: cuGold,
      displayValue: cuGold.toFixed(6),
      signal: cuGold > 0.0015 ? 'bullish' : cuGold < 0.0012 ? 'bearish' : 'neutral',
      status: cuGold > 0.0015 ? 'Risk On' : cuGold < 0.0012 ? 'Risk Off' : 'Neutral',
    },
    {
      ...RATIOS_MOCK[1],
      value: auAg,
      displayValue: auAg.toFixed(1),
      signal: auAg > 80 ? 'warning' : auAg < 60 ? 'bullish' : 'neutral',
      status: auAg > 80 ? 'Risk Off' : auAg > 60 ? 'Neutral' : 'Industrial',
    },
    {
      ...RATIOS_MOCK[2],
      value: nSpx,
      displayValue: `${nSpx.toFixed(3)}×`,
      signal: nSpx > 3.5 ? 'bullish' : 'neutral',
      status: nSpx > 3.5 ? 'Tech Dominance' : 'Converging',
    },
    {
      ...RATIOS_MOCK[3],
      value: risk,
      displayValue: regimeLbl,
      status: spread < 0 ? 'Curve Inverted' : 'Curve Normal',
      signal: risk > 60 ? 'warning' : risk < 30 ? 'bullish' : 'neutral',
    },
  ]
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [data, setData] = useState<MarketData | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [usingFallback, setUsingFallback] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/market', { cache: 'no-store' })
      if (!res.ok) throw new Error('fetch failed')
      const json: MarketData = await res.json()
      setData(json)
      setLastUpdate(new Date())
      setUsingFallback(!json.isMarketOpen && json.equities[0]?.price === 5847.32)
    } catch {
      setUsingFallback(true)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 30_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-200" style={{ fontFamily: 'var(--font-geist-sans)' }}>
      <style>{`
        @keyframes ticker {
          from { transform: translateX(0) }
          to   { transform: translateX(-50%) }
        }
      `}</style>

      {/* ── Header ── */}
      <header className="sticky top-0 z-50 bg-[#070b14]/95 backdrop-blur-sm border-b border-[#1a2540]">
        <div className="max-w-screen-2xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            {/* Status dot */}
            <div
              className={cn('w-2 h-2 rounded-full shrink-0', data?.isMarketOpen ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600')}
              style={data?.isMarketOpen ? { boxShadow: '0 0 8px #34d399' } : undefined}
            />
            <h1
              className="font-mono text-base font-bold tracking-[0.2em] text-slate-100 uppercase"
              style={{ fontFamily: 'var(--font-geist-mono)' }}
            >
              Market<span className="text-amber-400">Pulse</span>
            </h1>
            {data && (
              <span
                className={cn(
                  'hidden sm:inline text-[10px] font-mono px-2 py-0.5 rounded-md border tracking-widest uppercase',
                  data.isMarketOpen
                    ? 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10'
                    : 'text-slate-500 border-slate-700 bg-slate-800/40'
                )}
              >
                {data.isMarketOpen ? 'NYSE Open' : 'Market Closed'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-4">
            {lastUpdate && (
              <span className="hidden md:block text-[10px] text-slate-700 font-mono">
                Refreshed {lastUpdate.toLocaleTimeString()}
              </span>
            )}
            {usingFallback && (
              <span className="text-[10px] text-amber-500/70 font-mono hidden md:block">demo data</span>
            )}
            <LiveClock />
            <button
              onClick={load}
              className="text-[11px] font-mono text-slate-600 hover:text-slate-400 border border-[#1a2540] hover:border-slate-600 px-2 py-1 rounded-md transition-colors"
            >
              ↻
            </button>
          </div>
        </div>

        <TickerTape data={data} />
      </header>

      {/* ── Main ── */}
      <main className="max-w-screen-2xl mx-auto px-4 py-5 space-y-4">
        {!data ? (
          <DashboardSkeleton />
        ) : (
          <>
            {/* Equities */}
            <section>
              <div
                className="text-[10px] font-mono text-slate-600 uppercase tracking-widest mb-2"
                style={{ fontFamily: 'var(--font-geist-mono)' }}
              >
                Equity Indices
              </div>
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                {data.equities.map((e) => (
                  <EquityCard key={e.symbol} inst={e} />
                ))}
              </div>
            </section>

            {/* Rates | FX | Commodities */}
            <section className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              <YieldCurveSection rates={data.rates} />
              <FXTable fx={data.fx} />
              <CommodityTable commodities={data.commodities} />
            </section>

            {/* Risk */}
            <section>
              <RiskSection vol={data.volatility} />
            </section>

            {/* Technical & Cross-Asset Dynamics */}
            <section>
              <div className="text-[10px] font-mono text-slate-600 uppercase tracking-widest mb-2">
                Technical &amp; Cross-Asset Dynamics
              </div>
              <TechnicalSection
                technicals={buildLiveTechnicals(data)}
                ratios={buildLiveRatios(data)}
              />
            </section>

            {/* Institutional Flows & Positioning */}
            <section>
              <div className="text-[10px] font-mono text-slate-600 uppercase tracking-widest mb-2">
                Institutional Flows &amp; Positioning
              </div>
              <InstitutionalFlowsSection />
            </section>
          </>
        )}

        <p className="text-center text-[10px] text-slate-800 font-mono pb-4">
          For informational purposes only · Not financial advice · Data sourced from public market feeds
        </p>
      </main>
    </div>
  )
}
