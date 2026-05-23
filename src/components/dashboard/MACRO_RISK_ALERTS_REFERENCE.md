# Macro Risk Matrix - Alert Thresholds Quick Reference

## 🎯 At-A-Glance Alert Triggers

### Stress Badge (Bond Market Liquidity)

| MOVE/VIX Ratio | Status | Color | Meaning |
|---|---|---|---|
| < 6.5x | **STABLE** | 🟢 Gray | Normal bond-equity vol relationship |
| 6.5x - 7.15x | **STRESS WARNING** | 🟡 Amber | Early signs of bond market stress |
| > 7.15x | **ELEVATED** | 🟠 Orange | Moderate bond-equity vol divergence |
| > 8.45x | **CRITICAL** | 🔴 Red | **BOND STRESS** - Liquidity constraints |

**What to do:**
- **STABLE**: No action needed, normal carry environment
- **STRESS WARNING**: Monitor credit spreads (HY OAS), watch for coordinated selling
- **CRITICAL**: Consider defensive positioning, reduce high-yield exposure

---

### Tail Risk Hedging Alert

| Condition | Status | Color | Action |
|---|---|---|---|
| VVIX flat (< 5% change) | **NO DIVERGENCE** | 🟢 Gray | Normal tail risk positioning |
| VVIX +2% to +5% | **MONITORING** | 🟡 Amber | Slight hedging pickup |
| VVIX +5% while VIX ≤ 0% | **TAIL HEDGING** | 🟠 Orange | **Tail hedges deploying** |
| VVIX +10% while VIX < 0% | **AGGRESSIVE** | 🔴 Red | **Heavy hedge activation** |

**Interpretation:**
- VVIX measures how fast the VIX is moving. If VVIX surges while VIX is flat = someone buying VIX calls / variance swaps
- This is a **leading indicator** of market stress brewing beneath the surface
- Often precedes a sharp VIX move by 24-48 hours

**What to do:**
- **NO DIVERGENCE**: Stay with your baseline positioning
- **TAIL HEDGING**: Review stop-loss levels, position sizing on shorts
- **AGGRESSIVE**: De-risk if overlevered, consider taking profits on short vol

---

### HY OAS Expansion Alert

| 5-Day Change | Status | Color | Meaning |
|---|---|---|---|
| < 0 bps | **TIGHTENING** | 🟢 Green | Credit strength, risk-on |
| 0-5 bps | **STABLE** | 🟢 Gray | Normal range, equilibrium |
| 5-15 bps | **WIDENING** | 🟡 Amber | Modest credit stress |
| > 15 bps | **EXPANSION** | 🟠 Amber | **Credit spread widening** |

**What to do:**
- **TIGHTENING**: Buy high-yield, accumulate credit exposure
- **STABLE**: Maintain positioning
- **WIDENING**: Start trimming high-yield positions, reduce leverage
- **EXPANSION**: Sell high-yield, increase duration, go long treasuries

**Real-world example:**
- Monday: HY OAS = 350 bps
- Tuesday-Friday: Spreads widen due to Fed surprise, Friday close = 365 bps
- 5-Day Change = +15 bps → Alert triggers amber
- The next morning, the component shows this visually, prompting risk reduction

---

### VIX Levels & Market Regime

| VIX Level | Regime | Color | Volatility State |
|---|---|---|---|
| < 12 | **RISK ON** | 🟢 Emerald | Complacency / Low Vol |
| 12-15 | **NORMAL** | 🟢 Emerald | Healthy volatility |
| 15-20 | **NEUTRAL** | 🟢 Slate | Baseline conditions |
| 20-30 | **ELEVATED** | 🟠 Amber | Heightened uncertainty |
| 30-40 | **RISK OFF** | 🔴 Red | High stress conditions |
| > 40 | **PANIC** | 🔴 Red | Market crisis / capitulation |

---

### MOVE Index Levels & Bond Market State

| MOVE Level | Bond Vol State | Color | Interpretation |
|---|---|---|---|
| < 100 | **Low** | 🟢 Emerald | Calm bond market |
| 100-115 | **Normal** | 🟢 Slate | Baseline |
| 115-130 | **Elevated** | 🟡 Amber | Bond volatility picking up |
| 130-150 | **High** | 🟠 Orange | Significant bond selling |
| > 150 | **Extreme** | 🔴 Red | Bond market crisis |

**Context:**
- MOVE tracks 1-10 year fixed-income volatility
- Rising MOVE = flight-to-quality or yield curve repricing
- When MOVE > VIX × 6.5 = bond volatility is outsized relative to equities

---

## 📊 Combined Stress Score

Use this framework to assess overall market stress:

### Low Risk Environment (Score: 0-25)
```
VIX < 15 AND MOVE < 115 AND HY OAS stable AND Skew < 120
⟹ RISK ON / Go long equities
```

### Moderate Risk (Score: 25-50)
```
VIX 15-20 AND MOVE 115-130 AND HY OAS widening 5-10 bps
⟹ NEUTRAL / Maintain balanced positioning
```

### Elevated Risk (Score: 50-75)
```
VIX 20-30 AND MOVE > 130 AND HY OAS > 15 bps expansion AND Skew > 140
⟹ ELEVATED / Reduce size, tighten stops
```

### Critical Risk (Score: 75-100)
```
VIX > 30 AND MOVE > 150 AND MOVE/VIX > 8.45x AND HY OAS expanding rapidly
⟹ RISK OFF / Exit leverage, go defensive
```

---

## 🚨 Priority Alert Order

When multiple alerts trigger, prioritize in this order:

1. **BOND STRESS (MOVE/VIX > 8.45x)**
   - Indicates systemic liquidity concern
   - Action: Reduce gross exposure immediately

2. **AGGRESSIVE TAIL HEDGING (VVIX +10% while VIX < 0%)**
   - Someone knows something is coming
   - Action: Tighten risk management

3. **HY OAS RAPID EXPANSION (> 20 bps in 5d)**
   - Credit market is repricing risk
   - Action: Trim high-yield, extend duration

4. **VIX SPIKE (jumping > 30)**
   - Volatility event already occurred
   - Action: Reassess positions post-move

---

## 📈 Real-World Scenario Playbook

### Scenario: Flash Crash in Progress

**What you see:**
- VIX: 17.82 → 28.5 (↑60%)
- MOVE: 129.3 → 142 (↑10%)
- MOVE/VIX ratio: 7.26x → 5.0x (ratio drops as VIX spikes faster)
- HY OAS: +2.5 bps → +8 bps (spreads widening)
- Skew: 131.2 → 145+ (tail premium spiking)

**What the alerts show:**
- ❌ BOND STRESS clears (ratio normalizes) as equities catch down
- ✓ TAIL HEDGING alert may trigger if VVIX doesn't follow VIX move
- ✓ HY OAS expansion alert: spreads widening on risk-off
- ✓ Regime shifts to ELEVATED or RISK OFF

**Your action:**
- Sell any rallies, don't catch falling knives
- Move to sidelines or go long hedges
- Wait for stabilization before re-entering

---

### Scenario: Bond Selloff (Rates Rising)

**What you see:**
- VIX: 17.82 → 18.5 (↑4%)
- MOVE: 129.3 → 142 (↑10%)
- MOVE/VIX ratio: 7.26x → 7.68x (↑ WARNING)
- HY OAS: +2.5 bps → +18 bps (↑ EXPANSION ALERT)
- Skew: 131.2 → 135

**What the alerts show:**
- 🟠 STRESS WARNING: Bond vol outpacing equity vol
- ⚠️ HY OAS EXPANSION: Spreads have widened >15 bps
- ⚠️ Regime still NEUTRAL but trending toward ELEVATED

**Your action:**
- Reduce high-yield exposure proactively
- Buy long-term treasuries as a hedge
- Monitor for BOND STRESS escalation if MOVE/VIX continues rising

---

### Scenario: Quiet Hedging Pickup (Pre-Crash)

**What you see:**
- VIX: 17.82 → 17.3 (flat, -3%)
- VVIX: 92.4 → 97.5 (+5.5%)
- MOVE: 129.3 → 130 (flat)
- HY OAS: 350 → 351 (flat)
- Skew: 131.2 → 138 (↑ tail premium)

**What the alerts show:**
- ✓ TAIL HEDGING ALERT (VVIX +5.5% while VIX down)
- 🟠 Skew trending elevated
- 🟢 Surface appears calm (VIX, MOVE, OAS flat)

**This is the early warning signal!**

**Your action:**
- Reduce long positions proactively
- Tighten profit-taking levels
- Increase hedge ratio on portfolios
- Expect a move within 24-48 hours

---

## 🎯 Monitoring Workflow

**Every 15 minutes during market hours:**
1. Check if any **RED** badges appeared → Immediate action required
2. Check if **AMBER** badges changed (escalation) → Reassess risk
3. Monitor HY OAS rolling 5-day change → Trend assessment
4. Scan MOVE/VIX ratio → Liquidity stress detector

**Daily end-of-day:**
1. Record 5-day HY OAS change for next day's baseline
2. Note VVIX close for divergence detection tomorrow
3. Review regime transitions (RISK ON → NEUTRAL, etc.)
4. Adjust hedging ratios based on aggregate alert count

---

## 📲 Setting Up Alerts (Future Integration)

When you add webhooks to this component:

```typescript
// Send alert to monitoring system
if (moveVixRatio > 8.45) {
  sendAlert('CRITICAL_BOND_STRESS', {
    ratio: moveVixRatio,
    move: movePrice,
    vix: vixPrice,
    timestamp: Date.now(),
  })
}

// Slack webhook example
if (hyOas.rolling5dayChange > 15) {
  postToSlack('⚠️ HY OAS EXPANSION: +' + hyOas.rolling5dayChange + ' bps in 5 days')
}
```

---

## Quick Decision Tree

```
Is VIX < 15?
├─ YES → RISK ON, go long
└─ NO
    Is VIX < 20?
    ├─ YES → NEUTRAL, maintain
    └─ NO
        Is MOVE/VIX > 8.45x?
        ├─ YES → BOND STRESS, de-risk immediately
        └─ NO
            Is HY OAS > 15 bps wider?
            ├─ YES → Credit deterioration, reduce HY
            └─ NO
                Is VVIX > +5% while VIX < 0%?
                ├─ YES → Tail hedging, tighten stops
                └─ NO → Continue monitoring
```

---

**Last Updated**: 2026-05-22
**Component Version**: 1.0.0
