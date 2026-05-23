# Market Data Abstraction Layer Integration Guide

## Overview

A modular, type-safe architecture that unifies FX, Commodities, and Index data handling with dynamic liveness calculation and automatic visual indicators.

```
MarketRegistry (Config)
        ↓
FetchMarketData (Service)
        ↓
useMarketNodes (Hook)
        ↓
MarketNodeRow (Component)
```

---

## Architecture

### 1. **Type System** (`src/lib/types/market.ts`)

```typescript
interface MarketNode {
  id: string                    // 'EURUSD', 'GC', 'ES'
  displayName: string          // "EUR/USD", "Gold", "S&P E-Mini"
  category: 'fx' | 'commodity' | 'index'
  price: number
  change: number
  changePercent: number
  liveness: LivenessMetrics    // Status + age + message
  sparkline?: number[]         // Intraday history
}

type LivenessStatus =
  | 'LIVE_INTRADAY'            // 🟢 Fresh data, market active
  | 'MARKET_CLOSED_STALE'      // 🕐 No update since market close
  | 'FEED_DISCONNECTED'        // 🔴 API down or very stale (>30m)
```

### 2. **Configuration Registry** (`src/lib/config/marketRegistry.ts`)

Maps UI tokens to data sources:

```typescript
const marketRegistry = {
  'EURUSD': {
    id: 'EURUSD',
    displayName: 'EUR/USD',
    category: 'fx',
    primarySource: {
      type: 'yahoo-finance',
      symbol: 'EURUSD=X',        // Yahoo Finance ticker
      refreshIntervalMs: 30000,   // 30s polling
      maxAgeMs: 300000,           // Stale after 5min
    },
    secondarySource: {
      type: 'fred',
      symbol: 'DEXUSEU',         // FRED series ID
      refreshIntervalMs: 3600000, // 1h (FRED publishes weekly)
      maxAgeMs: 86400000,        // Stale after 24h
    },
    decimals: 4,
    unit: 'USD',
    exchangeCode: 'FOREX',
    marketHours: {
      open: '17:00',
      close: '17:00',            // 24/5 market
      timezone: 'America/New_York',
      daysOpen: [0,1,2,3,4,5],  // Sun-Fri
    },
  },
  // ... more markets
}
```

**Includes:**
- 6 FX pairs: DXY, EUR/USD, GBP/USD, USD/JPY, USD/CNY, AUD/USD
- 6 Commodities: Gold, Silver, WTI, Brent, Copper, Natural Gas
- 4 Index Futures: ES, NQ, YM, RTY

### 3. **Market Fetcher Service** (`src/lib/services/marketFetcher.ts`)

Orchestrates data fetching and liveness calculation:

```typescript
export async function fetchMarketData(
  category: 'fx' | 'commodity' | 'index'
): Promise<MarketDataSnapshot>

// Liveness calculation logic:
function calculateLiveness(
  lastUpdateMs: number,
  maxAgeMs: number,
  context: LivenessContext,
  feedHealthPercent: number
): LivenessStatus {
  // FEED_DISCONNECTED if age > 30min OR feedHealth < 20%
  // MARKET_CLOSED_STALE if market closed AND age > maxAge
  // LIVE_INTRADAY if market open AND age < 5min
  // Otherwise MARKET_CLOSED_STALE
}
```

### 4. **React Hook** (`src/lib/hooks/useMarketNodes.ts`)

Provides market data to components with auto-polling:

```typescript
const { data, isLoading, error, refetch } = useMarketNodes('fx', 30000)

data.nodes['EURUSD'].liveness.status  // 'LIVE_INTRADAY' | 'MARKET_CLOSED_STALE' | ...
data.nodes['EURUSD'].price            // 1.1348
data.nodes['EURUSD'].liveness.message // "🟢 Live (12s ago)"
```

### 5. **Component** (`src/components/market/MarketNodeRow.tsx`)

Renders a single market with dynamic liveness indicators.

---

## Usage Examples

### Example 1: FX Matrix with Liveness Indicators

```typescript
'use client'

import { useMarketNodes } from '@/lib/hooks/useMarketNodes'
import { MarketNodeRow } from '@/components/market/MarketNodeRow'

export function FXMatrix() {
  const { data, isLoading } = useMarketNodes('fx', 30000) // Poll every 30s

  if (isLoading) return <div>Loading...</div>
  if (!data) return <div>No data</div>

  return (
    <div className="space-y-2">
      <h3>FX Market (FRED + Yahoo)</h3>
      
      {Object.values(data.nodes).map(node => (
        <MarketNodeRow key={node.id} node={node} />
      ))}

      {/* Health Summary */}
      <div className="text-[10px] text-slate-400 pt-2 border-t border-slate-800">
        <div>Live: {data.health.liveCount}/{data.health.totalNodes}</div>
        <div>Stale: {data.health.staleCount}</div>
        <div>Health: {data.health.healthPercent.toFixed(1)}%</div>
      </div>
    </div>
  )
}
```

**Output:**
```
FX Market (FRED + Yahoo)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
EUR/USD  | 1.1348 | +0.0048 (+0.42%) | 🟢 LIVE_INTRADAY | 5s ago
GBP/USD  | 1.3412 | +0.0028 (+0.21%) | 🟢 LIVE_INTRADAY | 12s ago
USD/JPY  | 143.28 | -0.48 (-0.33%)   | 🕐 MARKET_CLOSED_STALE | 2h ago
...
```

### Example 2: Commodity Dashboard with Sparklines

```typescript
'use client'

import { useMarketNodes } from '@/lib/hooks/useMarketNodes'
import { MarketNodeRowWithSparkline } from '@/components/market/MarketNodeRow'

export function CommodityCards() {
  const { data, isLoading } = useMarketNodes('commodity', 30000)

  if (!data) return null

  return (
    <div className="grid grid-cols-2 gap-4">
      {Object.values(data.nodes).map(node => (
        <div key={node.id} className="bg-slate-900 p-4 rounded-lg">
          <MarketNodeRowWithSparkline node={node} />
        </div>
      ))}
    </div>
  )
}
```

### Example 3: Accessing Individual Nodes

```typescript
const { node } = useMarketNodes('fx')

const eurusd = node('EURUSD')
if (eurusd?.liveness.status === 'LIVE_INTRADAY') {
  console.log('EUR/USD is live:', eurusd.price)
}
```

---

## Liveness Indicators Explained

### 🟢 GREEN PULSE - LIVE_INTRADAY

**When:** Data age < 5 minutes AND market is active

**Visual:** Pulsing green circle (2s cycle)

**What it means:**
- Real-time market tick
- Active institutional flow
- Safe to trade on this data

**Example:**
```
EUR/USD: 1.1348 | +0.48 | 🟢 LIVE_INTRADAY | 12s ago
```

### 🕐 AMBER CLOCK - MARKET_CLOSED_STALE

**When:** Market is closed OR data age > max freshness threshold

**Visual:** Static amber circle with clock emoji

**What it means:**
- Last update from previous market session
- No intraday movement
- Safe to monitor, but not for tick trading

**Example:**
```
EUR/USD: 1.1348 | -0.12 | 🕐 MARKET_CLOSED_STALE | 16h ago
```

### 🔴 RED WARNING - FEED_DISCONNECTED

**When:** Data age > 30 min OR API health < 20%

**Visual:** Static red circle with warning emoji

**What it means:**
- API unavailable or severely degraded
- Last known price may be stale
- **Do not rely on this data for decisions**

**Example:**
```
EUR/USD: 1.1348 | — | 🔴 FEED_DISCONNECTED | Check feed health
```

---

## Configuration Guide

### Adding a New Market

1. **Add to `marketRegistry.ts`:**

```typescript
const NEW_MARKETS: Record<string, MarketRegistryConfig> = {
  'BTCUSD': {
    id: 'BTCUSD',
    displayName: 'Bitcoin USD',
    category: 'commodity',
    primarySource: {
      type: 'yahoo-finance',
      symbol: 'BTC-USD',
      refreshIntervalMs: 10000,  // More liquid, faster polling
      maxAgeMs: 180000,          // 3min threshold
    },
    decimals: 2,
    unit: 'USD',
    exchangeCode: 'CRYPTO',
    // ... market hours config
  },
}

// Then add to MARKET_REGISTRY:
export const MARKET_REGISTRY = {
  ...FX_MARKETS,
  ...COMMODITY_MARKETS,
  ...INDEX_MARKETS,
  ...NEW_MARKETS,  // ← Add here
}
```

2. **Adjust Market Hours (if needed):**

```typescript
marketHours: {
  open: '00:00',              // 24/7 markets
  close: '23:59',
  timezone: 'UTC',
  daysOpen: [0, 1, 2, 3, 4, 5, 6],  // All days
}
```

3. **Access via Hook:**

```typescript
const { data } = useMarketNodes('commodity')
const bitcoin = data?.nodes['BTCUSD']
```

---

## Health Metrics & Monitoring

### Dashboard Health Indicator

```typescript
const { data } = useMarketNodes('fx')

const healthStatus = data?.health.healthPercent >= 80
  ? '✅ Excellent'
  : data?.health.healthPercent >= 60
  ? '🟡 Degraded'
  : '🔴 Critical'
```

### Per-Node Health

```typescript
const { data } = useMarketNodes('fx')

data.nodes.forEach((node, id) => {
  console.log(`${id}: ${node.liveness.status} (${node.liveness.ageSeconds}s)`)
})
```

### Source-Level Diagnostics

```typescript
data.sources.yahoo.healthy        // bool
data.sources.yahoo.lastSuccessMs  // unix timestamp
data.sources.yahoo.errorMsg       // error details
```

---

## Styling & Customization

### Customize Liveness Colors

Edit `MarketNodeRow.tsx`:

```typescript
const statusColor = isLive 
  ? '#34d399'      // Green
  : isStale 
  ? '#fbbf24'      // Amber
  : '#ef4444'      // Red
```

### Compact Mode

```typescript
// Full layout (6 columns)
<MarketNodeRow node={node} />

// Compact (single-line)
<MarketNodeRow node={node} compact={true} />

// With sparkline
<MarketNodeRow node={node} showSparkline={true} />
```

### Custom Pulse Animation

```typescript
const pulseAnimation = isLive ? `
  @keyframes pulse {
    0%, 100% { box-shadow: 0 0 0 0 ${statusColor}40; }
    50% { box-shadow: 0 0 0 8px transparent; }
  }
  animation: pulse 2s infinite;
` : ''
```

---

## Performance Considerations

| Operation | Time | Notes |
|-----------|------|-------|
| Fetch Yahoo (6 markets) | 500ms–1s | Parallel requests |
| Liveness calculation | <1ms | Pure math |
| **Total per category** | **~1s** | Acceptable for 30s poll |

**Optimizations:**
- Poll intervals are configurable per market
- Stale cache is used if fetch fails
- Parallel fetching across categories

---

## Testing Checklist

- [ ] All 6 FX markets render with correct prices
- [ ] All 6 Commodity futures display
- [ ] All 4 Index futures show live data
- [ ] Liveness indicators update every 30s
- [ ] Green pulse animates for live data (<5min old)
- [ ] Amber clock shows when market closed
- [ ] Red warning displays if data >30min old
- [ ] Tooltips show age in human-readable format
- [ ] Sparklines render correctly when enabled
- [ ] Health % updates based on data freshness
- [ ] Component handles API errors gracefully
- [ ] Performance: renders <100ms per market

---

## Migration from Old Components

### Old Structure
```
FX Section
├─ Manual Yahoo fetching
├─ No liveness tracking
└─ Static error handling
```

### New Structure
```
FX Section (useMarketNodes)
├─ Unified data source
├─ Dynamic liveness 🟢🕐🔴
└─ Automatic fallbacks
```

**Replace:**
```typescript
// Old
<FXCard symbol="EURUSD" price={price} />

// New
<MarketNodeRow node={data.nodes['EURUSD']} />
```

---

## Future Enhancements

1. **WebSocket Live Updates:** Real-time push instead of polling
2. **Redis Caching:** Cache layer for failed fetches
3. **Multi-Source Validation:** Yahoo + FRED + Bloomberg comparison
4. **Historical Tracking:** Store liveness delta over time
5. **Alerts:** Slack/email when health drops
6. **Time-zone Support:** Market hours for different exchanges
7. **Bid/Ask Spreads:** Show liquidity metrics

---

## Troubleshooting

**Issue: All markets showing FEED_DISCONNECTED**
```
→ Check Yahoo Finance API status
→ Verify network connectivity
→ Check console for fetch errors
```

**Issue: Liveness stuck at MARKET_CLOSED_STALE**
```
→ Correct market hours in config
→ Verify timezone is 'America/New_York'
→ Check daysOpen array matches market schedule
```

**Issue: Sparklines not rendering**
```
→ Ensure showSparkline={true} is passed
→ Verify sparkline array exists on node
→ Check SVG viewBox dimensions
```

---

## Code References

- **Types:** `src/lib/types/market.ts`
- **Config:** `src/lib/config/marketRegistry.ts`
- **Service:** `src/lib/services/marketFetcher.ts`
- **Hook:** `src/lib/hooks/useMarketNodes.ts`
- **Component:** `src/components/market/MarketNodeRow.tsx`
