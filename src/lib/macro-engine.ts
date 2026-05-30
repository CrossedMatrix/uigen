/**
 * Unified Macro Engine — Liquidity × Yield Curve Signal Matrix
 * ─────────────────────────────────────────────────────────────────────────────
 * Combines two independent FRED data streams into a single institutional bias:
 *
 *   Axis 1 — Fed Liquidity Trend  (WALCL 14-day momentum)
 *     expanding  → balance sheet growing  → supportive backdrop
 *     contracting → QT / drain in progress → headwind for risk assets
 *     flat        → no dominant impulse
 *
 *   Axis 2 — Yield Curve Regime   (from macroSignals.ts SMA-delta classifier)
 *     BEAR_STEEPENER → inflation / long-end premium rising
 *     BULL_STEEPENER → front-end collapsing (pivot panic)
 *     BEAR_FLATTENER → front-end tightening / inversion approach
 *     BULL_FLATTENER → flight-to-quality duration rally
 *     NEUTRAL        → no dominant curve driver
 *
 * Signal Matrix:
 *   expanding  + BEAR_STEEPENER | NEUTRAL   → RISK_ON
 *   expanding  + BULL_STEEPENER | *FLATTENER → CAUTIOUS_GROWTH
 *   flat       + any                         → CAUTIOUS_GROWTH
 *   contracting + BEAR_STEEPENER             → BEAR_STEEPENING
 *   contracting + other                      → RISK_OFF
 *
 * Pure functions only — no I/O, no side effects.
 * All data fetching lives in the API route handlers.
 */

import type { YieldCurveSignal, YieldRegime } from '@/lib/market/macroSignals'

// ─── Public types ─────────────────────────────────────────────────────────────

export type MacroBias =
  | 'RISK_ON'
  | 'CAUTIOUS_GROWTH'
  | 'BEAR_STEEPENING'
  | 'RISK_OFF'

export interface MacroSignal {
  /** Combined institutional bias from the liquidity × curve matrix */
  bias:                 MacroBias
  /** One-sentence institutional justification for the bias */
  explanation:          string
  /** Fed balance sheet momentum direction over the rolling 14-day window */
  liquidityDirection:   'expanding' | 'contracting' | 'flat'
  /**
   * Rolling 14-day percent change in WALCL (Fed balance sheet total).
   * Positive = expanding QE / re-injection; negative = QT / drain.
   */
  liquidityMomentum14d: number
  /** Yield curve regime label from the SMA-delta classifier, or 'UNKNOWN' if unavailable */
  curveRegime:          YieldRegime | 'UNKNOWN'
  /** Whether a velocity shock was detected on the 10Y tenor */
  velocityShock:        boolean
  /** 10Y − 2Y spread value in percentage points */
  spreadValue:          number | null
  /** Unix ms timestamp of the calculation */
  timestamp:            number
}

export interface MacroEngineInput {
  /** WALCL 14-day momentum direction (from fed-liquidity route or WALCL series) */
  liquidityDirection:   'expanding' | 'contracting' | 'flat'
  /** Rolling 14-day % change in WALCL — positive = QE, negative = QT */
  liquidityMomentum14d: number
  /** Yield curve signal from calculateMacroSignals() — null when FRED key absent */
  yieldCurveSignal:     YieldCurveSignal | null
}

// ─── Bias Matrix ──────────────────────────────────────────────────────────────

/**
 * Derive the macro bias from the two-axis matrix.
 *
 * Priority rules (read top-to-bottom; first match wins):
 *   1. contracting + BEAR_STEEPENER → BEAR_STEEPENING
 *      (stagflation signal: tightening conditions AND long-end premium rising)
 *   2. contracting + any            → RISK_OFF
 *      (liquidity withdrawal = headwind regardless of curve shape)
 *   3. flat + any                   → CAUTIOUS_GROWTH
 *      (no impulse — hold positioning, neither add nor reduce risk)
 *   4. expanding + NEUTRAL | BEAR_STEEPENER → RISK_ON
 *      (liquidity injections supporting the reflationary trade)
 *   5. expanding + everything else  → CAUTIOUS_GROWTH
 *      (good liquidity but curve signalling stress — partial hedge warranted)
 */
function deriveBias(
  liquidityDirection: 'expanding' | 'contracting' | 'flat',
  regime: YieldRegime,
): MacroBias {
  if (liquidityDirection === 'contracting') {
    return regime === 'BEAR_STEEPENER' ? 'BEAR_STEEPENING' : 'RISK_OFF'
  }

  if (liquidityDirection === 'flat') {
    return 'CAUTIOUS_GROWTH'
  }

  // expanding
  if (regime === 'NEUTRAL' || regime === 'BEAR_STEEPENER') {
    return 'RISK_ON'
  }

  return 'CAUTIOUS_GROWTH'
}

// ─── Explanation Engine ───────────────────────────────────────────────────────

/**
 * Returns a one-sentence institutional justification for the current macro bias.
 * Explanations are keyed on `${liquidityDirection}:${regime}` to be
 * maximally specific, with a per-bias fallback for edge cases.
 */
function buildExplanation(
  bias:               MacroBias,
  liquidityDirection: 'expanding' | 'contracting' | 'flat',
  regime:             YieldRegime,
  momentum14d:        number,
  velocityShock:      boolean,
): string {
  const key = `${liquidityDirection}:${regime}` as const
  const shockSuffix = velocityShock ? ' Velocity shock in 10Y heightens short-term duration risk.' : ''
  const momPct = Math.abs(momentum14d).toFixed(2)

  const EXPLANATIONS: Partial<Record<string, string>> = {
    // ── EXPANDING liquidity ──────────────────────────────────────────────────
    'expanding:NEUTRAL':
      `Fed balance sheet expanding +${momPct}% (14d) with a neutral curve — reflationary backdrop supports broad risk exposure.`,
    'expanding:BEAR_STEEPENER':
      `Liquidity injection +${momPct}% (14d) coincides with a bear-steepening curve; inflation premium rising but monetary fuel intact — overweight cyclicals with duration hedge.`,
    'expanding:BULL_STEEPENER':
      `Balance sheet growing +${momPct}% (14d) while front-end rates collapse — market pricing an emergency pivot; pivot trades favour duration and defensive growth.`,
    'expanding:BEAR_FLATTENER':
      `Fed expanding +${momPct}% (14d) but front-end tightening flattens the curve — mixed signal; favour quality over pure beta until inversion risk resolves.`,
    'expanding:BULL_FLATTENER':
      `Liquidity growing +${momPct}% (14d) alongside a bull-flattener signals flight-to-quality within an easing backdrop — risk-off in equities, constructive on duration.`,

    // ── CONTRACTING liquidity ────────────────────────────────────────────────
    'contracting:NEUTRAL':
      `Balance sheet contracting −${momPct}% (14d) with no compensating curve steepness — QT headwinds dominate; reduce beta and extend cash buffers.`,
    'contracting:BEAR_STEEPENER':
      `QT drain −${momPct}% (14d) combined with a bear-steepening curve signals stagflationary stress — long-end premium rising into shrinking liquidity; underweight equities, overweight real assets.`,
    'contracting:BULL_STEEPENER':
      `Fed contracting −${momPct}% (14d) while front-end collapses — pivot pricing absent liquidity support; cautious on duration duration, watch for false breakout in credit spreads.`,
    'contracting:BEAR_FLATTENER':
      `Balance sheet shrinking −${momPct}% (14d) + inversion approach — classic late-cycle recession flag; rotate to defensive sectors and short-duration fixed income.`,
    'contracting:BULL_FLATTENER':
      `QT −${momPct}% (14d) with a bull-flattener indicates flight-to-quality into a liquidity contraction — high conviction RISK_OFF; overweight Treasuries, underweight credit and EM.`,

    // ── FLAT liquidity ───────────────────────────────────────────────────────
    'flat:NEUTRAL':
      `Fed balance sheet flat and curve neutral — no dominant macro impulse; maintain baseline allocation, monitor for breakout in either direction.`,
    'flat:BEAR_STEEPENER':
      `Flat liquidity with a bear-steepening curve — inflation narrative building without monetary support; trim long-duration, favour commodities and TIPS.`,
    'flat:BULL_STEEPENER':
      `Flat balance sheet while front-end collapses — pivot expectations without fresh liquidity; hold defensive positioning until balance sheet expansion confirms.`,
    'flat:BEAR_FLATTENER':
      `Flat liquidity + front-end tightening = cautionary signal; reduce risk incrementally and watch credit spreads for early deterioration.`,
    'flat:BULL_FLATTENER':
      `Balance sheet paused while duration rallies in a bull-flattener — ambiguous; quality bias warranted but avoid outright short risk.`,
  }

  const base = EXPLANATIONS[key] ?? fallbackExplanation(bias, liquidityDirection, regime, momPct)
  return base + shockSuffix
}

function fallbackExplanation(
  bias:               MacroBias,
  liquidityDirection: 'expanding' | 'contracting' | 'flat',
  regime:             YieldRegime,
  momPct:             string,
): string {
  switch (bias) {
    case 'RISK_ON':
      return `Expanding liquidity (+${momPct}% 14d) with supportive curve regime (${regime}) — macro backdrop favours risk-on positioning.`
    case 'CAUTIOUS_GROWTH':
      return `Mixed signals from ${liquidityDirection} liquidity and ${regime} curve — maintain moderate risk with selective factor exposure.`
    case 'BEAR_STEEPENING':
      return `Contracting liquidity (−${momPct}% 14d) with ${regime} — stagflationary stress signal; real assets over financial assets.`
    case 'RISK_OFF':
      return `Liquidity contraction (−${momPct}% 14d) removes the risk-asset support layer; reduce beta and build defensive buffer.`
  }
}

// ─── Top-level entry point ────────────────────────────────────────────────────

/**
 * Derive a unified macro signal from the liquidity × yield curve matrix.
 *
 * Never throws — degrades to CAUTIOUS_GROWTH with a safe explanation when
 * input data is unavailable or malformed.
 *
 * @param input  MacroEngineInput containing WALCL momentum + YieldCurveSignal
 * @returns      MacroSignal — serialisation-safe (no NaN / Infinity in output)
 */
export function getMacroSignal(input: MacroEngineInput): MacroSignal {
  const { liquidityDirection, liquidityMomentum14d, yieldCurveSignal } = input

  // Graceful degradation when yield curve data is unavailable
  const regime:        YieldRegime = yieldCurveSignal?.regime        ?? 'NEUTRAL'
  const velocityShock: boolean     = yieldCurveSignal?.velocityShock ?? false
  const spreadValue:   number | null = yieldCurveSignal?.spreadValue ?? null

  const bias        = deriveBias(liquidityDirection, regime)
  const explanation = buildExplanation(
    bias,
    liquidityDirection,
    regime,
    liquidityMomentum14d,
    velocityShock,
  )

  return {
    bias,
    explanation,
    liquidityDirection,
    liquidityMomentum14d: Number.isFinite(liquidityMomentum14d) ? parseFloat(liquidityMomentum14d.toFixed(4)) : 0,
    curveRegime:    yieldCurveSignal ? regime : 'UNKNOWN',
    velocityShock,
    spreadValue:    spreadValue !== null ? parseFloat(spreadValue.toFixed(4)) : null,
    timestamp:      Date.now(),
  }
}
