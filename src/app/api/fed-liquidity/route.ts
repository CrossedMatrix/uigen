import { NextResponse } from 'next/server'
import type {
  FedLiquiditySnapshot,
  FedLiquidityMeta,
  FedLiquidityDiagnostic,
} from '@/lib/types/fed-liquidity'
import { toPrecise, computeNetLiquidity } from '@/lib/format/fedLiquidity'
import {
  fredCacheRead,
  fredCacheWrite,
  fredCacheSeedRead,
  cacheAgeLabel,
} from '@/lib/services/fredCacheStore'

// ─── Config ───────────────────────────────────────────────────────────────────

const FRED_API_KEY  = process.env.FRED_API_KEY?.trim() ?? ''
const FRED_BASE_URL = 'https://api.stlouisfed.org/fred/series/observations'

// ─── Boot-time sanity check ──────────────────────────────────────────────────
// Runs once when this module is first imported by the Next.js server.
// Prints a boolean so we can verify .env.local is wired correctly WITHOUT
// ever leaking the actual key into logs.
console.log(
  '[fed-liquidity] BOOT — Checking token visibility...',
  {
    present:    !!process.env.FRED_API_KEY,
    keyLength:  process.env.FRED_API_KEY?.trim().length ?? 0,
    nodeEnv:    process.env.NODE_ENV,
    note:       process.env.FRED_API_KEY
      ? 'OK — key visible to server runtime'
      : 'MISSING — restart `npm run dev` after editing .env.local',
  },
)

/**
 * Series definitions with unit information.
 *
 *   WALCL    – Total Assets (Wednesday Level)        [Millions of USD] – Weekly
 *   WDTGAL   – Treasury General Account (Wed Level)  [Millions of USD] – Weekly
 *               • Backup for TGA in case WTREGEN is unavailable.
 *   WTREGEN  – User-requested TGA proxy              [Millions or Billions, unverified]
 *               • Often returns 404 / wrong data on FRED – we try it first
 *                 and fall back to WDTGAL when it fails or returns garbage.
 *   RRPONTSYD – ON Reverse Repo: Treasury Securities [Billions of USD] – Daily
 *
 * Net Liquidity = (WALCL / 1_000) − TGA_billions − RRPONTSYD_billions
 */
const SERIES = {
  WALCL:     { id: 'WALCL',     toBillions: (v: number) => v / 1_000 },
  WTREGEN:   { id: 'WTREGEN',   toBillions: (v: number) => v / 1_000 }, // assume millions, sanity-checked below
  WDTGAL:    { id: 'WDTGAL',    toBillions: (v: number) => v / 1_000 }, // millions
  RRPONTSYD: { id: 'RRPONTSYD', toBillions: (v: number) => v        }, // already billions
} as const

// Sanity bands (in billions) – anything outside means we likely have the
// wrong unit or wrong series (sentinel for unit-mismatch bugs).
const SANITY = {
  WALCL_BS:    { min: 1_000, max: 15_000 }, // Fed BS realistically 1–15 T
  TGA:         { min: 1,     max: 2_500  }, // TGA realistically 1 B – 2.5 T
  RRP:         { min: 0,     max: 5_000  }, // RRP realistically 0 – 5 T
}

// ─── Cache key ────────────────────────────────────────────────────────────────

const CACHE_KEY = 'fed-liquidity'

// ─── Stale-cache response helper ─────────────────────────────────────────────
//
// Tags the snapshot's meta.status as 'CACHED' so the UI badge switches from
// ■ DEMO DATA  →  ◐ CACHED · FRED  (amber, real data, not live).

function serveStaleCache(
  snapshot:  FedLiquiditySnapshot,
  fetchedAt: number,
): NextResponse {
  console.warn(
    `[fed-liquidity] FRED unavailable — serving cache ` +
    `(age: ${cacheAgeLabel(fetchedAt)}, fetched ${new Date(fetchedAt).toISOString()})`,
  )
  const stale: FedLiquiditySnapshot = {
    ...snapshot,
    meta: snapshot.meta
      ? { ...snapshot.meta, status: 'CACHED', timestamp: new Date().toISOString() }
      : undefined,
  }
  return NextResponse.json(stale, { status: 200 })
}

// ─── FRED Mock Fallback ──────────────────────────────────────────────────────

const DEMO_META: FedLiquidityMeta = {
  dataSource:  'MOCK_FALLBACK',
  status:      'DEMO_FALLBACK',
  seriesDates: { fta: '—', tga: '—', rro: '—' },
  timestamp:   new Date().toISOString(),
}

// All figures are in BILLIONS of USD on a single normalized scale, matching the
// live parser (WALCL millions→billions via /1_000; RRPONTSYD already billions).
//
// RRPONTSYD note: the overnight reverse-repo facility drained from its
// 2022-23 peak (~$2.48 T) down to a few billion dollars by 2026.  The previous
// mock hard-coded rrp: 2_480 (=$2.48 T), which inflated the "drained" metric and
// collapsed net liquidity.  The realistic late-May-2026 level fluctuates between
// roughly $1 B and $2 B, so net liquidity lands in the correct ~$5.6-5.7 T band:
//   netLiquidity = balanceSheetTotal − tga − rrp = 6480 − 830 − 1.5 = 5648.5
const MOCK_SNAPSHOT: FedLiquiditySnapshot = {
  date:              new Date().toISOString().split('T')[0],
  balanceSheetTotal: 6_480,
  tga:               830,
  rrp:               1.5,
  netLiquidity:      5_648.5,
  momentum14d:       -0.30,
  momentumDirection: 'contracting',
  meta:              DEMO_META,
}

// ─── FRED Fetch Helpers ───────────────────────────────────────────────────────

interface FREDObservation {
  date:  string
  value: string  // FRED returns '.' for missing values
}

/**
 * Fetches the most recent `limit` observations for `seriesId`.
 * Throws on non-2xx, missing observations, or FRED-side error_message.
 */
async function fetchSeries(seriesId: string, limit = 25): Promise<FREDObservation[]> {
  const params = new URLSearchParams({
    series_id:  seriesId,
    api_key:    FRED_API_KEY,
    file_type:  'json',
    sort_order: 'desc',
    limit:      String(limit),
  })

  // AbortSignal.timeout caps each individual FRED request at 8 s.
  // Without this, a slow FRED server causes the Promise.all to hang
  // until Next.js kills the whole handler with a 504.
  const res = await fetch(`${FRED_BASE_URL}?${params}`, {
    next:   { revalidate: 3600 },
    signal: AbortSignal.timeout(8_000),
  })

  if (!res.ok) {
    // FRED returns 400 with an error_message body for invalid series IDs
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

  const valid: FREDObservation[] = (json.observations ?? []).filter(
    (o: FREDObservation) => o.value !== '.' && o.value.trim() !== '',
  )

  if (valid.length === 0) {
    throw new Error(`FRED ${seriesId} → no valid observations returned`)
  }

  return valid
}

/**
 * Settled-style wrapper: never throws. Returns success or failure record so
 * the caller can decide per-series whether to fall back.
 */
type SeriesResult =
  | { ok: true;  seriesId: string; obs: FREDObservation[] }
  | { ok: false; seriesId: string; error: string }

async function safeFetch(seriesId: string, limit = 25): Promise<SeriesResult> {
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

/** Given observations sorted DESC, return the one closest to (≤) target. */
function findNearest(obs: FREDObservation[], target: Date): FREDObservation {
  const targetMs = target.getTime()
  for (const o of obs) {
    if (new Date(o.date).getTime() <= targetMs) return o
  }
  return obs[obs.length - 1]
}

// ─── GET Handler ──────────────────────────────────────────────────────────────

export async function GET() {
  // ── 0. Read cache (memory → file) ─────────────────────────────────────────
  const cached = fredCacheRead<FedLiquiditySnapshot>(CACHE_KEY)

  // ── Guard: no key ──────────────────────────────────────────────────────────
  // Even without a key we can serve a prior successful cache entry so the UI
  // shows real data after a server restart where the key was temporarily absent.
  if (!FRED_API_KEY) {
    if (cached) return serveStaleCache(cached.entry.data, cached.entry.fetchedAt)
    const seed = fredCacheSeedRead<FedLiquiditySnapshot>(CACHE_KEY)
    if (seed) return serveStaleCache(seed.data, seed.fetchedAt)
    console.warn('[fed-liquidity] FRED_API_KEY not set – serving mock data')
    return NextResponse.json({ ...MOCK_SNAPSHOT, meta: DEMO_META }, { status: 200 })
  }

  // ── Fresh cache hit — skip FRED entirely ──────────────────────────────────
  if (cached?.fresh) {
    console.info(
      `[fed-liquidity] Cache hit (age: ${cacheAgeLabel(cached.entry.fetchedAt)}, ` +
      `source: ${cached.source}) — skipping FRED fetch`,
    )
    return NextResponse.json(cached.entry.data, { status: 200 })
  }

  // ── 1. Fire all primary requests in parallel (no rejection cascades) ─────
  //   HY-OAS and STLFSI4 ride along here so a single round-trip covers every
  //   FRED series the dashboard renders.  Both new series fail-open: if the
  //   fetch errors out, the relevant card simply hides itself rather than
  //   blocking the rest of the snapshot.
  const [walclR, wtregenR, rrpR, hyOasR, stlfsiR] = await Promise.all([
    safeFetch(SERIES.WALCL.id,     25),
    safeFetch(SERIES.WTREGEN.id,   25), // user-requested primary
    safeFetch(SERIES.RRPONTSYD.id, 25),
    safeFetch('BAMLH0A0HYM2',      5),  // ICE BofA High Yield OAS (daily)
    safeFetch('STLFSI4',           5),  // St. Louis Fed Financial Stress Index (weekly)
  ])

  // ── 2. WALCL is the gate for AUTHENTICATED status ─────────────────────────
  // On any failure (429, 504, timeout, network error): prefer stale cache
  // (real historical data) over the hard-coded static mock.
  if (!walclR.ok) {
    console.error(
      '[fed-liquidity] PRIMARY WALCL failed:', walclR.error,
      walclR.error?.includes('429') ? '← FRED rate-limit hit' : '',
    )
    if (cached) return serveStaleCache(cached.entry.data, cached.entry.fetchedAt)

    // ── L3: committed seed — real data, always present on any checkout ──────
    const seed = fredCacheSeedRead<FedLiquiditySnapshot>(CACHE_KEY)
    if (seed) {
      console.warn(
        `[fed-liquidity] Using committed seed (age: ${cacheAgeLabel(seed.fetchedAt)}) ` +
        '— live FRED unavailable and no file cache exists',
      )
      return serveStaleCache(seed.data, seed.fetchedAt)
    }

    console.warn('[fed-liquidity] No cache or seed available — returning DEMO_FALLBACK')
    return NextResponse.json(
      { ...MOCK_SNAPSHOT, meta: { ...DEMO_META, timestamp: new Date().toISOString() } },
      { status: 200 },
    )
  }

  // ── 3. TGA: try WTREGEN first, fall back to WDTGAL on failure or unit mismatch
  let tgaDiag: FedLiquidityDiagnostic
  let tgaBillions: number
  let tgaDate: string

  const tryParseTga = (r: SeriesResult, label: string): number | null => {
    if (!r.ok) return null
    const raw = parseFloat(r.obs[0].value)
    const asBillions = SERIES.WTREGEN.toBillions(raw)
    // If the assumed unit produces nonsense, try treating it as already-billions
    if (asBillions >= SANITY.TGA.min && asBillions <= SANITY.TGA.max) {
      console.info(`[fed-liquidity] ${label} parsed OK (${asBillions.toFixed(1)}B from ${raw} millions)`)
      return asBillions
    }
    // Maybe it's already in billions
    if (raw >= SANITY.TGA.min && raw <= SANITY.TGA.max) {
      console.info(`[fed-liquidity] ${label} unit looked like billions (${raw.toFixed(1)}B raw)`)
      return raw
    }
    return null
  }

  const tgaFromPrimary = tryParseTga(wtregenR, 'WTREGEN')
  if (tgaFromPrimary != null) {
    tgaBillions = tgaFromPrimary
    tgaDate     = wtregenR.ok ? wtregenR.obs[0].date : '—'
    tgaDiag = {
      resolvedSeriesId: 'WTREGEN',
      ok:               true,
      usedFallback:     false,
    }
  } else {
    // WTREGEN failed or returned out-of-band — try WDTGAL (real TGA series)
    const wdtgalR = await safeFetch(SERIES.WDTGAL.id, 25)
    const tgaFromFallback = tryParseTga(wdtgalR, 'WDTGAL')
    if (tgaFromFallback != null) {
      tgaBillions = tgaFromFallback
      tgaDate     = wdtgalR.ok ? wdtgalR.obs[0].date : '—'
      tgaDiag = {
        resolvedSeriesId: 'WDTGAL',
        ok:               true,
        usedFallback:     true,
      }
      console.info('[fed-liquidity] TGA resolved via WDTGAL fallback')
    } else {
      // Both failed – use mock TGA but keep AUTHENTICATED (WALCL still real)
      tgaBillions = MOCK_SNAPSHOT.tga
      tgaDate     = '—'
      tgaDiag = {
        resolvedSeriesId: 'WTREGEN',
        ok:               false,
        usedFallback:     true,
        error:            wtregenR.ok ? 'unit out of band' : wtregenR.error,
      }
      console.warn('[fed-liquidity] TGA failed on both WTREGEN and WDTGAL – using mock value')
    }
  }

  // ── 4. RRPONTSYD: best-effort with sanity check ──────────────────────────
  let rrpBillions: number
  let rrpDate: string
  let rrpDiag: FedLiquidityDiagnostic

  if (rrpR.ok) {
    const raw = parseFloat(rrpR.obs[0].value) // already billions
    if (raw >= SANITY.RRP.min && raw <= SANITY.RRP.max) {
      rrpBillions = raw
      rrpDate     = rrpR.obs[0].date
      rrpDiag     = { resolvedSeriesId: 'RRPONTSYD', ok: true, usedFallback: false }
    } else {
      rrpBillions = MOCK_SNAPSHOT.rrp
      rrpDate     = '—'
      rrpDiag     = { resolvedSeriesId: 'RRPONTSYD', ok: false, usedFallback: true, error: `value ${raw} out of sanity band` }
      console.warn(`[fed-liquidity] RRP sanity failure: ${raw}`)
    }
  } else {
    rrpBillions = MOCK_SNAPSHOT.rrp
    rrpDate     = '—'
    rrpDiag     = { resolvedSeriesId: 'RRPONTSYD', ok: false, usedFallback: true, error: rrpR.error }
    console.warn('[fed-liquidity] RRP fetch failed:', rrpR.error)
  }

  // ── 5. WALCL values & sanity ──────────────────────────────────────────────
  const walclBillionsRaw = SERIES.WALCL.toBillions(parseFloat(walclR.obs[0].value))
  let   walclBillions    = walclBillionsRaw
  let   walclDiag: FedLiquidityDiagnostic = {
    resolvedSeriesId: 'WALCL', ok: true, usedFallback: false,
  }

  if (walclBillions < SANITY.WALCL_BS.min || walclBillions > SANITY.WALCL_BS.max) {
    console.warn(`[fed-liquidity] WALCL out of sanity band (${walclBillions}B) – clamping to mock`)
    walclBillions = MOCK_SNAPSHOT.balanceSheetTotal
    walclDiag = { resolvedSeriesId: 'WALCL', ok: false, usedFallback: true, error: `value ${walclBillionsRaw}B out of sanity band` }
  }

  // ── 6. Net Liquidity ──────────────────────────────────────────────────────
  //   Compute on the FULL-PRECISION billions values (no rounding upstream).
  //   This is critical for small RRP balances — e.g. RRPONTSYD = $1.78 B
  //   would round to 2 if we used Math.round before subtracting; here the
  //   raw 1.78 flows through into the difference.
  const netLiquidity = computeNetLiquidity(walclBillions, tgaBillions, rrpBillions)

  // ── 7. 14-day momentum on WALCL ───────────────────────────────────────────
  const t14         = new Date()
  t14.setDate(t14.getDate() - 14)
  const walcl14d    = findNearest(walclR.obs, t14)
  const walcl14dBil = SERIES.WALCL.toBillions(parseFloat(walcl14d.value))
  const momentum14d = walcl14dBil > 0
    ? ((walclBillions - walcl14dBil) / walcl14dBil) * 100
    : 0
  const momentumDirection: FedLiquiditySnapshot['momentumDirection'] =
    momentum14d >  0.5 ? 'expanding'   :
    momentum14d < -0.5 ? 'contracting' : 'flat'

  // ── 7b. Extract HY-OAS and STLFSI4 — fail-open ────────────────────────────
  //   Both series are best-effort additions to the dashboard.  A missing
  //   observation or transient FRED failure leaves the corresponding field
  //   undefined; the React monitor card then hides its row entirely so a
  //   single broken series can't blank out the primary WALCL/TGA/RRP grid.
  let hyOasSpread: number | undefined
  let hyOasDate:   string | undefined
  if (hyOasR.ok) {
    const v = parseFloat(hyOasR.obs[0].value)
    if (Number.isFinite(v) && v >= 0 && v < 50) {           // sanity: 0..50pp
      hyOasSpread = parseFloat(v.toFixed(3))
      hyOasDate   = hyOasR.obs[0].date
    }
  }

  let stlfsi:     number | undefined
  let stlfsiDate: string | undefined
  if (stlfsiR.ok) {
    const v = parseFloat(stlfsiR.obs[0].value)
    if (Number.isFinite(v) && v > -10 && v < 20) {           // sanity: ±extremes
      stlfsi     = parseFloat(v.toFixed(3))
      stlfsiDate = stlfsiR.obs[0].date
    }
  }

  // ── 8. Assemble & return ──────────────────────────────────────────────────
  const meta: FedLiquidityMeta = {
    dataSource:  'FRED_API',
    status:      'AUTHENTICATED',  // ← key fix: WALCL succeeded, that's the gate
    // Raw FRED series mapped onto the clean display acronyms:
    //   fta ← WALCL, tga ← WTREGEN, rro ← RRPONTSYD
    seriesDates: {
      fta: walclR.obs[0].date,
      tga: tgaDate,
      rro: rrpDate,
    },
    timestamp: new Date().toISOString(),
    diagnostics: {
      fta: walclDiag,
      tga: tgaDiag,
      rro: rrpDiag,
    },
  }

  // ── Precision policy ──
  //   See `lib/format/fedLiquidity.ts` for the rationale.  Math.round() was
  //   the previous bug — it collapsed small RRP balances (e.g. 1.78 → 2) and
  //   cascaded into netLiquidity.  toPrecise() preserves 3 decimal places
  //   (million-dollar resolution at the billion scale).
  const snapshot: FedLiquiditySnapshot = {
    date:              walclR.obs[0].date,
    balanceSheetTotal: toPrecise(walclBillions),
    tga:               toPrecise(tgaBillions),
    rrp:               toPrecise(rrpBillions),
    netLiquidity:      toPrecise(netLiquidity),
    momentum14d:       parseFloat(momentum14d.toFixed(2)),
    momentumDirection,
    hyOasSpread,
    hyOasDate,
    stlfsi,
    stlfsiDate,
    meta,
  }

  console.info(
    `[fed-liquidity] AUTHENTICATED — ` +
    `BS:$${snapshot.balanceSheetTotal.toFixed(2)}B  ` +
    `TGA:$${snapshot.tga.toFixed(2)}B(${tgaDiag.resolvedSeriesId}${tgaDiag.usedFallback ? '*' : ''})  ` +
    `RRP:$${snapshot.rrp.toFixed(3)}B  Net:$${snapshot.netLiquidity.toFixed(2)}B  14d:${momentum14d.toFixed(2)}%  ` +
    `HY-OAS:${hyOasSpread != null ? hyOasSpread.toFixed(2) + 'pp' : '—'}  ` +
    `STLFSI:${stlfsi != null ? stlfsi.toFixed(2) : '—'}`
  )

  // ── Persist to cache (L1 memory + L2 file) ───────────────────────────────
  fredCacheWrite(CACHE_KEY, snapshot)

  return NextResponse.json(snapshot, { status: 200 })
}
