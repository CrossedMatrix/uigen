'use client'

import { useState, useEffect } from 'react'

// ─── Types ────────────────────────────────────────────────────────────────────

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
    previousClose: number // for divergence detection
  }
  move: {
    price: number
    change: number
    changePercent: number
    historicalMean: number // for stress badge calculation
  }
  gamma: {
    price: number // gamma level 0-1 (normalized)
    change: number
    changePercent: number
    regime: 'low' | 'medium' | 'high' // gamma regime
  }
  skew: {
    price: number
    change: number
    changePercent: number
  }
  putCallRatio: number
  timestamp: number
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

export const MACRO_RISK_MOCK: MacroRiskMetrics = {
  vix: {
    price: 17.82,
    change: -0.84,
    changePercent: -4.50,
  },
  vvix: {
    price: 92.4,
    change: -2.1,
    changePercent: -2.22,
    previousClose: 94.5, // for divergence detection
  },
  move: {
    price: 129.3,
    change: 1.2,
    changePercent: 0.94,
    historicalMean: 115, // 20-day average
  },
  gamma: {
    price: 0.62, // normalized 0-1, where 1 = extremely high gamma
    change: 0.08,
    changePercent: 14.81,
    regime: 'medium', // 'low' | 'medium' | 'high'
  },
  skew: {
    price: 131.2,
    change: 1.4,
    changePercent: 1.08,
  },
  putCallRatio: 0.72,
  timestamp: Date.now(),
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

/**
 * Calculate a risk score from 0-100 using linear interpolation between boundaries.
 * Clamps result between 0-100 and rounds to nearest integer.
 *
 * @param value - Current reading
 * @param minVal - Value that maps to 100 (best/safest)
 * @param maxVal - Value that maps to 0 (worst/most risky)
 * @param invert - If true, reverses the scale (useful if higher value is better)
 * @returns Integer score 0-100
 *
 * Example: VIX of 17.82 with boundaries 12→100 and 35→0
 * score = ((35 - 17.82) / (35 - 12)) * 100 = 74.65 ≈ 75
 */
function calculateRiskScore(value: number, minVal: number, maxVal: number, invert = false): number {
  // Clamp to prevent division issues
  const clampedValue = Math.max(Math.min(value, maxVal), minVal)

  // Linear interpolation: maps minVal→100, maxVal→0
  const rawScore = ((maxVal - clampedValue) / (maxVal - minVal)) * 100

  // Apply invert if needed (for cases where higher value is better)
  const score = invert ? 100 - rawScore : rawScore

  // Clamp final result to 0-100 and round to nearest integer
  return Math.round(Math.max(0, Math.min(100, score)))
}

// ─── Tooltip Component ────────────────────────────────────────────────────────

interface TooltipProps {
  label: string
  explanation: string
}

function Tooltip({ label, explanation }: TooltipProps) {
  const [isVisible, setIsVisible] = useState(false)

  return (
    <div className="relative inline-flex items-center gap-1">
      <span className="text-[10px] text-slate-500 font-mono uppercase tracking-wider">{label}</span>
      <div
        className="relative group"
        onMouseEnter={() => setIsVisible(true)}
        onMouseLeave={() => setIsVisible(false)}
      >
        <div className="w-4 h-4 rounded-full bg-slate-700 border border-slate-600 flex items-center justify-center cursor-help hover:bg-slate-600 transition-colors">
          <span className="text-[10px] font-mono text-slate-400 leading-none">?</span>
        </div>
        {isVisible && (
          <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 w-48 bg-[#070b14] border border-slate-600 rounded-lg p-2.5 text-[12px] text-slate-300 font-mono z-50 shadow-lg">
            {explanation}
            <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-slate-600" />
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Stress Badge Component ────────────────────────────────────────────────────

interface StressBadgeProps {
  vixPrice: number
  movePrice: number
  moveMean: number
}

function StressBadge({ vixPrice, movePrice, moveMean }: StressBadgeProps) {
  // Calculate MOVE/VIX ratio and compare to historical norm (~6.5)
  const ratio = movePrice / vixPrice
  const historicalNorm = 6.5
  const ratioDeviation = ((ratio - historicalNorm) / historicalNorm) * 100

  const isStressed = ratio > historicalNorm * 1.1 // >10% above norm
  const stressLevel =
    ratio > historicalNorm * 1.3 ? 'critical' : ratio > historicalNorm * 1.15 ? 'elevated' : 'normal'

  const stressBgColor =
    stressLevel === 'critical'
      ? 'bg-red-500/20 border-red-500/40'
      : stressLevel === 'elevated'
        ? 'bg-amber-500/20 border-amber-500/40'
        : 'bg-slate-700/40 border-slate-600/40'

  const stressTextColor =
    stressLevel === 'critical'
      ? 'text-red-400'
      : stressLevel === 'elevated'
        ? 'text-amber-400'
        : 'text-slate-400'

  return (
    <div className={cn('px-2.5 py-1.5 rounded border flex items-center gap-2', stressBgColor)}>
      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: stressLevel === 'critical' ? '#f87171' : stressLevel === 'elevated' ? '#fbbf24' : '#94a3b8' }} />
      <span className={cn('text-[12px] font-mono font-semibold uppercase tracking-wider', stressTextColor)}>
        {stressLevel === 'critical' ? 'BOND STRESS' : stressLevel === 'elevated' ? 'STRESS WARNING' : 'Stable'}
      </span>
      <span className={cn('text-[11px] font-mono', stressTextColor)}>
        {ratio.toFixed(2)}x
      </span>
    </div>
  )
}

// ─── Tail Risk Alert ────────────────────────────────────────────────────────

interface TailRiskAlertProps {
  vvixPrice: number
  vvixChange: number
  vixPrice: number
  vixChange: number
}

function TailRiskAlert({ vvixPrice, vvixChange, vixPrice, vixChange }: TailRiskAlertProps) {
  // Detect divergence: VVIX +5% while VIX flat/down
  const vvixPctChange = ((vvixChange / (vvixPrice - vvixChange)) * 100)
  const vixPctChange = vixChange / (vixPrice - vixChange) * 100

  const hasDivergence = vvixPctChange > 5 && vixPctChange <= 0
  const divergenceSeverity = hasDivergence ? 'alert' : 'clear'

  const alertBgColor = hasDivergence ? 'bg-orange-500/20 border-orange-500/40' : 'bg-slate-700/40 border-slate-600/40'
  const alertTextColor = hasDivergence ? 'text-orange-400' : 'text-slate-400'

  return (
    <div className={cn('px-2.5 py-1.5 rounded border flex items-center gap-2', alertBgColor)}>
      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: hasDivergence ? '#fb923c' : '#94a3b8' }} />
      <span className={cn('text-[12px] font-mono font-semibold uppercase tracking-wider', alertTextColor)}>
        {hasDivergence ? 'TAIL HEDGING' : 'No Divergence'}
      </span>
      {hasDivergence && (
        <span className={cn('text-[11px] font-mono', alertTextColor)}>
          {vvixPctChange.toFixed(1)}%↑
        </span>
      )}
    </div>
  )
}

// ─── HY OAS Card ────────────────────────────────────────────────────────────

interface GammaCardProps {
  gamma: {
    price: number
    change: number
    changePercent: number
    regime: 'low' | 'medium' | 'high'
  }
}

function GammaCard({ gamma }: GammaCardProps) {
  const normalized = Math.min(gamma.price, 1)
  const gammaColor =
    gamma.regime === 'high' ? 'text-red-400' : gamma.regime === 'medium' ? 'text-amber-400' : 'text-emerald-400'
  const gammaBg =
    gamma.regime === 'high'
      ? 'bg-red-500/10'
      : gamma.regime === 'medium'
        ? 'bg-amber-500/10'
        : 'bg-emerald-500/10'

  return (
    <div>
      <Tooltip
        label="Gamma"
        explanation="Measures price sensitivity of options. High gamma = sharp moves expected. Low gamma = stable conditions. Indicates convexity risk in options market."
      />
      <div className="font-mono text-3xl font-semibold text-slate-100 tabular-nums leading-none mb-2 mt-2">
        {(gamma.price * 100).toFixed(0)}
        <span className="text-xl text-slate-300 ml-1">%</span>
      </div>
      <div className={cn('text-xs font-mono mb-2', changeColor(gamma.change))}>
        {fmtChange(gamma.change, 3)} ({fmtPct(gamma.changePercent)})
      </div>

      {/* Gamma regime indicator */}
      <div className={cn('w-full h-1.5 rounded-full bg-slate-800/60 overflow-hidden mb-2')}>
        <div
          className={cn('h-full rounded-full transition-all duration-500', gammaColor)}
          style={{ width: `${normalized * 100}%` }}
        />
      </div>

      <div className={cn('px-2 py-1.5 rounded border text-center mb-2', gammaBg)}>
        <div className={cn('text-[12px] font-mono font-semibold uppercase tracking-wider', gammaColor)}>
          {gamma.regime === 'high' ? 'HIGH GAMMA' : gamma.regime === 'medium' ? 'MEDIUM GAMMA' : 'LOW GAMMA'}
        </div>
      </div>

      <div className="text-[10px] text-slate-400 leading-snug">
        {gamma.regime === 'high' ? (
          <>
            ⚠ Elevated convexity<br />
            Expect sharp moves
          </>
        ) : gamma.regime === 'medium' ? (
          <>
            Moderate sensitivity<br />
            Balanced conditions
          </>
        ) : (
          <>
            Low convexity risk<br />
            Stable environment
          </>
        )}
      </div>
    </div>
  )
}

// ─── VIX Gauge (improved from original) ────────────────────────────────────

interface VixGaugeProps {
  vix: {
    price: number
    change: number
    changePercent: number
  }
}

function VixGauge({ vix }: VixGaugeProps) {
  const normalized = Math.min(vix.price / 40, 1)
  return (
    <div>
      <Tooltip
        label="VIX"
        explanation="Equity market volatility index. Tracks S&P 500 implied volatility. Low VIX = calm markets. High VIX = fear/stress. Range: 10-40."
      />
      <div className="font-mono text-3xl font-semibold text-slate-100 tabular-nums leading-none mb-2">
        {vix.price.toFixed(2)}
      </div>
      <div className={cn('text-xs font-mono mb-2', changeColor(vix.change))}>
        {fmtChange(vix.change, 2)} ({fmtPct(vix.changePercent)})
      </div>
      <div className="w-full h-1.5 rounded-full bg-slate-800/60 overflow-hidden mb-2">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            vix.price < 15
              ? 'bg-emerald-400'
              : vix.price < 20
                ? 'bg-slate-400'
                : vix.price < 30
                  ? 'bg-amber-400'
                  : 'bg-red-500'
          )}
          style={{ width: `${normalized * 100}%` }}
        />
      </div>
      <div className="text-[10px] text-slate-400 leading-snug">
        {vix.price < 12
          ? 'Complacency'
          : vix.price < 20
            ? 'Normal volatility'
            : vix.price < 30
              ? 'Elevated risk'
              : 'Market stress'}
      </div>
    </div>
  )
}

// ─── MOVE Index Card ────────────────────────────────────────────────────────

interface MoveCardProps {
  move: {
    price: number
    change: number
    changePercent: number
    historicalMean: number
  }
}

function MoveCard({ move }: MoveCardProps) {
  const normalized = Math.min(move.price / 200, 1)
  const isAboveMean = move.price > move.historicalMean
  const abovePercent = ((move.price - move.historicalMean) / move.historicalMean) * 100

  return (
    <div>
      <Tooltip
        label="MOVE Index"
        explanation="Fixed-income volatility index. Tracks bond market stress & yield curve repricing. Rising MOVE = bond selling. Complements VIX."
      />
      <div className="font-mono text-3xl font-semibold text-slate-100 tabular-nums leading-none mb-2">
        {move.price.toFixed(1)}
      </div>
      <div className={cn('text-xs font-mono mb-2', changeColor(move.change))}>
        {fmtChange(move.change, 1)} ({fmtPct(move.changePercent)})
      </div>
      <div className="w-full h-1.5 rounded-full bg-slate-800/60 overflow-hidden mb-2">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            move.price < 110
              ? 'bg-emerald-400'
              : move.price < 130
                ? 'bg-slate-400'
                : move.price < 150
                  ? 'bg-amber-400'
                  : 'bg-red-500'
          )}
          style={{ width: `${normalized * 100}%` }}
        />
      </div>
      <div className="text-[10px] text-slate-400 leading-snug">
        Bond volatility index.
        <br />
        {isAboveMean ? `${abovePercent.toFixed(1)}% above mean` : `Below mean (${(-abovePercent).toFixed(1)}%)`}
      </div>
    </div>
  )
}

// ─── VVIX Card ────────────────────────────────────────────────────────────

interface VvixCardProps {
  vvix: {
    price: number
    change: number
    changePercent: number
  }
}

function VvixCard({ vvix }: VvixCardProps) {
  return (
    <div>
      <Tooltip
        label="VVIX"
        explanation="Volatility of VIX. Measures VIX stability. VVIX spike while VIX flat = tail hedges deploying (leading indicator). Range: 50-150."
      />
      <div className="font-mono text-3xl font-semibold text-slate-100 tabular-nums leading-none mb-2">
        {vvix.price.toFixed(1)}
      </div>
      <div className={cn('text-xs font-mono mb-2', changeColor(vvix.change))}>
        {fmtChange(vvix.change, 1)} ({fmtPct(vvix.changePercent)})
      </div>
      <div className="text-[10px] text-slate-400 leading-snug">
        Volatility of VIX.
        <br />
        {vvix.price > 100 ? '⚠ Elevated uncertainty' : 'Normal range'}
      </div>
    </div>
  )
}

// ─── Main Macro Risk Matrix Component ──────────────────────────────────────

export interface MacroRiskMatrixProps {
  metrics: MacroRiskMetrics
}

export function MacroRiskMatrix({ metrics }: MacroRiskMatrixProps) {
  const { vix, vvix, move, gamma, skew, putCallRatio } = metrics

  // Calculate scores (0-100 scale) using linear interpolation
  // VIX: 12 or lower = 100 (safe), 35 or higher = 0 (extreme danger)
  const vixScore = calculateRiskScore(vix.price, 12, 35)

  // MOVE: 60 or lower = 100 (calm), 160 or higher = 0 (extreme stress)
  const moveScore = calculateRiskScore(move.price, 60, 160)

  // VVIX: 75 or lower = 100 (stable), 130 or higher = 0 (exploding)
  const vvixScore = calculateRiskScore(vvix.price, 75, 130)

  // SKEW: 115 or lower = 100 (flat), 155 or higher = 0 (tail risk priced)
  const skewScore = calculateRiskScore(skew.price, 115, 155)

  // Put/Call Ratio: 0.45 or lower = 100 (bullish), 1.15 or higher = 0 (bearish hedging)
  const putCallScore = calculateRiskScore(putCallRatio, 0.45, 1.15)

  // Gamma: Convert regime to score
  const getGammaScore = () => {
    // Map regime to score: low (100) > medium (50) > high (0)
    switch (gamma.regime) {
      case 'low':
        return 100 // Low gamma = stable
      case 'medium':
        return 50 // Medium = moderate
      case 'high':
        return 0 // High gamma = unstable
      default:
        return 50
    }
  }
  const gammaScore = getGammaScore()

  const avgScore = (vixScore + moveScore + vvixScore + skewScore + putCallScore + gammaScore) / 6

  const getRegimeLabel = (score: number) => {
    if (score < 33.33) return 'RISK OFF'
    if (score < 66.67) return 'NEUTRAL'
    return 'RISK ON'
  }

  const getRegimeColor = (score: number) => {
    if (score < 33.33) return '#f87171'
    if (score < 66.67) return '#fbbf24'
    return '#34d399'
  }

  const SIG = {
    bullish: { text: 'text-emerald-400', bg: 'bg-emerald-400/10', border: 'border-emerald-400/30' },
    bearish: { text: 'text-red-400', bg: 'bg-red-400/10', border: 'border-red-400/30' },
    warning: { text: 'text-amber-400', bg: 'bg-amber-400/10', border: 'border-amber-400/30' },
    neutral: { text: 'text-slate-400', bg: 'bg-slate-700/30', border: 'border-slate-500/40' },
  }

  const ScoreCard = ({ title, subtitle, value, change, changePct, score, regime, note, explanation }: { title: string; subtitle: string; value: string; change: string; changePct: string; score: number; regime: string; note: string; explanation: string }) => (
    <div className={cn('bg-[#0c1221] border rounded-xl p-3 flex flex-col gap-2', 'border-[#1a2540]')}>
      <div className="flex items-start justify-between gap-1">
        <div>
          <div className="text-[12px] font-mono text-amber-400/80 uppercase tracking-widest mb-0.5">{title}</div>
          <div className="text-[10px] text-slate-300">{subtitle}</div>
        </div>
        <Tooltip label="" explanation={explanation} />
      </div>
      <div className="flex items-end justify-between gap-1">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-xl font-semibold tabular-nums leading-none">
            {value}
          </div>
          <div className="font-mono text-[12px] mt-0.5" style={{ color: change.startsWith('+') ? '#f87171' : '#34d399' }}>
            {change}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-1">
        <span className={cn('text-[11px] font-mono font-semibold tracking-wider px-1.5 py-0.5 rounded border', score > 66.67 ? SIG.bullish.text + ' ' + SIG.bullish.bg + ' ' + SIG.bullish.border : score > 33.33 ? SIG.neutral.text + ' ' + SIG.neutral.bg + ' ' + SIG.neutral.border : SIG.bearish.text + ' ' + SIG.bearish.bg + ' ' + SIG.bearish.border)}>
          {regime}
        </span>
        <span className="text-[11px] font-mono font-semibold px-1.5 py-0.5 rounded border bg-slate-700/30 border-slate-500/40" style={{ color: score > 66.67 ? '#34d399' : score > 33.33 ? '#fbbf24' : '#f87171' }}>
          {score.toFixed(0)}
        </span>
      </div>
      <p className="text-[11px] text-slate-400 leading-tight">
        {note}
      </p>
    </div>
  )

  return (
    <div>
      <div className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest mb-2">
        Macro Risk Matrix &amp; Cross-Asset Volatility
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2 mb-3">
        <ScoreCard
          title="VIX"
          subtitle="Equity Volatility"
          value={vix.price.toFixed(2)}
          change={vix.change >= 0 ? '+' + vix.change.toFixed(2) : vix.change.toFixed(2)}
          changePct={vix.changePercent.toFixed(1) + '%'}
          score={vixScore}
          regime={vixScore > 66.67 ? 'RISK ON' : vixScore > 33.33 ? 'NEUTRAL' : 'RISK OFF'}
          note={vix.price < 15 ? 'Market complacency' : vix.price < 20 ? 'Normal environment' : vix.price < 30 ? 'Heightened uncertainty' : 'Elevated panic'}
          explanation={vix.price < 15 ? 'COMPLACENCY (Score 100): Market at ease. Typical of bull markets 2017, mid-2021. Signals potential for sharp reversals.' : vix.price < 20 ? 'NORMAL (Score 100): Healthy market. Historical baseline 15-20. Growth environment intact.' : vix.price < 30 ? 'ELEVATED (Score 50): Caution warranted. Similar to March 2022, Sept 2023 pre-pivot. Volatility spike likely.' : 'RISK OFF (Score 0): Crisis mode. March 2020, March 2023 banking panic levels. Flight to safety active.'}
        />
        <ScoreCard
          title="MOVE"
          subtitle="Bond Volatility"
          value={move.price.toFixed(1)}
          change={move.change >= 0 ? '+' + move.change.toFixed(2) : move.change.toFixed(2)}
          changePct={move.changePercent.toFixed(1) + '%'}
          score={moveScore}
          regime={moveScore > 66.67 ? 'CALM' : moveScore > 33.33 ? 'MODERATE' : 'STRESS'}
          note={move.price > 150 ? 'Rate volatility spike' : move.price > 130 ? 'Rising rate uncertainty' : 'Stable bond market'}
          explanation={move.price < 110 ? 'CALM (Score 100): Bond market sleeping. Pre-2022 baseline. Rates stable, Fed predictable. Low hedging need.' : move.price < 130 ? 'MODERATE (Score 50): Rising uncertainty. Similar to late 2022 rate shock. Fed path unclear. Refinancing stress.' : 'STRESS (Score 0): Bond crisis. March 2020, Sept 2022 (LDI meltdown), June 2023 (banking stress). Liquidity drying.'}
        />
        <ScoreCard
          title="VVIX"
          subtitle="Volatility of Vol"
          value={vvix.price.toFixed(1)}
          change={vvix.change >= 0 ? '+' + vvix.change.toFixed(2) : vvix.change.toFixed(2)}
          changePct={vvix.changePercent.toFixed(1) + '%'}
          score={vvixScore}
          regime={vvixScore > 66.67 ? 'STABLE' : vvixScore > 33.33 ? 'UNCERTAIN' : 'CHAOS'}
          note={vvix.price > 120 ? 'Extreme vol volatility' : vvix.price > 100 ? 'Vol uncertainty rising' : 'Vol regime stable'}
          explanation={vvix.price < 50 ? 'STABLE (Score 100): Vol of vol calm. 2017 regime. Market expects stability. Gamma scalping profitable.' : vvix.price < 100 ? 'UNCERTAIN (Score 50): Vol instability rising. Precedes vol spikes. Similar to Aug 2015, early 2018. Options skew widening.' : 'CHAOS (Score 0): VVIX explosion. Feb 2018 (vol snap), March 2020 (pandemic), June 2024 Japan carry unwind. Hedges fail.'}
        />
        <ScoreCard
          title="SKEW"
          subtitle="Tail Risk Premium"
          value={skew.price.toFixed(1)}
          change={skew.change >= 0 ? '+' + skew.change.toFixed(2) : skew.change.toFixed(2)}
          changePct={skew.changePercent.toFixed(1) + '%'}
          score={skewScore}
          regime={skewScore > 66.67 ? 'CHEAP' : skewScore > 33.33 ? 'NORMAL' : 'EXPENSIVE'}
          note={skew.price > 145 ? 'Expensive downside hedges' : skew.price < 120 ? 'Compressed tail risk' : 'Normal tail pricing'}
          explanation={skew.price < 120 ? 'CHEAP (Score 100): Put demand low. Summer 2017 regime. Tail hedges underowned. Risk-on complacency.' : skew.price < 145 ? 'NORMAL (Score 50): Balanced skew. 120-140 is fair value. Put-call options fairly priced.' : 'EXPENSIVE (Score 0): Put panic. March 2020 (140+), Sept 2022 (135+). Hedging arms race. Puts overpriced.'}
        />
        <ScoreCard
          title="PUT/CALL"
          subtitle="Options Flow Sentiment"
          value={putCallRatio.toFixed(2)}
          change={putCallRatio > 0.7 ? 'Hedging' : 'Calls'}
          changePct={putCallRatio > 0.9 ? 'Active' : 'Neutral'}
          score={putCallScore}
          regime={putCallScore > 66.67 ? 'CALL' : putCallScore > 33.33 ? 'NEUTRAL' : 'PUT'}
          note={putCallRatio > 0.9 ? 'Put hedging active' : putCallRatio > 0.75 ? 'Balanced bias' : 'Call demand dominant'}
          explanation={putCallRatio < 0.6 ? 'CALL DEMAND (Score 100): Bullish options flow. Typical of Jan 2017, May 2021. Call spreads bought. Upside positioning.' : putCallRatio < 0.9 ? 'NEUTRAL (Score 50): Balanced. Normal baseline 0.65-0.75. No extreme convexity demand.' : 'PUT DEMAND (Score 0): Hedging frenzy. Feb 2018 (>1.2), March 2020 (>1.5), Oct 2023 (war premiums). Tail buyers.'}
        />
        <ScoreCard
          title="GAMMA"
          subtitle={`Gamma Regime (${gamma.regime})`}
          value={gamma.price.toFixed(2)}
          change={gamma.change >= 0 ? '+' + gamma.change.toFixed(2) : gamma.change.toFixed(2)}
          changePct={gamma.changePercent.toFixed(1) + '%'}
          score={gammaScore}
          regime={gammaScore > 66.67 ? 'LOW' : gammaScore > 33.33 ? 'MEDIUM' : 'HIGH'}
          note={gamma.regime === 'low' ? 'Stable pricing' : gamma.regime === 'medium' ? 'Moderate dynamics' : 'High market sensitivity'}
          explanation={gamma.regime === 'low' ? 'LOW GAMMA (Score 100): Stable deltas. Delta hedging smooth. Market maker friendly. 2017-2021 baseline. Gamma scalps fail.' : gamma.regime === 'medium' ? 'MEDIUM GAMMA (Score 50): Moderate pin risk. Minor rehedging flows. Sept 2022-Feb 2023 typical. Price levels matter more.' : 'HIGH GAMMA (Score 0): Explosive deltas. Major option expirations pending. March 2020 (circuit breakers), Jan 2021 (GME), Aug 2024 (AI selloff). Hedges fail instantly.'}
        />
      </div>
      <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest mb-0.5">Combined Regime</div>
            <div className="text-[11px] text-slate-300">Macro volatility assessment</div>
          </div>
          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="font-mono text-3xl font-bold leading-none" style={{ color: getRegimeColor(avgScore) }}>
                {getRegimeLabel(avgScore)}
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
                backgroundColor: avgScore > (i + 0.5) * (2 / 6) ? getRegimeColor(avgScore) : '#1e293b',
                opacity: avgScore > (i + 0.5) * (2 / 6) ? 1 : 0.3,
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
