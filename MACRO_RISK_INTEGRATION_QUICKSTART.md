# Macro Risk Matrix - Live Data Integration Quick Start

## 🔗 Integration Roadmap

```
Current State              Next Step (1-2 hours)        Production (1-2 days)
┌──────────────────┐     ┌──────────────────┐         ┌──────────────────┐
│ Mock Data Only   │────▶│ Wire API Route   │────────▶│ Live Data Feeds  │
│ Dashboard ready  │     │ + Fallback       │         │ + DB Caching     │
└──────────────────┘     └──────────────────┘         └──────────────────┘
```

---

## Phase 1: Create Your API Route (1-2 hours)

### Step 1: Create `/api/macro-risk` Endpoint

Create file: `src/app/api/macro-risk/route.ts`

```typescript
import { NextRequest, NextResponse } from 'next/server'
import { MACRO_RISK_MOCK, MacroRiskMetrics } from '@/components/dashboard/MacroRiskMatrix'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// In-memory cache for 1-minute window
let cachedMetrics: MacroRiskMetrics | null = null
let cacheTimestamp = 0
const CACHE_TTL = 60_000 // 1 minute

async function fetchMacroRiskData(): Promise<MacroRiskMetrics> {
  // TODO: Replace with real data sources (Phase 2)
  // For now, return mock with slight variations
  return {
    ...MACRO_RISK_MOCK,
    vix: {
      ...MACRO_RISK_MOCK.vix,
      price: MACRO_RISK_MOCK.vix.price + (Math.random() - 0.5) * 0.5, // ±0.25 jitter
    },
    timestamp: Date.now(),
  }
}

export async function GET(request: NextRequest) {
  try {
    // Check cache
    if (cachedMetrics && Date.now() - cacheTimestamp < CACHE_TTL) {
      return NextResponse.json(cachedMetrics)
    }

    // Fetch fresh data
    const metrics = await fetchMacroRiskData()
    cachedMetrics = metrics
    cacheTimestamp = Date.now()

    return NextResponse.json(metrics)
  } catch (error) {
    console.error('Macro risk fetch failed:', error)
    // Fallback to mock data
    return NextResponse.json(MACRO_RISK_MOCK)
  }
}
```

### Step 2: Update Dashboard to Use API

Modify `src/app/dashboard/page.tsx`:

```typescript
// Add this to your data fetching section
const [macroRisk, setMacroRisk] = useState<MacroRiskMetrics | null>(null)

useEffect(() => {
  const fetchMacroRisk = async () => {
    try {
      const res = await fetch('/api/macro-risk', { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setMacroRisk(data)
      }
    } catch (error) {
      console.error('Macro risk fetch error:', error)
      // Will use MACRO_RISK_MOCK fallback
    }
  }

  fetchMacroRisk()
  const interval = setInterval(fetchMacroRisk, 60_000) // Update every minute
  return () => clearInterval(interval)
}, [])

// In your render section:
<MacroRiskMatrix metrics={macroRisk ?? MACRO_RISK_MOCK} />
```

### Step 3: Test with Mock

```bash
# Start your dev server
npm run dev

# Visit dashboard - should show Macro Risk Matrix with mock data
http://localhost:3000/dashboard
```

✅ Phase 1 complete: API route returns data, dashboard consumes it

---

## Phase 2: Connect Live Data Sources (1-2 days)

### VIX + VVIX (CBOE)

**Option A: CBOE API (Recommended)**
```typescript
// Install: npm install @cboe/websocket-client

import { CBOEWebSocket } from '@cboe/websocket-client'

const cboe = new CBOEWebSocket()

cboe.on('quote', (quote) => {
  if (quote.symbol === '^VIX') {
    // Update VIX price
  } else if (quote.symbol === '^VVIX') {
    // Store previousClose before updating
    vvixPreviousClose = currentVvix.price
    // Update VVIX price
  }
})

cboe.subscribe(['^VIX', '^VVIX'])
```

**Option B: Yahoo Finance (Free, 15-min delayed)**
```typescript
async function fetchVixData() {
  const res = await fetch('https://query1.finance.yahoo.com/v10/finance/quoteSummary/^VIX')
  const data = await res.json()
  return {
    price: data.quoteSummary.result[0].price.regularMarketPrice,
    change: data.quoteSummary.result[0].price.regularMarketChange,
  }
}
```

### MOVE Index

**Option A: Bloomberg Terminal (Best - Real-time)**
```typescript
// Setup Bloomberg SDK
// Reference: https://github.com/bloomberglabs/tBloomberg-api-python

const moveQuote = await bloomberg.fetch({
  securities: ['^MOVE'],
  fields: ['PX_LAST', 'CHG', 'PCT_CHANGE', 'EMA_20'],
})

return {
  price: moveQuote.data[0].PX_LAST,
  change: moveQuote.data[0].CHG,
  changePercent: moveQuote.data[0].PCT_CHANGE,
  historicalMean: moveQuote.data[0].EMA_20, // 20-day moving average
}
```

**Option B: Refinitiv EIKON (Alternative)**
```typescript
// Use EIKON SDK or REST API
// Reference: https://github.com/Refinitiv/refinitiv-data-examples

const moveData = await eikon.data.get({
  instruments: ['^MOVE'],
  fields: ['CLOSE', 'NET_CHG', 'PCT_CHG'],
  parameters: {
    SDate: '-5D', // Get last 5 days for mean calculation
  },
})
```

### HY OAS (High-Yield Spreads)

**Option A: BofA Merrill Lynch Data (Best)**
```typescript
// Via Bloomberg Terminal or Refinitiv
const hyOasQuote = await bloomberg.fetch({
  securities: ['LUACTRUU Index'], // HY OAS Index
  fields: ['PX_LAST', 'CHG', 'HIST_CLOSE'],
  overrides: [
    { fieldId: 'HIST_CLOSE', value: 5 }, // Last 5 days
  ],
})

const rollingData = hyOasQuote.historicalData
const rolling5dayChange = rollingData[0] - rollingData[4]

return {
  price: hyOasQuote.data[0].PX_LAST,
  change: hyOasQuote.data[0].CHG,
  rolling5dayChange: rolling5dayChange,
  rolling5dayHigh: Math.max(...rollingData),
}
```

**Option B: Yahoo Finance ETF (Alternative)**
```typescript
// Use HY bond ETF proxy: HYG, LQD, ANYD
async function fetchHyOasProxy() {
  const res = await fetch('https://query1.finance.yahoo.com/v10/finance/quoteSummary/HYG')
  const data = await res.json()
  // Note: This is approximate, not true HY OAS
  return data.quoteSummary.result[0].price
}
```

### CBOE Skew

**Option A: CBOE Real-time**
```typescript
cboe.subscribe(['^SKEW'])

cboe.on('quote', (quote) => {
  if (quote.symbol === '^SKEW') {
    skewMetrics = {
      price: quote.price,
      change: quote.change,
      changePercent: quote.changePercent,
    }
  }
})
```

**Option B: Yahoo Finance**
```typescript
async function fetchSkew() {
  const res = await fetch('https://query1.finance.yahoo.com/v10/finance/quoteSummary/^SKEW')
  const data = await res.json()
  return data.quoteSummary.result[0].price
}
```

### Put/Call Ratio

**CBOE Official**
```typescript
cboe.subscribe(['^PCRATIO']) // Official CBOE put/call ratio

// Or calculate from options data
async function calculatePutCallRatio() {
  const options = await fetchOptionsChain('^SPX') // Get S&P 500 options
  const putVolume = options.puts.reduce((sum, opt) => sum + opt.volume, 0)
  const callVolume = options.calls.reduce((sum, opt) => sum + opt.volume, 0)
  return putVolume / callVolume
}
```

---

## Implementation Template

Complete updated `src/app/api/macro-risk/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { MacroRiskMetrics, MACRO_RISK_MOCK } from '@/components/dashboard/MacroRiskMatrix'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// Data sources (to be implemented)
async function fetchVixData(): Promise<{ price: number; change: number; changePercent: number }> {
  // TODO: Replace with real CBOE feed
  return { ...MACRO_RISK_MOCK.vix }
}

async function fetchVvixData(): Promise<{
  price: number
  change: number
  changePercent: number
  previousClose: number
}> {
  // TODO: Replace with real CBOE feed
  return { ...MACRO_RISK_MOCK.vvix }
}

async function fetchMoveData(): Promise<{
  price: number
  change: number
  changePercent: number
  historicalMean: number
}> {
  // TODO: Replace with real Bloomberg/Refinitiv feed
  return { ...MACRO_RISK_MOCK.move }
}

async function fetchHyOasData(): Promise<{
  price: number
  change: number
  changePercent: number
  rolling5dayChange: number
  rolling5dayHigh: number
}> {
  // TODO: Replace with real BofA ML feed + rolling window cache
  return { ...MACRO_RISK_MOCK.hyOas }
}

async function fetchSkewData(): Promise<{ price: number; change: number; changePercent: number }> {
  // TODO: Replace with real CBOE feed
  return { ...MACRO_RISK_MOCK.skew }
}

async function fetchPutCallRatio(): Promise<number> {
  // TODO: Replace with real CBOE or calculated feed
  return MACRO_RISK_MOCK.putCallRatio
}

export async function GET() {
  try {
    const [vix, vvix, move, hyOas, skew, putCallRatio] = await Promise.allSettled([
      fetchVixData(),
      fetchVvixData(),
      fetchMoveData(),
      fetchHyOasData(),
      fetchSkewData(),
      fetchPutCallRatio(),
    ])

    const metrics: MacroRiskMetrics = {
      vix: vix.status === 'fulfilled' ? vix.value : MACRO_RISK_MOCK.vix,
      vvix: vvix.status === 'fulfilled' ? vvix.value : MACRO_RISK_MOCK.vvix,
      move: move.status === 'fulfilled' ? move.value : MACRO_RISK_MOCK.move,
      hyOas: hyOas.status === 'fulfilled' ? hyOas.value : MACRO_RISK_MOCK.hyOas,
      skew: skew.status === 'fulfilled' ? skew.value : MACRO_RISK_MOCK.skew,
      putCallRatio: putCallRatio.status === 'fulfilled' ? putCallRatio.value : MACRO_RISK_MOCK.putCallRatio,
      timestamp: Date.now(),
    }

    return NextResponse.json(metrics)
  } catch (error) {
    console.error('Macro risk data fetch failed:', error)
    return NextResponse.json(MACRO_RISK_MOCK)
  }
}
```

---

## Data Source Priority List

| Metric | Best | Alternative | Fallback |
|--------|------|-------------|----------|
| VIX | CBOE WebSocket | Yahoo Finance | Mock |
| VVIX | CBOE WebSocket | Yahoo Finance | Mock |
| MOVE | Bloomberg Terminal | Refinitiv EIKON | Mock |
| HY OAS | BofA Merrill Lynch | Bloomberg | HYG ETF |
| Skew | CBOE API | CBOE WebSocket | Mock |
| Put/Call | CBOE API | Options chain calc | Mock |

---

## Caching Strategy

```typescript
// For high-frequency data (VIX, VVIX, Skew, Put/Call)
const CACHE_TTL_SHORT = 5_000 // 5 seconds

// For moderate frequency (MOVE, HY OAS)
const CACHE_TTL_MEDIUM = 30_000 // 30 seconds

// For daily/history (5-day rolling for HY OAS)
const CACHE_TTL_LONG = 300_000 // 5 minutes

// Redis storage for 5-day window
const hyOas5DayWindow = await redis.lrange('hy-oas:history', 0, 4)
const rolling5dayChange = hyOas5DayWindow[0] - hyOas5DayWindow[4]
```

---

## Testing Checklist

- [ ] API endpoint responds with valid MacroRiskMetrics
- [ ] All 6 metrics have non-zero values
- [ ] Dashboard displays metrics without errors
- [ ] Stress badge color changes based on MOVE/VIX ratio
- [ ] Tail risk alert triggers when VVIX > +5%
- [ ] HY OAS expands >15 bps, alert shows amber
- [ ] Fallback to MACRO_RISK_MOCK if any feed fails
- [ ] API caches data for 1 minute
- [ ] Data updates when cache expires

---

## Common Issues & Solutions

### Issue: MOVE data not available / not updating
**Solution**: Use Bloomberg Terminal or subscribe to ICE data feed. For dev, keep using MACRO_RISK_MOCK.

### Issue: HY OAS history not tracked
**Solution**: Implement Redis list storage for 5-day rolling window.

### Issue: VVIX previousClose is null
**Solution**: Store previous day's close before each update cycle.

### Issue: Put/Call ratio always same
**Solution**: Update more frequently (5-10 sec) or fetch from real-time CBOE API.

---

## Next Phase: Webhook Alerts

Once live data is flowing:

```typescript
// Send alerts to Slack when thresholds trigger
if (moveVixRatio > 8.45) {
  await fetch(process.env.SLACK_WEBHOOK_CRITICAL, {
    method: 'POST',
    body: JSON.stringify({
      text: `🔴 BOND STRESS: MOVE/VIX = ${moveVixRatio.toFixed(2)}x | MOVE: ${movePrice} | VIX: ${vixPrice}`,
    }),
  })
}
```

---

**Time to First Live Data**: 1-2 days
**Complexity**: Medium (data sourcing)
**Priority**: High (completes the risk monitoring system)

Start with VIX/VVIX from CBOE, then add MOVE, and you'll have a production-grade system.
