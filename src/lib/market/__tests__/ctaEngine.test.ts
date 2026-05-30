import { describe, expect, it } from 'vitest'
import {
  ema,
  emaSeries,
  macd,
  adx,
  classifyClustering,
  classifyRegime,
  trendIntensity,
  buildAssetRow,
  type DailyBar,
} from '../ctaEngine'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeBars(closes: number[]): DailyBar[] {
  // Real, zero-padded YYYY-MM-DD dates (one calendar day apart) so the series is
  // lexicographically sortable — matching live Alpaca/FMP/IBKR bar timestamps.
  const base = Date.UTC(2024, 0, 1)
  return closes.map((c, i) => {
    const d = new Date(base + i * 86_400_000)
    return { t: d.toISOString().slice(0, 10), o: c, h: c * 1.01, l: c * 0.99, c, v: 1_000 }
  })
}

/** Synthetic 220-bar uptrend, useful for EMA+MACD smoke tests. */
function uptrendBars(): DailyBar[] {
  return makeBars(Array.from({ length: 220 }, (_, i) => 100 + i * 0.5))
}

// ─── EMA ──────────────────────────────────────────────────────────────────────

describe('ema', () => {
  it('matches simple manual calculation', () => {
    // EMA10 of a flat series should equal that constant.
    expect(ema(Array(20).fill(50), 10)).toBeCloseTo(50, 6)
  })

  it('returns NaN when input is shorter than the period', () => {
    expect(Number.isNaN(ema([1, 2, 3], 10))).toBe(true)
  })

  it('produces a value greater than SMA for an uptrending series', () => {
    // EMA puts more weight on recent values → should sit ABOVE the SMA
    // when the series is monotonically rising.
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i)
    const sma = closes.reduce((a, b) => a + b, 0) / closes.length
    expect(ema(closes, 10)).toBeGreaterThan(sma)
  })
})

describe('emaSeries', () => {
  it('emits NaN warm-up padding and a final value matching ema()', () => {
    const closes = Array.from({ length: 30 }, (_, i) => i + 1)
    const series = emaSeries(closes, 10)
    expect(series.length).toBe(30)
    expect(Number.isNaN(series[0])).toBe(true)
    expect(Number.isNaN(series[8])).toBe(true)   // last warm-up index
    expect(Number.isNaN(series[9])).toBe(false)  // first emitted value
    expect(series[series.length - 1]).toBeCloseTo(ema(closes, 10), 6)
  })
})

// ─── MACD ─────────────────────────────────────────────────────────────────────

describe('macd', () => {
  it('returns positive MACD line on a clear linear uptrend', () => {
    // NB: a perfectly linear ramp produces a CONSTANT MACD line, so the
    // histogram (= macd − signal) is ~0.  Real markets oscillate, so a
    // non-zero histogram check requires non-linear input.
    const closes = Array.from({ length: 60 }, (_, i) => 100 + i)
    const { macd: m, histogram } = macd(closes)
    expect(m).toBeGreaterThan(0)
    expect(Math.abs(histogram)).toBeLessThan(0.01) // ≈ 0 on linear input
  })

  it('returns positive histogram when momentum accelerates', () => {
    // Quadratic ramp — recent moves bigger than older ones.  EMA12 catches
    // up faster than EMA26, so MACD line rises through its 9d signal EMA.
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * i * 0.01)
    const { histogram } = macd(closes)
    expect(histogram).toBeGreaterThan(0)
  })

  it('returns near-zero values on a flat series', () => {
    const { macd: m, histogram } = macd(Array(60).fill(100))
    expect(Math.abs(m)).toBeLessThan(1e-6)
    expect(Math.abs(histogram)).toBeLessThan(1e-6)
  })
})

// ─── ADX ──────────────────────────────────────────────────────────────────────

describe('adx', () => {
  it('measures elevated strength on a strong uptrend', () => {
    const bars = uptrendBars()
    // Make the synthetic uptrend more "ranging" friendly by tightening H/L:
    const trendingBars = bars.map((b, i) => ({ ...b, h: b.c + 0.1, l: b.c - 0.1, o: b.c }))
    const a = adx(trendingBars, 14)
    expect(a).toBeGreaterThan(20)
  })

  it('returns 0 on insufficient data', () => {
    expect(adx(uptrendBars().slice(0, 10), 14)).toBe(0)
  })
})

// ─── Clustering ───────────────────────────────────────────────────────────────

describe('classifyClustering', () => {
  it('labels tight EMAs as COMPRESSED', () => {
    expect(classifyClustering(0.5)).toBe('COMPRESSED')
    expect(classifyClustering(-0.7)).toBe('COMPRESSED')
  })

  it('labels mild divergence as NEUTRAL', () => {
    expect(classifyClustering(2)).toBe('NEUTRAL')
  })

  it('labels wide positive spread as EXPANDING_UP', () => {
    expect(classifyClustering(5)).toBe('EXPANDING_UP')
  })

  it('labels wide negative spread as EXPANDING_DOWN', () => {
    expect(classifyClustering(-5)).toBe('EXPANDING_DOWN')
  })
})

// ─── CTA Trend Intensity ───────────────────────────────────────────────────────

describe('trendIntensity', () => {
  it('returns ~50 (neutral) when price sits exactly on both EMAs', () => {
    const { score, intensityPct } = trendIntensity(100, 100, 100)
    expect(score).toBe(50)
    expect(intensityPct).toBeCloseTo(0, 6)
  })

  it('scores a clean bullish breakout above 75', () => {
    // Price 5%+ above both EMAs with a positive ribbon → strong long.
    const { score } = trendIntensity(110, 104, 100)
    expect(score).toBeGreaterThan(75)
  })

  it('scores a bearish breakdown below 25', () => {
    // Price well below both EMAs with a negative ribbon → strong short.
    const { score } = trendIntensity(90, 96, 100)
    expect(score).toBeLessThan(25)
  })

  it('clamps to the 0..100 range on extreme distance', () => {
    expect(trendIntensity(200, 150, 100).score).toBe(100)
    expect(trendIntensity(40, 70, 100).score).toBe(0)
  })

  it('reports the signed blended intensity percentage', () => {
    const { intensityPct } = trendIntensity(110, 104, 100)
    expect(intensityPct).toBeGreaterThan(0)
  })

  it('caps the score at 50 when price is below the 50-day EMA (guardrail)', () => {
    // price 100 sits BELOW ema50 101, but a strongly positive long-term ribbon
    // (ema200 = 80) would otherwise blend to a bullish >50 reading.  The strict
    // guardrail hard-caps it at 50 (neutral) — never net-long under the 50d line.
    const { score } = trendIntensity(100, 101, 80)
    expect(score).toBe(50)
  })

  it('cannot reach MAX_LONG territory (>75) while price is below EMA50', () => {
    // Even with a very wide bullish ribbon, sub-EMA50 price is capped at 50.
    expect(trendIntensity(100, 105, 60).score).toBeLessThanOrEqual(50)
  })
})

// ─── Regime classifier ───────────────────────────────────────────────────────

describe('classifyRegime', () => {
  it('labels strong uptrend + crowded longs as MAX_LONG', () => {
    expect(classifyRegime({
      priceAboveEMA50: true, priceAboveEMA200: true,
      adx: 30, histogram: 1.2, positioningScore: 85,
    })).toBe('MAX_LONG')
  })

  it('labels strong downtrend + crowded shorts as MAX_CROWDED_SHORT', () => {
    expect(classifyRegime({
      priceAboveEMA50: false, priceAboveEMA200: false,
      adx: 30, histogram: -1.2, positioningScore: 10,
    })).toBe('MAX_CROWDED_SHORT')
  })

  it('flags a falling MACD over an uptrend as TREND_CLIPPED', () => {
    expect(classifyRegime({
      priceAboveEMA50: true, priceAboveEMA200: true,
      adx: 18, histogram: -0.3, positioningScore: 70,
    })).toBe('TREND_CLIPPED')
  })

  it('falls back to NEUTRAL when conditions do not match', () => {
    expect(classifyRegime({
      priceAboveEMA50: true, priceAboveEMA200: false,
      adx: 15, histogram: 0.1, positioningScore: 50,
    })).toBe('NEUTRAL')
  })
})

// ─── Top-level engine row build ──────────────────────────────────────────────

describe('buildAssetRow', () => {
  it('returns a DATA_STALE_OR_MISSING stub when fewer than 200 bars are supplied', () => {
    // Used to throw — now degrades gracefully so the route handler can
    // ship a clean 200 payload instead of a 502 crash.
    const row = buildAssetRow({
      asset: 'X', name: 'Test', bars: uptrendBars().slice(0, 100),
    })
    expect(row.regime).toBe('DATA_STALE_OR_MISSING')
    expect(row.asset).toBe('X')
    expect(row.ema50).toBe(0)
    expect(row.adx).toBe(0)
    expect(row.positioningScore).toBe(50)            // no trend computable → neutral
    expect(row.trendIntensityPct).toBe(0)
  })

  it('produces a valid CTAAssetRow with a bullish trend score for a synthetic uptrend', () => {
    const bars = uptrendBars()
    const row = buildAssetRow({ asset: 'TEST', name: 'Synthetic uptrend', bars })
    expect(row.ema50).toBeGreaterThan(row.ema200)   // 50d should sit above 200d
    expect(row.emaSpreadPct).toBeGreaterThan(0)
    expect(['EXPANDING_UP', 'NEUTRAL']).toContain(row.clustering)
    // Trend intensity is derived from the bars, not CFTC — uptrend → bullish.
    expect(row.positioningScore).toBeGreaterThan(75)
    expect(row.trendIntensityPct).toBeGreaterThan(0)
    expect(row.regime).not.toBe('DATA_STALE_OR_MISSING')
  })

  it('stamps the positioning timestamp with the latest bar date', () => {
    const bars = uptrendBars()
    const row = buildAssetRow({ asset: 'DATE', name: 'Timestamped', bars })
    expect(row.positioningDate).toBe(bars[bars.length - 1].t)
  })

  it('reads the most-recent bar even when the input is in descending order', () => {
    const asc  = uptrendBars()                       // oldest → newest (last is highest)
    const desc = [...asc].reverse()                  // newest → oldest (inverted)
    const rowAsc  = buildAssetRow({ asset: 'A', name: 'asc',  bars: asc })
    const rowDesc = buildAssetRow({ asset: 'D', name: 'desc', bars: desc })
    // Defensive sort means both resolve to the same latest price / date / score.
    expect(rowDesc.currentPrice).toBe(rowAsc.currentPrice)
    expect(rowDesc.positioningDate).toBe(rowAsc.positioningDate)
    expect(rowDesc.positioningScore).toBe(rowAsc.positioningScore)
  })

  it('aligns regime with the trend-intensity band (uptrend > 75 ⇒ MAX_LONG)', () => {
    const row = buildAssetRow({ asset: 'UP', name: 'Strong uptrend', bars: uptrendBars() })
    expect(row.positioningScore).toBeGreaterThan(75)
    expect(row.regime).toBe('MAX_LONG')
  })

  it('stub row sets neutral trend positioning when bars are insufficient', () => {
    const bars = uptrendBars().slice(0, 50)
    const row = buildAssetRow({ asset: 'PARTIAL', name: 'Partial-history asset', bars })
    expect(row.regime).toBe('DATA_STALE_OR_MISSING')
    expect(row.positioningScore).toBe(50)
    expect(row.positioningDate).toBe(bars[bars.length - 1].t)
  })
})
