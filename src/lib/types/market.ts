/**
 * Market Data Abstraction Layer Types
 * Core interfaces for unified FX, Commodities, and Indices data handling
 */

// ─── Liveness Status ──────────────────────────────────────────────────────────

export type LivenessStatus =
  | 'LIVE_INTRADAY'        // Data is <5 min old, market is active
  | 'MARKET_CLOSED_STALE'  // Data is stale (no update since market close)
  | 'FEED_DISCONNECTED'    // API unavailable or data significantly delayed

export interface LivenessMetrics {
  status: LivenessStatus
  lastUpdateMs: number      // Unix timestamp of last successful data fetch
  ageSeconds: number        // How old is current data (now - lastUpdateMs)
  isMarketOpen: boolean
  feedHealthPercent: number // 0-100; 100 = all sources healthy
  dataSource: 'yahoo' | 'fred' | 'fallback'
  message: string           // Human-readable status message
}

// ─── Data Sources ────────────────────────────────────────────────────────────

export type DataSourceType = 'yahoo-finance' | 'fred' | 'mock' | 'cache'

export interface DataSource {
  type: DataSourceType
  symbol: string           // Yahoo Finance ticker or FRED series ID
  priority: number         // 1 = primary, 2 = secondary, 3 = fallback
  refreshIntervalMs: number // How often this source should be polled
  maxAgeMs: number        // Data older than this is considered stale
  lastSuccessMs: number   // Last successful fetch timestamp
  lastErrorMs?: number
  lastErrorMsg?: string
}

// ─── Market Instrument Node ────────────────────────────────────────────────────

export interface MarketNode {
  // Identity
  id: string                  // Unique key: 'EURUSD', 'GC', 'ES', etc.
  displayName: string         // "EUR/USD", "Gold Futures", "S&P E-Mini"
  category: 'fx' | 'commodity' | 'index' | 'rate' | 'volatility'

  // Data Sources
  sources: DataSource[]       // Primary, secondary, fallback sources

  // Current State
  price: number              // Live price
  change: number             // Absolute change
  changePercent: number      // Percentage change
  timestamp: number          // Unix ms of last update

  // Optional Fields
  high?: number
  low?: number
  open?: number
  bid?: number
  ask?: number

  // Sparkline Data (intraday history)
  sparkline?: number[]       // Last N prices (1h, 5h, etc.)

  // Liveness Tracking
  liveness: LivenessMetrics

  // Metadata
  decimals: number           // Decimal places for display (e.g., 4 for EURUSD)
  unit?: string             // Unit label: "USD", "oz", "bbl", "%", etc.
  exchangeCode?: string     // CME, NYSE, etc.
  holidays?: string[]       // Array of market holidays (ISO dates)
}

// ─── Market Data Snapshot (Full Response) ────────────────────────────────────

export interface MarketDataSnapshot {
  timestamp: number
  nodes: Record<string, MarketNode>  // Keyed by MarketNode.id

  // Aggregated health metrics
  health: {
    totalNodes: number
    liveCount: number
    staleCount: number
    disconnectedCount: number
    healthPercent: number
  }

  // Source-level diagnostics
  sources: {
    yahoo: {
      healthy: boolean
      lastSuccessMs: number
      lastErrorMs?: number
      errorMsg?: string
    }
    fred: {
      healthy: boolean
      lastSuccessMs: number
      lastErrorMs?: number
      errorMsg?: string
    }
  }
}

// ─── Market Registry Configuration ────────────────────────────────────────────

export interface MarketRegistryConfig {
  id: string
  displayName: string
  category: 'fx' | 'commodity' | 'index' | 'rate' | 'volatility'

  // Data source configuration
  primarySource: {
    type: 'yahoo-finance' | 'fred'
    symbol: string
    refreshIntervalMs: number
    maxAgeMs: number
  }

  secondarySource?: {
    type: 'yahoo-finance' | 'fred'
    symbol: string
    refreshIntervalMs: number
    maxAgeMs: number
  }

  fallbackSource?: {
    type: 'mock' | 'cache'
    symbol: string
  }

  // Display configuration
  decimals: number
  unit?: string
  exchangeCode?: string

  // Market hours (for liveness calculation)
  marketHours?: {
    open: string      // "09:30" ET
    close: string     // "16:00" ET
    timezone: string  // "America/New_York"
    daysOpen: number[] // 1-5 for Mon-Fri, 0-6 for Sun-Sat
  }

  // Holiday calendar
  holidays?: string[] // ISO date strings: "2026-12-25"
}

// ─── Liveness Calculator Context ──────────────────────────────────────────────

export interface LivenessContext {
  nowMs: number
  marketOpenState: {
    isOpen: boolean
    nextOpenMs: number
    nextCloseMs: number
  }
  feedHealthPercent: number
}

// ─── Display Props for Components ─────────────────────────────────────────────

export interface MarketNodeDisplayProps {
  node: MarketNode
  showSparkline?: boolean
  showLivenessIndicator?: boolean
  compactMode?: boolean
  decimalOverride?: number
}

// ─── Hook Return Types ────────────────────────────────────────────────────────

export interface UseMarketDataReturn {
  data: MarketDataSnapshot | null
  isLoading: boolean
  error: string | null
  refetch: () => Promise<void>
  node: (id: string) => MarketNode | null
  nodes: (category: string) => MarketNode[]
}
