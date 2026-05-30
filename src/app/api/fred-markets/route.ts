import { NextResponse } from 'next/server'
import type {
  FredMarketsData,
  FredMarketsMeta,
  FredSeriesDiagnostic,
  YieldPoint,
  YieldCurveData,
  DXYPoint,
  DXYData,
} from '@/types/fred-markets'
import {
  fredCacheRead,
  fredCacheWrite,
  fredCacheSeedRead,
  cacheAgeLabel,
} from '@/lib/services/fredCacheStore'

// ─── Config ───────────────────────────────────────────────────────────────────

const FRED_API_KEY  = process.env.FRED_API_KEY?.trim() ?? ''
const FRED_BASE_URL = 'https://api.stlouisfed.org/fred/series/observations'

/** FRED daily series update once per business day (~4-5 PM ET) */
const REVALIDATE_SECS = 900   // 15 min CDN cache

// ─── Boot-time sanity check ──────────────────────────────────────────────────
// Runs once when this module is first imported by the Next.js server.
// Confirms .env.local is wired without ever leaking the key value itself.
console.log(
  '[fred-markets] BOOT — Checking token visibility...',
  {
    present:   !!process.env.FRED_API_KEY,
    keyLength: process.env.FRED_API_KEY?.trim().length ?? 0,
    nodeEnv:   process.env.NODE_ENV,
    note:      process.env.FRED_API_KEY
      ? 'OK — key visible to server runtime'
      : 'MISSING — restart `npm run dev` after editing .env.local',
  },
)

// ─── Series definitions ──────────────────────────────────────────────────────

const YIELD_SERIES: Array<{ id: string; label: string; maturity: number }> = [
  { id: 'DTB3',  label: '3M',  maturity: 0.25 },
  { id: 'DGS2',  label: '2Y',  maturity: 2    },
  { id: 'DGS5',  label: '5Y',  maturity: 5    },
  { id: 'DGS10', label: '10Y', maturity: 10   },
  { id: 'DGS30', label: '30Y', maturity: 30   },
]

const DXY_SERIES = {
  broad: { id: 'DTWEXBGS',   label: 'DXY BROAD' },
  afe:   { id: 'DTWEXAFEGS', label: 'DXY AFE'   },
} as const

/**
 * Sanity bands – anything outside flags a probable unit-mismatch bug.
 *  Treasury yields realistically 0–20 %
 *  Trade-weighted indexes realistically 50–200
 */
const SANITY = {
  YIELD: { min: 0,  max: 20  },
  DXY:   { min: 50, max: 200 },
}

// ─── FRED fetch helpers ───────────────────────────────────────────────────────

interface FREDObservation {
  date:  string
  value: string
}

async function fetchSeries(seriesId: string, limit = 10): Promise<FREDObservation[]> {
  const params = new URLSearchParams({
    series_id:  seriesId,
    api_key:    FRED_API_KEY,
    file_type:  'json',
    sort_order: 'desc',
    limit:      String(limit),
  })

  // AbortSignal.timeout caps each individual FRED series request at 8 s.
  // fred-markets fires 12 parallel requests; without a timeout a single
  // slow FRED call blocks the entire Promise.all until Next.js 504s.
  const res = await fetch(`${FRED_BASE_URL}?${params}`, {
    next:   { revalidate: REVALIDATE_SECS },
    signal: AbortSignal.timeout(8_000),
  })

  if (!res.ok) {
    let detail = ''
    try {
      const errJson = await res.json()
      detail = errJson?.error_message ? ` – ${errJson.error_message}` : ''
    } catch { /* ignore */ }
    throw new Error(`FRED ${seriesId} → HTTP ${res.status}${detail}`)
  }

  const json = await res.json()
  if (json.error_message) {
    throw new Error(`FRED ${seriesId} → ${json.error_message}`)
  }

  /**
   * Strip FRED's '.' sentinel (used for weekends, holidays, unreported days).
   * Because we requested sort_order=desc + limit=10, obs[0] is automatically
   * the latest available **business-day** print — no weekend handling needed.
   */
  const valid: FREDObservation[] = (json.observations ?? []).filter(
    (o: FREDObservation) => o.value !== '.' && o.value.trim() !== '',
  )

  if (valid.length === 0) {
    throw new Error(`FRED ${seriesId} → no valid observations in last ${limit} records`)
  }
  return valid
}

async function fetchSeriesHistory(seriesId: string, limitHistory = 260): Promise<FREDObservation[]> {
  const params = new URLSearchParams({
    series_id:  seriesId,
    api_key:    FRED_API_KEY,
    file_type:  'json',
    sort_order: 'desc',
    limit:      String(limitHistory),
  })

  const res = await fetch(`${FRED_BASE_URL}?${params}`, {
    next:   { revalidate: REVALIDATE_SECS },
    signal: AbortSignal.timeout(8_000),
  })

  if (!res.ok) {
    throw new Error(`FRED ${seriesId} history → HTTP ${res.status}`)
  }

  const json = await res.json()
  if (json.error_message) {
    throw new Error(`FRED ${seriesId} history → ${json.error_message}`)
  }

  const valid: FREDObservation[] = (json.observations ?? []).filter(
    (o: FREDObservation) => o.value !== '.' && o.value.trim() !== '',
  )

  return valid
}

/** Settled-style wrapper – never throws */
type SeriesResult =
  | { ok: true;  seriesId: string; obs: FREDObservation[] }
  | { ok: false; seriesId: string; error: string }

async function safeFetch(seriesId: string, limit = 10): Promise<SeriesResult> {
  try {
    const obs = await fetchSeries(seriesId, limit)
    return { ok: true, seriesId, obs }
  } catch (err) {
    return {
      ok: false,
      seriesId,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

async function safeFetchHistory(seriesId: string, limitHistory = 260): Promise<SeriesResult> {
  try {
    const obs = await fetchSeriesHistory(seriesId, limitHistory)
    return { ok: true, seriesId, obs }
  } catch (err) {
    return {
      ok: false,
      seriesId,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ─── Cache key ────────────────────────────────────────────────────────────────

const CACHE_KEY = 'fred-markets'

// ─── Stale-cache response helper ─────────────────────────────────────────────
//
// Tags all three meta blocks (yieldCurve, dxy, overall) as 'CACHED' so every
// UI badge in the yield curve + DXY panels switches to amber ◐ CACHED · FRED.

function serveStaleCache(
  data:      FredMarketsData,
  fetchedAt: number,
): NextResponse {
  console.warn(
    `[fred-markets] FRED unavailable — serving cache ` +
    `(age: ${cacheAgeLabel(fetchedAt)}, fetched ${new Date(fetchedAt).toISOString()})`,
  )
  const ts = new Date().toISOString()
  const asCached = (m: FredMarketsMeta): FredMarketsMeta =>
    ({ ...m, status: 'CACHED', timestamp: ts })

  const stale: FredMarketsData = {
    ...data,
    yieldCurve: { ...data.yieldCurve, meta: asCached(data.yieldCurve.meta) },
    dxy:        { ...data.dxy,        meta: asCached(data.dxy.meta)        },
    meta:       asCached(data.meta),
  }
  return NextResponse.json(stale, { status: 200 })
}

// ─── Mock fallback data ──────────────────────────────────────────────────────

const DEMO_META: FredMarketsMeta = {
  dataSource: 'MOCK_FALLBACK',
  status:     'DEMO_FALLBACK',
  timestamp:  new Date().toISOString(),
}

function mockYield(
  id: string,
  label: string,
  mat: number,
  rate: number,
  ch: number,
  high52w?: number,
  low52w?: number,
): YieldPoint {
  return {
    seriesId:  id,
    label,
    maturity:  mat,
    rate,
    prevRate:  parseFloat((rate - ch).toFixed(4)),
    change:    ch,
    changeBps: parseFloat((ch * 100).toFixed(2)),
    date:      '—',
    high52w,
    low52w,
  }
}

function mockDXY(id: string, label: string, val: number, ch: number): DXYPoint {
  return {
    seriesId:  id,
    label,
    value:     val,
    prevValue: parseFloat((val - ch).toFixed(4)),
    change:    ch,
    changePct: parseFloat(((ch / (val - ch)) * 100).toFixed(3)),
    date:      '—',
  }
}

// Baseline yields tuned to current real-time benchmark targets (late May 2026):
// 2Y ≈ 3.88%, 10Y ≈ 4.40%.  52-week high/low bands bracket each tenor so the
// fallback never reads as stale-flat when FRED is briefly unavailable.
const MOCK_YIELDS: YieldPoint[] = [
  mockYield('DTB3',  '3M',  0.25, 4.30, -0.01, 4.60, 4.20),
  mockYield('DGS2',  '2Y',  2,    3.88, -0.02, 4.40, 3.70),
  mockYield('DGS5',  '5Y',  5,    4.05, -0.01, 4.55, 3.85),
  mockYield('DGS10', '10Y', 10,   4.40,  0.01, 4.80, 4.05),
  mockYield('DGS30', '30Y', 30,   4.95,  0.02, 5.15, 4.60),
]

const MOCK_RESPONSE: FredMarketsData = {
  yieldCurve: {
    points:            MOCK_YIELDS,
    spread2y10y:       parseFloat((MOCK_YIELDS[3].rate - MOCK_YIELDS[1].rate).toFixed(4)),
    spread2y10yChange: parseFloat((MOCK_YIELDS[3].change - MOCK_YIELDS[1].change).toFixed(4)),
    spread10y3m:       parseFloat((MOCK_YIELDS[3].rate - MOCK_YIELDS[0].rate).toFixed(4)),
    spread10y3mChange: parseFloat((MOCK_YIELDS[3].change - MOCK_YIELDS[0].change).toFixed(4)),
    isInverted:        MOCK_YIELDS[3].rate - MOCK_YIELDS[1].rate < 0,
    steepeningType:    null,
    observationDate:   '—',
    meta:              DEMO_META,
  },
  dxy: {
    broad: mockDXY('DTWEXBGS',   'DXY BROAD', 116.42, -0.18),
    afe:   mockDXY('DTWEXAFEGS', 'DXY AFE',   109.77, -0.14),
    meta:  DEMO_META,
  },
  meta: DEMO_META,
}

// ─── Per-series parsers w/ sanity check & previous-day delta ─────────────────

/**
 * Convert a successful series result → YieldPoint, with sanity-band guard.
 * Returns the diagnostic record alongside the point so the caller can track.
 * If historical data is provided, calculates 52-week high/low.
 */
function buildYieldFromResult(
  def: { id: string; label: string; maturity: number },
  r: SeriesResult,
  historyResult?: SeriesResult,
): { point: YieldPoint; diag: FredSeriesDiagnostic } {
  if (!r.ok) {
    const fallback = MOCK_YIELDS.find(m => m.seriesId === def.id)!
    return {
      point: fallback,
      diag:  {
        resolvedSeriesId: def.id,
        ok:               false,
        error:            r.error,
        usedFallback:     true,
      },
    }
  }

  const latest = parseFloat(r.obs[0].value)
  const prev   = r.obs.length > 1 ? parseFloat(r.obs[1].value) : latest

  // Sanity band check – yields realistically 0–20 %
  if (latest < SANITY.YIELD.min || latest > SANITY.YIELD.max) {
    const fallback = MOCK_YIELDS.find(m => m.seriesId === def.id)!
    console.warn(`[fred-markets] ${def.id} sanity failure: rate ${latest}% out of band`)
    return {
      point: fallback,
      diag:  {
        resolvedSeriesId: def.id,
        ok:               false,
        usedFallback:     true,
        sanityNote:       `rate ${latest}% outside ${SANITY.YIELD.min}–${SANITY.YIELD.max}% band`,
      },
    }
  }

  const change = parseFloat((latest - prev).toFixed(4))

  // Calculate 52-week high/low if history is available
  let high52w: number | undefined
  let low52w: number | undefined

  if (historyResult?.ok && historyResult.obs.length > 0) {
    const validRates = historyResult.obs
      .map(o => parseFloat(o.value))
      .filter(v => !isNaN(v) && v >= SANITY.YIELD.min && v <= SANITY.YIELD.max)

    if (validRates.length > 0) {
      high52w = parseFloat(Math.max(...validRates).toFixed(4))
      low52w = parseFloat(Math.min(...validRates).toFixed(4))
    }
  }

  return {
    point: {
      seriesId:  def.id,
      label:     def.label,
      maturity:  def.maturity,
      rate:      latest,
      prevRate:  prev,
      change,
      changeBps: parseFloat((change * 100).toFixed(2)),
      date:      r.obs[0].date,
      high52w,
      low52w,
    },
    diag: {
      resolvedSeriesId: def.id,
      ok:               true,
      usedFallback:     false,
    },
  }
}

function buildDXYFromResult(
  def: { id: string; label: string },
  r: SeriesResult,
): { point: DXYPoint; diag: FredSeriesDiagnostic } {
  if (!r.ok) {
    const fallback = def.id === 'DTWEXBGS' ? MOCK_RESPONSE.dxy.broad : MOCK_RESPONSE.dxy.afe
    return {
      point: fallback,
      diag:  {
        resolvedSeriesId: def.id,
        ok:               false,
        error:            r.error,
        usedFallback:     true,
      },
    }
  }

  const latest = parseFloat(r.obs[0].value)
  const prev   = r.obs.length > 1 ? parseFloat(r.obs[1].value) : latest

  if (latest < SANITY.DXY.min || latest > SANITY.DXY.max) {
    const fallback = def.id === 'DTWEXBGS' ? MOCK_RESPONSE.dxy.broad : MOCK_RESPONSE.dxy.afe
    console.warn(`[fred-markets] ${def.id} sanity failure: ${latest} out of band`)
    return {
      point: fallback,
      diag:  {
        resolvedSeriesId: def.id,
        ok:               false,
        usedFallback:     true,
        sanityNote:       `index ${latest} outside ${SANITY.DXY.min}–${SANITY.DXY.max} band`,
      },
    }
  }

  const change = parseFloat((latest - prev).toFixed(4))
  return {
    point: {
      seriesId:  def.id,
      label:     def.label,
      value:     latest,
      prevValue: prev,
      change,
      changePct: prev > 0 ? parseFloat(((change / prev) * 100).toFixed(3)) : 0,
      date:      r.obs[0].date,
    },
    diag: {
      resolvedSeriesId: def.id,
      ok:               true,
      usedFallback:     false,
    },
  }
}

// ─── GET Handler ─────────────────────────────────────────────────────────────

export async function GET() {
  // ── 0. Read cache (memory → file) ─────────────────────────────────────────
  const cached = fredCacheRead<FredMarketsData>(CACHE_KEY)

  // ── Guard: no key ──────────────────────────────────────────────────────────
  if (!FRED_API_KEY) {
    if (cached) return serveStaleCache(cached.entry.data, cached.entry.fetchedAt)
    const seed = fredCacheSeedRead<FredMarketsData>(CACHE_KEY)
    if (seed) return serveStaleCache(seed.data, seed.fetchedAt)
    console.warn('[fred-markets] FRED_API_KEY not set – serving mock data')
    return NextResponse.json(MOCK_RESPONSE, { status: 200 })
  }

  // ── Fresh cache hit — skip all 12 FRED requests ───────────────────────────
  if (cached?.fresh) {
    console.info(
      `[fred-markets] Cache hit (age: ${cacheAgeLabel(cached.entry.fetchedAt)}, ` +
      `source: ${cached.source}) — skipping FRED fetch`,
    )
    return NextResponse.json(cached.entry.data, { status: 200 })
  }

  // ── 1. Fire ALL fetches in parallel via safeFetch (no cascade failures) ──
  //       Also fetch historical data (260 obs ≈ 52 weeks) for high/low bands
  const [
    dtb3R, dgs2R, dgs5R, dgs10R, dgs30R,
    broadR, afeR,
    dtb3Hist, dgs2Hist, dgs5Hist, dgs10Hist, dgs30Hist,
  ] = await Promise.all([
    safeFetch('DTB3',       10),
    safeFetch('DGS2',       10),
    safeFetch('DGS5',       10),
    safeFetch('DGS10',      10),
    safeFetch('DGS30',      10),
    safeFetch('DTWEXBGS',   10),
    safeFetch('DTWEXAFEGS', 10),
    safeFetchHistory('DTB3',       260),
    safeFetchHistory('DGS2',       260),
    safeFetchHistory('DGS5',       260),
    safeFetchHistory('DGS10',      260),
    safeFetchHistory('DGS30',      260),
  ])

  // ── 2. Build yield points + diagnostics ─────────────────────────────────
  const yieldResults = [dtb3R, dgs2R, dgs5R, dgs10R, dgs30R]
  const yieldHistResults = [dtb3Hist, dgs2Hist, dgs5Hist, dgs10Hist, dgs30Hist]
  const yieldPoints: YieldPoint[]                  = []
  const yieldDiags: Record<string, FredSeriesDiagnostic> = {}

  YIELD_SERIES.forEach((def, i) => {
    const { point, diag } = buildYieldFromResult(def, yieldResults[i], yieldHistResults[i])
    yieldPoints.push(point)
    yieldDiags[def.id] = diag
  })

  // ── 3. Calculate spreads and steepening classification ─────────────────
  const p3m  = yieldPoints.find(p => p.seriesId === 'DTB3')!
  const p2y  = yieldPoints.find(p => p.seriesId === 'DGS2')!
  const p10y = yieldPoints.find(p => p.seriesId === 'DGS10')!

  const spread2y10y       = parseFloat((p10y.rate   - p2y.rate).toFixed(4))
  const spread2y10yChange = parseFloat((p10y.change - p2y.change).toFixed(4))
  const spread10y3m       = parseFloat((p10y.rate   - p3m.rate).toFixed(4))
  const spread10y3mChange = parseFloat((p10y.change - p3m.change).toFixed(4))

  // ── Steepening Classifier Engine ─────────────────────────────────────────
  // Classification can ONLY occur if curve is actively widening
  let steepeningType: 'BEAR_STEEPENING' | 'BULL_STEEPENING' | null = null

  if (spread2y10yChange > 0) {
    // Curve is widening — classify based on which end is driving it
    if (p10y.change > 0) {
      // Long end rising: BEAR STEEPENING (Growth/Reflationary)
      steepeningType = 'BEAR_STEEPENING'
    } else if (p2y.change < 0) {
      // Short end falling: BULL STEEPENING (Fed Liquidity Pivot)
      steepeningType = 'BULL_STEEPENING'
    }
  }

  // ── 4. DXY ───────────────────────────────────────────────────────────────
  const { point: broad, diag: broadDiag } = buildDXYFromResult(DXY_SERIES.broad, broadR)
  const { point: afe,   diag: afeDiag   } = buildDXYFromResult(DXY_SERIES.afe,   afeR)

  // ── 5. Determine AUTHENTICATED status per panel ─────────────────────────
  //   yieldCurve is "live" if at least DGS2 + DGS10 succeeded (needed for spread)
  //   dxy is "live" if DTWEXBGS (primary broad index) succeeded
  const yieldsAuth = yieldDiags['DGS2'].ok && yieldDiags['DGS10'].ok
  const dxyAuth    = broadDiag.ok

  // Overall: AUTHENTICATED if ANY panel resolved live
  const overallStatus: FredMarketsMeta['status'] =
    yieldsAuth || dxyAuth ? 'AUTHENTICATED' : 'DEMO_FALLBACK'

  // ── 6. Build meta blocks per panel ───────────────────────────────────────
  const baseTs = new Date().toISOString()

  const yieldMeta: FredMarketsMeta = {
    dataSource:  yieldsAuth ? 'FRED_API' : 'MOCK_FALLBACK',
    status:      yieldsAuth ? 'AUTHENTICATED' : 'DEMO_FALLBACK',
    timestamp:   baseTs,
    diagnostics: yieldDiags,
  }

  const dxyMeta: FredMarketsMeta = {
    dataSource:  dxyAuth ? 'FRED_API' : 'MOCK_FALLBACK',
    status:      dxyAuth ? 'AUTHENTICATED' : 'DEMO_FALLBACK',
    timestamp:   baseTs,
    diagnostics: { DTWEXBGS: broadDiag, DTWEXAFEGS: afeDiag },
  }

  const overallMeta: FredMarketsMeta = {
    dataSource:  overallStatus === 'AUTHENTICATED' ? 'FRED_API' : 'MOCK_FALLBACK',
    status:      overallStatus,
    timestamp:   baseTs,
    diagnostics: { ...yieldDiags, DTWEXBGS: broadDiag, DTWEXAFEGS: afeDiag },
  }

  // ── 7. Assemble response ─────────────────────────────────────────────────
  const yieldCurve: YieldCurveData = {
    points:            yieldPoints,
    spread2y10y,
    spread2y10yChange,
    spread10y3m,
    spread10y3mChange,
    isInverted:        spread2y10y < 0,
    steepeningType,
    observationDate:   yieldDiags['DGS10'].ok ? p10y.date : '—',
    meta:              yieldMeta,
  }

  const dxy: DXYData = { broad, afe, meta: dxyMeta }

  const response: FredMarketsData = {
    yieldCurve,
    dxy,
    meta: overallMeta,
  }

  // ── 8. Diagnostic console summary ────────────────────────────────────────
  const yieldSummary = yieldPoints
    .map(p => `${p.label}:${p.rate.toFixed(2)}%${yieldDiags[p.seriesId].ok ? '' : '*'}`)
    .join(' ')

  const steepeningNote = steepeningType ? ` [${steepeningType}]` : ''
  console.info(
    `[fred-markets] ${overallStatus} — ` +
    `Yields[${yieldSummary}]  ` +
    `Spread:${spread2y10y >= 0 ? '+' : ''}${spread2y10y.toFixed(3)}pp${steepeningNote}  ` +
    `DXY:${broad.value.toFixed(2)}${broadDiag.ok ? '' : '*'} ` +
    `AFE:${afe.value.toFixed(2)}${afeDiag.ok ? '' : '*'}  ` +
    `(${Object.values(overallMeta.diagnostics!).filter(d => d.ok).length}/` +
    `${Object.keys(overallMeta.diagnostics!).length} series live)`
  )

  // ── 9. Cache management ──────────────────────────────────────────────────
  // Only update cache when the key yield series (DGS2 + DGS10) resolved live
  // so a fully-mock DEMO_FALLBACK response can never evict good cached data.
  if (overallStatus === 'AUTHENTICATED') {
    fredCacheWrite(CACHE_KEY, response)
  } else {
    // All key fetches failed (429, 504, timeout, etc.) — prefer stale cache
    // over the static mock so the UI keeps showing real yield curve data.
    const is429 = [dgs2R, dgs10R].some(
      r => !r.ok && r.error?.includes('429'),
    )
    console.error(
      '[fred-markets] DEMO_FALLBACK — all key fetches failed.',
      is429 ? '← FRED rate-limit (429) detected' : '',
    )
    if (cached) return serveStaleCache(cached.entry.data, cached.entry.fetchedAt)

    // ── L3: committed seed — real data, always present on any checkout ──────
    const seed = fredCacheSeedRead<FredMarketsData>(CACHE_KEY)
    if (seed) {
      console.warn(
        `[fred-markets] Using committed seed (age: ${cacheAgeLabel(seed.fetchedAt)}) ` +
        '— live FRED unavailable and no file cache exists',
      )
      return serveStaleCache(seed.data, seed.fetchedAt)
    }

    console.warn('[fred-markets] No cache or seed available — returning DEMO_FALLBACK')
  }

  return NextResponse.json(response, { status: 200 })
}
