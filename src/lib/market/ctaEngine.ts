/**
 * Systematic CTA Exposure Engine
 * ─────────────────────────────────────────────────────────────────────────────
 * Trend-following position estimator for the core futures-tracking ETF basket.
 *
 * For each asset the engine derives:
 *   - 50-day & 200-day exponential moving averages (EMA)
 *   - 14-day momentum velocity (MACD line + ADX strength)
 *   - EMA "clustering": the absolute % distance between the 50d and 200d EMA
 *     mapped to an expansion-vs-compression visual indicator
 *   - Regime label: MAX LONG / TREND CLIPPED · DE-LEVERAGING /
 *                   SHORT EXPANSION / MAX CROWDED SHORT / NEUTRAL
 *   - Historical positioning score (0-100): current Managed-Money net
 *     contracts vs. the 3-year extremes from the CFTC TFF dataset
 *
 * Pure functions only — no side effects.  Data fetching lives in the
 * /api/market/cta-engine route handler so this file is unit-testable.
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DailyBar {
  t: string  // ISO date
  o: number; h: number; l: number; c: number; v: number
}

export type CTARegime =
  | 'MAX_LONG'
  | 'TREND_CLIPPED'
  | 'NEUTRAL'
  | 'SHORT_EXPANSION'
  | 'MAX_CROWDED_SHORT'
  | 'DATA_STALE_OR_MISSING'
  // Live-snapshot fallback: no rolling-bar history available, so EMA fields
  // carry intraday open/prior-close proxies derived from the live Alpaca tick.
  | 'LIVE_TRACKING'

export type EMAClustering = 'EXPANDING_UP' | 'EXPANDING_DOWN' | 'COMPRESSED' | 'NEUTRAL'

export interface CTAAssetRow {
  asset:           string
  name:            string
  currentPrice:    number
  ema50:           number
  ema200:          number
  ema50vsPricePct: number   // (price − ema50) / ema50 × 100
  emaSpreadPct:    number   // (ema50 − ema200) / ema200 × 100  (positive = uptrend)
  clustering:      EMAClustering
  macd:            number   // 12/26 MACD line
  signal:          number   // 9-day EMA of MACD line
  histogram:       number   // macd − signal
  adx:             number   // 14-day Average Directional Index
  regime:          CTARegime
  /** CTA Trend Intensity: 0 (max short) … 50 (neutral) … 100 (max long).
   *  Derived purely from the EMA ribbon — no CFTC / external positioning data. */
  positioningScore: number
  /** Signed trend-intensity distance off the breakout level, e.g. +5.8 / −1.5 (%). */
  trendIntensityPct: number
  /** Date of the latest processed daily bar (YYYY-MM-DD) — the positioning timestamp. */
  positioningDate:  string
}

// ─── EMA / MACD / ADX primitives ─────────────────────────────────────────────

/**
 * Exponential Moving Average over `period`.  Uses the standard
 * `α = 2 / (period + 1)` smoothing.  Returns NaN if the input is shorter
 * than `period`, otherwise returns the final EMA value.
 */
export function ema(closes: number[], period: number): number {
  if (closes.length < period) return NaN
  const k = 2 / (period + 1)
  // Seed with the simple moving average of the first `period` closes.
  let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k)
  }
  return prev
}

/** Full EMA series — returned aligned to input length (NaN padding for warm-up). */
export function emaSeries(closes: number[], period: number): number[] {
  const out = new Array<number>(closes.length).fill(NaN)
  if (closes.length < period) return out
  const k = 2 / (period + 1)
  let prev = closes.slice(0, period).reduce((a, b) => a + b, 0) / period
  out[period - 1] = prev
  for (let i = period; i < closes.length; i++) {
    prev = closes[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/**
 * MACD(12,26,9) — returns the final {macd, signal, histogram} triple.
 * MACD line  = EMA12 − EMA26
 * Signal     = EMA9 of MACD line
 * Histogram  = MACD − Signal
 */
export function macd(closes: number[]): { macd: number; signal: number; histogram: number } {
  const e12 = emaSeries(closes, 12)
  const e26 = emaSeries(closes, 26)
  const macdLine: number[] = []
  for (let i = 0; i < closes.length; i++) {
    if (!Number.isNaN(e12[i]) && !Number.isNaN(e26[i])) {
      macdLine.push(e12[i] - e26[i])
    }
  }
  if (macdLine.length === 0) return { macd: 0, signal: 0, histogram: 0 }
  const sig = ema(macdLine, 9)
  const m   = macdLine[macdLine.length - 1]
  return { macd: m, signal: sig, histogram: m - sig }
}

/**
 * Average Directional Index (ADX-14).  Standard Wilder formulation.
 * Returns 0..100.  ADX < 20 → ranging; ADX > 25 → trending strongly.
 *
 * This is a compact iterative implementation — accurate enough for regime
 * detection without pulling a charting library.
 */
export function adx(bars: DailyBar[], period = 14): number {
  if (bars.length < period * 2) return 0
  const len = bars.length
  let trSum = 0, plusDmSum = 0, minusDmSum = 0
  // Initial period accumulation
  for (let i = 1; i <= period; i++) {
    const cur = bars[i], prev = bars[i - 1]
    const tr     = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c))
    const upMove   = cur.h - prev.h
    const downMove = prev.l - cur.l
    trSum      += tr
    plusDmSum  += upMove   > downMove && upMove   > 0 ? upMove   : 0
    minusDmSum += downMove > upMove   && downMove > 0 ? downMove : 0
  }

  let smoothedTR    = trSum
  let smoothedPlus  = plusDmSum
  let smoothedMinus = minusDmSum
  const dxValues: number[] = []

  for (let i = period + 1; i < len; i++) {
    const cur = bars[i], prev = bars[i - 1]
    const tr     = Math.max(cur.h - cur.l, Math.abs(cur.h - prev.c), Math.abs(cur.l - prev.c))
    const upMove   = cur.h - prev.h
    const downMove = prev.l - cur.l
    const plusDm   = upMove   > downMove && upMove   > 0 ? upMove   : 0
    const minusDm  = downMove > upMove   && downMove > 0 ? downMove : 0

    // Wilder smoothing: subtract 1/period of prior, add new.
    smoothedTR    = smoothedTR    - smoothedTR    / period + tr
    smoothedPlus  = smoothedPlus  - smoothedPlus  / period + plusDm
    smoothedMinus = smoothedMinus - smoothedMinus / period + minusDm

    const plusDI  = (smoothedPlus  / smoothedTR) * 100
    const minusDI = (smoothedMinus / smoothedTR) * 100
    const dx = (Math.abs(plusDI - minusDI) / Math.max(plusDI + minusDI, 1e-9)) * 100
    dxValues.push(dx)
  }

  // Final ADX = Wilder-smoothed mean of DX values
  if (dxValues.length === 0) return 0
  let adxVal = dxValues.slice(0, period).reduce((a, b) => a + b, 0) / period
  for (let i = period; i < dxValues.length; i++) {
    adxVal = (adxVal * (period - 1) + dxValues[i]) / period
  }
  // Flat bars (all OHLC identical) produce smoothedTR=0 → NaN via 0/0.
  // JSON.stringify converts NaN→null which crashes .toFixed() on the client.
  if (!Number.isFinite(adxVal)) return 0
  return parseFloat(adxVal.toFixed(2))
}

// ─── EMA clustering classifier ────────────────────────────────────────────────

/**
 * Maps EMA spread to a clustering label.
 *   |spread| < 1%   → COMPRESSED (trend exhaustion / consolidation)
 *   |spread| < 3%   → NEUTRAL
 *   spread > 3%     → EXPANDING_UP   (50d well above 200d, bull trend)
 *   spread < -3%    → EXPANDING_DOWN (50d well below 200d, bear trend)
 */
export function classifyClustering(emaSpreadPct: number): EMAClustering {
  const abs = Math.abs(emaSpreadPct)
  if (abs < 1) return 'COMPRESSED'
  if (abs < 3) return 'NEUTRAL'
  return emaSpreadPct > 0 ? 'EXPANDING_UP' : 'EXPANDING_DOWN'
}

// ─── Regime classifier ───────────────────────────────────────────────────────

/**
 * Maps the Trend Intensity score (+ momentum nuance) to a discrete regime label.
 *
 * The headline regime is driven directly by the 0-100 Trend Intensity score so
 * the badge can never disagree with the number shown next to it:
 *   MAX_LONG          — score > 75  (clean bullish breakout)
 *   MAX_CROWDED_SHORT — score < 25  (bearish breakdown)
 * The mid-band (25-75) is refined by momentum / trend structure:
 *   TREND_CLIPPED     — uptrend but MACD histogram rolling over
 *   SHORT_EXPANSION   — price below both EMAs and trending lower (ADX > 25)
 *   NEUTRAL           — otherwise
 */
export function classifyRegime(args: {
  priceAboveEMA50: boolean
  priceAboveEMA200: boolean
  adx: number
  histogram: number
  positioningScore: number
}): CTARegime {
  const { priceAboveEMA50, priceAboveEMA200, adx, histogram, positioningScore } = args

  // Headline bands — score drives MAX LONG / MAX CROWDED SHORT directly.
  if (positioningScore > 75) return 'MAX_LONG'
  if (positioningScore < 25) return 'MAX_CROWDED_SHORT'

  // Mid-band nuance from momentum / trend structure.
  const trending = adx > 25
  if (priceAboveEMA50 && histogram < 0 && positioningScore > 60) return 'TREND_CLIPPED'
  if (!priceAboveEMA50 && !priceAboveEMA200 && trending)         return 'SHORT_EXPANSION'
  return 'NEUTRAL'
}

// ─── CTA Trend Intensity ───────────────────────────────────────────────────────

/**
 * CTA Trend Intensity Signal — a pure trend-following positioning metric derived
 * from the Moving-Average Ribbon (price vs 50/200d EMA + the 50/200 spread).  No
 * CFTC or external positioning data is involved.
 *
 * Returns:
 *   • intensityPct — the signed trend distance off the breakout level (%), the
 *     blended average of price-vs-EMA50, price-vs-EMA200 and the EMA ribbon.
 *   • score        — that intensity mapped to a 0-100 conviction scale:
 *        50  = neutral / at the ribbon
 *        >75 = clean bullish breakout   (≈ +5% intensity)
 *        <25 = bearish breakdown        (≈ −5% intensity)
 *        0 / 100 saturate at ±10% intensity.
 */
export function trendIntensity(
  price: number,
  ema50: number,
  ema200: number,
): { score: number; intensityPct: number } {
  const pct = (v: number, ref: number) => (ref !== 0 ? ((v - ref) / ref) * 100 : 0)
  const p50    = pct(price, ema50)    // price vs 50d EMA
  const p200   = pct(price, ema200)   // price vs 200d EMA
  const ribbon = pct(ema50, ema200)   // 50d vs 200d ribbon structure
  const intensityPct = (p50 + p200 + ribbon) / 3
  // ±5% ⇒ 75/25, ±10% ⇒ 100/0 (scale factor 5).
  let score = Math.max(0, Math.min(100, Math.round(50 + intensityPct * 5)))

  // Strict sanity guardrail: a close trading BELOW its 50-day EMA cannot be a
  // net-long reading.  The score is hard-capped at 50 (neutral) so the ribbon's
  // long-term tilt can never manufacture a bullish (>50) trend reading while
  // price sits under the 50d line.  This makes a MAX_LONG (>75) state impossible
  // sub-EMA50 by construction.
  if (price < ema50 && score > 50) score = 50

  return { score, intensityPct: parseFloat(intensityPct.toFixed(2)) }
}

// ─── Top-level engine entry ──────────────────────────────────────────────────

/**
 * Build a stub row representing an asset whose bar history is too short
 * for the EMA200 / ADX-14 calculations.  This used to throw; now it
 * degrades gracefully so the API can return a clean 200 payload that
 * includes the missing row with an explicit DATA_STALE_OR_MISSING regime,
 * rather than dropping the row entirely or crashing with a 502.
 */
export function buildStaleRow(args: {
  asset: string
  name:  string
  bars?: DailyBar[]
}): CTAAssetRow {
  const { asset, name, bars = [] } = args
  // Defensive: force ascending (oldest → newest) so index length-1 is the most
  // recent bar regardless of the provider's sort order.
  const ordered   = [...bars].sort((a, b) => a.t.localeCompare(b.t))
  const lastBar   = ordered.length ? ordered[ordered.length - 1] : null
  const lastClose = lastBar ? lastBar.c : 0
  return {
    asset,
    name,
    currentPrice:    parseFloat((lastClose ?? 0).toFixed(4)),
    ema50:           0,
    ema200:          0,
    ema50vsPricePct: 0,
    emaSpreadPct:    0,
    clustering:      'NEUTRAL',
    macd:            0,
    signal:          0,
    histogram:       0,
    adx:             0,
    regime:          'DATA_STALE_OR_MISSING',
    // No bar history → no computable trend → neutral 50, zero intensity.
    positioningScore:  50,
    trendIntensityPct: 0,
    positioningDate:   lastBar ? lastBar.t : '',
  }
}

/** Minimal live-quote shape needed to build a snapshot proxy row. */
export interface LiveSnapshot {
  /** Last/most-recent trade price. */
  price:     number
  /** Current trading session's open (intraday anchor). Null if unavailable. */
  open:      number | null
  /** Prior session close (price − session change). Null if unavailable. */
  prevClose: number | null
}

/**
 * Build a LIVE-PROXY row when no rolling-bar history exists for an asset but a
 * live Alpaca snapshot price IS available (the common case for ETFs whose IEX
 * daily-bar history comes back empty).  Instead of a dead DATA_STALE stub, the
 * EMA fields are anchored to the snapshot's own day boundaries:
 *   • ema50  proxy = session OPEN   (today's intraday anchor)
 *   • ema200 proxy = prior CLOSE    (price − session change)
 *   • "vs 50d"     = price drift off the open
 *   • clustering   = open vs prior close (the daily open/close boundary move)
 * ADX / MACD are left at 0 (not computable from a single tick, and no longer
 * surfaced in the UI).  Regime is the valid 'LIVE_TRACKING' state so the
 * component lights up with live numbers rather than an empty payload.
 */
export function buildLiveProxyRow(args: {
  asset:    string
  name:     string
  snapshot: LiveSnapshot
}): CTAAssetRow {
  const { asset, name, snapshot } = args
  const fin = (n: number) => Number.isFinite(n) ? n : 0
  const pct = (v: number, ref: number) => ref !== 0 ? ((v - ref) / ref) * 100 : 0

  const price       = snapshot.price
  const ema50Proxy  = snapshot.open      ?? price                  // intraday anchor
  const ema200Proxy = snapshot.prevClose ?? snapshot.open ?? price // prior-session anchor
  const emaSpreadPct = pct(ema50Proxy, ema200Proxy)

  // Trend intensity from the snapshot's own day boundaries (no CFTC).
  const trend = trendIntensity(price, ema50Proxy, ema200Proxy)

  return {
    asset,
    name,
    currentPrice:    parseFloat(fin(price).toFixed(4)),
    ema50:           parseFloat(fin(ema50Proxy).toFixed(4)),
    ema200:          parseFloat(fin(ema200Proxy).toFixed(4)),
    ema50vsPricePct: parseFloat(fin(pct(price, ema50Proxy)).toFixed(2)),
    emaSpreadPct:    parseFloat(fin(emaSpreadPct).toFixed(2)),
    clustering:      classifyClustering(emaSpreadPct),
    macd:            0,
    signal:          0,
    histogram:       0,
    adx:             0,
    regime:          'LIVE_TRACKING',
    positioningScore:  trend.score,
    trendIntensityPct: trend.intensityPct,
    // Live snapshot → positioning timestamp is today's active date.
    positioningDate:   new Date().toISOString().slice(0, 10),
  }
}

/**
 * Aggregate all calculations for a single asset.  Returns a stub row with
 * `regime: 'DATA_STALE_OR_MISSING'` instead of throwing when the bar
 * history is too short — the route handler relies on this to deliver a
 * 200 response even if Alpaca returns zero bars for one of the universe
 * entries.
 */
export function buildAssetRow(args: {
  asset:   string
  name:    string
  bars:    DailyBar[]
}): CTAAssetRow {
  const { asset, name, bars } = args
  // Defensive: force ascending (oldest → newest) so every downstream calc reads
  // the most-recent bar at index length-1 — never an inverted/descending series.
  const ordered = [...bars].sort((a, b) => a.t.localeCompare(b.t))
  if (ordered.length < 200) {
    // Graceful degradation — the route stays 200, the UI shows a clear
    // "DATA STALE OR MISSING" badge instead of an opaque 502.
    return buildStaleRow({ asset, name, bars: ordered })
  }
  const closes = ordered.map(b => b.c)
  const price  = closes[closes.length - 1]   // most recent close

  const e50  = ema(closes, 50)
  const e200 = ema(closes, 200)
  const macdData = macd(closes)
  const adxVal   = adx(ordered, 14)

  const ema50vsPricePct = ((price - e50)  / e50)  * 100
  const emaSpreadPct    = ((e50   - e200) / e200) * 100
  const clustering      = classifyClustering(emaSpreadPct)

  // CTA Trend Intensity — pure trend positioning from the EMA ribbon (no CFTC).
  const trend    = trendIntensity(price, e50, e200)
  const posScore = trend.score

  const regime = classifyRegime({
    priceAboveEMA50:  price > e50,
    priceAboveEMA200: price > e200,
    adx:              adxVal,
    histogram:        macdData.histogram,
    positioningScore: posScore,
  })

  // JSON.stringify converts NaN → null; any null reaching .toFixed() on the
  // client crashes the render.  Coerce every numeric field to 0 if not finite.
  const fin = (n: number) => Number.isFinite(n) ? n : 0

  return {
    asset,
    name,
    currentPrice:    parseFloat(fin(price).toFixed(4)),
    ema50:           parseFloat(fin(e50).toFixed(4)),
    ema200:          parseFloat(fin(e200).toFixed(4)),
    ema50vsPricePct: parseFloat(fin(ema50vsPricePct).toFixed(2)),
    emaSpreadPct:    parseFloat(fin(emaSpreadPct).toFixed(2)),
    clustering,
    macd:            parseFloat(fin(macdData.macd).toFixed(4)),
    signal:          parseFloat(fin(macdData.signal).toFixed(4)),
    histogram:       parseFloat(fin(macdData.histogram).toFixed(4)),
    adx:             fin(adxVal),
    regime,
    positioningScore:  fin(posScore),
    trendIntensityPct: fin(trend.intensityPct),
    // Positioning timestamp = the latest processed daily bar's date.
    positioningDate:   ordered[ordered.length - 1].t,
  }
}
