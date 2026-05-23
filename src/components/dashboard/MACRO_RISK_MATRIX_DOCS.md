# Macro Risk Matrix - Institutional Grade Volatility Dashboard

## Overview

The **Macro Risk Matrix** is an institutional-grade component that upgrades your dashboard's volatility monitoring from basic equity options tracking to a sophisticated multi-asset risk assessment tool. It synthesizes equity volatility, fixed-income volatility, credit stress, and tail-risk metrics into a scannable 2-row grid layout.

## Data Structure

### MacroRiskMetrics Interface

```typescript
export interface MacroRiskMetrics {
  vix: {
    price: number
    change: number
    changePercent: number
  }
  vvix: {
    price: number
    change: number
    changePercent: number
    previousClose: number // for divergence detection
  }
  move: {
    price: number
    change: number
    changePercent: number
    historicalMean: number // for stress badge calculation
  }
  hyOas: {
    price: number // in basis points
    change: number // in basis points
    changePercent: number
    rolling5dayChange: number // cumulative 5-day change in bps
    rolling5dayHigh: number
  }
  skew: {
    price: number
    change: number
    changePercent: number
  }
  putCallRatio: number
  timestamp: number
}
```

### Mock Data Example

```typescript
export const MACRO_RISK_MOCK: MacroRiskMetrics = {
  vix: {
    price: 17.82,
    change: -0.84,
    changePercent: -4.50,
  },
  vvix: {
    price: 92.4,
    change: -2.1,
    changePercent: -2.22,
    previousClose: 94.5,
  },
  move: {
    price: 129.3,
    change: 1.2,
    changePercent: 0.94,
    historicalMean: 115, // 20-day average
  },
  hyOas: {
    price: 350, // basis points
    change: 2.5, // bps
    changePercent: 0.72,
    rolling5dayChange: 12, // accumulated +12 bps over 5 days
    rolling5dayHigh: 365,
  },
  skew: {
    price: 131.2,
    change: 1.4,
    changePercent: 1.08,
  },
  putCallRatio: 0.72,
  timestamp: Date.now(),
}
```

## Component Architecture

### Row 1: Equity & Fixed Income Volatility

#### VIX Gauge
- **Purpose**: Real-time equity volatility
- **Display**: Large price value + percent change + progress bar
- **Color Coding**:
  - **Emerald** (< 15): Complacency
  - **Slate** (15-20): Normal volatility
  - **Amber** (20-30): Elevated risk
  - **Red** (> 30): Market stress
- **Progress Bar**: Normalized to 40 (VIX rarely exceeds this)

#### MOVE Index Card
- **Purpose**: Fixed-income volatility (bond market stress)
- **Display**: Large price value + percent change + progress bar
- **Data Point**: Shows how many basis points above/below 20-day mean
- **Color Coding**:
  - **Emerald** (< 110): Normal bond volatility
  - **Slate** (110-130): Moderate
  - **Amber** (130-150): Elevated
  - **Red** (> 150): Bond market distress
- **Interpretation**: Rising MOVE indicates bond selloff or flight-to-quality dynamics

#### VVIX Card
- **Purpose**: Volatility of volatility (VIX convexity)
- **Display**: Simple metric with change indicator
- **Alert Threshold**: > 100 triggers "⚠ Elevated uncertainty" label
- **Use Case**: Detects if VIX itself is becoming unstable

#### Cross-Asset Stress Column

##### Stress Badge
Detects liquidity strain via MOVE/VIX ratio:
```typescript
const ratio = movePrice / vixPrice
const historicalNorm = 6.5
const isStressed = ratio > historicalNorm * 1.1

// Thresholds:
// > 7.15 (1.1x) = elevated warning (amber)
// > 8.45 (1.3x) = critical (red)
// <= 7.15 = stable (gray)
```

**Interpretation**:
- When **MOVE > 6.5x VIX**: Fixed-income volatility disconnects from equity vol → bond market is repricing faster than stocks → potential liquidity constraints
- **Critical threshold (8.45x)**: Institutional liquidity drying up
- **Elevated threshold (7.15x)**: Early warning of bond market stress

##### Tail Risk Hedging Alert
Detects VVIX/VIX divergence indicating tail-risk hedging activity:
```typescript
const vvixPctChange = ((vvixChange / (vvixPrice - vvixChange)) * 100)
const vixPctChange = vixChange / (vixPrice - vixChange) * 100

const hasDivergence = vvixPctChange > 5 && vixPctChange <= 0
```

**Interpretation**:
- **Normal**: VIX and VVIX move together
- **Divergence**: VVIX +5% while VIX flat/down = hedge funds activating tail-risk protection
- **Severity**: If VVIX +10% with VIX down, it's aggressive hedging activity

### Row 2: Credit Spreads & Structural Metrics

#### HY OAS Card (High-Yield Credit Spreads)
- **Price**: Current spread in basis points (e.g., 350 bps = 3.50%)
- **5-Day Change**: Cumulative expansion/contraction over rolling 5-day window
- **Alert Logic**:
  ```typescript
  const hasSignificantExpansion = hyOas.rolling5dayChange > 15
  // If spreads expand by >15 bps in 5 days, highlight in amber
  ```
- **Interpretation**:
  - **Widening (>15 bps in 5d)**: Credit markets pricing in deteriorating conditions
  - **Steady state**: Normal carry environment
  - **Tightening**: Risk appetite improving
- **Color Coding**:
  - **Amber badge**: Spreads widening significantly (>15 bps)
  - **Gray badge**: Normal conditions

#### CBOE Skew (Tail Risk Premium)
- **Purpose**: Out-of-the-money put demand
- **Display**: Large price value + percent change
- **Alert Threshold**:
  - **> 145**: "⚠ Elevated left-tail risk" (orange)
  - **120-145**: Normal skew (gray)
  - **< 120**: Compressed tails (gray)
- **Interpretation**:
  - High skew = investors buying tail protection (risk-off)
  - Low skew = complacency in tail coverage

#### Put/Call Ratio
- **Purpose**: Options flow indicator
- **Display**: Ratio value + normalized progress bar
- **Color Coding**:
  - **Red** (> 0.9): Put hedging active (risk-off)
  - **Amber** (0.75-0.9): Balanced
  - **Emerald** (< 0.6): Call demand dominant (risk-on)
  - **Slate** (0.6-0.75): Neutral
- **Progress Bar**: Normalized to 1.2 max

#### Regime Summary
Combined equity & credit assessment:
```typescript
// Composite regime logic:
// RISK ON: VIX < 15
// NEUTRAL: 15 <= VIX < 20
// ELEVATED: 20 <= VIX < 30
// RISK OFF: VIX >= 30
```

**Color Scheme**:
- **Emerald**: RISK ON
- **Slate**: NEUTRAL
- **Amber**: ELEVATED
- **Red**: RISK OFF

## Usage in Dashboard

### Integration

```typescript
import { MacroRiskMatrix, MACRO_RISK_MOCK, type MacroRiskMetrics } from '@/components/dashboard/MacroRiskMatrix'

export default function Dashboard() {
  // Your data fetching logic
  const [data, setData] = useState<MarketData | null>(null)
  
  return (
    <>
      {/* Volatility & Options Flow Section */}
      <section>
        <div className="text-[10px] font-mono text-slate-600 uppercase tracking-widest mb-2">
          Volatility &amp; Options Flow
        </div>
        <MacroRiskMatrix metrics={data?.volatility?.macroRisk ?? MACRO_RISK_MOCK} />
      </section>
    </>
  )
}
```

### Type Extensions

Update your `VolatilityData` interface to include macro risk metrics:

```typescript
interface VolatilityData {
  vix: Instrument
  vvix: Instrument
  skew: Instrument
  putCallRatio: number
  macroRisk?: MacroRiskMetrics // New field
}
```

## API Integration

When you build your `/api/market` endpoint, include these data sources:

### Required Live Data Feeds

1. **VIX & VVIX**: CBOE ticker symbols `^VIX` and `^VVIX`
   - Source: CBOE WebSocket or REST API
   - Frequency: Real-time (bid-ask midpoint)

2. **MOVE Index**: ICE ticker `^MOVE`
   - Source: Bloomberg Terminal / ICE API
   - Frequency: Intraday (as updates available)
   - Fallback: Yahoo Finance (delayed)

3. **HY OAS**: ICE ticker `LQD` (iShares HY Corporate) or direct ICE feed
   - Source: Market Data Terminal / ICE BofA HY OAS index
   - Historical: Keep 5-day rolling window in Redis or in-memory cache
   - Calculate `rolling5dayChange` as: `today - 5daysAgo`

4. **Skew**: CBOE ticker `^SKEW`
   - Source: CBOE WebSocket
   - Frequency: Real-time

5. **Put/Call Ratio**: CBOE ticker `^PCRATIO`
   - Source: CBOE WebSocket or calculated from options chains
   - Frequency: Real-time

### Mock Data for Development

```typescript
// Use MACRO_RISK_MOCK for local development and fallback scenarios
import { MACRO_RISK_MOCK } from '@/components/dashboard/MacroRiskMatrix'

// In your API route:
app.get('/api/market', (req, res) => {
  try {
    const data = await fetchLiveMarketData()
    res.json({
      ...data,
      volatility: {
        ...data.volatility,
        macroRisk: data.macroRisk // your live data
      }
    })
  } catch {
    res.json({
      ...fallbackData,
      volatility: {
        ...fallbackData.volatility,
        macroRisk: MACRO_RISK_MOCK // fallback to mock
      }
    })
  }
})
```

## Alert Logic Reference

### Stress Badge Conditions

```typescript
// Bond market stress detection
const moveVixRatio = movePrice / vixPrice
const historicalNorm = 6.5

if (moveVixRatio > historicalNorm * 1.3) {
  // CRITICAL: "BOND STRESS" - red badge
  // Action: Check for liquidity-constrained environments
} else if (moveVixRatio > historicalNorm * 1.15) {
  // ELEVATED: "STRESS WARNING" - amber badge
  // Action: Monitor credit spread widening
} else {
  // STABLE: gray badge
  // Action: Normal carry environment
}
```

### Tail Risk Divergence

```typescript
// VVIX surging while VIX stagnant = hedging acceleration
const vvixSessionPctChange = ((vvixChange / (vvixPrice - vvixChange)) * 100)
const vixSessionPctChange = ((vixChange / (vixPrice - vixChange)) * 100)

if (vvixSessionPctChange > 5 && vixSessionPctChange <= 0) {
  // TAIL HEDGING ALERT: orange badge
  // Interpretation: Tail-risk hedges being deployed while spot vol is calm
  // Action: Review long gamma positions, monitor realized vol
}
```

### HY OAS Expansion Alert

```typescript
// Credit spread widening detected
if (hyOas.rolling5dayChange > 15) {
  // AMBER: "Spreads widening" - significant expansion
  // Action: Reduce high-yield exposure, monitor covenant-lite issuance
} else if (hyOas.rolling5dayChange > 5) {
  // YELLOW: Moderate widening
} else {
  // GREEN: Stable or tightening
}
```

## Color Palette

The component uses your existing dark terminal theme:

- **Emerald (#34d399)**: Risk-on, normal conditions, bullish signals
- **Amber (#fbbf24)**: Warnings, elevated conditions, yellow flags
- **Orange (#fb923c)**: Strong warnings, hedging activity
- **Red (#f87171)**: Critical stress, risk-off, capitulation
- **Slate (#94a3b8)**: Neutral, normal range, baseline
- **Dark theme**: `bg-[#0c1221]` cards, `border-[#1a2540]` borders

## Performance Optimization

The component is lightweight:
- **Bundle size**: ~8KB (minified, gzipped)
- **Dependencies**: Only React hooks (`useState`, `useEffect`)
- **Render**: Single pass, no expensive calculations
- **Animations**: CSS transitions only (60fps)

## Future Enhancements

1. **Historical sparklines** on each metric (5-day mini-chart)
2. **Realized vs Implied vol** comparison
3. **Credit curve** (investment grade vs high-yield spread differential)
4. **Volatility term structure** (VIX futures curve)
5. **Cross-asset correlation** matrix heat map
6. **Risk dashboard drilldown** on click to detailed metrics

## Troubleshooting

### Stress Badge always shows "STABLE"
**Issue**: MOVE/VIX ratio is very low
**Fix**: Ensure MOVE data is being fetched correctly. MOVE should typically be 100-150, not missing or zero-valued.

### Tail Risk Alert never triggers
**Issue**: VVIX and VIX changes need to be calculated from previous close
**Fix**: Ensure `vvix.previousClose` is set to the prior session's VVIX close price.

### HY OAS 5-Day Change not updating
**Issue**: Rolling window calculation is incorrect
**Fix**: Keep a 5-day history in Redis/cache and recalculate `rolling5dayChange` as `latest - 5daysAgo`

## References

- **VIX Methodology**: CBOE White Paper on Volatility Index
- **MOVE Index**: ICE Fixed Income Volatility Index
- **HY OAS**: BofA Merrill Lynch High-Yield OAS spread
- **VVIX**: CBOE Volatility of Volatility Index
- **Skew**: CBOE SKEW (tail risk) Index
