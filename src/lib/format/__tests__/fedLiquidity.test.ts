import { describe, expect, it } from 'vitest'
import { computeNetLiquidity, fmtBillions, toPrecise } from '../fedLiquidity'

describe('toPrecise', () => {
  it('preserves 3 decimal places for small RRP balances', () => {
    // Bug-reproducer: the legacy Math.round() flow collapsed 1.78 → 2.
    expect(toPrecise(1.78)).toBe(1.78)
  })

  it('keeps full precision when value already has ≤ 3 decimals', () => {
    expect(toPrecise(1.234)).toBe(1.234)
  })

  it('rounds to 3 decimals when input has more precision', () => {
    expect(toPrecise(1.23456789)).toBeCloseTo(1.235, 3)
  })

  it('handles trillion-scale WALCL values without overflow loss', () => {
    expect(toPrecise(7239.876)).toBe(7239.876)
  })
})

describe('computeNetLiquidity', () => {
  it('subtracts using full-precision billions (no upstream rounding)', () => {
    // walcl = 7240, tga = 165, rrp = 1.78  →  7240 - 165 - 1.78 = 7073.22
    // Legacy Math.round(rrp) → 2  ⇒  result 7073 (wrong by 0.22B).
    const net = computeNetLiquidity(7240, 165, 1.78)
    expect(net).toBeCloseTo(7073.22, 2)
  })

  it('matches WALCL − TGA − RRP for typical 2024 values', () => {
    const net = computeNetLiquidity(7100.5, 800.25, 450.75)
    expect(net).toBe(5849.5)
  })

  it('preserves precision through the calculation', () => {
    // Synthetic small-RRP edge case: the post-2025 RRP-near-zero environment.
    const net = computeNetLiquidity(6900.123, 700.456, 0.789)
    expect(net).toBeCloseTo(6198.878, 3)
  })
})

describe('fmtBillions', () => {
  it('formats large WALCL value in trillions with 2 decimals', () => {
    expect(fmtBillions(7240)).toBe('$7.24T')
  })

  it('formats sub-trillion TGA in trillions with 2 decimals', () => {
    expect(fmtBillions(165)).toBe('$0.17T')
  })

  it('formats small RRP value in billions, not "$0.00T"', () => {
    // Bug-reproducer: $1.78B should NEVER render as "$0.00T".
    expect(fmtBillions(1.78)).toBe('$1.78B')
  })

  it('switches to billions display below the $10B threshold', () => {
    expect(fmtBillions(9.5)).toBe('$9.50B')
  })

  it('uses extra trillion precision in the 10-100B band', () => {
    // Just above the $10B switch — 3-decimal trillion rendering avoids
    // collapsing 25B → $0.03T (visually indistinguishable from 30B).
    expect(fmtBillions(25)).toBe('$0.025T')
  })

  it('handles negative values for hypothetical Net Liquidity contraction', () => {
    expect(fmtBillions(-1500)).toBe('$-1.50T')
  })
})

describe('integration: RRP precision flows into Net Liquidity display', () => {
  it('1.78B RRP keeps Net Liquidity within $0.01B of expected', () => {
    // Simulate the end-to-end pipeline:
    //   raw FRED billions  →  toPrecise  →  computeNetLiquidity  →  fmtBillions
    const walclRaw = 7240
    const tgaRaw   = 165
    const rrpRaw   = 1.78

    const walcl = toPrecise(walclRaw)
    const tga   = toPrecise(tgaRaw)
    const rrp   = toPrecise(rrpRaw)
    const net   = computeNetLiquidity(walcl, tga, rrp)

    expect(rrp).toBe(1.78)
    expect(fmtBillions(rrp)).toBe('$1.78B')
    expect(net).toBeCloseTo(7073.22, 2)
    expect(fmtBillions(net)).toBe('$7.07T')
  })
})
