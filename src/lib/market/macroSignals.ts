/**
 * Macro Signal Engine — Yield Curve Regime Classifier
 * ─────────────────────────────────────────────────────────────────────────────
 * Pure functions that derive a programmatic regime label, velocity-shock flag,
 * and directional risk-bias signal from live FRED yield-curve observations.
 *
 * Regime logic (rate-of-change relative to 5-day SMA baselines):
 *   BEAR_STEEPENER  → long end (10Y) rising faster than short end (2Y)
 *                     Inflation / duration-risk premium expanding → RISK_OFF
 *   BULL_STEEPENER  → short end (2Y) falling faster than long end
 *                     Fed-cutting / panic-pivot regime              → DEFENSIVE
 *   BEAR_FLATTENER  → short end rising faster than long end
 *                     Tightening conditions / inversion threat      → CAUTION
 *   BULL_FLATTENER  → long end falling faster than short end
 *                     Flight-to-quality rally in duration           → RISK_OFF
 *   NEUTRAL         → no dominant driver (< 2 bp differential)     → RISK_ON
 *
 * Velocity shock: 10Y daily change > 1.5 σ of the prior 14-session window.
 *
 * Pure functions only — no I/O, no side effects.
 * All data fetching lives in the route handlers so this file is unit-testable.
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export type YieldRegime =
  | 'BULL_STEEPENER'
  | 'BEAR_STEEPENER'
  | 'BULL_FLATTENER'
  | 'BEAR_FLATTENER'
  | 'NEUTRAL'

export type SignalBias = 'RISK_ON' | 'RISK_OFF' | 'DEFENSIVE' | 'CAUTION'

export interface YieldCurveSignal {
  /** Discrete rate-of-change regime derived from 5-day SMA deltas */
  regime:        YieldRegime
  /**
   * True when the most recent 1-day 10Y yield move exceeds 1.5 standard
   * deviations of the daily changes over the prior 14-session window.
   */
  velocityShock: boolean
  /** Current 10Y − 2Y spread in percentage points (positive = normal curve) */
  spreadValue:   number
  /** Directional risk signal mapped from the regime */
  signalBias:    SignalBias
}

/** Single daily FRED observation — rate is already a float (e.g. 4.38 %) */
export interface YieldObservation {
  date: string   // YYYY-MM-DD
  rate: number   // percent, e.g. 4.38 — NOT decimal
}

export interface MacroSignalInput {
  /**
   * DGS10 observations **ordered oldest → newest** (FRED descending output
   * must be reversed before passing here).
   * Minimum 5 observations for the SMA baseline; 16+ for full velocity shock.
   */
  yield10y: YieldObservation[]
  /**
   * DGS2 observations **ordered oldest → newest**.
   * Minimum 5 observations for the SMA baseline.
   */
  yield2y: YieldObservation[]
}

// ─── Internal math primitives ─────────────────────────────────────────────────

/**
 * Simple arithmetic mean of the last `period` elements.
 * Returns NaN when the array is shorter than `period`.
 */
function sma(values: number[], period: number): number {
  if (values.length < period) return NaN
  const window = values.slice(-period)
  return window.reduce((a, b) => a + b, 0) / period
}

/**
 * Population standard deviation.  Returns 0 for single-element arrays
 * so callers never divide by zero in the velocity-shock path.
 */
function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

// ─── Regime classifier ────────────────────────────────────────────────────────

/**
 * Compare how far each tenor's latest rate sits above/below its 5-day SMA.
 *
 *   delta10Y = current10Y − SMA5(10Y)   +ve → 10Y rising above its baseline
 *   delta2Y  = current2Y  − SMA5(2Y)    +ve → 2Y  rising above its baseline
 *   diff     = delta10Y − delta2Y
 *
 * A 2 bp minimum `diff` threshold filters daily noise.  The two independent
 * sign checks ensure we correctly separate steepeners from flatteners even
 * when both ends are moving in the same direction.
 *
 *   diff > +0.02 AND delta10Y > 0 → BEAR_STEEPENER (long end rising)
 *   diff > +0.02 AND delta2Y  < 0 → BULL_STEEPENER (short end falling)
 *   diff < −0.02 AND delta2Y  > 0 → BEAR_FLATTENER (short end rising)
 *   diff < −0.02 AND delta10Y < 0 → BULL_FLATTENER (long end falling)
 *   otherwise                     → NEUTRAL
 *
 * Priority ordering matters: if delta10Y > 0 AND delta2Y < 0 simultaneously
 * (rare — both conditions point to steepening), BEAR_STEEPENER wins because
 * the rising long end is the dominant inflation signal.
 */
function classifyRegime(
  current10Y: number,
  current2Y:  number,
  sma5_10Y:   number,
  sma5_2Y:    number,
): YieldRegime {
  if (!Number.isFinite(sma5_10Y) || !Number.isFinite(sma5_2Y)) return 'NEUTRAL'

  const delta10Y = current10Y - sma5_10Y
  const delta2Y  = current2Y  - sma5_2Y
  const diff     = delta10Y  - delta2Y     // positive → 10Y moving more than 2Y

  const THRESHOLD = 0.02  // 2 basis points (rates in %)

  if (diff >  THRESHOLD && delta10Y > 0) return 'BEAR_STEEPENER'
  if (diff >  THRESHOLD && delta2Y  < 0) return 'BULL_STEEPENER'
  if (diff < -THRESHOLD && delta2Y  > 0) return 'BEAR_FLATTENER'
  if (diff < -THRESHOLD && delta10Y < 0) return 'BULL_FLATTENER'
  return 'NEUTRAL'
}

// ─── Regime → bias mapping ────────────────────────────────────────────────────

const REGIME_BIAS: Record<YieldRegime, SignalBias> = {
  BEAR_STEEPENER: 'RISK_OFF',    // Long-end inflation premium expanding
  BULL_STEEPENER: 'DEFENSIVE',   // Fed-cut / flight-to-safety in short end
  BEAR_FLATTENER: 'CAUTION',     // Front-end tightening, growth slowdown risk
  BULL_FLATTENER: 'RISK_OFF',    // Duration rally = flight-to-quality signal
  NEUTRAL:        'RISK_ON',     // No dominant curve driver
}

// ─── Velocity shock detector ─────────────────────────────────────────────────

/**
 * Returns true when the most recent day-over-day 10Y yield change exceeds
 * 1.5 standard deviations of the prior 14 sessions' daily changes.
 *
 * Algorithm:
 *   1. Take up to the last 15 observations (yields)
 *   2. Build 14 day-over-day changes from those 15 observations
 *   3. σ = population stddev of the first 13 changes (the "prior" window)
 *   4. If |change₁₄| > 1.5 σ → shock = true
 *
 * Degrades gracefully: returns false when fewer than 3 observations exist
 * or when σ = 0 (flat series, no volatility baseline to compare against).
 */
function detectVelocityShock(yield10y: YieldObservation[]): boolean {
  if (yield10y.length < 3) return false

  // Last 15 observations → up to 14 daily changes
  const obs = yield10y.slice(-15)
  const changes: number[] = []
  for (let i = 1; i < obs.length; i++) {
    changes.push(obs[i].rate - obs[i - 1].rate)
  }

  if (changes.length < 2) return false

  const latestChange = changes[changes.length - 1]
  const priorChanges = changes.slice(0, -1)

  const σ = stddev(priorChanges)
  if (σ === 0) return false

  return Math.abs(latestChange) > 1.5 * σ
}

// ─── Top-level entry point ────────────────────────────────────────────────────

/**
 * Compute the macro yield-curve signal from live FRED DGS10 / DGS2 arrays.
 *
 * Expects observations ordered **oldest → newest** (reverse the FRED
 * `sort_order=desc` response before passing here).
 *
 * Never throws — degrades to NEUTRAL / RISK_ON when the series is too short
 * or contains invalid values.
 *
 * @param input  MacroSignalInput containing yield10y + yield2y observation arrays
 * @returns      YieldCurveSignal — deterministic, serialisation-safe (no NaN/Infinity)
 */
export function calculateMacroSignals(input: MacroSignalInput): YieldCurveSignal {
  const { yield10y, yield2y } = input

  const NEUTRAL_FALLBACK: YieldCurveSignal = {
    regime:        'NEUTRAL',
    velocityShock: false,
    spreadValue:   0,
    signalBias:    'RISK_ON',
  }

  // Guard: need at least one current observation per tenor
  if (yield10y.length === 0 || yield2y.length === 0) return NEUTRAL_FALLBACK

  const current10Y = yield10y[yield10y.length - 1].rate
  const current2Y  = yield2y[yield2y.length  - 1].rate

  if (!Number.isFinite(current10Y) || !Number.isFinite(current2Y)) return NEUTRAL_FALLBACK

  const rates10Y = yield10y.map(o => o.rate)
  const rates2Y  = yield2y.map(o => o.rate)

  // 5-day SMA baselines — NaN when series < 5 obs → classifyRegime returns NEUTRAL
  const sma5_10Y = sma(rates10Y, 5)
  const sma5_2Y  = sma(rates2Y,  5)

  const regime        = classifyRegime(current10Y, current2Y, sma5_10Y, sma5_2Y)
  const velocityShock = detectVelocityShock(yield10y)
  const spreadValue   = parseFloat((current10Y - current2Y).toFixed(4))
  const signalBias    = REGIME_BIAS[regime]

  return { regime, velocityShock, spreadValue, signalBias }
}
