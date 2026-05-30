'use client'

/**
 * CrossAssetRatiosPanel
 * ─────────────────────────────────────────────────────────────────────────────
 * Self-contained ratio display component.  Owns its own commodity and FX data
 * subscriptions via useMarketNodes so that ratio calculations are never blocked
 * by the parent's render cycle or the /api/market fallback pool.
 *
 * Data sources:
 *   Copper / Gold ratio  → useMarketNodes('commodity')  nodes: 'HG', 'GC'
 *   Gold  / Silver ratio → useMarketNodes('commodity')  nodes: 'GC', 'SI'
 *   NDX   / SPX ratio   → props (from /api/market equities array)
 *   Risk Regime          → props (VIX from /api/market + yield spread from FRED)
 *
 * Null-safety contract:
 *   Any node whose .price is null (rate-limited / not yet loaded) causes its
 *   ratio to return null, which RatioCardComponent renders as "--" at fixed
 *   structural height — zero layout shift, zero corrupted math.
 */

import type { ReactNode } from 'react'
import { useMarketNodes } from '@/lib/hooks/useMarketNodes'
import { useAlpacaData } from '@/hooks/useAlpacaData'
import { ema } from '@/lib/market/ctaEngine'
import { RatiosPanel, RATIOS_MOCK, type RatioCard } from '@/components/dashboard/TechnicalSection'

// ETF → cash-index ratio scalar.
// The NDX/SPX cash ratio ≈ 4.00×.  QQQ ≈ NDX/40, SPY ≈ SPX/10 → raw ETF ratio
// (QQQ/SPY) ≈ (NDX/40)/(SPX/10) = NDX/SPX × 0.25.  To reconstruct the true
// index ratio we need to multiply by 40/10 = 4.  We calibrate to 4.10 to
// eliminate the residual ETF-vs-futures premium drift observed on TradingView.
// Combined: trueNdxSpxRatio = (qqqPrice / spyPrice) * NDX_SPX_SCALAR
const NDX_SPX_SCALAR = 4.10

// RSP/SPY historical baseline: the long-run equal-weight / cap-weight ratio
// trades around 0.29–0.31.  A reading below this threshold — regardless of the
// 5-day delta — signals sustained mega-cap concentration, not just a short-term
// drift.  We use 0.29 as the absolute floor so a ratio of 0.2762 renders as
// "Mega-Cap Concentration" even when the 5-day slope is temporarily flat.
const BREADTH_CONCENTRATION_THRESHOLD = 0.29

// ─── Props ────────────────────────────────────────────────────────────────────

export interface CrossAssetRatiosPanelProps {
  /** NDX index level from /api/market equities (null = unavailable) */
  ndx:           number | null
  /** SPX index level from /api/market equities (null = unavailable) */
  spx:           number | null
  /** VIX spot level from /api/market volatility (null = unavailable) */
  vix:           number | null
  /** 10-year treasury yield (null = unavailable) */
  rate10y:       number | null
  /** 5-year treasury yield used as 2Y proxy (null = unavailable) */
  rate5y:        number | null
  /** FRED authoritative 2Y-10Y spread — preferred over derived spread */
  fredSpread?:   number | null
  /** Optional badge rendered next to the 'Cross-Asset Ratios · Macro Dynamics' heading */
  statusBadge?:  ReactNode
}

// ─── Component ────────────────────────────────────────────────────────────────

export function CrossAssetRatiosPanel({
  ndx,
  spx,
  vix,
  rate10y,
  rate5y,
  fredSpread,
  statusBadge,
}: CrossAssetRatiosPanelProps) {

  // ── Live commodity prices — independent subscription, 30-second poll ──────
  // Always requests 1D timeframe: ratio calculations want the spot price,
  // not a multi-day comparative change.  The commodity *grid* above this
  // component uses commTF (user-selected), this is intentionally separate.
  const { data: commodityData } = useMarketNodes('commodity', 300_000, '1D')

  // ── Live FX prices — available for future DXY-related ratios ─────────────
  // Destructured but not yet wired to a ratio card.  Included per architecture
  // spec so that DXY / Commodities ratio cards can be added without a hook change.
  const { data: _fxData } = useMarketNodes('fx', 300_000, '1D')

  // ── Live Alpaca ETF snapshots — NDX/SPX fallback, market breadth, VIX proxy,
  //    AND commodity ratio fallback (CPER/GLD/SLV) ──────────────────────────────
  // ^NDX / ^GSPC / ^VIX all come from FMP, which subscription-walls index symbols
  // and returns null.  CPER/GLD/SLV are the direct ETF proxies for the commodity
  // ratios; fetching them here means ratio cards stay live even when the
  // useMarketNodes cold-start cache hasn't yet populated.
  const { quoteMap: etfQuotes } = useAlpacaData({
    symbols:      ['SPY', 'QQQ', 'RSP', 'VIXY', 'CPER', 'GLD', 'SLV'],
    assetClass:   'us_equity',
    type:         'snapshot',
    pollInterval: 60_000,
  })
  const qqqPrice  = etfQuotes.get('QQQ')?.price          ?? null
  const spyPrice  = etfQuotes.get('SPY')?.price          ?? null
  const rspPrice  = etfQuotes.get('RSP')?.price          ?? null
  const vixyPrice = etfQuotes.get('VIXY')?.price         ?? null
  const rspChgPct = etfQuotes.get('RSP')?.changePercent  ?? null
  const spyChgPct = etfQuotes.get('SPY')?.changePercent  ?? null

  // Direct Alpaca commodity ETF prices — unconditional fallback.
  // Used when useMarketNodes hasn't resolved yet (cold cache / first load).
  const alpacaCper = etfQuotes.get('CPER')?.price ?? null
  const alpacaGld  = etfQuotes.get('GLD')?.price  ?? null
  const alpacaSlv  = etfQuotes.get('SLV')?.price  ?? null

  // ── VIXY daily bars — synthetic VIX-curve proxy (10d vs 40d EMA) ─────────────
  // Cash ^VIX is FMP-walled, so derive a term-structure proxy from the live
  // Alpaca VIXY ETF: short-term (10d EMA) vs medium-term (40d EMA) volatility.
  const { quoteMap: vixyBars } = useAlpacaData({
    symbols:      ['VIXY'],
    assetClass:   'us_equity',
    type:         'bars',
    timeframe:    '1Day',
    limit:        60,
    pollInterval: 300_000,
  })
  const vixyCloses = (vixyBars.get('VIXY')?.bars ?? []).map(b => b.c)
  const vixy10d    = vixyCloses.length >= 10 ? ema(vixyCloses, 10) : NaN
  const vixy40d    = vixyCloses.length >= 40 ? ema(vixyCloses, 40) : NaN
  const syntheticCurve =
    Number.isFinite(vixy10d) && Number.isFinite(vixy40d) && vixy40d > 0
      ? vixy10d / vixy40d
      : null

  // ── RSP / SPY daily bars — historical breadth ratio series (sparkline) ──────
  // No backend rspSpySeries exists, so compile it client-side: per-session
  // RSP-close ÷ SPY-close, aligned by index (both arrays are ascending, same
  // sessions).  Drives the breadth card's sparkline + rolling 5-day direction.
  const { quoteMap: breadthBars } = useAlpacaData({
    symbols:      ['RSP', 'SPY'],
    assetClass:   'us_equity',
    type:         'bars',
    timeframe:    '1Day',
    limit:        120,
    pollInterval: 300_000,
  })
  const rspSpySeries: number[] = (() => {
    const rspCloses = (breadthBars.get('RSP')?.bars ?? []).map(b => b.c)
    const spyCloses = (breadthBars.get('SPY')?.bars ?? []).map(b => b.c)
    const n = Math.min(rspCloses.length, spyCloses.length)
    if (n < 2) return []
    // Align from the tail (most recent), take up to the last 30 sessions.
    const start = Math.max(0, n - 30)
    const out: number[] = []
    for (let i = start; i < n; i++) {
      const r = rspCloses[rspCloses.length - n + i]
      const s = spyCloses[spyCloses.length - n + i]
      if (s > 0) out.push(r / s)
    }
    return out
  })()
  // Rolling 5-day delta of the breadth ratio: expanding = broad participation.
  const breadth5dExpanding: boolean | null =
    rspSpySeries.length >= 6
      ? rspSpySeries[rspSpySeries.length - 1] >= rspSpySeries[rspSpySeries.length - 6]
      : null

  // ── Resolve commodity nodes by registry key ───────────────────────────────
  // Node IDs in MarketDataSnapshot.nodes match marketRegistry keys:
  //   'GC'  = Gold Futures    (Yahoo: GC=F)
  //   'SI'  = Silver Futures  (Yahoo: SI=F)
  //   'HG'  = Copper Futures  (Yahoo: HG=F)
  const goldNode   = commodityData?.nodes['GC'] ?? null
  const silverNode = commodityData?.nodes['SI'] ?? null
  const copperNode = commodityData?.nodes['HG'] ?? null

  const goldPrice   = goldNode?.price   ?? null
  const silverPrice = silverNode?.price ?? null
  const copperPrice = copperNode?.price ?? null

  // ── Ratio 1: Copper / Gold — risk appetite barometer ─────────────────────
  // Primary: useMarketNodes commodity nodes (GC → GLD, HG → CPER via registry).
  // Fallback: direct Alpaca ETF snapshots fetched unconditionally above.
  // The 62.5 scalar normalises CPER/GLD to the front-month COMEX ratio (~0.0015).
  const cuGoldPrimary  = copperPrice !== null && goldPrice !== null && goldPrice > 0
  const cuGoldFallback = !cuGoldPrimary && alpacaCper !== null && alpacaGld !== null && alpacaGld > 0
  const cuGold: number | null = cuGoldPrimary
    ? copperPrice! / (goldPrice! * 62.5)
    : cuGoldFallback
      ? alpacaCper! / (alpacaGld! * 62.5)
      : null
  const cuGoldSource: RatioCard['source'] = cuGoldPrimary ? 'live_futures'
    : cuGoldFallback ? 'alpaca_etf'
    : undefined

  // ── Ratio 2: Gold / Silver — monetary demand spread ───────────────────────
  // Primary: useMarketNodes commodity nodes.
  // Fallback: direct Alpaca GLD / SLV snapshots.
  // ×10 scalar aligns GLD's 0.096 oz/share vs SLV's 0.952 oz/share to the
  // institutional spot ratio (~81).
  const auAgPrimary  = goldPrice !== null && silverPrice !== null && silverPrice > 0
  const auAgFallback = !auAgPrimary && alpacaGld !== null && alpacaSlv !== null && alpacaSlv > 0
  const auAg: number | null = auAgPrimary
    ? (goldPrice! * 10) / silverPrice!
    : auAgFallback
      ? (alpacaGld! * 10) / alpacaSlv!
      : null
  const auAgSource: RatioCard['source'] = auAgPrimary ? 'live_futures'
    : auAgFallback ? 'alpaca_etf'
    : undefined

  // ── Ratio 3: NDX / SPX — tech vs. broad market ───────────────────────────
  // Primary: real ^NDX / ^GSPC cash-index levels from /api/market.
  // Fallback: reconstruct via Alpaca ETF proxies already live in this component.
  //   trueRatio = (QQQ / SPY) × NDX_SPX_SCALAR (4.10)
  // This keeps the card populated and accurately scaled when FMP returns 402.
  const nSpx: number | null =
    ndx !== null && spx !== null && spx > 0
      ? ndx / spx
      : qqqPrice !== null && spyPrice !== null && spyPrice > 0
        ? (qqqPrice / spyPrice) * NDX_SPX_SCALAR
        : null

  // ── Ratio 4: VIX / Curve Signal — synthetic VIXY term-structure ──────────
  // Primary: VIXY 10d-EMA ÷ 40d-EMA (front-month vs core volatility).
  //   < 1.0 → Contango      → front vol below core → risk stable (lower score)
  //   > 1.0 → Backwardation → front-month spiking → risk-off (score scales up)
  // Fallback (thin bar history): cash ^VIX, else the VIXY snapshot normalized to
  // the cash-VIX scale (×0.75), blended with the inverted-yield-curve stress.
  const spread: number | null =
    fredSpread !== undefined && fredSpread !== null
      ? fredSpread
      : rate10y !== null && rate5y !== null
        ? rate10y - rate5y
        : null

  const volLevel: number | null =
    vix !== null ? vix : vixyPrice !== null ? vixyPrice * 0.75 : null

  let riskScore:  number | null = null
  let curveState = '--'
  let curveSignal: RatioCard['signal'] = 'neutral'
  let curveNote = RATIOS_MOCK[3].note

  if (syntheticCurve !== null) {
    // Map ~0.85..1.15 onto 0..100 risk; > 1.0 (backwardation) pushes risk up.
    riskScore   = Math.round(Math.max(0, Math.min(100, ((syntheticCurve - 0.85) / 0.30) * 100)))
    curveState  = syntheticCurve > 1.0 ? 'Backwardation · Risk Off' : 'Contango · Risk Stable'
    curveSignal = syntheticCurve > 1.05 ? 'warning' : syntheticCurve > 1.0 ? 'neutral' : 'bullish'
    curveNote   = `VIXY term structure ${syntheticCurve.toFixed(3)}× (10d/40d EMA) — ${
      syntheticCurve > 1.0
        ? 'front-month vol spiking into backwardation; volatility expansion risk rising.'
        : 'front vol below core; volatility regime stable (contango).'
    }`
  } else if (volLevel !== null) {
    const vixComp   = Math.max(0, Math.min(50, ((volLevel - 10) / 30) * 50))
    const curveComp = spread !== null && spread < 0 ? Math.min(50, (Math.abs(spread) / 2) * 50) : 0
    riskScore   = Math.round(vixComp + curveComp)
    curveState  = spread !== null && spread < 0 ? 'Curve Inverted · Risk' : 'Vol Stable'
    curveSignal = riskScore > 60 ? 'warning' : riskScore < 30 ? 'bullish' : 'neutral'
    curveNote   = `Vol proxy ${volLevel.toFixed(1)}${vix === null ? ' (VIXY)' : ''}${
      spread !== null
        ? spread < 0 ? ` · inverted curve (${spread.toFixed(2)}%) — recession tail risk.` : ` · curve +${spread.toFixed(2)}%.`
        : '.'
    }`
  }

  // ── Ratio 5: Market Breadth — equal-weight (RSP) vs cap-weight (SPY) ──────
  const breadthRatio: number | null =
    rspPrice !== null && spyPrice !== null && spyPrice > 0 ? rspPrice / spyPrice : null
  // Rising ratio (equal-weight outpacing cap-weight) = broad participation;
  // falling = mega-cap concentration.
  //
  // Two-gate logic (both must pass for "Broad Participation"):
  //   1. Absolute floor: ratio must be >= BREADTH_CONCENTRATION_THRESHOLD (0.29).
  //      A ratio of 0.276 is structurally in mega-cap concentration territory
  //      regardless of the 5-day delta direction.
  //   2. Directional gate: 5-day delta expanding, or intraday RSP outperforming
  //      SPY (before bars load).
  //
  // This prevents a flat / temporarily rising delta from masking a deeply
  // depressed ratio and displaying the wrong "Broad Participation" label.
  const breadthAboveFloor = breadthRatio !== null && breadthRatio >= BREADTH_CONCENTRATION_THRESHOLD
  const breadthDirectional =
    breadth5dExpanding !== null
      ? breadth5dExpanding
      : rspChgPct !== null && spyChgPct !== null ? rspChgPct >= spyChgPct : false
  const breadthRising = breadthAboveFloor && breadthDirectional

  // ── Assemble RatioCard array ──────────────────────────────────────────────
  const ratios: RatioCard[] = [
    {
      ...RATIOS_MOCK[0],
      value:        cuGold,
      displayValue: cuGold !== null ? cuGold.toFixed(6) : '--',
      signal:       cuGold === null  ? 'neutral'
                    : cuGold > 0.0015 ? 'bullish'
                    : cuGold < 0.0012 ? 'bearish'
                    : 'neutral',
      status:       cuGold === null  ? '--'
                    : cuGold > 0.0015 ? 'Risk On'
                    : cuGold < 0.0012 ? 'Risk Off'
                    : 'Neutral',
      source:       cuGoldSource,
    },
    {
      ...RATIOS_MOCK[1],
      value:        auAg,
      displayValue: auAg !== null ? auAg.toFixed(1) : '--',
      signal:       auAg === null  ? 'neutral'
                    : auAg > 80    ? 'warning'
                    : auAg < 60    ? 'bullish'
                    : 'neutral',
      status:       auAg === null  ? '--'
                    : auAg > 80    ? 'Risk Off'
                    : auAg > 60    ? 'Neutral'
                    : 'Industrial',
      source:       auAgSource,
    },
    {
      ...RATIOS_MOCK[2],
      value:        nSpx,
      displayValue: nSpx !== null ? `${nSpx.toFixed(3)}×` : '--',
      signal:       nSpx === null  ? 'neutral'
                    : nSpx > 3.5   ? 'bullish'
                    : 'neutral',
      status:       nSpx === null  ? '--'
                    : nSpx > 3.5   ? 'Tech Dominance'
                    : 'Converging',
    },
    {
      ...RATIOS_MOCK[3],
      value:        riskScore,
      displayValue: riskScore !== null ? `${riskScore}/100` : '--',
      status:       curveState,
      signal:       curveSignal,
      note:         curveNote,
    },
    {
      id:           'market_breadth',
      name:         'RSP / SPY',
      subtitle:     'Market Breadth (Equal vs. Cap Weight)',
      value:        breadthRatio,
      displayValue: breadthRatio !== null ? breadthRatio.toFixed(4) : '--',
      change:       rspChgPct !== null && spyChgPct !== null ? parseFloat((rspChgPct - spyChgPct).toFixed(2)) : 0,
      status:       breadthRatio === null ? '--' : breadthRising ? 'Broad Participation' : 'Mega-Cap Concentration',
      // Sparkline stroke is driven by `signal`: emerald when the 5-day breadth
      // delta is expanding (bullish), amber when contracting (warning).
      signal:       breadthRatio === null ? 'neutral' : breadthRising ? 'bullish' : 'warning',
      sparkline:    rspSpySeries,
      note:         breadthRatio === null
        ? 'RSP / SPY — equal-weight vs cap-weight S&P 500 breadth gauge.'
        : breadthRising
          ? 'Equal-weight (RSP) outpacing cap-weight (SPY) — healthy broad participation.'
          : 'Cap-weight (SPY) leading equal-weight (RSP) — narrow, mega-cap-concentrated tape.',
    },
  ]

  return <RatiosPanel ratios={ratios} statusBadge={statusBadge} />
}
