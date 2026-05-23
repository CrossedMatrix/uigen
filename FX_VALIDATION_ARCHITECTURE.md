# FX Market Data Architecture: Yahoo Finance + FRED Validation

## Overview

This document outlines the complete architecture for integrating Yahoo Finance real-time FX spot rates with FRED (Federal Reserve Economic Data) macro FX series, including a comprehensive validation engine to detect staleness, variance anomalies, and data quality issues.

---

## System Architecture

### Three-Layer Design

```
┌─────────────────────────────────────────────────────────────┐
│  PRESENTATION LAYER (React Components)                      │
│  - useFXMarketData() hook                                   │
│  - Dashboard FX cards with validation badges               │
│  - Real-time pricing with source indicators                 │
└─────────────────────────────────────────────────────────────┘
                         ↑
┌─────────────────────────────────────────────────────────────┐
│  API LAYER: /api/fx-market (Next.js Route Handler)         │
│  - Orchestrates FRED + Yahoo Finance parallel fetches      │
│  - Invokes validation engine                               │
│  - Returns FX data with validation metadata                │
└─────────────────────────────────────────────────────────────┘
                         ↑
                    ┌────┴────┐
                    ↓         ↓
        ┌──────────────────┐  ┌──────────────────┐
        │  FRED API        │  │  Yahoo Finance   │
        │  (Macro Data)    │  │  (Real-time)     │
        │  Series: DEXUSEU │  │  Symbol: EURUSD=X│
        │  Freq: Weekly    │  │  Freq: Real-time │
        └──────────────────┘  └──────────────────┘
```

---

## Data Flow

### Request Flow: GET /api/fx-market

1. **Client Request**
   ```typescript
   const { data, isLoading } = useFXMarketData(5 * 60_000) // Poll every 5 minutes
   ```

2. **API Handler Execution**
   ```
   FetchAllFREDFXData() ──────────┐
                                  ├──> Validation Engine
   FetchFXBatch(yahooSymbols) ────┘
   ```

3. **Validation Process**
   - For each FX pair (DXY, EUR/USD, GBP/USD, USD/JPY, USD/CNY, AUD/USD):
     - Extract FRED price + timestamp
     - Extract Yahoo price + timestamp
     - Run validation checks
     - Determine display source

4. **Response with Health Metrics**
   ```json
   {
     "pairs": [
       {
         "symbol": "EURUSD=X",
         "name": "EUR/USD",
         "fredPrice": 1.1348,
         "yahooPrice": 1.1351,
         "validationStatus": "VALIDATION_MISMATCH",
         "deltaBps": 26,
         "recommendation": "use_yahoo_with_warning",
         "displayPrice": 1.1351,
         "displaySource": "yahoo"
       }
     ],
     "validationHealth": {
       "totalPairs": 6,
       "okCount": 4,
       "staleCount": 1,
       "mismatchCount": 1,
       "healthPercentage": 83.3
     }
   }
   ```

---

## Validation Engine: Core Logic

### Validation States

| Status | Trigger | Recommendation | UI Badge |
|--------|---------|----------------|----------|
| `OK` | Both sources fresh and <50 bps delta | Use FRED | ✅ Green |
| `STALE_MACRO` | FRED >24h old, but prices align | Use FRED with warning | ⚠️ Amber |
| `VALIDATION_MISMATCH` | >0.5% (50 bps) delta between sources | Use Yahoo, flag divergence | 🔴 Red |
| `MISSING_YAHOO` | Yahoo unavailable, FRED available | Use FRED | ⚠️ Amber |
| `MISSING_FRED` | FRED unavailable, Yahoo available | Use Yahoo | ⚠️ Amber |

### Validation Formulas

#### 1. Staleness Check
```typescript
daysStale = (now - fredObsDate) / (1000 * 60 * 60 * 24)

if (daysStale > 1 && yahooHasRecentTick) {
  status = 'STALE_MACRO'
}
```

**Why this matters:** FRED publishes weekly, so a 3-day old observation might be stale if markets have moved intraday. Yahoo Finance updates in real-time during market hours.

#### 2. Variance / Arbitrage Check
```typescript
delta% = |yahooPrice - fredPrice| / yahooPrice * 100
deltaBps = delta% * 100

// Example: EUR/USD = 1.1348 (FRED) vs 1.1351 (Yahoo)
// delta = |1.1351 - 1.1348| / 1.1351 * 100 = 0.026% = 2.6 bps ✅

// Critical example: If delta > 50 bps (0.5%), flag
```

**Why this matters:** FX spot markets are highly liquid and efficient. A >50 bps spread between authoritative sources signals:
- Data lag (FRED didn't update)
- API inconsistency (one source is delayed)
- Market dislocation (rare, but possible in crises)

### Decision Tree

```
Does FRED data exist?
├─ NO
│  └─ Does Yahoo exist?
│     ├─ YES → Recommend YAHOO (MISSING_FRED)
│     └─ NO  → ERROR (MISSING_YAHOO)
└─ YES
   ├─ Does Yahoo exist?
   │  └─ NO  → Recommend FRED (MISSING_YAHOO)
   │          Check if FRED >24h old
   │          ├─ YES → Flag STALE_MACRO
   │          └─ NO  → OK
   └─ YES
      ├─ Is FRED >24h old?
      │  ├─ YES
      │  │  ├─ Is delta > 50 bps? → Recommend YAHOO (high variance)
      │  │  └─ Else             → Recommend FRED_WITH_WARNING (stale but aligned)
      │  └─ NO
      │     ├─ Is delta > 50 bps? → Recommend YAHOO_WITH_WARNING (fresh but divergent)
      │     └─ Else             → Recommend FRED (OK)
```

---

## Service Layer Implementation

### File Structure

```
src/lib/
├── services/
│   ├── yahoo-finance-fx.ts      ← Yahoo Finance API integration
│   └── fx-validation.ts          ← Validation engine logic
├── types/
│   └── fx-market-data.ts         ← TypeScript interfaces
└── hooks/
    └── useFXMarketData.ts        ← React hook for components
    
src/app/api/
└── fx-market/
    └── route.ts                  ← Next.js API handler
```

### Yahoo Finance FX Service

**File:** `src/lib/services/yahoo-finance-fx.ts`

```typescript
export async function fetchYahooFXQuotes(symbols: string[]): Promise<Map<string, FXDataPoint>>
```

**Features:**
- Fallback endpoints (query2 → query1)
- 8-second timeout with AbortSignal
- Returns Map for O(1) lookups in validation
- Retry logic with exponential backoff

**Supported Symbols:**
```typescript
const FX_SYMBOL_MAP = {
  'DXY': 'DX-Y.NYB',           // Dollar Index
  'EURUSD': 'EURUSD=X',        // EUR/USD
  'GBPUSD': 'GBPUSD=X',        // GBP/USD
  'USDJPY': 'USDJPY=X',        // USD/JPY
  'USDCNY': 'CNY=X',           // USD/CNY
  'AUDUSD': 'AUDUSD=X',        // AUD/USD
}
```

### Validation Service

**File:** `src/lib/services/fx-validation.ts`

```typescript
export function validateFXPair(
  fxPair: string,
  fredSymbol: string,
  yahooSymbol: string,
  fredPrice: number | null,
  fredDate: string | null,
  yahooPrice: number | null,
  yahooTimestamp: number | null
): FXValidationResult
```

**Returns:**
```typescript
{
  status: ValidationStatus              // OK, STALE_MACRO, VALIDATION_MISMATCH, etc.
  deltaBps: number | null              // Variance in basis points
  recommendation: string               // use_fred, use_yahoo, use_*_with_warning
  fredDaysStale: number | null         // Days since FRED observation
  // ...
}
```

---

## API Route: /api/fx-market

**File:** `src/app/api/fx-market/route.ts`

### Request
```
GET /api/fx-market
```

### Response (200 OK)
```json
{
  "pairs": [
    {
      "symbol": "EURUSD=X",
      "name": "EUR/USD",
      "fredPrice": 1.1348,
      "fredDate": "2026-05-20",
      "yahooPrice": 1.1351,
      "yahooTimestamp": 1716193000000,
      "validationStatus": "OK",
      "deltaBps": 2.6,
      "recommendation": "use_fred",
      "displayPrice": 1.1348,
      "displaySource": "fred",
      "dailyChange": 0.0048,
      "dailyChangePercent": 0.42
    }
    // ... 5 more pairs
  ],
  "validationHealth": {
    "totalPairs": 6,
    "okCount": 5,
    "staleCount": 0,
    "mismatchCount": 1,
    "missingCount": 0,
    "avgDeltaBps": 18.3,
    "healthPercentage": 83.3
  },
  "timestamp": 1716193000000,
  "fredDataTimestamp": 1716193000000,
  "yahooDataTimestamp": 1716193000000
}
```

### Error Handling
- **Network errors:** Logs to console, returns 500 with error detail
- **FRED unavailable:** Falls back to Yahoo data
- **Yahoo unavailable:** Falls back to FRED data
- **Both unavailable:** Returns pairs with null prices

---

## React Hook: useFXMarketData

**File:** `src/lib/hooks/useFXMarketData.ts`

### Usage

```typescript
'use client'

import { useFXMarketData } from '@/lib/hooks/useFXMarketData'

export function FXPanel() {
  const { data, isLoading, validationHealthy } = useFXMarketData(5 * 60_000)

  if (isLoading) return <Spinner />
  if (!data) return <Error />

  return (
    <div>
      <div className="flex gap-2">
        <span>FX Health:</span>
        <span className={validationHealthy ? 'text-green-400' : 'text-amber-400'}>
          {data.validationHealth.healthPercentage.toFixed(1)}%
        </span>
      </div>

      {data.pairs.map(pair => (
        <FXCard key={pair.symbol} pair={pair} />
      ))}
    </div>
  )
}

function FXCard({ pair }) {
  return (
    <div>
      <div>{pair.name}</div>
      <div>{pair.displayPrice}</div>
      <div className={
        pair.validationStatus === 'OK'
          ? 'text-green-400'
          : pair.validationStatus.includes('STALE')
          ? 'text-amber-400'
          : 'text-red-400'
      }>
        {pair.validationStatus}
      </div>
      {pair.validationStatus === 'VALIDATION_MISMATCH' && (
        <tooltip title={`${pair.deltaBps.toFixed(1)} bps divergence between FRED and Yahoo. Using ${pair.displaySource.toUpperCase()} source.`}>
          ⚠️ {pair.deltaBps.toFixed(1)} bps variance
        </tooltip>
      )}
    </div>
  )
}
```

---

## Integration Points

### 1. Dashboard FX Section
Update your FX market card component:
```typescript
import { useFXMarketData } from '@/lib/hooks/useFXMarketData'

const FXMarketCard = () => {
  const { data, validationHealthy } = useFXMarketData()
  // Render with validation badges
}
```

### 2. Macro Positioning Dashboard
Cross-check FX validation when displaying DXY/EUR/GBP positioning:
```typescript
const fxHealth = data.validationHealth.healthPercentage
if (fxHealth < 75) {
  // Show warning badge on positioning matrix
  showValidationWarning('FX data quality degraded')
}
```

### 3. Liquidity Monitoring
Use FX validation health in Fed Liquidity Monitor:
```typescript
const fxHealthy = data.validationHealth.healthPercentage >= 80
const fedLiquidityBadge = `${fxHealthy ? '✅' : '⚠️'} Liquidity Monitor`
```

---

## Monitoring & Observability

### Logs to Watch

```
[yahoo-fx] Fetched 6 FX quotes from query1
[fx-market] FRED EURUSD failed: HTTP 404
[fx-market] Request completed in 342ms | Health: 83.3% | Stale: 0, Mismatches: 1
```

### Health Dashboard Metrics
- **Health Percentage:** % of pairs in OK status
- **Average Delta:** Mean bps variance across all pairs
- **Stale Count:** Pairs with FRED >24h old
- **Mismatch Count:** Pairs with >50 bps variance

### Alerting Rules
- **CRITICAL:** Health < 50% (more than half of pairs have issues)
- **WARNING:** Health < 75% (potential data quality degradation)
- **INFO:** Mismatch > 1 pair (variance detected, investigate source)

---

## Performance Characteristics

| Operation | Latency | Notes |
|-----------|---------|-------|
| Fetch FRED (all 6 pairs) | 1–2s | Parallel requests, cached 1h |
| Fetch Yahoo (all 6 pairs) | 500ms–1s | Real-time, 8s timeout per symbol |
| Validation (6 pairs) | <50ms | In-memory calculations |
| **Total /api/fx-market** | **1.5–3s** | Parallel fetches, dominant latency = FRED |

**Optimization tips:**
- Yahoo data fetches are fastest (real-time push)
- FRED is slowest; cache at 1h is reasonable given weekly publication
- Validation is negligible; computation can be moved to edge if needed

---

## Testing Checklist

- [ ] Happy path: Both FRED and Yahoo available, <50 bps delta
- [ ] FRED stale: >24h old but prices align
- [ ] High variance: >50 bps delta between sources
- [ ] FRED down: Yahoo provides fallback
- [ ] Yahoo down: FRED provides fallback
- [ ] Both down: Graceful error with previous cached data
- [ ] Load test: /api/fx-market under 100 concurrent requests
- [ ] Timeout test: FRED takes >8s, should timeout gracefully
- [ ] Component test: Dashboard renders with validation badges

---

## Future Enhancements

1. **Spark lines:** Fetch intraday Yahoo data for all 6 FX pairs
2. **Historical variance:** Track delta over time to detect systematic API lag
3. **Alerting:** Send Slack/email when health drops below threshold
4. **Caching:** Store validated FX data in Redis for faster subsequent requests
5. **Backtesting:** Compare FRED vs Yahoo post-facto for audit trail
6. **Multi-source:** Add Bloomberg terminal or other data providers for further validation

---

## References

- **FRED API:** https://fred.stlouisfed.org/docs/api
- **Yahoo Finance:** https://finance.yahoo.com/quote/EURUSD=X
- **FX Series IDs:**
  - DEXUSEU (EUR/USD)
  - DEXUSUK (GBP/USD)
  - DEXJPUS (JPY/USD)
  - DEXAUST (AUD/USD)
