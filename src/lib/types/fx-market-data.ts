/**
 * FX Market Data Types
 * Unified interface for FRED macro FX data + Yahoo Finance validation results
 */

import type { ValidationStatus } from '../services/fx-validation'

export interface FREDFXObservation {
  date: string
  value: string
}

export interface FXDataWithValidation {
  symbol: string
  name: string
  fredPrice: number | null
  fredDate: string | null
  yahooPrice: number | null
  yahooTimestamp: number | null

  // Validation status
  validationStatus: ValidationStatus
  deltaBps: number | null
  recommendation: 'use_fred' | 'use_yahoo' | 'use_fred_with_warning' | 'use_yahoo_with_warning'

  // Display price: Use recommended source
  displayPrice: number
  displaySource: 'fred' | 'yahoo'

  // Change metrics (from whichever source is displayed)
  dailyChange: number
  dailyChangePercent: number

  // Sparklines (from Yahoo if available, else empty)
  sparklines?: Record<string, number[]>
}

export interface FXMarketDataResponse {
  pairs: FXDataWithValidation[]
  validationHealth: {
    totalPairs: number
    okCount: number
    staleCount: number
    mismatchCount: number
    missingCount: number
    avgDeltaBps: number | null
    healthPercentage: number
  }
  timestamp: number
  fredDataTimestamp: number | null
  yahooDataTimestamp: number | null
}

/**
 * FRED FX Series Configuration
 * Maps FRED series IDs to commodity/FX label names
 */
export const FRED_FX_SERIES: Record<string, {
  id: string
  label: string
  yahooSymbol: string
  displayFormat: 'rate' | 'index' // 'rate' for 1:100+ (EURUSD), 'index' for <1 (DXY)
}> = {
  'DXY': {
    id: 'DEXUSEU',      // Placeholder; actual series varies
    label: 'US Dollar Index',
    yahooSymbol: 'DX-Y.NYB',
    displayFormat: 'index',
  },
  'EURUSD': {
    id: 'DEXUSEU',      // EUR/USD Exchange Rate
    label: 'EUR/USD',
    yahooSymbol: 'EURUSD=X',
    displayFormat: 'rate',
  },
  'GBPUSD': {
    id: 'DEXUSUK',      // GBP/USD Exchange Rate
    label: 'GBP/USD',
    yahooSymbol: 'GBPUSD=X',
    displayFormat: 'rate',
  },
  'USDJPY': {
    id: 'DEXJPUS',      // JPY/USD Exchange Rate (inverted for USD/JPY display)
    label: 'USD/JPY',
    yahooSymbol: 'USDJPY=X',
    displayFormat: 'rate',
  },
  'USDCNY': {
    id: 'DEXCAUS',      // CNY/USD; may not exist on FRED (fallback to Yahoo)
    label: 'USD/CNY',
    yahooSymbol: 'CNY=X',
    displayFormat: 'rate',
  },
  'AUDUSD': {
    id: 'DEXAUST',      // AUD/USD Exchange Rate
    label: 'AUD/USD',
    yahooSymbol: 'AUDUSD=X',
    displayFormat: 'rate',
  },
}
