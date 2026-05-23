# FX Market Data Integration Guide

## Quick Start

### 1. Verify the API is Working

```bash
curl http://localhost:3000/api/fx-market
```

**Expected response:**
```json
{
  "pairs": [
    {
      "symbol": "EURUSD=X",
      "name": "EUR/USD",
      "validationStatus": "OK",
      "displayPrice": 1.1348,
      "displaySource": "fred"
    }
    // ... more pairs
  ],
  "validationHealth": {
    "healthPercentage": 83.3
  }
}
```

### 2. Add to Your Dashboard Component

```typescript
'use client'

import { useFXMarketData, getValidationStatusMessage } from '@/lib/hooks/useFXMarketData'

export function FXMarketSection() {
  const { data, isLoading, validationHealthy, error } = useFXMarketData(5 * 60_000)

  if (isLoading) return <div>Loading FX data...</div>
  if (error) return <div className="text-red-400">Error: {error}</div>
  if (!data) return null

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4">
      {/* Validation Health Header */}
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
          FX Market Data (FRED + Yahoo Validation)
        </h3>
        <div
          className={`text-[10px] font-mono font-bold px-2 py-1 rounded border ${
            validationHealthy
              ? 'text-green-400 border-green-400/30 bg-green-400/10'
              : 'text-amber-400 border-amber-400/30 bg-amber-400/10'
          }`}
        >
          Health: {data.validationHealth.healthPercentage.toFixed(1)}%
        </div>
      </div>

      {/* FX Pair Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {data.pairs.map(pair => (
          <FXPairCard key={pair.symbol} pair={pair} />
        ))}
      </div>

      {/* Validation Summary */}
      <div className="mt-4 pt-3 border-t border-slate-800 text-[9px] text-slate-400 font-mono">
        <div className="flex justify-between">
          <span>OK: {data.validationHealth.okCount}/{data.validationHealth.totalPairs}</span>
          <span>Stale: {data.validationHealth.staleCount}</span>
          <span>Mismatches: {data.validationHealth.mismatchCount}</span>
          <span>Avg Delta: {data.validationHealth.avgDeltaBps?.toFixed(1) || '—'} bps</span>
        </div>
      </div>
    </div>
  )
}

function FXPairCard({ pair }) {
  const statusColor =
    pair.validationStatus === 'OK'
      ? '#34d399'
      : pair.validationStatus.includes('STALE')
      ? '#fbbf24'
      : '#ef4444'

  const statusIcon =
    pair.validationStatus === 'OK'
      ? '✅'
      : pair.validationStatus.includes('STALE')
      ? '⚠️'
      : '🔴'

  return (
    <div
      className="bg-[#080d18] border rounded-lg p-3 space-y-2"
      style={{ borderColor: statusColor + '40' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-[11px] font-mono font-bold text-slate-100">
            {pair.name}
          </div>
          <div className="text-[9px] text-slate-400">
            Source: {pair.displaySource.toUpperCase()}
          </div>
        </div>
        <div
          className="text-[11px] font-mono font-bold"
          style={{ color: statusColor }}
        >
          {pair.displayPrice.toFixed(pair.symbol.includes('JPY') ? 2 : 4)}
        </div>
      </div>

      {/* Changes */}
      <div className="text-[10px] text-slate-300 font-mono flex gap-2">
        {pair.dailyChange !== 0 && (
          <>
            <span style={{ color: pair.dailyChange >= 0 ? '#34d399' : '#f87171' }}>
              {pair.dailyChange >= 0 ? '+' : ''}{pair.dailyChange.toFixed(4)}
            </span>
            <span style={{ color: pair.dailyChangePercent >= 0 ? '#34d399' : '#f87171' }}>
              ({pair.dailyChangePercent >= 0 ? '+' : ''}{pair.dailyChangePercent.toFixed(2)}%)
            </span>
          </>
        )}
      </div>

      {/* Validation Status */}
      <div className="pt-1 border-t border-slate-800">
        <div className="flex items-center gap-1.5">
          <span>{statusIcon}</span>
          <span className="text-[9px] font-mono" style={{ color: statusColor }}>
            {pair.validationStatus}
          </span>
        </div>

        {/* Variance Warning */}
        {pair.deltaBps !== null && pair.deltaBps > 25 && (
          <div className="text-[8px] text-amber-400/70 mt-1 font-mono">
            {pair.deltaBps.toFixed(1)} bps variance (FRED: {pair.fredPrice?.toFixed(4)}, Yahoo: {pair.yahooPrice?.toFixed(4)})
          </div>
        )}

        {/* Staleness Warning */}
        {pair.fredDaysStale !== null && pair.fredDaysStale > 1 && (
          <div className="text-[8px] text-amber-400/70 mt-1 font-mono">
            FRED data is {pair.fredDaysStale.toFixed(1)} days old
          </div>
        )}
      </div>
    </div>
  )
}
```

### 3. Add to Page Layout

```typescript
// src/app/dashboard/page.tsx

import { FXMarketSection } from '@/components/fx-market-section'
import { InstitutionalFlowsSection } from '@/components/dashboard/InstitutionalFlowsSection'

export default function DashboardPage() {
  return (
    <div className="space-y-4">
      {/* Existing sections */}
      <InstitutionalFlowsSection cot={[]} />

      {/* New FX validation section */}
      <FXMarketSection />

      {/* Rest of dashboard */}
    </div>
  )
}
```

---

## Validation Logic in Context

### Scenario 1: Everything OK ✅
```
FRED EUR/USD:  1.1348 (published 2h ago)
Yahoo EUR/USD: 1.1348 (live)
Delta: 0 bps
Status: ✅ OK → Use FRED
```

### Scenario 2: Stale but Aligned ⚠️
```
FRED EUR/USD:  1.1345 (published 3 days ago)
Yahoo EUR/USD: 1.1348 (live)
Delta: 2.6 bps
Status: ⚠️ STALE_MACRO → Use FRED with warning
Tooltip: "FRED data is 3.2 days old but prices align"
```

### Scenario 3: High Variance 🔴
```
FRED EUR/USD:  1.1348 (published 2h ago)
Yahoo EUR/USD: 1.1418 (live)
Delta: 61.5 bps (>50 bps threshold)
Status: 🔴 VALIDATION_MISMATCH → Use YAHOO with warning
Tooltip: "61.5 bps divergence detected. Using live Yahoo price."
```

### Scenario 4: FRED Unavailable
```
FRED EUR/USD:  null (API error)
Yahoo EUR/USD: 1.1348 (live)
Status: ⚠️ MISSING_FRED → Use YAHOO
Tooltip: "FRED API unavailable, using live Yahoo data"
```

---

## Monitoring Dashboard

Add this to your admin/monitoring dashboard:

```typescript
'use client'

import { useFXMarketData } from '@/lib/hooks/useFXMarketData'

export function FXValidationMonitor() {
  const { data, error } = useFXMarketData(30000) // Update every 30s for monitoring

  if (error) {
    return (
      <div className="bg-red-950/50 border border-red-400 p-3 rounded text-red-300">
        🔴 API Error: {error}
      </div>
    )
  }

  if (!data) return null

  const { validationHealth } = data

  const healthStatus =
    validationHealth.healthPercentage >= 90
      ? '🟢 Excellent'
      : validationHealth.healthPercentage >= 75
      ? '🟡 Good'
      : validationHealth.healthPercentage >= 50
      ? '🟠 Degraded'
      : '🔴 Critical'

  return (
    <div className="bg-slate-900 border border-slate-700 rounded-lg p-4 space-y-2">
      <h3 className="font-mono font-bold">FX Validation Health</h3>

      <div className="grid grid-cols-3 gap-2 text-[11px] font-mono">
        <div>
          <div className="text-slate-400">Health</div>
          <div className={validationHealth.healthPercentage >= 75 ? 'text-green-400' : 'text-amber-400'}>
            {validationHealth.healthPercentage.toFixed(1)}%
          </div>
        </div>

        <div>
          <div className="text-slate-400">OK Pairs</div>
          <div className="text-blue-400">
            {validationHealth.okCount}/{validationHealth.totalPairs}
          </div>
        </div>

        <div>
          <div className="text-slate-400">Avg Variance</div>
          <div className={
            (validationHealth.avgDeltaBps ?? 0) <= 50
              ? 'text-green-400'
              : 'text-amber-400'
          }>
            {validationHealth.avgDeltaBps?.toFixed(1) || '—'} bps
          </div>
        </div>
      </div>

      <div className="text-[10px] text-slate-400 pt-2 border-t border-slate-700">
        {validationHealth.staleCount > 0 && (
          <div>⚠️ {validationHealth.staleCount} stale (>24h)</div>
        )}
        {validationHealth.mismatchCount > 0 && (
          <div>🔴 {validationHealth.mismatchCount} high variance (>50 bps)</div>
        )}
        {validationHealth.missingCount > 0 && (
          <div>❌ {validationHealth.missingCount} data unavailable</div>
        )}
      </div>

      <div className="text-[9px] text-slate-500 pt-1">
        Status: {healthStatus}
      </div>
    </div>
  )
}
```

---

## Error Handling

### Handle API Errors Gracefully

```typescript
const { data, error, isLoading } = useFXMarketData()

if (error) {
  // Log to monitoring service
  console.error('[FX Market]', error)
  
  // Show user-facing message
  return (
    <div className="bg-amber-950/50 p-3 rounded border border-amber-700">
      <p className="text-amber-300">
        Unable to fetch live FX data. Using cached prices.
      </p>
    </div>
  )
}
```

### Use Previous Data as Fallback

```typescript
const cachedData = useRef(null)

const { data } = useFXMarketData()

const displayData = data || cachedData.current

if (displayData) {
  cachedData.current = displayData
  // Render with displayData (fresh or cached)
}
```

---

## Performance Tips

1. **Adjust poll interval based on use case:**
   - Watchlist dashboard: 30 seconds
   - Admin monitoring: 30 seconds
   - Main dashboard: 5 minutes
   - Static charts: 60 minutes

2. **Batch FX requests:**
   ```typescript
   // Good: Single hook manages all pairs
   const fxData = useFXMarketData()
   
   // Avoid: Multiple independent API calls
   const eur = useFXMarketData('EURUSD') // ❌ Don't do this
   const gbp = useFXMarketData('GBPUSD') // ❌ Creates 2 API calls
   ```

3. **Leverage Next.js caching:**
   ```typescript
   // API route already uses cache: 'no-store'
   // But you can cache in components with SWR or React Query:
   import useSWR from 'swr'
   
   const { data } = useSWR('/api/fx-market', fetch, {
     revalidateOnFocus: false,
     dedupingInterval: 30000, // 30s dedup
   })
   ```

---

## Troubleshooting

### Issue: "FX data is unavailable"
```
Solution 1: Check FRED_API_KEY in .env.local
Solution 2: Verify Yahoo Finance endpoints (query1/query2)
Solution 3: Check network connectivity
```

### Issue: "All FX pairs showing MISSING_FRED"
```
FRED API is down or returning empty observations
Fallback: Dashboard uses Yahoo Finance data
Check: https://fred.stlouisfed.org/api/fred/series/DEXUSEU/observations?api_key=...
```

### Issue: "High variance (>50 bps) between FRED and Yahoo"
```
Likely causes:
1. FRED data is stale (published once/week)
2. Market dislocation or gap
3. API lag on one service

Action: Trust Yahoo as real-time source, investigate further
Monitor: Add logging to track which source is used
```

---

## Deployment Checklist

- [ ] FRED_API_KEY configured in production .env
- [ ] `/api/fx-market` returns 200 within 3 seconds
- [ ] Validation health is >= 75% (most pairs OK)
- [ ] Dashboard component renders without errors
- [ ] Monitoring dashboard shows health metrics
- [ ] Error boundaries catch API failures gracefully
- [ ] Alerts configured for health < 50%

---

## Next Steps

1. **Add Sparklines:** Fetch intraday Yahoo FX data for charts
2. **Historical Tracking:** Store validation delta over time
3. **Alerting:** Slack notification when health drops
4. **Caching:** Redis layer for faster repeated requests
5. **Multi-source:** Add Bloomberg or other providers for redundancy
