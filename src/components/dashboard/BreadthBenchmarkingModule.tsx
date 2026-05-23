'use client'

import { useState, useMemo, useId } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IndexData {
  symbol: string
  name: string
  price: number
  change: number
  changePercent: number
  fiftyTwoWeekHigh: number
  fiftyTwoWeekLow: number
  components: number
}

export interface EquityBenchmark {
  ticker: string
  name: string
  price: number
  change: number
  changePercent: number
  beta: number // vs SPY
  alphaVsRsp: number // 15-day trend: Ticker/RSP ratio
  concentrationZScore: number // Deviation from 90-day avg weight
  avgWeight90d: number // Historical average index weight
  currentWeight: number // Current index weight
}

export interface BreadthBenchmarkData {
  spy: IndexData
  rsp: IndexData
  concentrationRatio: number
  concentrationRatioChange: number
  relativeTimingScore: number // 0.00-2.00 VectorVest scale
  ratioTrendline: number[] // 15-day sparkline
  equities: EquityBenchmark[]
  timestamp: number
}

// ─── Utility Functions ─────────────────────────────────────────────────────────

function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(' ')
}

/**
 * Calculate Beta: correlation of ticker volatility to SPY volatility
 * Simplified: uses price change correlation over recent period
 */
function calculateBeta(tickerChangePercent: number, spyChangePercent: number): number {
  if (spyChangePercent === 0) return 1.0
  return tickerChangePercent / spyChangePercent
}

/**
 * Calculate Alpha vs RSP: 15-day trend of Ticker/RSP ratio
 * Shows if ticker is outperforming equal-weight breadth
 */
function calculateAlphaVsRsp(tickerPrice: number, rspPrice: number, previousRatio: number): number {
  const currentRatio = tickerPrice / (rspPrice || 1)
  return ((currentRatio - previousRatio) / previousRatio) * 100
}

/**
 * Calculate Concentration Z-Score
 * Measures deviation from 90-day average weight in an index
 * Formula: (Current Weight - 90d Avg) / StdDev
 */
function calculateConcentrationZScore(currentWeight: number, avgWeight: number, stdDev = 0.15): number {
  return (currentWeight - avgWeight) / stdDev
}

/**
 * Calculate VectorVest Relative Timing Score (0.00-2.00 scale)
 * Based on trend of SPY/RSP ratio over past 15 days
 * > 1.00 = Concentration rising (uptrend)
 * < 1.00 = Breadth expanding (downtrend)
 * = 1.00 = Balanced/Neutral
 */
function calculateRelativeTimingScore(trendline: number[]): number {
  if (trendline.length < 2) return 1.0

  const firstHalf = trendline.slice(0, Math.floor(trendline.length / 2))
  const secondHalf = trendline.slice(Math.floor(trendline.length / 2))

  const avgFirst = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
  const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length

  const trend = (avgSecond - avgFirst) / avgFirst
  // Clamp to 0.00-2.00 scale
  const score = 1.0 + Math.max(-0.5, Math.min(0.5, trend))
  return Math.round(score * 100) / 100
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

export const BREADTH_BENCHMARK_MOCK: BreadthBenchmarkData = {
  spy: {
    symbol: 'SPY',
    name: 'S&P 500 ETF (Cap-Weighted)',
    price: 587.42,
    change: +2.18,
    changePercent: +0.37,
    fiftyTwoWeekHigh: 625.80,
    fiftyTwoWeekLow: 478.30,
    components: 500,
  },
  rsp: {
    symbol: 'RSP',
    name: 'Invesco S&P 500 Equal Weight ETF',
    price: 158.65,
    change: +0.92,
    changePercent: +0.58,
    fiftyTwoWeekHigh: 175.20,
    fiftyTwoWeekLow: 128.40,
    components: 500,
  },
  concentrationRatio: 3.704, // SPY / RSP = 587.42 / 158.65
  concentrationRatioChange: +0.084,
  relativeTimingScore: 1.18, // > 1.00 = concentration rising
  ratioTrendline: [3.52, 3.54, 3.58, 3.61, 3.64, 3.67, 3.68, 3.69, 3.70, 3.71, 3.70, 3.71, 3.72, 3.71, 3.704],
  equities: [
    {
      ticker: 'NVDA',
      name: 'NVIDIA',
      price: 134.82,
      change: +3.24,
      changePercent: +2.46,
      beta: 2.14, // 2.46% / 0.37% ≈ 6.6x, but mocked as 2.14 realistic
      alphaVsRsp: +18.4, // Outperforming RSP
      concentrationZScore: 2.84, // Significantly above average weight
      avgWeight90d: 8.2,
      currentWeight: 9.8,
    },
    {
      ticker: 'MSFT',
      name: 'Microsoft',
      price: 445.23,
      change: +1.82,
      changePercent: +0.41,
      beta: 1.12,
      alphaVsRsp: +6.2,
      concentrationZScore: 2.41,
      avgWeight90d: 7.1,
      currentWeight: 8.4,
    },
    {
      ticker: 'AMZN',
      name: 'Amazon',
      price: 198.45,
      change: +1.34,
      changePercent: +0.68,
      beta: 1.86,
      alphaVsRsp: +12.8,
      concentrationZScore: 1.92,
      avgWeight90d: 6.5,
      currentWeight: 7.9,
    },
    {
      ticker: 'GOOGL',
      name: 'Alphabet',
      price: 195.67,
      change: +0.87,
      changePercent: +0.45,
      beta: 1.21,
      alphaVsRsp: +3.4,
      concentrationZScore: 1.65,
      avgWeight90d: 6.2,
      currentWeight: 7.3,
    },
    {
      ticker: 'META',
      name: 'Meta Platforms',
      price: 542.18,
      change: +2.14,
      changePercent: +0.40,
      beta: 1.58,
      alphaVsRsp: +8.6,
      concentrationZScore: 1.28,
      avgWeight90d: 5.8,
      currentWeight: 6.9,
    },
    {
      ticker: 'TSLA',
      name: 'Tesla',
      price: 289.56,
      change: -1.24,
      changePercent: -0.43,
      beta: 1.94,
      alphaVsRsp: -6.8,
      concentrationZScore: 1.14,
      avgWeight90d: 4.9,
      currentWeight: 5.2,
    },
  ],
  timestamp: Date.now(),
}

// ─── Mini Sparkline ───────────────────────────────────────────────────────────

function MiniTrendline({
  data,
  color,
  w = 72,
  h = 28,
}: {
  data: number[]
  color: string
  w?: number
  h?: number
}) {
  const uid = useId()
  const gid = `bt${uid.replace(/:/g, '')}`

  if (data.length < 2) return <div style={{ width: w, height: h }} className="rounded bg-slate-800/40" />

  const min = Math.min(...data)
  const max = Math.max(...data)
  const rng = max - min || 0.01
  const pad = 2

  const pts = data.map((v, i) => ({
    x: (i / (data.length - 1)) * w,
    y: h - pad - ((v - min) / rng) * (h - pad * 2),
  }))

  const line = pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
  const area = `M0,${h} ${pts.map((p) => `L${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')} L${w},${h} Z`

  return (
    <svg width="100%" height={h} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="overflow-visible">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.20" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={pts[pts.length - 1].x} cy={pts[pts.length - 1].y} r="2.5" fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// ─── Macro Index Cards ────────────────────────────────────────────────────────

function IndexCard({ index }: { index: IndexData }) {
  const isPositive = index.change >= 0
  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-xl p-3 space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono font-semibold text-slate-200">{index.symbol}</span>
        <span className="text-[12px] font-mono text-slate-400">{index.components} components</span>
      </div>
      <div>
        <div className="text-2xl font-mono font-bold text-slate-100">{index.price.toFixed(2)}</div>
        <div className="font-mono text-[11px] mt-1" style={{ color: isPositive ? '#34d399' : '#f87171' }}>
          {isPositive ? '+' : ''}{index.change.toFixed(2)} ({index.changePercent.toFixed(2)}%)
        </div>
      </div>
      <div className="text-[12px] text-slate-400 font-mono space-y-0.5 border-t border-[#1a2540] pt-2">
        <div className="flex justify-between">
          <span>52W High:</span>
          <span className="text-slate-200">{index.fiftyTwoWeekHigh.toFixed(2)}</span>
        </div>
        <div className="flex justify-between">
          <span>52W Low:</span>
          <span className="text-slate-200">{index.fiftyTwoWeekLow.toFixed(2)}</span>
        </div>
      </div>
    </div>
  )
}

// ─── Timing Badge ─────────────────────────────────────────────────────────────

function TimingBadge({ score }: { score: number }) {
  const isConcentrating = score > 1.0
  const severity = Math.abs(score - 1.0)
  const color = isConcentrating ? '#ef4444' : '#34d399'
  const bgColor = isConcentrating ? 'bg-red-400/10' : 'bg-emerald-400/10'
  const borderColor = isConcentrating ? 'border-red-400/30' : 'border-emerald-400/30'

  const label = isConcentrating
    ? 'HIGH CONCENTRATION REGIME / THIN BREADTH'
    : 'EXPANDING BREADTH / CYCLICAL ROTATION'

  const detail = isConcentrating
    ? `Concentration +${((score - 1) * 100).toFixed(1)}% — Monitor rotation risk`
    : `Breadth +${((1 - score) * 100).toFixed(1)}% — Healthy participation`

  return (
    <div className={cn('border rounded-lg p-3', bgColor, borderColor)}>
      <div className="text-[10px] font-mono font-bold uppercase tracking-widest" style={{ color }}>
        {label}
      </div>
      <div className="text-[12px] font-mono mt-1" style={{ color }}>
        {detail}
      </div>
      <div className="text-[12px] font-mono text-slate-400 mt-1">
        Relative Timing Score: {score.toFixed(2)} / 2.00
      </div>
    </div>
  )
}

// ─── Equity Benchmarking Matrix ────────────────────────────────────────────────

function EquityBenchmarkMatrix({ equities, rspPrice }: { equities: EquityBenchmark[]; rspPrice: number }) {
  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-xl overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-[10px] font-mono">
          {/* Header */}
          <thead>
            <tr className="border-b border-[#1a2540] bg-[#080d18]">
              <th className="text-left px-3 py-2 text-slate-400 font-semibold uppercase tracking-wider">Ticker</th>
              <th className="text-right px-3 py-2 text-slate-400 font-semibold uppercase tracking-wider">Price</th>
              <th className="text-right px-3 py-2 text-slate-400 font-semibold uppercase tracking-wider">Change</th>
              <th className="text-right px-3 py-2 text-slate-400 font-semibold uppercase tracking-wider">Beta</th>
              <th className="text-right px-3 py-2 text-slate-400 font-semibold uppercase tracking-wider">Alpha vs RSP</th>
              <th className="text-right px-3 py-2 text-slate-400 font-semibold uppercase tracking-wider">Z-Score</th>
              <th className="text-center px-3 py-2 text-slate-400 font-semibold uppercase tracking-wider">Weight</th>
            </tr>
          </thead>

          {/* Body */}
          <tbody className="divide-y divide-[#1a2540]">
            {equities.map((eq) => {
              const isPositive = eq.change >= 0
              const alphaColor = eq.alphaVsRsp > 0 ? '#34d399' : '#f87171'
              const zColor = eq.concentrationZScore > 1.5 ? '#f87171' : eq.concentrationZScore > 0.5 ? '#fbbf24' : '#94a3b8'

              return (
                <tr key={eq.ticker} className="border-[#1a2540]/40 hover:bg-[#1a2540]/30 transition-colors">
                  <td className="px-3 py-2">
                    <div className="font-semibold text-slate-200">{eq.ticker}</div>
                    <div className="text-[12px] text-slate-400">{eq.name}</div>
                  </td>
                  <td className="text-right px-3 py-2 text-slate-200">${eq.price.toFixed(2)}</td>
                  <td className={cn('text-right px-3 py-2', isPositive ? 'text-emerald-400' : 'text-red-400')}>
                    {isPositive ? '+' : ''}{eq.changePercent.toFixed(2)}%
                  </td>
                  <td className="text-right px-3 py-2 text-slate-300">{eq.beta.toFixed(2)}×</td>
                  <td className="text-right px-3 py-2" style={{ color: alphaColor }}>
                    {eq.alphaVsRsp > 0 ? '+' : ''}{eq.alphaVsRsp.toFixed(1)}%
                  </td>
                  <td className="text-right px-3 py-2" style={{ color: zColor }}>
                    {eq.concentrationZScore.toFixed(2)}σ
                  </td>
                  <td className="text-center px-3 py-2 text-slate-300">
                    <div className="font-semibold">{eq.currentWeight.toFixed(1)}%</div>
                    <div className="text-[11px] text-slate-500">avg {eq.avgWeight90d.toFixed(1)}%</div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export interface BreadthBenchmarkingProps {
  data?: BreadthBenchmarkData
}

export function BreadthBenchmarkingModule({ data = BREADTH_BENCHMARK_MOCK }: BreadthBenchmarkingProps) {
  const concentrationColor = data.relativeTimingScore > 1.0 ? '#ef4444' : '#34d399'

  return (
    <section className="space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
          Systematic Breadth &amp; Corporate Equity Benchmarking
        </h2>
        <span className="text-[12px] font-mono text-slate-400">
          Concentration Ratio: {data.concentrationRatio.toFixed(3)}× {data.concentrationRatioChange > 0 ? '+' : ''}{data.concentrationRatioChange.toFixed(3)}
        </span>
      </div>

      {/* Macro Index Tracking */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <IndexCard index={data.spy} />
        <IndexCard index={data.rsp} />
        <div className="bg-[#0c1221] border border-[#1a2540] rounded-xl p-3 space-y-2">
          <span className="text-[11px] font-mono font-semibold text-slate-200 block">Concentration Ratio</span>
          <div className="text-4xl font-mono font-bold" style={{ color: concentrationColor }}>
            {data.concentrationRatio.toFixed(2)}<span className="text-2xl">×</span>
          </div>
          <div className="text-[12px] font-mono mt-2">
            <div className="text-[12px] font-mono text-slate-400 mb-1">15-Day Trend</div>
            <MiniTrendline data={data.ratioTrendline} color={concentrationColor} w={160} h={32} />
          </div>
        </div>
      </div>

      {/* Timing Badge */}
      <TimingBadge score={data.relativeTimingScore} />

      {/* Equity Benchmarking Matrix */}
      <EquityBenchmarkMatrix equities={data.equities} rspPrice={data.rsp.price} />

      {/* Footer Notes */}
      <div className="text-[12px] font-mono text-slate-500 space-y-1 border-t border-[#1a2540] pt-3">
        <div>
          <strong>Beta vs. SPY:</strong> Measures volatility correlation. Beta &gt; 1.0 = more volatile than market, &lt; 1.0 = less volatile.
        </div>
        <div>
          <strong>Alpha vs. RSP:</strong> 15-day outperformance trend. Positive = beating equal-weight breadth, negative = underperforming.
        </div>
        <div>
          <strong>Concentration Z-Score:</strong> Standard deviations from 90-day average weight. &gt; 1.5σ = elevated concentration risk.
        </div>
        <div>
          <strong>Relative Timing (VectorVest):</strong> 0.00-2.00 scale. &gt; 1.00 = concentration regime, &lt; 1.00 = breadth expansion.
        </div>
      </div>
    </section>
  )
}
