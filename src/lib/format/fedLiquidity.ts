/**
 * Fed-Liquidity numeric formatting helpers.
 *
 * Shared between the API route, the React monitor card, and the vitest
 * suite so the precision contract has a single source of truth.
 *
 * Why this file exists:
 *   RRPONTSYD post-QT balances can be as small as ~$1.78 B.  The old code
 *   path called `Math.round()` on the billions value upstream, then divided
 *   by 1_000 for trillion display and called `.toFixed(2)` — flattening
 *   1.78 → 2 → 0.002 → "0.00T".  The fixes:
 *     1. `toPrecise()` preserves 3 decimals through the API layer.
 *     2. `fmtBillions()` auto-scales between trillions and billions so the
 *        display never collapses to $0.00T for legitimate sub-trillion
 *        values.
 */

/**
 * Round `value` to `decimals` places without binary floating-point drift.
 *
 * Plain `(x).toFixed(n)` / `Math.round(x * 10ⁿ)` operate on the *binary*
 * approximation of x, so boundary values land on the wrong side — e.g.
 * `(4.055).toFixed(2)` returns "4.05" because 4.055 is actually stored as
 * 4.0549999…, and an accumulated subtraction like 6.70 − 0.17 − 2.48 can drift
 * just enough to render "4.06" instead of "4.05".
 *
 * Scaling to an integer with an epsilon nudge in the value's direction snaps
 * these half-way cases to the mathematically correct result.
 */
export function preciseRound(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value
  const factor  = 10 ** decimals
  const nudged  = value * factor + (value >= 0 ? Number.EPSILON : -Number.EPSILON) * factor
  return Math.round(nudged) / factor
}

/** Round a billions-denominated value to million-dollar resolution. */
export function toPrecise(b: number): number {
  return preciseRound(b, 3)
}

/**
 * Format a billions-denominated value into the most readable scale.
 *  ≥ $100B → trillions, 2 decimals (e.g. "$7.24T")
 *  ≥ $10B  → trillions, 3 decimals (e.g. "$0.045T" displayed as 3dp)
 *  <  $10B → billions, 2 decimals  (e.g. "$1.78B")
 *
 * The bands prevent both information loss on the low end and visual
 * clutter on the high end.  Negative values are accepted (Net Liquidity
 * can swing negative on extreme contractions).
 */
export function fmtBillions(b: number): string {
  const abs = Math.abs(b)
  // preciseRound() first so the .toFixed() call only formats an already-correct
  // decimal — never the drifting binary approximation of the raw subtraction.
  if (abs >= 100) return `$${preciseRound(b / 1_000, 2).toFixed(2)}T`
  if (abs >= 10)  return `$${preciseRound(b / 1_000, 3).toFixed(3)}T`
  return `$${preciseRound(b, 2).toFixed(2)}B`
}

/**
 * Compute Net Liquidity from raw billions values.  Extracted so the API
 * and the vitest can both prove that small RRP values are NOT rounded
 * before entering the subtraction.
 *
 * Net Liquidity = WALCL − TGA − RRP   (all in billions)
 *
 * The subtraction is performed in integer millions to eliminate binary
 * floating-point drift before it can reach the 2-decimal display.  Working
 * directly in billions, 6700 − 170 − 2480 is exact, but fractional inputs like
 * 6704.383 − 169.5 − 2480.12 accumulate representation error that can flip the
 * final rounded trillion figure (e.g. 4.05 → 4.06).  Scaling to whole millions,
 * subtracting, then scaling back keeps million-dollar resolution exact.
 */
export function computeNetLiquidity(
  walclBillions: number,
  tgaBillions: number,
  rrpBillions: number,
): number {
  const toMillions = (b: number) => Math.round(b * 1_000)   // billions → integer millions
  const netMillions =
    toMillions(walclBillions) - toMillions(tgaBillions) - toMillions(rrpBillions)
  return netMillions / 1_000                                // back to billions, drift-free
}
