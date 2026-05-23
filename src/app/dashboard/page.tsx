'use client'

import { useState, useEffect, useId, useCallback } from 'react'
import { usePersistState } from '@/lib/hooks/usePersistState'
import { useFredMarkets } from '@/lib/hooks/useFredMarkets'
import { useMarketNodes } from '@/lib/hooks/useMarketNodes'
import { MarketNodeRow } from '@/components/market/MarketNodeRow'
import type { FredMarketsData, YieldCurveData, DXYData } from '@/types/fred-markets'
import {
  TechnicalSection,
  RatiosPanel,
  TECHNICALS_MOCK,
  RATIOS_MOCK,
  type TechnicalRow,
  type RatioCard,
} from '@/components/dashboard/TechnicalSection'
import { InstitutionalFlowsSection, FLOWS_MOCK } from '@/components/dashboard/InstitutionalFlowsSection'
import { InstitutionalSquawkNewsStream, SQUAWK_NEWS_MOCK, type SquawkNewsData } from '@/components/dashboard/InstitutionalSquawkNewsStream'
import {
  OptionsSection,
  IndexSkewHeads,
  OIWallsGrid,
  INDEX_SKEW_MOCK,
} from '@/components/dashboard/OptionsSection'
import { MacroRiskMatrix, MACRO_RISK_MOCK, type MacroRiskMetrics } from '@/components/dashboard/MacroRiskMatrix'
import { MacroPositioningPanel } from '@/components/dashboard/MacroPositioningPanel'

// ─── Types ────────────────────────────────────────────────────────────────────

type Timeframe = '1D' | '5D' | '1M' | '3M'

interface Instrument {
  symbol: string
  name: string
  price: number
  change: number
  changePercent: number
  high?: number
  low?: number
  sparkline: number[]
  sparklines?: Record<Timeframe, number[]>
}

interface FuturesInstrument {
  symbol: string
  name: string
  price: number
  change: number
  changePercent: number
  high?: number
  low?: number
  sparklines: Record<Timeframe, number[]>
}

interface VolatilityData {
  vix: Instrument
  vvix: Instrument
  skew: Instrument
  putCallRatio: number
  macroRisk?: MacroRiskMetrics // Extended macro risk metrics
}

interface CrossAssetRatios {
  copperGoldRatio: number
  goldSilverRatio: number
  vixVvixRatio: number
  btcGoldRatio: number
  oilGoldRatio: number
  yield2y10y: number
}

interface MarketData {
  futures?: FuturesInstrument[]
  equities: Instrument[]
  rates: Instrument[]
  fx: Instrument[]
  commodities: Instrument[]
  volatility: VolatilityData
  ratios: CrossAssetRatios
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
  return 'text-[#7ca5a5]'
}

function changeBg(n: number) {
  if (n > 0) return 'bg-emerald-400/10 text-emerald-400'
  if (n < 0) return 'bg-red-400/10 text-red-400'
  return 'bg-slate-700/50 text-slate-400'
}

function calcPeriodReturn(sparkline: number[]): number {
  if (sparkline.length < 2) return 0
  const first = sparkline[0]
  const last = sparkline[sparkline.length - 1]
  if (!first || first === 0) return 0
  return ((last - first) / first) * 100
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
  // mounted gate prevents SSR/CSR hydration mismatch.
  // The server renders at one wall-clock time, the browser hydrates at
  // another — toLocaleTimeString diverges by 1+ seconds and React panics.
  // We render nothing on the server, then swap in the live clock on the
  // client only after the first effect fires.
  const [mounted, setMounted] = useState(false)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    setMounted(true)
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  if (!mounted) {
    // Stable placeholder of the exact same dimensions to avoid layout shift
    return (
      <div className="text-right hidden sm:block" suppressHydrationWarning>
        <div className="font-mono text-sm text-slate-200 tracking-wider">
          --:--:-- <span className="text-slate-300 text-xs">ET</span>
        </div>
        <div className="text-[10px] text-slate-300">&nbsp;</div>
      </div>
    )
  }

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
    <div className="text-right hidden sm:block" suppressHydrationWarning>
      <div className="font-mono text-sm text-slate-200 tracking-wider">
        {time} <span className="text-slate-300 text-xs">ET</span>
      </div>
      <div className="text-[10px] text-slate-300">{date}</div>
    </div>
  )
}

// ─── Timeframe Bar ────────────────────────────────────────────────────────────

function TimeframeBar({ value, onChange }: { value: Timeframe; onChange: (tf: Timeframe) => void }) {
  const tfs: Timeframe[] = ['1D', '5D', '1M', '3M']
  return (
    <div className="flex items-center gap-1 bg-[#080d18] border border-[#1a2540] rounded-lg p-0.5">
      {tfs.map((tf) => (
        <button
          key={tf}
          onClick={() => onChange(tf)}
          className={cn(
            'text-[10px] font-mono px-2.5 py-1 rounded-md transition-colors font-semibold tracking-wider',
            value === tf
              ? 'bg-amber-400/15 text-amber-400 border border-amber-400/30'
              : 'text-slate-300 hover:text-slate-400',
          )}
        >
          {tf}
        </button>
      ))}
    </div>
  )
}

// ─── Ticker Tape ──────────────────────────────────────────────────────────────

function TickerTape({ data }: { data: MarketData | null }) {
  if (!data) return <div className="h-7 bg-[#080c15] border-b border-[#1a2540]" />

  // Prefer futures for the leading indices
  const leadItems = data.futures?.length
    ? data.futures.map((f) => ({ ...f, sparkline: [] }))
    : data.equities

  const items = [
    ...leadItems,
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
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl px-3 py-2 hover:border-[#2a3f64] transition-colors flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1.5">
          <span className="text-[10px] font-mono text-amber-400/80 tracking-widest uppercase shrink-0">
            {inst.symbol.replace('^', '')}
          </span>
          <span className="text-xs text-slate-300 truncate">{inst.name}</span>
        </div>
      </div>

      <span className="font-mono text-sm font-semibold text-slate-100 tabular-nums shrink-0">
        {fmtPrice(inst.price)}
      </span>

      <span className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded-md font-medium shrink-0', changeBg(inst.changePercent))}>
        {fmtPct(inst.changePercent)}
      </span>
    </div>
  )
}

// ─── Futures Card ─────────────────────────────────────────────────────────────

const FUTURES_META: Record<string, { label: string; underlying: string }> = {
  'ES=F':  { label: 'ES',  underlying: 'S&P 500 E-Mini' },
  'NQ=F':  { label: 'NQ',  underlying: 'NASDAQ 100 E-Mini' },
  'YM=F':  { label: 'YM',  underlying: 'DOW JONES E-Mini' },
  'RTY=F': { label: 'RTY', underlying: 'Russell 2000 Mini' },
}

function FuturesCard({ inst, timeframe }: { inst: FuturesInstrument; timeframe: Timeframe }) {
  const spark = inst.sparklines[timeframe] ?? []
  const periodPct = timeframe === '1D' ? inst.changePercent : calcPeriodReturn(spark)
  const periodChange = timeframe === '1D' ? inst.change : (inst.price * periodPct / 100)
  const up = periodPct >= 0
  const meta = FUTURES_META[inst.symbol]

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl px-3 py-2 hover:border-[#2a3f64] transition-colors flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-1">
          <span className="text-[10px] font-mono text-amber-400/80 tracking-widest uppercase shrink-0">{meta?.label ?? inst.symbol}</span>
          <span className="text-[11px] font-mono text-slate-400 border border-slate-800 px-1 rounded shrink-0">FUT</span>
          <span className="text-[10px] text-slate-300 truncate">{meta?.underlying ?? inst.name}</span>
        </div>
      </div>

      <span className="font-mono text-sm font-semibold text-slate-100 tabular-nums shrink-0">
        {fmtPrice(inst.price)}
      </span>

      <div className="flex items-baseline gap-1 shrink-0">
        <span className={cn('text-[10px] font-mono px-1.5 py-0.5 rounded-md font-medium', changeBg(periodPct))}>
          {fmtPct(periodPct)}
        </span>
        {timeframe !== '1D' && <span className="text-slate-400 text-[11px]">{timeframe}</span>}
      </div>
    </div>
  )
}

// ─── FRED Live Badge (reusable) ───────────────────────────────────────────────

function FredLiveBadge({ isLive, isLoading }: { isLive: boolean; isLoading?: boolean }) {
  if (isLoading) {
    return (
      <span className="text-[11px] font-mono text-slate-500 animate-pulse tracking-wider">
        fetching…
      </span>
    )
  }
  if (isLive) {
    return (
      <div
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md border"
        style={{ borderColor: '#34d39960', backgroundColor: '#34d39912' }}
        title="Live data from FRED API"
      >
        <span
          className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{ backgroundColor: '#34d399', boxShadow: '0 0 6px #34d399, 0 0 12px #34d39980' }}
        />
        <span className="text-[11px] font-mono font-bold tracking-widest uppercase text-emerald-400">
          ● REAL-TIME FRED
        </span>
      </div>
    )
  }
  return (
    <div
      className="flex items-center gap-1 px-1.5 py-0.5 rounded-md border"
      style={{ borderColor: '#fbbf2450', backgroundColor: '#fbbf2410' }}
      title="Add FRED_API_KEY to .env.local for live data"
    >
      <span className="inline-block w-1.5 h-1.5 rounded-full border flex-shrink-0" style={{ borderColor: '#fbbf24' }} />
      <span className="text-[11px] font-mono font-bold tracking-widest uppercase text-amber-400">
        DEMO
      </span>
    </div>
  )
}

// ─── Yield Curve ──────────────────────────────────────────────────────────────

function YieldCurveSection({
  rates,
  fredData,
  isLoading,
}: {
  rates:      Instrument[]
  fredData?:  YieldCurveData | null
  isLoading?: boolean
}) {
  const isLive = fredData?.meta.status === 'AUTHENTICATED'

  // Resolved values: prefer FRED live data, fall back to market API
  const p2y  = fredData?.points.find(p => p.seriesId === 'DGS2')
  const p10y = fredData?.points.find(p => p.seriesId === 'DGS10')

  const rate2y   = p2y  ?? rates.find(r => r.name.includes('2-Year'))
  const rate10y_ = p10y ?? rates.find(r => r.symbol === '^TNX')

  const r2yVal    = p2y  ? p2y.rate   : (rate2y  as Instrument | undefined)?.price
  const r2yCh     = p2y  ? p2y.change : (rate2y  as Instrument | undefined)?.change
  const r10yVal   = p10y ? p10y.rate  : (rate10y_ as Instrument | undefined)?.price
  const r10yCh    = p10y ? p10y.change: (rate10y_ as Instrument | undefined)?.change

  const spreadNum = fredData
    ? fredData.spread2y10y
    : r2yVal != null && r10yVal != null ? r10yVal - r2yVal : null

  const spreadChg = fredData ? fredData.spread2y10yChange : null
  const inverted  = spreadNum != null && spreadNum < 0

  const spreadColor = spreadNum == null ? '#94a3b8' : inverted ? '#f87171' : '#34d399'

  // Context-aware momentum color: considers both spread state and change direction
  const getSpreadChangeColor = (): string => {
    if (spreadNum == null || spreadChg == null) return '#94a3b8'

    if (inverted) {
      return spreadChg >= 0 ? '#34d399' : '#f87171'
    }

    if (spreadNum > 0) {
      return spreadChg > 0 ? '#34d399' : '#fbbf24'
    }

    return '#94a3b8'
  }

  // Full curve rows: use FRED if available, else market API rates
  const curveRows = fredData
    ? fredData.points
    : rates.slice(0, 5).map(r => ({
        label: r.name.replace(/-Year.*/,'Y').replace('3-Month','3M'),
        rate: r.price,
        seriesId: r.symbol,
        change: r.change,
        changeBps: r.change * 100,
        maturity: 0,
        prevRate: r.price,
        date: '—',
        high52w: undefined,
        low52w: undefined,
      }))

  return (
    <div
      className="border rounded-2xl p-3 flex flex-col h-[320px] transition-colors duration-300"
      style={{
        backgroundColor: '#0c1221',
        borderColor: isLive ? '#34d39928' : '#1a2540',
      }}
    >
      {/* ─── HEADER WITH STATUS & TIMESTAMP ─────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-shrink-0 pb-2 border-b border-slate-800/30">
        <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">Yield Curve</h3>
        <div className="flex items-center gap-2">
          {isLive && fredData && (
            <span className="text-[9px] font-mono text-slate-500">
              obs. {fredData.observationDate}
            </span>
          )}
          <FredLiveBadge isLive={isLive} isLoading={isLoading} />
        </div>
      </div>

      {/* ─── 2Y & 10Y HERO BLOCKS: 50/50 SPLIT WITH PROPER VERTICAL SPACING ─────── */}
      <div className="grid grid-cols-2 gap-2.5 py-2 flex-shrink-0 h-[100px]">
        {/* 2Y Block */}
        <div className="bg-[#070d1a] rounded-lg p-2.5 border border-[#1a2540] flex flex-col justify-between">
          {/* Label Row */}
          <div className="flex items-center justify-between h-5">
            <span className="text-[11px] text-slate-400 font-mono leading-none">2-Year</span>
            {isLive && <span className="text-[9px] font-mono text-slate-600 leading-none">DGS2</span>}
          </div>

          {/* Rate Display */}
          <div className="h-7 flex items-center">
            <div className="text-lg font-mono font-semibold text-slate-100 tabular-nums leading-none">
              {r2yVal != null ? r2yVal.toFixed(3) : '—'}%
            </div>
          </div>

          {/* Change & Basis Points */}
          {r2yCh != null && (
            <div className="h-4 flex items-center">
              <div className={`text-[9px] font-mono tabular-nums leading-none ${r2yCh >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                {r2yCh >= 0 ? '+' : ''}{r2yCh.toFixed(3)}pp {isLive && `(${p2y!.changeBps >= 0 ? '+' : ''}${p2y!.changeBps.toFixed(1)}bps)`}
              </div>
            </div>
          )}

          {/* 52-Week Range */}
          {p2y?.high52w != null && p2y?.low52w != null && isLive && (
            <div className="h-3.5 flex items-center">
              <div className="text-[8px] text-slate-600 font-mono leading-none">
                H: {p2y.high52w.toFixed(2)}% L: {p2y.low52w.toFixed(2)}%
              </div>
            </div>
          )}
        </div>

        {/* 10Y Block */}
        <div className="bg-[#070d1a] rounded-lg p-2.5 border border-[#1a2540] flex flex-col justify-between">
          {/* Label Row */}
          <div className="flex items-center justify-between h-5">
            <span className="text-[11px] text-slate-400 font-mono leading-none">10-Year</span>
            {isLive && <span className="text-[9px] font-mono text-slate-600 leading-none">DGS10</span>}
          </div>

          {/* Rate Display */}
          <div className="h-7 flex items-center">
            <div className="text-lg font-mono font-semibold text-slate-100 tabular-nums leading-none">
              {r10yVal != null ? r10yVal.toFixed(3) : '—'}%
            </div>
          </div>

          {/* Change & Basis Points */}
          {r10yCh != null && (
            <div className="h-4 flex items-center">
              <div className={`text-[9px] font-mono tabular-nums leading-none ${r10yCh >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                {r10yCh >= 0 ? '+' : ''}{r10yCh.toFixed(3)}pp {isLive && `(${p10y!.changeBps >= 0 ? '+' : ''}${p10y!.changeBps.toFixed(1)}bps)`}
              </div>
            </div>
          )}

          {/* 52-Week Range */}
          {p10y?.high52w != null && p10y?.low52w != null && isLive && (
            <div className="h-3.5 flex items-center">
              <div className="text-[8px] text-slate-600 font-mono leading-none">
                H: {p10y.high52w.toFixed(2)}% L: {p10y.low52w.toFixed(2)}%
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ─── SPREAD METRICS: FIXED HEIGHT, NO VERTICAL DRIFT ────────────────────── */}
      <div className="grid grid-cols-2 gap-2.5 py-1.5 flex-shrink-0 h-[72px]">
        {/* 10Y-2Y Spread */}
        <div className="bg-[#070d1a] rounded-lg p-2 border border-[#1a2540] flex flex-col">
          <div className="flex items-start justify-between flex-1">
            <div className="flex flex-col justify-start">
              <div className="text-[11px] text-slate-400 font-mono leading-none mb-1">10Y–2Y Spread</div>
              <div className="text-base font-mono font-bold tabular-nums leading-none" style={{ color: spreadColor }}>
                {spreadNum != null ? `${spreadNum >= 0 ? '+' : ''}${spreadNum.toFixed(3)}%` : '—'}
              </div>
              {inverted && <div className="text-[10px] text-red-400 font-mono leading-none mt-0.5">CURVE INVERTED</div>}
            </div>
            {spreadChg != null && (
              <div className="text-right flex flex-col items-end">
                <div className="text-[11px] font-mono tabular-nums leading-none" style={{ color: getSpreadChangeColor() }}>
                  {spreadChg >= 0 ? '+' : ''}{spreadChg.toFixed(3)}pp
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 10Y-3M Spread */}
        {fredData?.spread10y3m != null && (
          <div className="bg-[#070d1a] rounded-lg p-2 border border-[#1a2540] flex flex-col">
            <div className="flex items-start justify-between flex-1">
              <div className="flex flex-col justify-start">
                <div className="text-[11px] text-slate-400 font-mono leading-none mb-1">10Y–3M Spread</div>
                <div className="text-base font-mono font-bold tabular-nums leading-none" style={{ color: fredData.spread10y3m >= 0 ? '#34d399' : '#f87171' }}>
                  {fredData.spread10y3m >= 0 ? '+' : ''}{fredData.spread10y3m.toFixed(3)}%
                </div>
                <div className="text-[9px] text-slate-500 font-mono leading-none mt-0.5">Banking margins</div>
              </div>
              {fredData.spread10y3mChange != null && (
                <div className="text-right flex flex-col items-end">
                  <div className="text-[11px] font-mono tabular-nums leading-none" style={{ color: fredData.spread10y3mChange >= 0 ? '#34d399' : '#f87171' }}>
                    {fredData.spread10y3mChange >= 0 ? '+' : ''}{fredData.spread10y3mChange.toFixed(3)}pp
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ─── STEEPENING BADGE ─────────────────────────────────────────────────────── */}
      {fredData?.steepeningType && (
        <div className="bg-amber-500/20 border border-amber-600/40 rounded-lg px-2 py-1.5 text-center flex-shrink-0">
          <div className="text-[11px] font-mono font-bold text-amber-400 leading-tight">
            {fredData.steepeningType === 'BEAR_STEEPENING'
              ? '⬆️ BEAR STEEPENING'
              : '⬇️ BULL STEEPENING'}
          </div>
        </div>
      )}

      {/* ─── FULL CURVE MATRIX: 5 MATURITIES WITH CLEAN SPACING ─────────────────── */}
      <div className="grid grid-cols-5 gap-2 mt-auto flex-shrink-0">
        {curveRows.map(p => {
          const ch = 'change' in p ? (p as typeof curveRows[0]).change : 0
          const hasHigh52w = 'high52w' in p && p.high52w != null
          const hasLow52w = 'low52w' in p && p.low52w != null
          return (
            <div key={p.seriesId} className="bg-[#0a1020] rounded px-1.5 py-1.5 border border-[#1a2540]/50 flex flex-col items-center justify-start min-h-[52px]">
              {/* Maturity Label */}
              <div className="text-[9px] text-slate-500 font-mono leading-tight mb-0.5">
                {p.label}
              </div>

              {/* Rate Value */}
              <div className="text-[10px] font-mono font-semibold text-slate-200 tabular-nums leading-tight">
                {'rate' in p ? (p as typeof curveRows[0]).rate.toFixed(2) : '—'}%
              </div>

              {/* Daily Change */}
              {isLive && (
                <div className={`text-[9px] font-mono tabular-nums leading-tight mt-0.5 ${ch >= 0 ? 'text-red-400/70' : 'text-emerald-400/70'}`}>
                  {ch >= 0 ? '+' : ''}{ch.toFixed(2)}
                </div>
              )}

              {/* 52-Week Range */}
              {isLive && hasHigh52w && hasLow52w && (
                <div className="text-[7px] text-slate-600 font-mono leading-tight mt-0.5">
                  <div>H: {(p as typeof curveRows[0]).high52w!.toFixed(2)}</div>
                  <div>L: {(p as typeof curveRows[0]).low52w!.toFixed(2)}</div>
                </div>
              )}
            </div>
          )
        })}
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
  'DXY':     '🇺🇸',
  'BTC/USD': '₿',
}

function FXTable({
  fx,
  timeframe,
  fredDxy,
  isLoading,
}: {
  fx:        Instrument[]
  timeframe: Timeframe
  fredDxy?:  DXYData | null
  isLoading?: boolean
}) {
  const isLive = fredDxy?.meta.status === 'AUTHENTICATED'
  const broad  = fredDxy?.broad

  return (
    <div
      className="border rounded-2xl p-2.5 flex flex-col h-[270px] transition-colors duration-300"
      style={{
        backgroundColor: '#0c1221',
        borderColor: isLive ? '#34d39928' : '#1a2540',
      }}
    >
      {/* Header with badge */}
      <div className="flex items-center justify-between mb-1.5 px-0.5 flex-shrink-0">
        <span className="text-[12px] font-mono text-slate-500 uppercase tracking-widest">FX Pairs</span>
        <FredLiveBadge isLive={isLive} isLoading={isLoading} />
      </div>

      <div className="divide-y divide-[#1a2540]/60 flex-1 overflow-auto">
        {/* DXY row — FRED live when available */}
        {broad ? (
          <div className="flex items-center py-1.5 gap-1.5 text-[10px]">
            <span className="text-sm w-5">🇺🇸</span>
            <span className="text-slate-300 font-mono w-14 shrink-0">
              DXY
            </span>
            <span className="font-mono text-slate-100 tabular-nums flex-1">
              {broad.value.toFixed(3)}
            </span>
            <span className={cn(
              'font-mono tabular-nums text-right',
              broad.change >= 0 ? 'text-emerald-400' : 'text-red-400'
            )}>
              {broad.change >= 0 ? '+' : ''}{broad.changePct.toFixed(3)}%
            </span>
            <span
              className="text-[10px] font-mono ml-1 px-1 py-0.5 rounded"
              style={{ color: '#34d39980', backgroundColor: '#34d39910' }}
              title={`DTWEXBGS · obs. ${broad.date}`}
            >
              FRED
            </span>
          </div>
        ) : null}

        {/* AFE Dollar Index — secondary row when live */}
        {fredDxy?.afe && isLive && (
          <div className="flex items-center py-1.5 gap-1.5 text-[10px]">
            <span className="text-sm w-5">🇺🇸</span>
            <span className="text-slate-300 font-mono w-14 shrink-0 text-[12px]">
              DXY AFE
            </span>
            <span className="font-mono text-slate-300 tabular-nums flex-1 text-[12px]">
              {fredDxy.afe.value.toFixed(3)}
            </span>
            <span className={cn(
              'font-mono tabular-nums text-right text-[12px]',
              fredDxy.afe.change >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'
            )}>
              {fredDxy.afe.change >= 0 ? '+' : ''}{fredDxy.afe.changePct.toFixed(3)}%
            </span>
            <span
              className="text-[10px] font-mono ml-1 px-1 py-0.5 rounded"
              style={{ color: '#34d39970', backgroundColor: '#34d39910' }}
              title={`DTWEXAFEGS · obs. ${fredDxy.afe.date}`}
            >
              AFE
            </span>
          </div>
        )}

        {/* Regular FX pairs from market API */}
        {fx.map((pair) => {
          const spark = pair.sparklines?.[timeframe] ?? pair.sparkline ?? []
          const periodPct = timeframe === '1D' ? pair.changePercent : calcPeriodReturn(spark)
          return (
            <div key={pair.symbol} className="flex items-center py-1.5 gap-1.5 text-[10px]">
              <span className="text-sm w-5">{FLAG[pair.name] ?? '🌐'}</span>
              <span className="text-slate-300 font-mono w-14 shrink-0">{pair.name}</span>
              <span className="font-mono text-slate-100 tabular-nums flex-1">{fmtPrice(pair.price)}</span>
              <span className={cn('font-mono tabular-nums text-right', changeColor(periodPct))}>
                {fmtPct(periodPct)}
              </span>
            </div>
          )
        })}
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

function CommodityTable({ commodities, timeframe }: { commodities: Instrument[]; timeframe: Timeframe }) {
  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-2.5 flex flex-col h-[270px]">
      <div className="divide-y divide-[#1a2540]/60 flex-1">
        {commodities.map((c) => {
          const spark = c.sparklines?.[timeframe] ?? c.sparkline ?? []
          const periodPct = timeframe === '1D' ? c.changePercent : calcPeriodReturn(spark)
          return (
            <div key={c.symbol} className="flex items-center py-1.5 gap-1.5 text-[10px]">
              <span className="text-sm w-5">{COMM_ICON[c.symbol] ?? '•'}</span>
              <div className="flex-1 min-w-0">
                <div className="text-slate-300 font-mono">{c.name}</div>
                <div className="text-[12px] text-slate-400">{COMM_UNIT[c.symbol]}</div>
              </div>
              <span className="font-mono text-slate-100 tabular-nums shrink-0">{fmtPrice(c.price)}</span>
              <span className={cn('font-mono w-12 text-right tabular-nums shrink-0', changeColor(periodPct))}>
                {fmtPct(periodPct)}
              </span>
            </div>
          )
        })}
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
        <span className="text-[10px] text-slate-300 font-mono uppercase tracking-wider">VIX</span>
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
        <div className="flex justify-between text-[12px] text-slate-400 font-mono">
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
      <div className="text-[10px] text-slate-300 font-mono uppercase tracking-wider mb-1">Put/Call Ratio</div>
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
        <div className="flex justify-between text-[12px] text-slate-400 font-mono">
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
          <div className="text-[10px] text-slate-300 font-mono uppercase tracking-wider mb-1">VVIX</div>
          <div className="font-mono text-3xl font-semibold text-slate-100 tabular-nums leading-none mb-1">
            {vvix.price.toFixed(1)}
          </div>
          <div className={cn('text-xs font-mono mb-2', changeColor(vvix.change))}>
            {fmtChange(vvix.change, 1)} ({fmtPct(vvix.changePercent)})
          </div>
          <div className="text-[10px] text-slate-400 leading-snug">
            Volatility of VIX.
            <br />
            {vvix.price > 100 ? '⚠ Elevated VIX uncertainty' : 'Normal range'}
          </div>
        </div>

        <div>
          <div className="text-[10px] text-slate-300 font-mono uppercase tracking-wider mb-1">CBOE SKEW</div>
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
          <div className="text-[10px] text-slate-400 leading-snug">
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

function buildLiveRatios(data: MarketData, fredData?: FredMarketsData | null): RatioCard[] {
  const ndx    = data.equities.find((e) => e.symbol === '^NDX')?.price    ?? 20842.65
  const spx    = data.equities.find((e) => e.symbol === '^GSPC')?.price   ?? 5847.32
  const gold   = data.commodities.find((c) => c.symbol === 'GC=F')?.price ?? 3215.40
  const silver = data.commodities.find((c) => c.symbol === 'SI=F')?.price ?? 32.84
  const copper = data.commodities.find((c) => c.symbol === 'HG=F')?.price ?? 4.58
  const vix    = data.volatility.vix.price
  const rate10 = data.rates.find((r) => r.symbol === '^TNX')?.price ?? 4.41
  const rate5y = data.rates.find((r) => r.symbol === '^FVX')?.price ?? 4.52

  const cuGold = copper / gold
  const auAg   = gold / silver
  const nSpx   = ndx / spx

  // Use live FRED spread (10Y - 2Y) when available, otherwise fall back to 10Y - 5Y
  const spread = fredData?.yieldCurve?.spread2y10y ?? (rate10 - rate5y)

  // Composite risk score 0–100: VIX contribution (0–50) + inverted-curve contribution (0–50)
  const vixScore   = Math.max(0, Math.min(50, ((vix - 10) / 30) * 50))
  const curveScore = spread < 0 ? Math.min(50, (Math.abs(spread) / 2) * 50) : 0
  const risk       = Math.round(vixScore + curveScore)
  const regimeLbl  = risk < 25 ? 'RISK ON' : risk < 50 ? 'MODERATE' : risk < 75 ? 'ELEVATED' : 'RISK OFF'

  // Curve status: positive spread = normalizing/steepening, negative = inverted
  const curveStatus = spread > 0 ? 'Curve Normalizing/Steepening' : spread < 0 ? 'Curve Inverted' : 'Curve Flat'

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
      status: curveStatus,
      signal: risk > 60 ? 'warning' : risk < 30 ? 'bullish' : 'neutral',
    },
  ]
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [data, setData] = useState<MarketData | null>(null)
  const [squawkData, setSquawkData] = useState<SquawkNewsData | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [usingFallback, setUsingFallback] = useState(false)
  const [equityTF,          setEquityTF]          = usePersistState<Timeframe>('cm.equityTF',          '1D')
  const [fxTF,              setFxTF]              = usePersistState<Timeframe>('cm.fxTF',              '1D')
  const [commTF,            setCommTF]            = usePersistState<Timeframe>('cm.commTF',            '1D')
  const [selectedOIAssets,  setSelectedOIAssets]  = usePersistState<string[]>('cm.selectedOIAssets',  ['SPX', 'NDX'])

  // Live FRED yields + DXY (15-min refresh – FRED daily series)
  // yieldsLive / dxyLive read the per-panel meta so each container can light
  // its own badge independently if one feed is healthy and the other isn't.
  const {
    data:       fredMarkets,
    isLoading:  fredLoading,
    yieldsLive: fredYieldsLive,
    dxyLive:    fredDxyLive,
  } = useFredMarkets()

  // Market Abstraction Layer: FX and Commodities with automatic polling and liveness indicators
  const { data: fxData, isLoading: fxLoading } = useMarketNodes('fx', 30000, fxTF)
  const { data: commodityData, isLoading: commodityLoading } = useMarketNodes('commodity', 30000, commTF)

  const load = useCallback(async () => {
    try {
      const [marketRes, squawkRes] = await Promise.all([
        fetch('/api/market', { cache: 'no-store' }),
        fetch('/api/institutional-squawk', { cache: 'no-store' }),
      ])

      if (!marketRes.ok) throw new Error('market fetch failed')
      const marketJson: MarketData = await marketRes.json()
      setData(marketJson)

      // Parse squawk response defensively: if the route errors or JSON is
      // malformed, keep squawkData as null so the component uses SQUAWK_NEWS_MOCK.
      if (squawkRes.ok) {
        try {
          const squawkJson: SquawkNewsData = await squawkRes.json()
          // Validate that the critical arrays are present before committing
          if (
            Array.isArray(squawkJson?.articles) &&
            Array.isArray(squawkJson?.topMovers) &&
            squawkJson.articles.length > 0 &&
            squawkJson.topMovers.length > 0
          ) {
            setSquawkData(squawkJson)
          } else {
            console.warn('[squawk] Response missing articles/topMovers arrays — keeping mock')
          }
        } catch (jsonErr) {
          console.warn('[squawk] JSON parse failed, keeping mock:', jsonErr)
        }
      } else {
        console.warn('[squawk] Non-OK response:', squawkRes.status, '— keeping mock')
      }

      setLastUpdate(new Date())
      setUsingFallback(!marketJson.isMarketOpen && marketJson.equities[0]?.price === 5847.32)
    } catch {
      setUsingFallback(true)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 60_000)
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
        <div className="max-w-[1920px] mx-auto px-8 py-3 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div
              className={cn('w-2 h-2 rounded-full shrink-0', data?.isMarketOpen ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600')}
              style={data?.isMarketOpen ? { boxShadow: '0 0 8px #34d399' } : undefined}
            />
            <h1
              className="font-mono text-base font-bold tracking-[0.18em] uppercase"
              style={{ fontFamily: 'var(--font-geist-mono)' }}
            >
              <span className="text-slate-100">CROSSED</span>
              <span className="text-amber-400 ml-2">MATRIX</span>
            </h1>
            {data && (
              <span
                className={cn(
                  'hidden sm:inline text-[10px] font-mono px-2 py-0.5 rounded-md border tracking-widest uppercase',
                  data.isMarketOpen
                    ? 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10'
                    : 'text-slate-300 border-slate-700 bg-slate-800/40'
                )}
              >
                {data.isMarketOpen ? 'NYSE Open' : 'Market Closed'}
              </span>
            )}
          </div>

          <div className="flex items-center gap-4">
            {lastUpdate && (
              <span className="hidden md:block text-[10px] text-slate-400 font-mono">
                Refreshed {lastUpdate.toLocaleTimeString()}
              </span>
            )}
            {usingFallback && (
              <span className="text-[10px] text-amber-500/70 font-mono hidden md:block">demo data</span>
            )}
            <LiveClock />
            <button
              onClick={load}
              className="text-[11px] font-mono text-slate-300 hover:text-slate-400 border border-[#1a2540] hover:border-slate-600 px-2 py-1 rounded-md transition-colors"
            >
              ↻
            </button>
          </div>
        </div>

        <TickerTape data={data} />
      </header>

      {/* ── Main ── */}
      <main className="max-w-[1920px] mx-auto px-8 py-4 space-y-3">
        {!data ? (
          <DashboardSkeleton />
        ) : (
          <>
            {/* Volatility · Options · Expirations — MOVED TO TOP */}
            <section>
              <div className="text-[10px] font-mono text-slate-300 uppercase tracking-widest mb-2">
                Volatility &amp; Options Flow
              </div>
              <div className="space-y-3">
                {/* Index Skew Heads — positioned above Macro Risk Matrix */}
                <IndexSkewHeads skewData={INDEX_SKEW_MOCK} />
                {/* Institutional-Grade Macro Risk Matrix */}
                <MacroRiskMatrix metrics={data.volatility.macroRisk ?? MACRO_RISK_MOCK} />

                {/* Index Futures · Continuous Front Month — moved into Volatility section */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] font-mono text-slate-300 uppercase tracking-widest">
                      {data.futures?.length ? 'Index Futures · Continuous Front Month' : 'Equity Indices'}
                    </div>
                    <TimeframeBar value={equityTF} onChange={setEquityTF} />
                  </div>
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
                    {(data.futures?.length ? data.futures : null)?.map((f) => (
                      <FuturesCard key={f.symbol} inst={f} timeframe={equityTF} />
                    )) ?? data.equities.map((e) => (
                      <EquityCard key={e.symbol} inst={e} />
                    ))}
                  </div>
                </div>

                {/* OI Walls — with 3-column layout and asset selection */}
                <OIWallsGrid selectedAssets={selectedOIAssets} onAssetsChange={setSelectedOIAssets} />
              </div>
            </section>

            {/* Cross-Asset Ratios & Macro Dynamics */}
            <section>
              <RatiosPanel ratios={buildLiveRatios(data, fredMarkets)} />
            </section>

            {/* FX Markets · Yield Curve · Commodities */}
            <section>
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 items-stretch">
                {/* FX Markets - New Abstraction Layer */}
                <div className="flex flex-col">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] font-mono text-slate-300 uppercase tracking-widest">FX Markets</div>
                    <TimeframeBar value={fxTF} onChange={setFxTF} />
                  </div>
                  <div className="flex-1 bg-[#0c1221] border border-[#1a2540] rounded-2xl p-2.5 overflow-auto">
                    {fxLoading && !fxData ? (
                      <div className="space-y-2">
                        {[0, 1, 2, 3, 4, 5].map((i) => (
                          <Pulse key={i} className="h-12 w-full" />
                        ))}
                      </div>
                    ) : fxData ? (
                      <div className="space-y-2">
                        {Object.values(fxData.nodes).map((node) => (
                          <MarketNodeRow key={node.id} node={node} compact={true} />
                        ))}
                        {/* Health Summary */}
                        <div className="text-[10px] text-slate-400 pt-2 border-t border-slate-800 mt-2">
                          <div>Live: {fxData.health.liveCount}/{fxData.health.totalNodes}</div>
                          <div>Health: {fxData.health.healthPercent.toFixed(1)}%</div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-slate-400 text-[11px] font-mono p-4 text-center">No data available</div>
                    )}
                  </div>
                </div>

                {/* Yield Curve */}
                <div className="flex flex-col">
                  <div className="text-[10px] font-mono text-slate-300 uppercase tracking-widest mb-2">Yield Curve</div>
                  <div className="flex-1">
                    <YieldCurveSection
                      rates={data.rates}
                      fredData={fredMarkets?.yieldCurve}
                      isLoading={fredLoading}
                    />
                  </div>
                </div>

                {/* Commodities - New Abstraction Layer */}
                <div className="flex flex-col">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[10px] font-mono text-slate-300 uppercase tracking-widest">Commodities</div>
                    <TimeframeBar value={commTF} onChange={setCommTF} />
                  </div>
                  <div className="flex-1 bg-[#0c1221] border border-[#1a2540] rounded-2xl p-2.5 overflow-auto">
                    {commodityLoading && !commodityData ? (
                      <div className="space-y-2">
                        {[0, 1, 2, 3, 4, 5].map((i) => (
                          <Pulse key={i} className="h-12 w-full" />
                        ))}
                      </div>
                    ) : commodityData ? (
                      <div className="space-y-2">
                        {Object.values(commodityData.nodes).map((node) => (
                          <MarketNodeRow key={node.id} node={node} compact={true} />
                        ))}
                        {/* Health Summary */}
                        <div className="text-[10px] text-slate-400 pt-2 border-t border-slate-800 mt-2">
                          <div>Live: {commodityData.health.liveCount}/{commodityData.health.totalNodes}</div>
                          <div>Health: {commodityData.health.healthPercent.toFixed(1)}%</div>
                        </div>
                      </div>
                    ) : (
                      <div className="text-slate-400 text-[11px] font-mono p-4 text-center">No data available</div>
                    )}
                  </div>
                </div>
              </div>
            </section>

            {/* Institutional Flows & Positioning */}
            <section>
              <div className="text-[10px] font-mono text-slate-300 uppercase tracking-widest mb-2">
                Institutional Flows &amp; Positioning
              </div>
              <InstitutionalFlowsSection />
            </section>

            {/* Institutional Squawk & Macro Intelligence */}
            <section>
              <div className="text-[10px] font-mono text-slate-300 uppercase tracking-widest mb-2">
                Institutional Squawk &amp; Macro Intelligence Feed
              </div>
              <InstitutionalSquawkNewsStream data={squawkData || SQUAWK_NEWS_MOCK} />
            </section>
          </>
        )}

        <p className="text-center text-[10px] text-slate-400 font-mono pb-4">
          CROSSED MATRIX · For informational purposes only · Not financial advice · Data sourced from public market feeds
        </p>
      </main>
    </div>
  )
}
