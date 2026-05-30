import { NextResponse } from 'next/server'
import type { FXMarketDataResponse, FXDataWithValidation } from '@/lib/types/fx-market-data'
import { FRED_FX_SERIES } from '@/lib/types/fx-market-data'
import {
  validateFXPair,
  summarizeValidation,
  isValidationHealthy,
} from '@/lib/services/fx-validation'

// ─── Provider Stub ────────────────────────────────────────────────────────────
// TODO: Replace with Alpaca SDK call once credentials are configured.
// Returns an empty map — FX pairs will display FRED prices only until wired in.

interface ProviderFXQuote {
  price:         number | null
  change:        number | null
  changePercent: number | null
  timestamp:     number
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function fetchProviderFXBatch(_symbols: string[]): Promise<Map<string, ProviderFXQuote>> {
  return new Map()
}

// ─── FRED Configuration ────────────────────────────────────────────────────────

const FRED_API_KEY = process.env.FRED_API_KEY?.trim() ?? ''
const FRED_BASE_URL = 'https://api.stlouisfed.org/fred/series/observations'

interface FREDObservation {
  date: string
  value: string
}

type SeriesResult =
  | {
      ok: true
      seriesId: string
      obs: FREDObservation[]
    }
  | {
      ok: false
      seriesId: string
      error: string
    }

/**
 * Fetch latest FRED FX observation for a given series
 * Returns the most recent valid observation
 */
async function safeFetchFREDSeries(seriesId: string, limit = 5): Promise<SeriesResult> {
  try {
    if (!FRED_API_KEY) {
      return { ok: false, seriesId, error: 'FRED_API_KEY not configured' }
    }

    const params = new URLSearchParams({
      series_id: seriesId,
      api_key: FRED_API_KEY,
      file_type: 'json',
      sort_order: 'desc',
      limit: String(limit),
    })

    const res = await fetch(`${FRED_BASE_URL}?${params}`, {
      next: { revalidate: 3600 }, // Cache for 1 hour
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) {
      let detail = ''
      try {
        const errJson = await res.json()
        detail = errJson?.error_message ? ` – ${errJson.error_message}` : ''
      } catch { /* ignore */ }
      return {
        ok: false,
        seriesId,
        error: `HTTP ${res.status}${detail}`,
      }
    }

    const json = await res.json()

    if (json.error_message) {
      return { ok: false, seriesId, error: json.error_message }
    }

    const valid: FREDObservation[] = (json.observations ?? []).filter(
      (o: FREDObservation) => o.value !== '.' && o.value.trim() !== ''
    )

    if (valid.length === 0) {
      return { ok: false, seriesId, error: 'No valid observations' }
    }

    return { ok: true, seriesId, obs: valid }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { ok: false, seriesId, error: msg }
  }
}

/**
 * Fetch all FRED FX data in parallel
 */
async function fetchAllFREDFXData(): Promise<
  Map<string, { price: number; date: string } | null>
> {
  const results = new Map<string, { price: number; date: string } | null>()

  const fredKeys = Object.keys(FRED_FX_SERIES)
  const fetchPromises = fredKeys.map((key) => {
    const config = FRED_FX_SERIES[key]
    return safeFetchFREDSeries(config.id)
  })

  const settled = await Promise.allSettled(fetchPromises)

  settled.forEach((outcome, idx) => {
    const key = fredKeys[idx]
    if (outcome.status === 'fulfilled') {
      const result = outcome.value
      if (result.ok && result.obs.length > 0) {
        const latestObs = result.obs[0]
        results.set(key, {
          price: parseFloat(latestObs.value),
          date: latestObs.date,
        })
      } else {
        const errorMsg = !result.ok ? result.error : 'Unknown error'
        console.warn(`[fx-market] FRED ${key} failed: ${errorMsg}`)
        results.set(key, null)
      }
    } else {
      console.warn(
        `[fx-market] FRED ${key} promise rejection:`,
        outcome.reason
      )
      results.set(key, null)
    }
  })

  return results
}

/**
 * Build FX data with validation
 */
function buildFXDataWithValidation(
  fredData: Map<string, { price: number; date: string } | null>,
  yahooData: Map<string, { price: number | null; change: number | null; changePercent: number | null; timestamp: number }>
): FXDataWithValidation[] {
  return Object.entries(FRED_FX_SERIES).map(([fredKey, config]) => {
    const fredEntry = fredData.get(fredKey)
    const yahooEntry = yahooData.get(config.yahooSymbol)

    const validation = validateFXPair(
      config.label,
      fredKey,
      config.yahooSymbol,
      fredEntry?.price ?? null,
      fredEntry?.date ?? null,
      yahooEntry?.price ?? null,
      yahooEntry?.timestamp ?? null
    )

    // Determine display price and source based on validation recommendation
    let displayPrice = 0
    let displaySource: 'fred' | 'yahoo' = 'fred'
    let dailyChange = 0
    let dailyChangePercent = 0

    if (validation.recommendation.includes('yahoo')) {
      displayPrice = yahooEntry?.price ?? 0
      displaySource = 'yahoo'
      dailyChange = yahooEntry?.change ?? 0
      dailyChangePercent = yahooEntry?.changePercent ?? 0
    } else {
      displayPrice = fredEntry?.price ?? 0
      displaySource = 'fred'
      // For FRED, we don't have intraday change data
      dailyChange = 0
      dailyChangePercent = 0
    }

    return {
      symbol: config.yahooSymbol,
      name: config.label,
      fredPrice: fredEntry?.price ?? null,
      fredDate: fredEntry?.date ?? null,
      yahooPrice: yahooEntry?.price ?? null,
      yahooTimestamp: yahooEntry?.timestamp ?? null,
      validationStatus: validation.status,
      deltaBps: validation.deltaBps,
      recommendation: validation.recommendation,
      displayPrice,
      displaySource,
      dailyChange,
      dailyChangePercent,
      sparklines: {}, // Populate from Yahoo sparkline endpoint if needed
    }
  })
}

/**
 * GET /api/fx-market
 * Returns FX market data with FRED/Yahoo validation
 */
export async function GET() {
  const startTime = Date.now()

  try {
    // Fetch FRED and provider data in parallel
    const [fredData, yahooData] = await Promise.all([
      fetchAllFREDFXData(),
      fetchProviderFXBatch(
        Object.values(FRED_FX_SERIES).map(cfg => cfg.yahooSymbol)
      ),
    ])

    // Convert provider FX data to usable format (empty until provider wired in)
    const yahooFormatted = new Map<string, {
      price: number | null
      change: number | null
      changePercent: number | null
      timestamp: number
    }>()

    for (const [symbol, data] of yahooData) {
      yahooFormatted.set(symbol, {
        price: data.price,
        change: data.change,
        changePercent: data.changePercent,
        timestamp: data.timestamp,
      })
    }

    // Build FX data with validation
    const fxPairs = buildFXDataWithValidation(fredData, yahooFormatted)

    // Calculate validation health
    const validationResults = fxPairs.map(pair => ({
      status: pair.validationStatus,
      deltaBps: pair.deltaBps,
    }))

    const healthy = validationResults.filter(r => isValidationHealthy({
      status: r.status,
      deltaBps: r.deltaBps,
    } as any)).length

    const validationHealth = {
      totalPairs: fxPairs.length,
      okCount: validationResults.filter(r => r.status === 'OK').length,
      staleCount: validationResults.filter(r => r.status === 'STALE_MACRO').length,
      mismatchCount: validationResults.filter(r => r.status === 'VALIDATION_MISMATCH').length,
      missingCount: validationResults.filter(r => r.status.includes('MISSING')).length,
      avgDeltaBps: validationResults
        .filter(r => r.deltaBps !== null)
        .reduce((sum, r) => sum + (r.deltaBps ?? 0), 0) / Math.max(1, validationResults.filter(r => r.deltaBps !== null).length),
      healthPercentage: (healthy / fxPairs.length) * 100,
    }

    const response: FXMarketDataResponse = {
      pairs: fxPairs,
      validationHealth,
      timestamp: Date.now(),
      fredDataTimestamp: fredData.size > 0 ? Date.now() : null,
      yahooDataTimestamp: yahooData.size > 0 ? Date.now() : null,
    }

    const elapsed = Date.now() - startTime
    console.info(
      `[fx-market] Request completed in ${elapsed}ms | ` +
      `Health: ${validationHealth.healthPercentage.toFixed(1)}% | ` +
      `Stale: ${validationHealth.staleCount}, Mismatches: ${validationHealth.mismatchCount}`
    )

    return NextResponse.json(response)
  } catch (err) {
    console.error('[fx-market] Unhandled error:', err)

    const errorMsg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      {
        error: 'Failed to fetch FX market data',
        details: errorMsg,
      },
      { status: 500 }
    )
  }
}
