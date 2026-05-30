/**
 * /api/market/options-skew  — Dynamic Options Chain Snapshot
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads ?ticker=NVDA (case-insensitive) and returns the parsed options chain
 * for the front-week / nearest-monthly expiration of that underlying.
 *
 * Response shape:
 *   {
 *     ticker:   "NVDA",
 *     spot:     130.25,             // underlying last trade
 *     expiry:   "2025-01-17",
 *     atmIV:    0.42,               // implied vol at the ATM strike (avg call+put)
 *     skewPct:  -8.3,               // 25Δ put IV − 25Δ call IV (%)
 *     callWall: 130,                // strike with max call OI
 *     putWall:  120,                // strike with max put OI
 *     maxPain:  125,                // strike minimising total ITM payout
 *     curve:    [{ label, iv }, …]  // 25P / 10P / ATM / 10C / 25C
 *     openInterestData: [{ strike, callOI, putOI }, …]   // for OI wall chart
 *     contractCount: 412,
 *   }
 *
 * Errors:
 *   400 — invalid / missing ticker
 *   404 — no chain found (delisted, unlisted underlying, expired chain)
 *   503 — Alpaca credentials missing
 *
 * Why a fresh route (vs. piggy-backing on /api/alpaca):
 *   The options chain endpoint lives at a different Alpaca path
 *   (/v1beta1/options/snapshots/…) and returns OCC-style symbol keys that
 *   need bespoke parsing.  Keeping the logic isolated stops the equity proxy
 *   from growing options-specific branches.
 */

import { type NextRequest, NextResponse } from 'next/server'

// ─── Config ───────────────────────────────────────────────────────────────────

const ALPACA_KEY_ID = process.env.ALPACA_API_KEY_ID?.trim() ?? ''
const ALPACA_SECRET = process.env.ALPACA_SECRET_KEY?.trim()  ?? ''
const DATA_API      = 'https://data.alpaca.markets'

const AUTH_HEADERS = {
  'APCA-API-KEY-ID':     ALPACA_KEY_ID,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Accept':              'application/json',
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface AlpacaOptionSnapshot {
  latestTrade?: { p: number; s: number; t: string }
  latestQuote?: { bp: number; ap: number; bs: number; as: number; t: string }
  greeks?: {
    delta?: number
    gamma?: number
    theta?: number
    vega?:  number
    rho?:   number
  }
  impliedVolatility?: number
}

interface OptionSnapshotsResponse {
  snapshots: Record<string, AlpacaOptionSnapshot>
  next_page_token?: string | null
}

interface ParsedContract {
  occ:        string
  underlying: string
  expiry:     string          // YYYY-MM-DD
  type:       'C' | 'P'
  strike:     number
  iv:         number | null   // 0..1 fraction (not %)
  delta:      number | null
  oi:         number          // synthetic — Alpaca doesn't return OI on snapshots
}

export interface OptionsSkewResponse {
  ticker:        string
  spot:          number | null
  expiry:        string
  atmIV:         number       // 0..1
  skewPct:       number       // (25Δ put IV − 25Δ call IV) × 100
  callWall:      number
  putWall:       number
  maxPain:       number
  curve:         { label: string; iv: number }[]
  openInterestData: { strike: number; callOI: number; putOI: number }[]
  contractCount: number
  /**
   * 30-day annualised Historical Volatility computed from the underlying's
   * Alpaca daily closes.  Same scale as `atmIV` (0..1 fraction).  null when
   * we couldn't pull enough daily bars (newly listed, ETF holiday gap, etc.)
   */
  hv30:          number | null
  /**
   * Volatility-Risk-Premium (VRP) classification — comparing front-week IV
   * to realised HV(30) tells us whether options are CHEAP or RICH:
   *   IV > HV × 1.10 → RICH    (options overpaying for realised vol)
   *   IV < HV × 0.90 → CHEAP   (options underpricing realised vol)
   *   else            → FAIR
   */
  vrpLabel:      'CHEAP' | 'FAIR' | 'RICH' | 'UNKNOWN'
  vrpRatio:      number | null   // atmIV / hv30 (null when hv30 unavailable)
  source:        'alpaca'
  timestamp:     number
}

// ─── OCC Symbol Parser ────────────────────────────────────────────────────────
// OCC format: {ROOT}{YYMMDD}{C|P}{STRIKE×1000 zero-padded to 8}
//   e.g. NVDA240119C00130000 → NVDA, 2024-01-19, Call, $130.00
const OCC_RE = /^([A-Z.]{1,6})(\d{6})([CP])(\d{8})$/

function parseOCC(occ: string): Omit<ParsedContract, 'iv' | 'delta' | 'oi'> | null {
  const m = OCC_RE.exec(occ)
  if (!m) return null
  const [, root, yymmdd, cp, strikeRaw] = m
  const yy = parseInt(yymmdd.slice(0, 2), 10)
  const mm = parseInt(yymmdd.slice(2, 4), 10)
  const dd = parseInt(yymmdd.slice(4, 6), 10)
  // 20YY for current decade; 19YY before that doesn't apply to live options
  const fullYear = 2000 + yy
  const expiry = `${fullYear}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
  const strike = parseInt(strikeRaw, 10) / 1000
  return {
    occ,
    underlying: root,
    expiry,
    type:       cp as 'C' | 'P',
    strike,
  }
}

// ─── Fetch Helpers ────────────────────────────────────────────────────────────

async function alpacaFetch<T>(path: string): Promise<T> {
  const res = await fetch(`${DATA_API}${path}`, {
    headers: AUTH_HEADERS as Record<string, string>,
    cache:   'no-store',
    signal:  AbortSignal.timeout(12_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Alpaca ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

async function fetchOptionsChain(ticker: string): Promise<OptionSnapshotsResponse> {
  // feed=indicative serves IEX-style indicative quotes (no SIP subscription
  // required).  limit=1000 maximises chain coverage in a single call.
  const params = new URLSearchParams({ feed: 'indicative', limit: '1000' })
  return alpacaFetch<OptionSnapshotsResponse>(
    `/v1beta1/options/snapshots/${encodeURIComponent(ticker)}?${params}`,
  )
}

/**
 * Fetch the last `barCount` daily closes for the underlying.  Used to
 * compute realised volatility (HV) for the IV-vs-HV premium badge.
 * Returns an empty array on any failure so the caller can degrade
 * gracefully (badge shows UNKNOWN, rest of payload still ships).
 */
async function fetchDailyCloses(ticker: string, barCount = 40): Promise<number[]> {
  try {
    const params = new URLSearchParams({
      symbols:    ticker,
      timeframe:  '1Day',
      limit:      String(barCount),
      feed:       'iex',
      adjustment: 'split',
      sort:       'asc',
    })
    const data = await alpacaFetch<{ bars: Record<string, { c: number }[]> }>(
      `/v2/stocks/bars?${params}`,
    )
    return (data.bars?.[ticker] ?? []).map(b => b.c).filter(c => Number.isFinite(c))
  } catch (e) {
    console.warn(`[options-skew] HV bars fetch failed for ${ticker}:`, e)
    return []
  }
}

/**
 * Annualised historical volatility from a closes array.  Uses standard
 * log-return standard deviation × √252.  Returns null when there isn't
 * enough data (need at least `window + 1` closes).
 *
 *   σ_annual = stddev(log(Pₜ / Pₜ₋₁)) × √252
 */
function computeHV(closes: number[], window = 30): number | null {
  if (closes.length < window + 1) return null
  const recent = closes.slice(-(window + 1))
  const returns: number[] = []
  for (let i = 1; i < recent.length; i++) {
    if (recent[i] > 0 && recent[i - 1] > 0) {
      returns.push(Math.log(recent[i] / recent[i - 1]))
    }
  }
  if (returns.length < 2) return null
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length
  const variance = returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1)
  const sigmaDaily = Math.sqrt(variance)
  return sigmaDaily * Math.sqrt(252)
}

async function fetchEquitySnapshot(ticker: string): Promise<number | null> {
  try {
    const params = new URLSearchParams({ symbols: ticker, feed: 'iex' })
    const data = await alpacaFetch<{
      snapshots: Record<string, { latestTrade?: { p: number }; dailyBar?: { c: number }; prevDailyBar?: { c: number } }>
    }>(`/v2/stocks/snapshots?${params}`)
    const snap = data.snapshots?.[ticker]
    return snap?.latestTrade?.p ?? snap?.dailyBar?.c ?? snap?.prevDailyBar?.c ?? null
  } catch (e) {
    console.warn(`[options-skew] spot fetch failed for ${ticker}:`, e)
    return null
  }
}

// ─── Analytics ────────────────────────────────────────────────────────────────

/** Pick the nearest expiration that has ≥ 20 contracts (filters noise/dead chains). */
function pickFrontExpiry(contracts: ParsedContract[]): string | null {
  const counts = new Map<string, number>()
  for (const c of contracts) counts.set(c.expiry, (counts.get(c.expiry) ?? 0) + 1)
  const today = new Date().toISOString().slice(0, 10)
  const futureExpiries = [...counts.entries()]
    .filter(([e, n]) => e >= today && n >= 20)
    .sort((a, b) => a[0].localeCompare(b[0]))
  return futureExpiries[0]?.[0] ?? null
}

/** Find contract whose delta is closest to target — interpolating across the chain. */
function nearestDelta(contracts: ParsedContract[], target: number): ParsedContract | null {
  let best: ParsedContract | null = null
  let bestDist = Infinity
  for (const c of contracts) {
    if (c.delta == null) continue
    const d = Math.abs(c.delta - target)
    if (d < bestDist) {
      bestDist = d
      best     = c
    }
  }
  return best
}

/** Strike with the maximum sum of `extract(contract)` across all options. */
function maxBy(
  bars: { strike: number; callOI: number; putOI: number }[],
  pick: 'callOI' | 'putOI',
): number {
  if (bars.length === 0) return 0
  return bars.reduce((best, b) => (b[pick] > best[pick] ? b : best), bars[0]).strike
}

/** Max-Pain: strike minimising payout to ITM holders, weighted by OI. */
function computeMaxPain(bars: { strike: number; callOI: number; putOI: number }[]): number {
  if (bars.length === 0) return 0
  const strikes = bars.map(b => b.strike).sort((a, b) => a - b)
  let minPain = Infinity
  let painK   = strikes[0]
  for (const k of strikes) {
    let pain = 0
    for (const b of bars) {
      if (b.strike < k) pain += (k - b.strike) * b.callOI
      if (b.strike > k) pain += (b.strike - k) * b.putOI
    }
    if (pain < minPain) { minPain = pain; painK = k }
  }
  return painK
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  if (!ALPACA_KEY_ID || !ALPACA_SECRET) {
    return NextResponse.json(
      { error: 'Alpaca credentials not configured' },
      { status: 503 },
    )
  }

  const { searchParams } = new URL(req.url)
  const tickerRaw = searchParams.get('ticker')?.trim().toUpperCase() ?? ''

  // Basic ticker sanity (1-5 alpha chars, optional .B suffix for class shares).
  if (!tickerRaw || !/^[A-Z]{1,5}(\.[A-Z])?$/.test(tickerRaw)) {
    return NextResponse.json(
      { error: 'Invalid ticker — provide ?ticker=NVDA' },
      { status: 400 },
    )
  }

  try {
    // Fetch chain + spot + daily closes in parallel — single round-trip.
    // The daily-closes call powers the HV(30) calculation for the
    // IV-vs-HV premium badge.
    const [chain, spot, closes] = await Promise.all([
      fetchOptionsChain(tickerRaw),
      fetchEquitySnapshot(tickerRaw),
      fetchDailyCloses(tickerRaw, 40),
    ])

    const snapshots = chain.snapshots ?? {}
    const rawKeys   = Object.keys(snapshots)

    if (rawKeys.length === 0) {
      return NextResponse.json(
        { error: `No active options chain found for ${tickerRaw}` },
        { status: 404 },
      )
    }

    // Parse every OCC symbol → ParsedContract with greeks + IV.
    const contracts: ParsedContract[] = []
    for (const occ of rawKeys) {
      const parsed = parseOCC(occ)
      if (!parsed) continue
      const snap = snapshots[occ]
      // Synthetic OI proxy: bid-size + ask-size approximates liquidity rank.
      // Alpaca's free snapshot endpoint doesn't return open_interest directly,
      // so this is the cleanest deterministic stand-in for wall computations.
      const oiProxy =
        (snap.latestQuote?.bs ?? 0) + (snap.latestQuote?.as ?? 0) +
        (snap.latestTrade?.s  ?? 0)
      contracts.push({
        ...parsed,
        iv:    snap.impliedVolatility ?? null,
        delta: snap.greeks?.delta     ?? null,
        oi:    Math.max(1, oiProxy),
      })
    }

    if (contracts.length === 0) {
      return NextResponse.json(
        { error: `No active options chain found for ${tickerRaw}` },
        { status: 404 },
      )
    }

    // Pick the front-week / nearest-monthly expiration with enough liquidity.
    const expiry = pickFrontExpiry(contracts)
    if (!expiry) {
      return NextResponse.json(
        { error: `No active options chain found for ${tickerRaw}` },
        { status: 404 },
      )
    }

    const frontChain = contracts.filter(c => c.expiry === expiry)
    const calls = frontChain.filter(c => c.type === 'C')
    const puts  = frontChain.filter(c => c.type === 'P')

    // ── Build OI bars (one entry per unique strike) ─────────────────────────
    const strikeMap = new Map<number, { callOI: number; putOI: number }>()
    for (const c of calls) {
      const e = strikeMap.get(c.strike) ?? { callOI: 0, putOI: 0 }
      e.callOI += c.oi
      strikeMap.set(c.strike, e)
    }
    for (const p of puts) {
      const e = strikeMap.get(p.strike) ?? { callOI: 0, putOI: 0 }
      e.putOI += p.oi
      strikeMap.set(p.strike, e)
    }
    const openInterestData = [...strikeMap.entries()]
      .map(([strike, { callOI, putOI }]) => ({
        strike,
        callOI: Math.round(callOI),
        putOI:  Math.round(putOI),
      }))
      .sort((a, b) => a.strike - b.strike)

    const callWall = maxBy(openInterestData, 'callOI')
    const putWall  = maxBy(openInterestData, 'putOI')
    const maxPain  = computeMaxPain(openInterestData)

    // ── ATM IV: average of nearest 50Δ call & put ───────────────────────────
    const atmCall = nearestDelta(calls,  0.5)
    const atmPut  = nearestDelta(puts,  -0.5)
    const atmIVRaw =
      atmCall?.iv != null && atmPut?.iv != null
        ? (atmCall.iv + atmPut.iv) / 2
        : (atmCall?.iv ?? atmPut?.iv ?? 0)
    const atmIV = atmIVRaw

    // ── Skew curve: 25Δ put / 10Δ put / ATM / 10Δ call / 25Δ call ──────────
    const p25 = nearestDelta(puts,  -0.25)
    const p10 = nearestDelta(puts,  -0.10)
    const c10 = nearestDelta(calls,  0.10)
    const c25 = nearestDelta(calls,  0.25)
    const ivPct = (c: ParsedContract | null) => ((c?.iv ?? atmIVRaw) * 100)
    const curve = [
      { label: '25P', iv: parseFloat(ivPct(p25).toFixed(2)) },
      { label: '10P', iv: parseFloat(ivPct(p10).toFixed(2)) },
      { label: 'ATM', iv: parseFloat((atmIV * 100).toFixed(2)) },
      { label: '10C', iv: parseFloat(ivPct(c10).toFixed(2)) },
      { label: '25C', iv: parseFloat(ivPct(c25).toFixed(2)) },
    ]

    // Delta skew = 25Δ put vol − 25Δ call vol (percentage points).
    const skewPct = parseFloat((ivPct(p25) - ivPct(c25)).toFixed(2))

    // ── HV(30) + Volatility-Risk-Premium classification ─────────────────────
    // ATM IV is already a 0..1 annualised fraction; computeHV returns the
    // same scale, so the ratio is directly comparable.
    const hv30Raw = computeHV(closes, 30)
    const hv30    = hv30Raw !== null ? parseFloat(hv30Raw.toFixed(4)) : null
    const vrpRatio = hv30 && hv30 > 0 ? parseFloat((atmIV / hv30).toFixed(3)) : null
    const vrpLabel: OptionsSkewResponse['vrpLabel'] =
      vrpRatio === null ? 'UNKNOWN' :
      vrpRatio > 1.10   ? 'RICH'    :
      vrpRatio < 0.90   ? 'CHEAP'   : 'FAIR'

    const payload: OptionsSkewResponse = {
      ticker:           tickerRaw,
      spot,
      expiry,
      atmIV:            parseFloat(atmIV.toFixed(4)),
      skewPct,
      callWall,
      putWall,
      maxPain,
      curve,
      openInterestData,
      contractCount:    frontChain.length,
      hv30,
      vrpLabel,
      vrpRatio,
      source:           'alpaca',
      timestamp:        Date.now(),
    }

    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'no-store' },
    })

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 404-shaped Alpaca errors (delisted / never had options) → friendly UI message
    if (msg.includes('404') || msg.toLowerCase().includes('not found')) {
      return NextResponse.json(
        { error: `No active options chain found for ${tickerRaw}` },
        { status: 404 },
      )
    }
    console.error(`[options-skew] ${tickerRaw}:`, msg)
    return NextResponse.json(
      { error: `Failed to load options chain for ${tickerRaw}: ${msg}` },
      { status: 502 },
    )
  }
}
