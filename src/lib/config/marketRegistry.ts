/**
 * Market Registry Configuration
 * Maps UI token IDs to provider tickers (Alpaca), FRED codes, and display metadata
 */

import type { MarketRegistryConfig } from '@/lib/types/market'

// ─── FX Market Configuration ─────────────────────────────────────────────────

const FX_MARKETS: Record<string, MarketRegistryConfig> = {
  DXY: {
    id: 'DXY',
    displayName: 'US Dollar Index',
    category: 'fx',
    primarySource: {
      type: 'alpaca',
      symbol: 'DX-Y.NYB',
      refreshIntervalMs: 30000,      // 30s during market hours
      maxAgeMs: 300000,              // Stale after 5 minutes
    },
    secondarySource: {
      type: 'fred',
      symbol: 'DEXUSEU',
      refreshIntervalMs: 3600000,    // 1h (FRED publishes weekly)
      maxAgeMs: 86400000,            // Stale after 24h
    },
    decimals: 2,
    unit: 'Index',
    exchangeCode: 'ICE',
    marketHours: {
      open: '08:00',
      close: '17:00',
      timezone: 'America/New_York',
      daysOpen: [1, 2, 3, 4, 5], // Mon-Fri
    },
    holidays: ['2026-01-01', '2026-07-04', '2026-12-25'],
  },

  EURUSD: {
    id: 'EURUSD',
    displayName: 'EUR/USD',
    category: 'fx',
    primarySource: {
      type: 'alpaca',
      symbol: 'EURUSD=X',
      refreshIntervalMs: 30000,
      maxAgeMs: 300000,
    },
    secondarySource: {
      type: 'fred',
      symbol: 'DEXUSEU',
      refreshIntervalMs: 3600000,
      maxAgeMs: 86400000,
    },
    decimals: 4,
    unit: 'USD',
    exchangeCode: 'FOREX',
    marketHours: {
      open: '17:00',
      close: '17:00', // 24/5 market; use Sunday-Friday
      timezone: 'America/New_York',
      daysOpen: [0, 1, 2, 3, 4, 5], // Sun-Fri (MT close Fri at 5pm)
    },
  },

  GBPUSD: {
    id: 'GBPUSD',
    displayName: 'GBP/USD',
    category: 'fx',
    primarySource: {
      type: 'alpaca',
      symbol: 'GBPUSD=X',
      refreshIntervalMs: 30000,
      maxAgeMs: 300000,
    },
    secondarySource: {
      type: 'fred',
      symbol: 'DEXUSUK',
      refreshIntervalMs: 3600000,
      maxAgeMs: 86400000,
    },
    decimals: 4,
    unit: 'USD',
    exchangeCode: 'FOREX',
    marketHours: {
      open: '17:00',
      close: '17:00',
      timezone: 'America/New_York',
      daysOpen: [0, 1, 2, 3, 4, 5],
    },
  },

  USDJPY: {
    id: 'USDJPY',
    displayName: 'USD/JPY',
    category: 'fx',
    primarySource: {
      type: 'alpaca',
      symbol: 'USDJPY=X',
      refreshIntervalMs: 30000,
      maxAgeMs: 300000,
    },
    secondarySource: {
      type: 'fred',
      symbol: 'DEXJPUS',
      refreshIntervalMs: 3600000,
      maxAgeMs: 86400000,
    },
    decimals: 2,
    unit: 'JPY',
    exchangeCode: 'FOREX',
    marketHours: {
      open: '17:00',
      close: '17:00',
      timezone: 'America/New_York',
      daysOpen: [0, 1, 2, 3, 4, 5],
    },
  },

  USDCNY: {
    id: 'USDCNY',
    displayName: 'USD/CNY',
    category: 'fx',
    primarySource: {
      type: 'alpaca',
      symbol: 'CNY=X',
      refreshIntervalMs: 60000,
      maxAgeMs: 600000, // Less liquid, allow 10min staleness
    },
    decimals: 4,
    unit: 'CNY',
    exchangeCode: 'FOREX',
    marketHours: {
      open: '17:00',
      close: '17:00',
      timezone: 'America/New_York',
      daysOpen: [0, 1, 2, 3, 4, 5],
    },
  },

  AUDUSD: {
    id: 'AUDUSD',
    displayName: 'AUD/USD',
    category: 'fx',
    primarySource: {
      type: 'alpaca',
      symbol: 'AUDUSD=X',
      refreshIntervalMs: 30000,
      maxAgeMs: 300000,
    },
    decimals: 4,
    unit: 'USD',
    exchangeCode: 'FOREX',
    marketHours: {
      open: '17:00',
      close: '17:00',
      timezone: 'America/New_York',
      daysOpen: [0, 1, 2, 3, 4, 5],
    },
  },
}

// ─── Commodity ETF Proxy Configuration ────────────────────────────────────────
// Alpaca does not support COMEX/NYMEX futures formats (GC=F, CL=F, etc.).
// We use exchange-traded ETFs that track the underlying commodities closely.
//   GLD  — SPDR Gold Trust          (≈ 0.096 oz gold per share)
//   SLV  — iShares Silver Trust     (≈ 0.952 oz silver per share)
//   USO  — US Oil Fund (WTI)        (rolls front-month WTI futures)
//   BNO  — US Brent Oil Fund        (rolls front-month Brent futures)
//   CPER — US Copper Index Fund     (copper futures basket)
//   UNG  — US Natural Gas Fund      (rolls front-month Henry Hub)
// All are valid Alpaca us_equity tickers — no subscription upgrade required.

const COMMODITY_MARKETS: Record<string, MarketRegistryConfig> = {
  GC: {
    id: 'GC',
    displayName: 'Gold (GLD)',
    category: 'commodity',
    primarySource: {
      type: 'alpaca',
      symbol: 'GLD',          // SPDR Gold Trust — NYSE Arca
      refreshIntervalMs: 30000,
      maxAgeMs: 300000,
    },
    decimals: 2,
    unit: 'USD/sh',
    exchangeCode: 'NYSE',
    marketHours: {
      open: '09:30',
      close: '16:00',
      timezone: 'America/New_York',
      daysOpen: [1, 2, 3, 4, 5],
    },
  },

  SI: {
    id: 'SI',
    displayName: 'Silver (SLV)',
    category: 'commodity',
    primarySource: {
      type: 'alpaca',
      symbol: 'SLV',          // iShares Silver Trust — NYSE Arca
      refreshIntervalMs: 30000,
      maxAgeMs: 300000,
    },
    decimals: 2,
    unit: 'USD/sh',
    exchangeCode: 'NYSE',
    marketHours: {
      open: '09:30',
      close: '16:00',
      timezone: 'America/New_York',
      daysOpen: [1, 2, 3, 4, 5],
    },
  },

  CL: {
    id: 'CL',
    displayName: 'WTI Oil (USO)',
    category: 'commodity',
    primarySource: {
      type: 'alpaca',
      symbol: 'USO',          // United States Oil Fund — NYSE Arca
      refreshIntervalMs: 30000,
      maxAgeMs: 300000,
    },
    decimals: 2,
    unit: 'USD/sh',
    exchangeCode: 'NYSE',
    marketHours: {
      open: '09:30',
      close: '16:00',
      timezone: 'America/New_York',
      daysOpen: [1, 2, 3, 4, 5],
    },
  },

  BZ: {
    id: 'BZ',
    displayName: 'Brent Oil (BNO)',
    category: 'commodity',
    primarySource: {
      type: 'alpaca',
      symbol: 'BNO',          // United States Brent Oil Fund — NYSE Arca
      refreshIntervalMs: 30000,
      maxAgeMs: 300000,
    },
    decimals: 2,
    unit: 'USD/sh',
    exchangeCode: 'NYSE',
    marketHours: {
      open: '09:30',
      close: '16:00',
      timezone: 'America/New_York',
      daysOpen: [1, 2, 3, 4, 5],
    },
  },

  HG: {
    id: 'HG',
    displayName: 'Copper (CPER)',
    category: 'commodity',
    primarySource: {
      type: 'alpaca',
      symbol: 'CPER',         // US Copper Index Fund — NYSE Arca
      refreshIntervalMs: 30000,
      maxAgeMs: 300000,
    },
    decimals: 2,
    unit: 'USD/sh',
    exchangeCode: 'NYSE',
    marketHours: {
      open: '09:30',
      close: '16:00',
      timezone: 'America/New_York',
      daysOpen: [1, 2, 3, 4, 5],
    },
  },

  NG: {
    id: 'NG',
    displayName: 'NatGas (UNG)',
    category: 'commodity',
    primarySource: {
      type: 'alpaca',
      symbol: 'UNG',          // United States Natural Gas Fund — NYSE Arca
      refreshIntervalMs: 30000,
      maxAgeMs: 300000,
    },
    decimals: 2,
    unit: 'USD/sh',
    exchangeCode: 'NYSE',
    marketHours: {
      open: '09:30',
      close: '16:00',
      timezone: 'America/New_York',
      daysOpen: [1, 2, 3, 4, 5],
    },
  },
}

// ─── Index Futures Configuration ──────────────────────────────────────────────

const INDEX_MARKETS: Record<string, MarketRegistryConfig> = {
  ES: {
    id: 'ES',
    displayName: 'S&P E-Mini',
    category: 'index',
    primarySource: {
      type: 'alpaca',
      symbol: 'ES=F',
      refreshIntervalMs: 15000, // More aggressive polling
      maxAgeMs: 300000,
    },
    decimals: 2,
    unit: 'Index',
    exchangeCode: 'CME',
    marketHours: {
      open: '17:00', // Sun 5pm (pre-market Mon)
      close: '16:00', // Fri 4pm
      timezone: 'America/New_York',
      daysOpen: [0, 1, 2, 3, 4, 5],
    },
  },

  NQ: {
    id: 'NQ',
    displayName: 'Nasdaq E-Mini',
    category: 'index',
    primarySource: {
      type: 'alpaca',
      symbol: 'NQ=F',
      refreshIntervalMs: 15000,
      maxAgeMs: 300000,
    },
    decimals: 2,
    unit: 'Index',
    exchangeCode: 'CME',
    marketHours: {
      open: '17:00',
      close: '16:00',
      timezone: 'America/New_York',
      daysOpen: [0, 1, 2, 3, 4, 5],
    },
  },

  YM: {
    id: 'YM',
    displayName: 'DOW E-Mini',
    category: 'index',
    primarySource: {
      type: 'alpaca',
      symbol: 'YM=F',
      refreshIntervalMs: 15000,
      maxAgeMs: 300000,
    },
    decimals: 0,
    unit: 'Index',
    exchangeCode: 'CME',
    marketHours: {
      open: '17:00',
      close: '16:00',
      timezone: 'America/New_York',
      daysOpen: [0, 1, 2, 3, 4, 5],
    },
  },

  RTY: {
    id: 'RTY',
    displayName: 'Russell 2000 E-Mini',
    category: 'index',
    primarySource: {
      type: 'alpaca',
      symbol: 'RTY=F',
      refreshIntervalMs: 15000,
      maxAgeMs: 300000,
    },
    decimals: 2,
    unit: 'Index',
    exchangeCode: 'CME',
    marketHours: {
      open: '17:00',
      close: '16:00',
      timezone: 'America/New_York',
      daysOpen: [0, 1, 2, 3, 4, 5],
    },
  },
}

// ─── Combined Registry ────────────────────────────────────────────────────────

export const MARKET_REGISTRY: Record<string, MarketRegistryConfig> = {
  ...FX_MARKETS,
  ...COMMODITY_MARKETS,
  ...INDEX_MARKETS,
}

// ─── Category Lookups ────────────────────────────────────────────────────────

export const getFXMarkets = (): MarketRegistryConfig[] =>
  Object.values(FX_MARKETS)

export const getCommodityMarkets = (): MarketRegistryConfig[] =>
  Object.values(COMMODITY_MARKETS)

export const getIndexMarkets = (): MarketRegistryConfig[] =>
  Object.values(INDEX_MARKETS)

export const getMarketsByCategory = (
  category: 'fx' | 'commodity' | 'index'
): MarketRegistryConfig[] => {
  return Object.values(MARKET_REGISTRY).filter(m => m.category === category)
}

export const getMarket = (id: string): MarketRegistryConfig | null => {
  return MARKET_REGISTRY[id] ?? null
}

/**
 * Get the primary provider symbol for a market ID
 * @example getProviderSymbol('EURUSD') => 'EURUSD=X'
 */
export const getProviderSymbol = (id: string): string | null => {
  const market = MARKET_REGISTRY[id]
  if (!market) return null
  return market.primarySource.symbol
}

/**
 * Get all provider symbols for a category
 * @example getSymbolsByCategory('commodity') => ['GLD', 'SLV', 'USO', ...]
 */
export const getSymbolsByCategory = (category: string): string[] => {
  return Object.values(MARKET_REGISTRY)
    .filter(m => m.category === category)
    .map(m => m.primarySource.symbol)
}
