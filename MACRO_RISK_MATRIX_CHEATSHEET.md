# Macro Risk Matrix - One-Page Cheat Sheet

## 📊 6-Metric Overview

```
┌─────────────────────────────────────────────────────────────────┐
│ MACRO RISK MATRIX CHEAT SHEET                                   │
├─────────────────────────────────────────────────────────────────┤

1️⃣  VIX (Equity Vol)            4️⃣ HY OAS (Credit Spreads)
   < 15  🟢 Complacency             < 300  🟢 Tight spreads
   15-20 🟢 Normal                  300-350 🟡 Normal
   20-30 🟠 Elevated                350-400 🟠 Widening
   > 30  🔴 Risk off                > 400  🔴 Crisis

2️⃣  MOVE (Bond Vol)            5️⃣ Skew (Tail Premium)
   < 110 🟢 Calm bonds               < 120  🟡 Cheap tails
   110-130 🟡 Moderate              120-145 🟢 Normal
   130-150 🟠 Elevated              > 145  🔴 Expensive tails
   > 150  🔴 Bond crisis            (High = put demand)

3️⃣  VVIX (Vol of Vol)          6️⃣ Put/Call Ratio
   < 50   🟢 Vol stable             < 0.6  🟢 Call demand
   50-100 🟢 Normal                 0.6-0.9 🟢 Neutral
   100-120 🟠 Vol uncertain         0.9+   🔴 Put demand
   > 120  🔴 Vol chaos

📍 CROSS-ASSET STRESS INDICATORS (NEW)
   • STRESS BADGE: MOVE/VIX ratio  (normal = 6.5x)
   • TAIL ALERT: VVIX vs VIX divergence
   • HY OAS 5-DAY: Spread momentum

└─────────────────────────────────────────────────────────────────┘
```

---

## 🚨 3 Critical Alerts

### 🔴 BOND STRESS (Highest Priority)
**When**: MOVE/VIX > 8.45x
**Means**: Bond volatility outsized vs equities
**Action**: 
- ✓ Cut gross exposure
- ✓ Check credit spreads
- ✓ Increase cash position

### 🟠 TAIL HEDGING (Second Priority)
**When**: VVIX +5% while VIX ≤ 0%
**Means**: Tail hedges deploying
**Action**:
- ✓ Tighten stops on longs
- ✓ Reduce leverage
- ✓ Expect move in 24-48h

### 🟠 HY OAS EXPANSION (Third Priority)
**When**: 5-day change > 15 bps
**Means**: Credit deterioration
**Action**:
- ✓ Trim high-yield
- ✓ Go long treasuries
- ✓ Reduce credit beta

---

## 🎯 Decision Tree (What to Do)

```
Is VIX < 15?
├─ YES  → RISK ON, go long
└─ NO
    Is MOVE/VIX > 8.45x?
    ├─ YES  → BOND STRESS, de-risk NOW
    └─ NO
        Is HY OAS up > 15 bps?
        ├─ YES  → CREDIT STRESS, reduce HY
        └─ NO
            Is VVIX up > 5% while VIX flat?
            ├─ YES  → TAIL HEDGING, tighten stops
            └─ NO
                Is Skew > 140?
                ├─ YES  → Expensive tails, sell vol
                └─ NO   → Continue monitoring
```

---

## 📈 Risk Score Calculation

Assign points for each alert:
- BOND STRESS (MOVE/VIX > 8.45x): +40 points
- TAIL HEDGING (VVIX +5%): +25 points
- HY OAS EXPANSION (> 15 bps): +20 points
- VIX SPIKE (> 30): +15 points

**Total Score → Regime**:
- 0-25:   RISK ON ✓ Go long
- 25-50:  NEUTRAL → Maintain
- 50-75:  ELEVATED → Reduce size
- 75-100: RISK OFF → Go defensive

---

## 📊 Metric Relationships

```
Normal Market:
  VIX ≈ 15-20
  MOVE ≈ 110-130
  MOVE/VIX ≈ 6.5x (stable)
  HY OAS ≈ 300-350 bps
  Skew ≈ 120-140
  Put/Call ≈ 0.65-0.75

Stress Market:
  VIX > 30
  MOVE > 150
  MOVE/VIX > 8x (divergence!)
  HY OAS > 400 bps (widening!)
  Skew > 145 (expensive)
  Put/Call > 0.90 (hedging!)
```

---

## ⏰ Monitoring Cadence

| Frequency | Metric | Action |
|-----------|--------|--------|
| Every 5 min | VIX, VVIX, Skew | Check for spikes |
| Every 15 min | MOVE/VIX ratio | Monitor stress |
| Every hour | HY OAS change | Trend assessment |
| Daily EOD | 5-day rolling avg | Reset baseline |

---

## 💡 Real-World Signals

### Pre-Crash (24-48 hours before)
- ✅ Skew trending > 140
- ✅ VVIX spiking (+5-10%)
- ✅ HY OAS creeping wider
- ✅ Put/Call picking up
- ❌ VIX still calm (< 20)

**Action**: Start de-risking, tighten stops

### During Crash
- ✅ VIX spiking (20 → 35+)
- ✅ MOVE following (normal divergence clears)
- ✅ HY OAS expanding rapidly
- ✅ Skew exploding (150+)
- ✅ Put/Call > 0.9 (panic buying)

**Action**: Exit longs, increase hedges

### Post-Crash (Recovery)
- ✅ VIX declining but elevated (25-30)
- ✅ MOVE sticking high (140+)
- ✅ MOVE/VIX > 6.5x (overshooting)
- ✅ HY OAS wider but stabilizing
- ✅ Skew declining but still elevated

**Action**: Selective entry, don't chase

---

## 🎨 Color Code Reference

| Status | Color | Meaning | Action |
|--------|-------|---------|--------|
| 🟢 | Green/Emerald | Normal / Risk-On | Go long |
| 🟡 | Yellow/Amber | Warning / Elevated | Monitor |
| 🟠 | Orange | Alert / Stress | Reduce |
| 🔴 | Red | Critical / Risk-Off | Exit |

---

## 📱 Mobile Monitoring

**Check in this order (2 min scan)**:
1. Are any badges RED? → Act immediately
2. Is MOVE/VIX ratio > 8? → Monitor credit
3. Did HY OAS expand > 15 bps? → Reduce HY
4. Is Skew > 140? → Expensive tails
5. Is VIX climbing? → Reduce size

**Daily end-of-day** (5 min scan):
- Note: VVIX close (for tomorrow's divergence detection)
- Note: HY OAS level (for 5-day rolling baseline)
- Trend: Which metric moved most?
- Adjustment: Increase/decrease hedge?

---

## 🔧 Quick Adjustments

| Alert | Quick Fix |
|-------|-----------|
| BOND STRESS | Sell 25% of equities, buy TLT |
| TAIL HEDGING | Buy VIX call spreads, reduce leverage |
| HY OAS EXPANSION | Sell HY ETF, buy IG bonds |
| SKEW EXPENSIVE | Sell vol, reduce put hedge |
| PUT/CALL SPIKE | Wait, don't chase, increase size gradually |

---

## 📊 Dashboard Layout (What You See)

```
ROW 1: Volatility Layer
[VIX]          [MOVE]          [VVIX]         [Stress Badges]
17.82          129.3           92.4           • STABLE 7.26x
-0.84%         +1.2%           -2.22%         • NO DIVERGENCE
Normal vol     Bond vol        Vol of vol     Real-time alerts

ROW 2: Risk Layer
[HY OAS]       [CBOE SKEW]     [PUT/CALL]     [REGIME]
350 bps        131.2           0.72           ☑ NEUTRAL
+2.5 bps       +1.4%           [====]         Combined assessment
+12 bps/5day   Normal skew     Call demand    Risk evaluation
```

---

## 🎯 Real Trading Example

**Scenario: Fed surprise hawkish hike**

```
BEFORE (2 hours prior):
  VIX: 15.5 → RISK ON
  MOVE: 120 → Calm bonds
  MOVE/VIX: 7.7x → Slight concern
  Skew: 138 → Rising (warning)
  Put/Call: 0.68 → Low

YOUR DECISION: "Reduce size, don't add longs"

DURING (Reaction):
  VIX: 15.5 → 26 (↑70%) SPIKE
  MOVE: 120 → 145 (↑21%) Following
  MOVE/VIX: 5.6x → NORMAL (ratio normalizes as VIX catches up)
  HY OAS: 350 → 368 (↑18 bps) EXPANDING ALERT 🟠
  Skew: 138 → 152 EXPENSIVE TAILS

YOUR DECISION: "Already reduced, selling rallies, buying puts"

AFTER (1 hour later):
  VIX: 26 → 24 (declining)
  MOVE: 145 → 140 (still elevated)
  MOVE/VIX: 5.8x → Still normal
  HY OAS: 368 → 365 (tightening)
  Skew: 152 → 145 (compressing)

YOUR DECISION: "Gradual entry on weakness, maintain hedges"
```

---

## 🚫 Common Mistakes to Avoid

| Mistake | Why Bad | Fix |
|---------|---------|-----|
| Only watching VIX | Rear-view mirror | Monitor MOVE/VIX ratio first |
| Ignoring VVIX spikes | Misses early warnings | VVIX divergence = next move |
| Trading HY OAS daily | Too noisy | Use 5-day rolling change |
| Panic selling on Skew spikes | Expensive hedges already priced in | Sell vol, don't chase |
| Holding thru BOND STRESS | Liquidity drying up | Reduce gross exposure when ratio > 8.45x |

---

## 📞 When to Call for Help

If you see:
- 🔴 BOND STRESS (MOVE/VIX > 8.45x)
- 🔴 VIX > 40
- 🔴 HY OAS > 450 bps AND expanding
- 🔴 Put/Call > 1.2

→ Consider reducing leverage/gross exposure

---

## 📚 Quick Links

- **Full Docs**: `MACRO_RISK_MATRIX_DOCS.md`
- **Alert Guide**: `MACRO_RISK_ALERTS_REFERENCE.md`
- **Integration**: `MACRO_RISK_INTEGRATION_QUICKSTART.md`
- **Component Code**: `src/components/dashboard/MacroRiskMatrix.tsx`

---

**Print this page and keep by your monitor during market hours.**

**Updated**: 2026-05-22 | **Component v1.0.0** | **Status**: Production Ready
