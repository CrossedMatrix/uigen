/**
 * FX Market Validation Engine
 * Compares FRED macro FX data against Yahoo Finance spot rates to detect:
 * - Staleness (FRED data > 24h old while Yahoo shows active movement)
 * - Variance/Arbitrage (>0.5% delta between sources)
 * - Data anomalies requiring UI warnings or fallbacks
 */

export type ValidationStatus =
  | 'OK'                   // Both sources agree, data is fresh
  | 'STALE_MACRO'         // FRED data is >24h old while Yahoo shows recent movement
  | 'VALIDATION_MISMATCH' // >0.5% delta between FRED and Yahoo prices
  | 'MISSING_YAHOO'       // Yahoo Finance data unavailable for this pair
  | 'MISSING_FRED'        // FRED data unavailable for this pair

export interface FXValidationResult {
  fxPair: string
  fredSymbol: string
  yahooSymbol: string

  // FRED data
  fredPrice: number | null
  fredTimestamp: Date | null
  fredDaysStale: number | null

  // Yahoo data
  yahooPrice: number | null
  yahooTimestamp: number | null

  // Validation metrics
  status: ValidationStatus
  deltaBps: number | null // Delta in basis points (0.5% = 50 bps)
  deltaPercent: number | null

  // Recommendation
  recommendation: 'use_fred' | 'use_yahoo' | 'use_fred_with_warning' | 'use_yahoo_with_warning'
}

/**
 * Compare FRED observation timestamp with current time
 * Returns number of days elapsed
 */
function daysSinceFREDObservation(fredDate: string): number {
  const fredTime = new Date(fredDate).getTime()
  const nowTime = Date.now()
  return (nowTime - fredTime) / (1000 * 60 * 60 * 24)
}

/**
 * Calculate percentage delta between two prices
 * Delta = |Yahoo - FRED| / Yahoo * 100
 */
function calculateDelta(yahooPrice: number, fredPrice: number): {
  deltaPercent: number
  deltaBps: number
} {
  if (!yahooPrice || yahooPrice === 0) {
    return { deltaPercent: 0, deltaBps: 0 }
  }
  const deltaPercent = Math.abs(yahooPrice - fredPrice) / yahooPrice * 100
  const deltaBps = deltaPercent * 100 // Convert % to basis points
  return { deltaPercent, deltaBps }
}

/**
 * Validate a single FX pair
 * Returns comprehensive validation result with recommendation
 */
export function validateFXPair(
  fxPair: string,
  fredSymbol: string,
  yahooSymbol: string,
  fredPrice: number | null,
  fredDate: string | null,
  yahooPrice: number | null,
  yahooTimestamp: number | null
): FXValidationResult {
  const result: FXValidationResult = {
    fxPair,
    fredSymbol,
    yahooSymbol,
    fredPrice,
    yahooPrice,
    fredTimestamp: fredDate ? new Date(fredDate) : null,
    yahooTimestamp,
    fredDaysStale: null,
    status: 'OK',
    deltaBps: null,
    deltaPercent: null,
    recommendation: 'use_fred',
  }

  // Case 1: No data from either source
  if (!fredPrice && !yahooPrice) {
    result.status = 'MISSING_FRED'
    result.recommendation = 'use_yahoo_with_warning'
    return result
  }

  // Case 2: Only FRED available
  if (fredPrice && !yahooPrice) {
    result.status = 'MISSING_YAHOO'
    const daysStale = fredDate ? daysSinceFREDObservation(fredDate) : null
    result.fredDaysStale = daysStale
    if (daysStale && daysStale > 1) {
      result.status = 'STALE_MACRO'
      result.recommendation = 'use_fred_with_warning'
    } else {
      result.recommendation = 'use_fred'
    }
    return result
  }

  // Case 3: Only Yahoo available
  if (!fredPrice && yahooPrice) {
    result.status = 'MISSING_FRED'
    result.recommendation = 'use_yahoo'
    return result
  }

  // Case 4: Both sources available — full validation
  if (fredPrice && yahooPrice) {
    const { deltaPercent, deltaBps } = calculateDelta(yahooPrice, fredPrice)
    result.deltaPercent = deltaPercent
    result.deltaBps = deltaBps

    const daysStale = fredDate ? daysSinceFREDObservation(fredDate) : null
    result.fredDaysStale = daysStale

    // Check for staleness: FRED >24h old while Yahoo shows recent tick
    if (daysStale && daysStale > 1) {
      // FRED is stale, but are there other anomalies?
      if (deltaBps > 50) {
        // Both stale AND high variance → trust Yahoo
        result.status = 'VALIDATION_MISMATCH'
        result.recommendation = 'use_yahoo'
      } else {
        // Just stale, but prices align → use FRED with warning
        result.status = 'STALE_MACRO'
        result.recommendation = 'use_fred_with_warning'
      }
    } else {
      // FRED is fresh, check variance
      if (deltaBps > 50) {
        // High variance between fresh sources
        result.status = 'VALIDATION_MISMATCH'
        // Assume Yahoo is more accurate for real-time FX
        result.recommendation = 'use_yahoo_with_warning'
      } else {
        // Both fresh and aligned
        result.status = 'OK'
        result.recommendation = 'use_fred'
      }
    }
  }

  return result
}

/**
 * Validate a batch of FX pairs
 * Orchestrates FRED and Yahoo data and returns validation matrix
 */
export function validateFXBatch(
  fxPairs: Array<{
    name: string
    fredSymbol: string
    yahooSymbol: string
    fredPrice: number | null
    fredDate: string | null
  }>,
  yahooData: Map<string, { price: number; timestamp: number }>
): FXValidationResult[] {
  return fxPairs.map(({ name, fredSymbol, yahooSymbol, fredPrice, fredDate }) => {
    const yahooEntry = yahooData.get(yahooSymbol)
    return validateFXPair(
      name,
      fredSymbol,
      yahooSymbol,
      fredPrice,
      fredDate,
      yahooEntry?.price ?? null,
      yahooEntry?.timestamp ?? null
    )
  })
}

/**
 * Health check: Returns true if validation indicates good data quality
 * Used by dashboards to show "Live Sync" badge or data quality indicators
 */
export function isValidationHealthy(result: FXValidationResult): boolean {
  return result.status === 'OK' || (result.deltaBps !== null && result.deltaBps <= 50)
}

/**
 * Summary statistics for a validation batch
 * Useful for logging and monitoring validation pipeline health
 */
export function summarizeValidation(results: FXValidationResult[]): {
  totalPairs: number
  okCount: number
  staleCount: number
  mismatchCount: number
  missingCount: number
  avgDeltaBps: number | null
  healthPercentage: number
} {
  const okCount = results.filter(r => r.status === 'OK').length
  const staleCount = results.filter(r => r.status === 'STALE_MACRO').length
  const mismatchCount = results.filter(r => r.status === 'VALIDATION_MISMATCH').length
  const missingCount = results.filter(r => r.status.includes('MISSING')).length

  const deltas = results
    .filter(r => r.deltaBps !== null)
    .map(r => r.deltaBps!)
  const avgDeltaBps = deltas.length > 0 ? deltas.reduce((a, b) => a + b, 0) / deltas.length : null

  const healthPercentage = results.length > 0
    ? (okCount / results.length) * 100
    : 0

  return {
    totalPairs: results.length,
    okCount,
    staleCount,
    mismatchCount,
    missingCount,
    avgDeltaBps,
    healthPercentage,
  }
}
