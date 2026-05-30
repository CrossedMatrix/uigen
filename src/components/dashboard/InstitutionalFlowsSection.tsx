'use client'

import { useState, useMemo, useRef, useEffect } from 'react'
import { usePersistState } from '@/lib/hooks/usePersistState'
import { useAlpacaData } from '@/hooks/useAlpacaData'
import type { AlpacaQuote } from '@/app/api/alpaca/route'
import type { PositioningRow, MacroPositioningData } from '@/app/api/macro-positioning/route'
import { StatusBadge } from '@/components/dashboard/StatusBadge'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface COTAsset {
  asset: string
  symbol: string
  leveragedNet: number
  leveragedChange1W: number
  commercialNet: number
  weeksAtExtreme: number
  trend3W: 'building_longs' | 'reducing_longs' | 'building_shorts' | 'reducing_shorts' | 'stabilizing'
  priceChange4W: number
  meanReversionAlert: boolean
  category?: 'index' | 'rates' | 'fx' | 'commodity'
  positioningScale?: number
}

/**
 * Technical trigger level where the trend-follower model flips net exposure.
 * Calculated as ~4-5% from the estimated current spot for each underlying.
 */
export interface CTAFlipMeta {
  /** Formatted price / index level string, e.g. "5,519" or "$92.20" */
  level: string
  /** % distance from estimated spot — negative = below spot, positive = above */
  pctFromSpot: number
  /** Which side triggers the flip: break BELOW (long→short) or break ABOVE (short→long) */
  direction: 'below' | 'above'
}

/**
 * Dollar-notional flow projection if the trend continues or the flip level breaks
 * over the next 5 trading sessions.
 */
export interface CTAFlowMeta {
  /** Formatted notional string, e.g. "$8.4B" or "$650M" */
  amount: string
  /** Human-readable execution action */
  action: 'Buy' | 'Add' | 'Liquidate' | 'Reduce' | 'Cover' | 'Sell'
  /** +1 = buy / inflow pressure,  -1 = sell / outflow pressure */
  sign: 1 | -1
}

export interface CTAGaugeRow {
  label: string
  exposure: number
  prevExposure: number
  signal: 'neutral' | 'exhaustion_risk' | 'bearish' | 'bullish'
  /** CTA flip-price metadata — rendered beneath the progress bar */
  ctaFlip?: CTAFlipMeta
  /** Estimated 5-session flow impact — rendered alongside ctaFlip */
  flow5D?: CTAFlowMeta
}

export interface SkewTicker {
  ticker: string
  callPct: number
  putPct: number
  impliedMove: number
  signal: 'upside_demand' | 'balanced' | 'hedging'
}

export interface FlowsData {
  cot: COTAsset[]
  ctaGauges: CTAGaugeRow[]
  techSkew: SkewTicker[]
}

// ─── Skew Database (searchable) ───────────────────────────────────────────────

const SKEW_DB: Record<string, SkewTicker> = {
  NVDA: { ticker: 'NVDA', callPct: 68, putPct: 32, impliedMove: 4.2, signal: 'upside_demand' },
  MU:   { ticker: 'MU',   callPct: 54, putPct: 46, impliedMove: 3.1, signal: 'balanced'      },
  SNDK: { ticker: 'SNDK', callPct: 62, putPct: 38, impliedMove: 2.8, signal: 'upside_demand' },
  AMD:  { ticker: 'AMD',  callPct: 58, putPct: 42, impliedMove: 3.8, signal: 'balanced'      },
  META: { ticker: 'META', callPct: 58, putPct: 42, impliedMove: 2.8, signal: 'balanced'      },
  AAPL: { ticker: 'AAPL', callPct: 45, putPct: 55, impliedMove: 1.9, signal: 'hedging'       },
  MSFT: { ticker: 'MSFT', callPct: 52, putPct: 48, impliedMove: 2.1, signal: 'balanced'      },
  AVGO: { ticker: 'AVGO', callPct: 64, putPct: 36, impliedMove: 3.5, signal: 'upside_demand' },
  ARM:  { ticker: 'ARM',  callPct: 72, putPct: 28, impliedMove: 5.8, signal: 'upside_demand' },
  MRVL: { ticker: 'MRVL', callPct: 65, putPct: 35, impliedMove: 4.4, signal: 'upside_demand' },
  SMCI: { ticker: 'SMCI', callPct: 60, putPct: 40, impliedMove: 6.2, signal: 'upside_demand' },
  ASTS: { ticker: 'ASTS', callPct: 74, putPct: 26, impliedMove: 7.1, signal: 'upside_demand' },
  PLTR: { ticker: 'PLTR', callPct: 66, putPct: 34, impliedMove: 4.0, signal: 'upside_demand' },
  TSLA: { ticker: 'TSLA', callPct: 55, putPct: 45, impliedMove: 5.5, signal: 'balanced'      },
  MSTR: { ticker: 'MSTR', callPct: 70, putPct: 30, impliedMove: 8.2, signal: 'upside_demand' },
  COIN: { ticker: 'COIN', callPct: 62, putPct: 38, impliedMove: 6.8, signal: 'upside_demand' },
  CRWD: { ticker: 'CRWD', callPct: 56, putPct: 44, impliedMove: 3.2, signal: 'balanced'      },
  PANW: { ticker: 'PANW', callPct: 53, putPct: 47, impliedMove: 2.9, signal: 'balanced'      },
  NOW:  { ticker: 'NOW',  callPct: 54, putPct: 46, impliedMove: 2.6, signal: 'balanced'      },
  SNOW: { ticker: 'SNOW', callPct: 48, putPct: 52, impliedMove: 4.8, signal: 'hedging'       },
  DDOG: { ticker: 'DDOG', callPct: 57, putPct: 43, impliedMove: 3.9, signal: 'balanced'      },
  RKLB: { ticker: 'RKLB', callPct: 76, putPct: 24, impliedMove: 8.4, signal: 'upside_demand' },
  OKLO: { ticker: 'OKLO', callPct: 78, putPct: 22, impliedMove: 9.2, signal: 'upside_demand' },
  VST:  { ticker: 'VST',  callPct: 68, putPct: 32, impliedMove: 4.6, signal: 'upside_demand' },
  CEG:  { ticker: 'CEG',  callPct: 64, putPct: 36, impliedMove: 3.8, signal: 'upside_demand' },
  AMZN: { ticker: 'AMZN', callPct: 55, putPct: 45, impliedMove: 2.4, signal: 'balanced'      },
  GOOGL:{ ticker: 'GOOGL',callPct: 53, putPct: 47, impliedMove: 2.2, signal: 'balanced'      },
  NFLX: { ticker: 'NFLX', callPct: 52, putPct: 48, impliedMove: 3.0, signal: 'balanced'      },
  UBER: { ticker: 'UBER', callPct: 58, putPct: 42, impliedMove: 2.8, signal: 'balanced'      },
  SHOP: { ticker: 'SHOP', callPct: 61, putPct: 39, impliedMove: 4.2, signal: 'upside_demand' },
}

// ─── 50-Stock Baskets (RAM/NAND front-loaded) ─────────────────────────────────

const INFRA_TICKERS_50 = [
  'MU','SNDK','WDC','STX','NTAP','PSTG',
  'NVDA','AMD','AVGO','ARM','MRVL','AMAT','LRCX','KLAC','SMCI',
  'TXN','ON','NXPI','INTC','QCOM',
  'DELL','HPE','IBM',
  'TSM','ASML','TER','ONTO','ENTG',
  'VST','CEG','CCJ','NRG','ETR','NEE','DUK','AEP','EXC','D',
  'OKLO','NNE','BWXT','GEV','FSLR',
  'MPWR','AMBA','POWI','ASTS','RKLB',
  'ENPH','SMR','ACLS','WOLF',
]

const SOFTWARE_TICKERS_50 = [
  'MSFT','GOOGL','AMZN','META','AAPL','NFLX',
  'ADBE','CRM','NOW','SAP','INTU','WDAY',
  'SNOW','PLTR','DDOG','MDB','ESTC','CFLT',
  'CRWD','ZS','OKTA','PANW','FTNT',
  'SQ','PYPL','V','MA',
  'UBER','ABNB','BKNG',
  'TWLO','HUBS','GTLB',
  'TTD','APP','RBLX',
  'SHOP','MELI','SE','PDD',
  'SPOT','PINS','SNAP',
  'WIX','VEEV','ANSS','CDNS','AZPN','DBX',
]

// ─── Mock Data ────────────────────────────────────────────────────────────────

export const FLOWS_MOCK: FlowsData = {
  cot: [],
  ctaGauges: [
    {
      label: 'Global Equities', exposure: 87, prevExposure: 79, signal: 'exhaustion_risk',
      // S&P 500 proxy spot ~5,780 · flip = −4.5% break below
      ctaFlip: { level: '5,519', pctFromSpot: -4.5, direction: 'below' },
      // At 87% long + exhaustion: systematic liquidation on trigger
      flow5D:  { amount: '$8.4B', action: 'Liquidate', sign: -1 },
    },
    {
      label: 'Emerging Markets', exposure: 34, prevExposure: 28, signal: 'neutral',
      // MSCI EM proxy spot ~1,182 · flip = −4.7% break below (trend still building)
      ctaFlip: { level: '1,127', pctFromSpot: -4.7, direction: 'below' },
      // Trending up from 28% → 34%: mechanical buying continues if trend holds
      flow5D:  { amount: '$1.2B', action: 'Add', sign: 1 },
    },
    {
      label: 'US Fixed Income', exposure: -22, prevExposure: -18, signal: 'bearish',
      // Short bonds (TLT proxy ~$88.20) · shorts cover on +4.5% rally to $92.20
      ctaFlip: { level: '$92.20', pctFromSpot: +4.5, direction: 'above' },
      // Rally through flip level forces systematic short-covering = buying
      flow5D:  { amount: '$2.1B', action: 'Cover', sign: 1 },
    },
    {
      label: 'Commodities', exposure: 61, prevExposure: 65, signal: 'neutral',
      // DJP basket proxy spot ~$28.80 · flip = −4.2% break below
      ctaFlip: { level: '$27.59', pctFromSpot: -4.2, direction: 'below' },
      // Declining from 65% → 61%: further reduction likely; not full liquidation
      flow5D:  { amount: '$650M', action: 'Reduce', sign: -1 },
    },
  ],
  techSkew: [],
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(' ')
}

/**
 * Format a contract count into a signed "K" string, e.g. +31K / −12K / 0K.
 *
 * The returned string ALREADY carries its own sign — callers must NOT prepend
 * another '+' (that produced the "++31K" double-plus bug).  Values that round
 * to zero are emitted as a clean "0K" with no sign, fixing the "−0K" artefact
 * that appeared for tiny negative changes (e.g. −400 → round → −0).
 */
function fmtK(n: number): string {
  const k = Math.round(n / 1000)
  if (k === 0) return '0K'                       // strip sign on zero → "0K"
  const sign = k > 0 ? '+' : '−'
  return `${sign}${Math.abs(k).toLocaleString()}K`
}

/**
 * Format a week-over-week momentum percentage, e.g. +8% / −15% / 0%.
 * Single sign only; a value that rounds to zero is emitted as a clean "0%"
 * (fixes the "+0%" and "+-0%" artefacts from the old `+`-prepend logic).
 */
function fmtMomentumPct(pct: number): string {
  const rounded = Math.round(pct)
  if (rounded === 0) return '0%'                 // strip sign on zero → "0%"
  const sign = rounded > 0 ? '+' : '−'
  return `${sign}${Math.abs(rounded)}%`
}

// Symbol name mapping (modern CFTC contract codes)
const SYMBOL_NAME_MAP: Record<string, string> = {
  'ES': 'S&P 500', 'NQ': 'Nasdaq-100', 'RTY': 'Russell 2K', 'VX': 'VIX',
  'SR3': 'SOFR 3M', 'ZT': '2Y Note', 'ZF': '5Y Note', 'ZN': '10Y Note', 'ZB': '30Y Bond',
  'DX': 'Dollar Index', '6E': 'Euro', '6J': 'Yen', '6A': 'Aussie $', '6C': 'CAD',
  'BTC': 'Bitcoin',
  'CL': 'Crude Oil', 'NG': 'Nat Gas', 'GC': 'Gold', 'SI': 'Silver', 'HG': 'Copper',
}

// Legacy symbol to modern CFTC code migration
const SYMBOL_MIGRATION_MAP: Record<string, string> = {
  '^TNX': 'ZN', 'ZT=F': 'ZT', 'ZF=F': 'ZF', 'ZN=F': 'ZN', 'ZB=F': 'ZB',
  'ES=F': 'ES', 'NQ=F': 'NQ', 'RTY=F': 'RTY',
  'CL=F': 'CL', 'NG=F': 'NG', 'GC=F': 'GC', 'SI=F': 'SI', 'HG=F': 'HG',
  'EUR=X': '6E', 'JPY=X': '6J', 'GBP=X': '6B', 'AUD=X': '6A', 'CAD=X': '6C',
}

// Category labels and colors
const CATEGORY_LABELS_MAP: Record<string, string> = { 'index': 'INDEX', 'rates': 'RATES', 'indexes': 'INDEX', 'treasuries': 'RATES', 'currency': 'FX', 'commodity': 'CMDTY' }
const CATEGORY_COLORS_MAP: Record<string, string> = { 'index': '#60a5fa', 'rates': '#a78bfa', 'indexes': '#60a5fa', 'treasuries': '#a78bfa', 'currency': '#34d399', 'commodity': '#fbbf24' }
const CATEGORY_TEXT_CLASS_MAP: Record<string, string> = { 'index': 'text-blue-400', 'indexes': 'text-blue-400', 'rates': 'text-violet-400', 'treasuries': 'text-violet-400', 'currency': 'text-emerald-400', 'fx': 'text-emerald-400', 'commodity': 'text-amber-400' }

function normalizeSymbolFormat(symbol: string): string {
  return SYMBOL_MIGRATION_MAP[symbol] || symbol
}

function getCategoryTextColor(category?: string): string {
  const cat = category || 'commodity'
  return CATEGORY_TEXT_CLASS_MAP[cat] || 'text-amber-400'
}

// ─── Tooltip Component ─────────────────────────────────────────────────────────

interface TooltipProps {
  children: React.ReactNode
  text: string
}

function Tooltip({ children, text }: TooltipProps) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative inline-block group">
      <button
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        className="text-slate-400 hover:text-slate-300 text-[10px] leading-none"
      >
        {children}
      </button>
      {show && (
        <div className="absolute z-50 bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1.5 bg-slate-900 border border-slate-700 rounded-lg text-[11px] text-slate-300 whitespace-nowrap shadow-lg">
          {text}
          <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-1 h-1 bg-slate-900 border-r border-b border-slate-700" />
        </div>
      )}
    </div>
  )
}

// ─── Signal Popup Tooltip Component ────────────────────────────────────────────

interface SignalPopupProps {
  signal: React.ReactNode
  thesis: string
  execution: string
}

function SignalPopup({ signal, thesis, execution }: SignalPopupProps) {
  const [show, setShow] = useState(false)
  return (
    <div className="relative inline-block">
      <div
        onMouseEnter={() => setShow(true)}
        onMouseLeave={() => setShow(false)}
        className="cursor-help"
      >
        {signal}
      </div>
      {show && (
        <div className="absolute z-50 right-0 top-full mt-1 w-64 bg-slate-950 border border-slate-700 rounded-lg p-2.5 shadow-xl">
          <div className="text-[10px] text-slate-400 font-mono mb-1.5 pb-1.5 border-b border-slate-800">
            <strong className="text-slate-300">CORE THESIS:</strong> {thesis}
          </div>
          <div className="text-[10px] text-slate-400 font-mono">
            <strong className="text-slate-300">EXECUTION:</strong> {execution}
          </div>
          <div className="absolute bottom-full right-2 w-2 h-2 bg-slate-950 border-r border-t border-slate-700 transform rotate-45" />
        </div>
      )}
    </div>
  )
}

// ─── Historical Scale Bar ──────────────────────────────────────────────────────

function HistoricalScaleBar({ positioningScale }: { positioningScale: number }) {
  const isExtreme = positioningScale < 10 || positioningScale > 90
  const isLong = positioningScale >= 50
  const fillPct = isLong ? positioningScale - 50 : 50 - positioningScale
  const fillColor = isExtreme
    ? (isLong ? '#38bdf8' : '#f87171')
    : (isLong ? '#60a5fa' : '#fb7185')

  return (
    <div className="relative w-full h-2.5 bg-slate-800/40 rounded-sm overflow-hidden flex">
      {/* Short side */}
      <div className="w-1/2 bg-red-950/20 rounded-l" />
      {/* Long side */}
      <div className="w-1/2 bg-blue-950/20 rounded-r" />

      {/* Active fill */}
      <div
        className="absolute top-0 h-full transition-all duration-300 rounded-sm"
        style={{
          left: isLong ? '50%' : `${50 - fillPct}%`,
          right: isLong ? `${50 - fillPct}%` : '50%',
          backgroundColor: fillColor,
          opacity: 0.75,
        }}
      />

      {/* Zero-line */}
      <div className="absolute left-1/2 top-0 w-px h-full bg-slate-600 z-10 transform -translate-x-1/2" />
    </div>
  )
}

// ─── Unified Positioning Matrix Row ───────────────────────────────────────────

// ── Dynamic Execution copy ────────────────────────────────────────────────────
// Returns the cross-market interpretation shown in the signal popup's EXECUTION
// block, evaluated against the active row.  Three families:
//
//   indexes    → per-contract read of what the equity index positioning means
//                for the broad stock market (ES / NQ / RTY / VX).
//   commodity  → per-contract trade-phase + equity impact (HG / CL / NG / GC / SI).
//   treasuries → signal-state machine keyed off "signal active" + weeks-at-extreme
//                (COILING → ACTIVE SQUEEZE → NOT THERE).
//
// Anything not explicitly mapped (currency, un-listed tenors) falls back to a
// generic framing so a popup is never blank.
function computeExecutionText(
  row:            PositioningRow,
  isExtreme:      boolean,
  weeksAtExtreme: number,
): string {
  switch (row.category) {
    // ── EQUITY INDEXES ──────────────────────────────────────────────────────
    case 'indexes':
      switch (row.symbol) {
        case 'ES':
          return "Institutions are maintaining a heavily hedged short overlay here (-402K contracts). This means a sudden turn in price will trigger a massive structural short cover, fuel-injecting a rapid squeeze back toward all-time highs."
        case 'NQ':
          return "With a -66K contract short bias sitting at the 9th percentile, the smart money is heavily leaning against tech. Watch for a liquidity flush to clean out these late shorts before a high-duration growth stock rally resumes."
        case 'RTY':
          return "Net short positioning here reflects severe institutional skepticism toward small-cap cyclical growth. A reversal here acts as a textbook early indicator of a broader macro reflation regime shift."
        case 'VX':
          return "Net short positioning at the 47th percentile shows a completely normalized volatility premium. This indicates low institutional demand for systemic tail-risk hedges, supporting a structural grind higher in major equity indexes."
        default:
          return "The 'Weeks at Extreme' counter tells you when the smart money is completely maxed out. Enter long when a short squeeze triggers a market-wide liquidity flush, and exit as the broad market indexes exhaust their moves."
      }

    // ── HARD ASSETS / COMMODITIES ───────────────────────────────────────────
    case 'commodity':
      switch (row.symbol) {
        case 'HG':
          return "STATUS: MOMENTUM EXTENSION. Institutional positioning is pinned at the 99th percentile extreme. The long accumulation is active and driving. This confirms robust global industrial demand—supporting an equity 'Risk On' regime and acting as a major green light for cyclical sectors and industrial equities."
        case 'CL':
        case 'NG':
          return "STATUS: REGIME NEUTRAL. Institutional positioning is perfectly balanced within normal historical bands (36th-40th percentile). There is no crowded imbalance or structural squeeze to exploit right now. Pass on tactical futures execution and look for broad energy equity setups (XLE) driven by localized supply metrics."
        case 'GC':
        case 'SI':
          return "STATUS: SAFE-HAVEN CONSOLIDATION. Precious metals positioning is holding stable in the high-40s percentile. Capital is neither aggressively crowding in nor panicking out. Watch the Gold/Silver ratio for a compression shift to signal industrial risk-on sentiment before deploying capital into mining equities."
        default:
          return "Track the extreme momentum. A massive short squeeze here signals heavy global inflationary pressure or a growth shock, which typically forces a hawkish Fed bias and puts immediate downward pressure on broad equity multiples."
      }

    // ── TREASURIES ──────────────────────────────────────────────────────────
    case 'treasuries': {
      // "Signal active" = a multi-year extreme is registering (SQUEEZE divergence
      // or top/bottom-decile positioning).  Otherwise positioning is normalized.
      const signalActive = row.divergenceVector === 'SQUEEZE' || isExtreme
      if (signalActive && weeksAtExtreme === 0) {
        return "STATUS: COILING / SETTING UP. The massive -1.6M institutional short position is completely maxed out at the 0th percentile. The spring is fully coiled, but the trigger hasn't fired yet. Watch for a daily reversal candle or an algorithmic volume spike to confirm the institutions are beginning to scramble."
      }
      if (signalActive && weeksAtExtreme > 0) {
        return `STATUS: ACTIVE SQUEEZE TRIGGERED. This crowded short has held historical limits for ${weeksAtExtreme} weeks and the unwind is actively underway. Yields are falling, and the panic cover is structural. Long positions are high-conviction right now; do not stand in the way of the flush.`
      }
      return "STATUS: NOT THERE. Institutional positioning is perfectly normalized within historical bands. There is no crowded imbalance to exploit here. Pass on this asset and wait for positioning to push back to a 0th or 100th percentile extreme."
    }

    // ── CURRENCY / FALLBACK ─────────────────────────────────────────────────
    default:
      return "Track the extreme momentum. A massive short squeeze here signals heavy global inflationary pressure or a growth shock, which typically forces a hawkish Fed bias and puts immediate downward pressure on broad equity multiples."
  }
}

function UnifiedMatrixRow({ row, isExtreme, hasCommericalInversion }: { row: PositioningRow; isExtreme: boolean; hasCommericalInversion: boolean }) {
  const displayName = SYMBOL_NAME_MAP[row.symbol] || row.symbol

  // ── Week-over-week momentum velocity ─────────────────────────────────────────
  // Momentum = Change ÷ |Previous Position|, where Previous = Current − Change.
  // The denominator is wrapped in Math.abs() so the velocity magnitude is taken
  // against the size of last week's baseline regardless of its sign (a net-short
  // book still has a positive contract base).  Dividing by the *current* position
  // understated velocity and was wrong when the position grew over the week.
  // Guard against a zero previous position (Infinity/NaN) by returning 0%.
  const prevPosition = row.leveragedNet - row.weeklyChange
  const momentumPct =
    prevPosition === 0 || row.weeklyChange === undefined
      ? 0
      : (row.weeklyChange / Math.abs(prevPosition)) * 100

  const weeksAtExtreme = 0
  const posScale = row.positioningScale ?? 50
  const isShort = row.leveragedNet < 0
  const isLong = row.leveragedNet > 0

  // ── Dynamic Core Thesis ──────────────────────────────────────────────────────
  // Swaps the positioning direction and the unwind terminology based on whether
  // the active contract's leveraged-fund net positioning is short or long:
  //   leveragedNet < 0  → Net Short  → the eventual unwind is a "short squeeze"
  //   leveragedNet ≥ 0  → Net Long   → the eventual unwind is a "long liquidation"
  const netDirection = isShort ? 'Net Short' : 'Net Long'
  const unwindType   = isShort ? 'short squeeze' : 'long liquidation'
  const dynamicThesis =
    `Institutions are currently heavily ${netDirection} on this asset, while commercial hedgers are positioned the exact opposite way. ` +
    `This sets up a crowded trade where retail can exploit the eventual ${unwindType} unwind.`

  // ── Dynamic Execution ────────────────────────────────────────────────────────
  // Per-asset cross-market interpretation — see computeExecutionText() above for
  // the full INDEXES / HARD-ASSETS / TREASURIES mapping.
  const dynamicExecution = computeExecutionText(row, isExtreme, weeksAtExtreme)

  // Determine signal with actionable trading bias
  let signalBadge: React.ReactNode = null

  if (row.divergenceVector === 'SQUEEZE') {
    // SQUEEZE detected: bias depends on current net position
    if (isShort) {
      // Leveraged funds are SHORT but commercials are LONG → Liquidity trap, expect squeeze UP
      signalBadge = (
        <SignalPopup
          signal={<div className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border animate-pulse" style={{
            color: '#ef4444',
            borderColor: 'rgba(239,68,68,0.5)',
            backgroundColor: 'rgba(239,68,68,0.1)',
            boxShadow: '0 0 10px rgba(239,68,68,0.3)',
          }}>
            <span className="text-[10px] font-mono font-bold">⚡ SCALP LONG (SQUEEZE)</span>
          </div>}
          thesis={dynamicThesis}
          execution={dynamicExecution}
        />
      )
    } else if (isLong) {
      // Leveraged funds are LONG but commercials are SHORT → Liquidity trap, expect squeeze DOWN
      signalBadge = (
        <SignalPopup
          signal={<div className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border animate-pulse" style={{
            color: '#34d399',
            borderColor: 'rgba(52,211,153,0.5)',
            backgroundColor: 'rgba(52,211,153,0.1)',
            boxShadow: '0 0 10px rgba(52,211,153,0.3)',
          }}>
            <span className="text-[10px] font-mono font-bold">⚡ SCALP SHORT (SQUEEZE)</span>
          </div>}
          thesis={dynamicThesis}
          execution={dynamicExecution}
        />
      )
    }
  } else if (isExtreme && row.divergenceVector !== 'SQUEEZE') {
    // Extreme positioning without squeeze: bias based on positioning direction
    if (posScale < 10) {
      // Extreme short without squeeze: distribution opportunity
      signalBadge = (
        <SignalPopup
          signal={<div className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border" style={{
            color: '#fbbf24',
            borderColor: 'rgba(251,191,36,0.4)',
            backgroundColor: 'rgba(251,191,36,0.08)',
          }}>
            <span className="text-[10px] font-mono font-bold">▼ BIAS: DISTRIBUTE SHORT</span>
          </div>}
          thesis={dynamicThesis}
          execution={dynamicExecution}
        />
      )
    } else if (posScale > 90) {
      // Extreme long without squeeze: accumulation opportunity
      signalBadge = (
        <SignalPopup
          signal={<div className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border" style={{
            color: '#fbbf24',
            borderColor: 'rgba(251,191,36,0.4)',
            backgroundColor: 'rgba(251,191,36,0.08)',
          }}>
            <span className="text-[10px] font-mono font-bold">▲ BIAS: ACCUMULATE LONG</span>
          </div>}
          thesis={dynamicThesis}
          execution={dynamicExecution}
        />
      )
    }
  } else if (posScale >= 15 && posScale <= 85) {
    // Neutral regime: positioning is balanced
    signalBadge = (
      <SignalPopup
        signal={<div className="inline-flex items-center gap-1 px-2 py-1 rounded-lg border" style={{
          color: '#94a3b8',
          borderColor: 'rgba(148,163,184,0.3)',
          backgroundColor: 'rgba(148,163,184,0.08)',
        }}>
          <span className="text-[10px] font-mono font-bold">⚪ NEUTRAL REGIME</span>
        </div>}
        thesis={dynamicThesis}
        execution={dynamicExecution}
      />
    )
  }

  const tickerColorClass = getCategoryTextColor(row.category)

  return (
    <div
      className={cn(
        'grid items-center gap-2 px-3 py-1.5 border-b border-slate-800/50 transition-colors',
        row.divergenceVector === 'SQUEEZE' ? 'bg-red-950/10' : 'hover:bg-slate-800/20'
      )}
      style={{ gridTemplateColumns: '10rem 7rem 9rem 2.5fr 6rem 8rem' }}
    >
      {/* ASSET: Symbol | Name */}
      <div className="font-mono text-sm font-semibold text-slate-100">
        <span className={tickerColorClass}>{row.symbol}</span>
        <span className="text-slate-400 font-normal"> | {displayName}</span>
      </div>

      {/* LEV. FUNDS NET */}
      <div className="text-right">
        <div
          className="font-mono text-sm font-bold tabular-nums"
          style={{ color: row.leveragedNet >= 0 ? '#38bdf8' : '#f87171' }}
        >
          {fmtK(row.leveragedNet)}
        </div>
      </div>

      {/* MOMENTUM VECTOR: 1W Velocity + W/W % Momentum — centered over the column */}
      <div className="text-center">
        <div className="font-mono text-xs text-slate-200">
          {Math.round(row.weeklyChange / 1000) === 0 || Math.round(momentumPct) === 0 ? (
            // Zero state — one clean string, never "−0K / +-0%".
            <span className="text-slate-400">0K / 0%</span>
          ) : (
            <>
              {/* fmtK / fmtMomentumPct each carry their own single sign (Math.abs
                  applied internally) — never prepend another '+' or '−' here. */}
              <span style={{ color: row.weeklyChange >= 0 ? '#34d399' : '#f87171' }}>
                {fmtK(row.weeklyChange)}
              </span>
              <span className="text-slate-400"> / </span>
              <span style={{ color: momentumPct >= 0 ? '#34d399' : '#f87171' }}>
                {fmtMomentumPct(momentumPct)}
              </span>
            </>
          )}
        </div>
      </div>

      {/* HISTORICAL SCALE Bar */}
      <div className="px-3">
        <HistoricalScaleBar positioningScale={posScale} />
        <div className="text-[9px] text-slate-500 text-center mt-0.5 font-mono">
          {posScale.toFixed(0)}th
        </div>
      </div>

      {/* WEEKS AT EXTREME */}
      <div className="text-center">
        <div className="font-mono text-sm font-bold text-slate-100">
          {weeksAtExtreme}
        </div>
        <div className="text-[9px] text-slate-500">weeks</div>
      </div>

      {/* TRIGGER SIGNAL — pill badge flex-centered in the column */}
      <div className="flex justify-center">
        {signalBadge || <div className="text-slate-600 text-[10px]">—</div>}
      </div>
    </div>
  )
}

// ─── Unified Institutional Matrix ──────────────────────────────────────────────

// ─── Category config for the unified view (FX omitted per dashboard spec) ─────
const UNIFIED_CATEGORIES = [
  { key: 'indexes',    label: 'INDEXES',     color: '#60a5fa' },
  { key: 'treasuries', label: 'TREASURIES',  color: '#a78bfa' },
  { key: 'commodity',  label: 'HARD ASSETS', color: '#fbbf24' },
] as const

type UnifiedCategory = typeof UNIFIED_CATEGORIES[number]['key']

export function UnifiedPositioningMatrix({ cot: defaultCot }: { cot: COTAsset[] }) {
  const [liveData, setLiveData] = useState<PositioningRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // Default: only the equity-index category is active on mount, so the matrix
  // opens showing just the 4 index contracts (ES · NQ · RTY · VX).  Users toggle
  // Treasuries / Hard Assets in via the filter pills.  NOTE: the key must be the
  // lowercase category id ('indexes') the row-filter compares against — not
  // 'INDEXES' — or `selectedCategories.has(row.category)` would match nothing.
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(
    new Set(['indexes'])
  )

  // Fetch live data
  useEffect(() => {
    const fetchData = async () => {
      try {
        const res = await fetch('/api/macro-positioning', { cache: 'no-store' })
        if (res.ok) {
          const data = await res.json() as MacroPositioningData
          console.info('[unified-matrix] Live data fetched:', { count: data.rows.length, symbols: data.rows.map(r => r.symbol) })
          setLiveData(data.rows)
        }
      } catch (err) {
        console.warn('[unified-matrix] Failed to fetch:', err)
      } finally {
        setIsLoading(false)
      }
    }
    fetchData()
  }, [])

  // Filter by selected categories
  const filtered = useMemo(() => {
    return liveData.filter((row) => {
      const cat = row.category || 'commodity'
      return selectedCategories.has(cat)
    })
  }, [liveData, selectedCategories])

  const toggleCategory = (cat: string) => {
    const newCats = new Set(selectedCategories)
    newCats.has(cat) ? newCats.delete(cat) : newCats.add(cat)
    setSelectedCategories(newCats)
  }

  const mrCount = filtered.filter((r) => r.divergenceVector === 'SQUEEZE').length

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 col-span-full w-full">
      {/* Header with status indicator */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
        <div>
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">CFTC COT — Institutional Positioning &amp; Squeeze Engine</h3>
            <StatusBadge variant="live" label="REAL-TIME CFTC" title="Live CFTC Commitments of Traders data" />
          </div>
          {mrCount > 0 && (
            <div className="text-[11px] font-mono text-red-400/70">
              {mrCount} squeeze signal{mrCount > 1 ? 's' : ''} active — high convexity regime
            </div>
          )}
        </div>
        <div className="flex items-center gap-3 text-[9px] text-slate-400 font-mono">
          <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-1.5 rounded bg-sky-400/70" /> Net Long</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-1.5 rounded bg-red-400/70" /> Net Short</span>
        </div>
      </div>

      {/* Category filter pills — FX omitted */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">Filter:</span>
        {UNIFIED_CATEGORIES.map(({ key, label, color }) => {
          const isActive = selectedCategories.has(key)
          return (
            <button
              key={key}
              onClick={() => toggleCategory(key)}
              className={cn(
                'px-3 py-1.5 rounded-lg text-[10px] font-mono font-bold uppercase tracking-wider transition-all border',
                isActive
                  ? 'ring-2 ring-offset-1'
                  : 'text-slate-500 bg-slate-900/40 border-slate-800 hover:bg-slate-800/60'
              )}
              style={isActive ? {
                backgroundColor: color,
                color: '#1a1a1a',
                borderColor: color,
                boxShadow: `0 0 12px ${color}40, inset 0 0 8px ${color}20`,
              } : undefined}
            >
              {label}
            </button>
          )
        })}
      </div>

      {/* Table header with tooltips */}
      <div className="border-t border-b border-slate-800/50 mb-1">
        <div
          className="grid items-center gap-2 px-3 py-2 bg-slate-900/30"
          style={{ gridTemplateColumns: '10rem 7rem 9rem 2.5fr 6rem 8rem' }}
        >
          {/* ASSET & LEV. FUNDS — alignment unchanged (left / right) */}
          <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Asset</div>
          <div className="text-right text-[10px] font-mono text-slate-400 uppercase tracking-widest">Lev. Funds</div>
          {/* MOMENTUM · HISTORICAL SCALE · WEEKS · SIGNAL — centered over their cells */}
          <div className="text-center text-[10px] font-mono text-slate-400 uppercase tracking-widest">Momentum</div>
          <div className="flex items-center gap-1.5 justify-center">
            <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Historical Scale</span>
            <Tooltip text="3-year COT positioning percentile. Extremes (<10% or >90%) signal exhaustion zones.">
              (?)
            </Tooltip>
          </div>
          <div className="flex items-center gap-1.5 justify-center">
            <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Weeks</span>
            <Tooltip text="Consecutive weeks at structural boundaries. Coiled springs = reversal risk.">
              (?)
            </Tooltip>
          </div>
          <div className="flex items-center gap-1.5 justify-center">
            <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Signal</span>
            <Tooltip text="SQUEEZE: extreme + commercials opposed. EXHAUSTION: extreme without commercial inversion.">
              (?)
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Table body — grouped by category */}
      {filtered.length === 0 ? (
        <div className="text-center py-6 text-[11px] text-slate-500 font-mono">No assets in selected categories</div>
      ) : (
        <div>
          {UNIFIED_CATEGORIES.filter(cat => selectedCategories.has(cat.key)).map(({ key, label, color }) => {
            const rows = liveData.filter(r => (r.category || 'commodity') === key)
            if (rows.length === 0) return null
            return (
              <div key={key}>
                {/* Category section header */}
                <div
                  className="px-3 py-1.5 flex items-center gap-2 border-b border-slate-800/80"
                  style={{ backgroundColor: `${color}10` }}
                >
                  <div
                    className="w-1.5 h-3 rounded-sm flex-shrink-0"
                    style={{ backgroundColor: color }}
                  />
                  <span
                    className="text-[9px] font-mono font-bold uppercase tracking-[0.18em]"
                    style={{ color }}
                  >
                    {label}
                  </span>
                  <span className="text-[9px] font-mono text-slate-600">
                    {rows.length} contracts
                  </span>
                </div>
                {/* Asset rows */}
                <div className="divide-y divide-slate-800/30">
                  {rows.map((row) => {
                    const isExtreme = (row.positioningScale ?? 50) < 10 || (row.positioningScale ?? 50) > 90
                    return (
                      <UnifiedMatrixRow
                        key={row.symbol}
                        row={row}
                        isExtreme={isExtreme}
                        hasCommericalInversion={true}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Footer explanation */}
      <div className="mt-4 pt-3 border-t border-slate-800/50">
        <p className="text-[10px] text-slate-500 font-mono leading-relaxed">
          <strong className="text-slate-400">Squeeze Engine:</strong> Tracks when institutional funds are heavily over-positioned in one direction while commercial hedgers bet the exact opposite way.{' '}
          <strong className="text-amber-400/70">&apos;Weeks at Extreme&apos;</strong> shows how long this tension has been building—the longer it holds, the bigger the potential explosive reversal.{' '}
          A <strong className="text-red-400/70">SQUEEZE</strong> signal fires when it&apos;s time to trade against the institutions, and turns off when the market flushes out.
        </p>
      </div>
    </div>
  )
}

// ─── CTA Gauge ────────────────────────────────────────────────────────────────

// ─── Systematic Execution Playbook ─────────────────────────────────────────────
//
// Regime classification from the net exposure derived by the CTA engine:
//   MAX LONG  exposure ≥ 70  → trend desks fully long, trailing stop-sells active
//   SHORT     exposure < 0   → desks net short
//   NEUTRAL   0 … 70         → sidelined / building
function ctaRegime(exposure: number): { label: string; color: string; isLong: boolean } {
  if (exposure >= 70) return { label: 'MAX LONG', color: '#34d399', isLong: true }
  if (exposure < 0)   return { label: 'SHORT',    color: '#f87171', isLong: false }
  return { label: 'NEUTRAL', color: '#fbbf24', isLong: false }
}

// Order Execution Directive — long books trail a stop-sell; short/sidelined books
// rest buy-stops above to capture the short-covering velocity on a break higher.
function executionDirective(isLong: boolean, flipLevel: string): string {
  return isLong
    ? `Maintain long exposure. Trailing stop-sell orders active at ${flipLevel}.`
    : `Desks are short/sidelined. System buy-stops rest at ${flipLevel} to capture short-covering velocity.`
}

function PlaybookRow({ row }: { row: CTAGaugeRow }) {
  const { label, exposure, ctaFlip } = row
  const regime    = ctaRegime(exposure)
  const flipLevel = ctaFlip?.level ?? '--'
  // % distance to trigger = live (flip − spot) / spot, already encoded by the
  // engine as ctaFlip.pctFromSpot (flip = spot × (1 + pctFromSpot/100)).
  const distLabel = ctaFlip
    ? `${ctaFlip.pctFromSpot >= 0 ? '+' : ''}${ctaFlip.pctFromSpot.toFixed(1)}%`
    : '--'
  const distColor = ctaFlip?.direction === 'above' ? '#34d399' : '#f87171'
  const directive = ctaFlip ? executionDirective(regime.isLong, flipLevel) : '—'

  return (
    <div className="grid grid-cols-12 gap-2 items-center px-2 py-2 border-b border-slate-800/50 hover:bg-slate-800/20 transition-colors">
      {/* Asset */}
      <div className="col-span-2 font-mono text-xs font-semibold text-slate-100">{label}</div>
      {/* Regime */}
      <div className="col-span-2">
        <span
          className="inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] font-mono font-bold tracking-wide whitespace-nowrap"
          style={{ color: regime.color, borderColor: `${regime.color}55`, backgroundColor: `${regime.color}14` }}
        >
          {regime.label}
        </span>
      </div>
      {/* Trail Stop (Flip Price) */}
      <div className="col-span-2 font-mono text-xs font-semibold tabular-nums text-slate-100">{flipLevel}</div>
      {/* % Distance to Trigger */}
      <div className="col-span-1 font-mono text-xs font-semibold tabular-nums" style={{ color: ctaFlip ? distColor : '#64748b' }}>
        {distLabel}
      </div>
      {/* Order Execution Directive */}
      <div className="col-span-5 font-mono text-[11px] text-slate-400 leading-snug">{directive}</div>
    </div>
  )
}

// ─── Live CTA gauge derivation ─────────────────────────────────────────────────
//
// The gauges are derived DIRECTLY from the Systematic & CTA Exposure Engine
// matrix (/api/market/cta-engine).  Each ETF row carries a 0-100 CFTC
// positioning percentile and a 50/200d EMA spread; we aggregate those per asset
// class into a net allocation %, and anchor the CTA flip price to the ETF's OWN
// live price (e.g. SPY ≈ $580) — never the cash-index level (5,519).

interface CTAEngineRow {
  asset:            string
  currentPrice:     number
  emaSpreadPct:     number
  ema50vsPricePct:  number
  positioningScore: number
}

const clampN = (lo: number, hi: number, v: number) => Math.max(lo, Math.min(hi, v))
const avgN   = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

// Each gauge maps to the engine ETF rows that compose it; `anchor` is the ETF
// whose live price the flip level is measured against.
const GAUGE_GROUPS: { label: string; symbols: string[]; anchor: string }[] = [
  { label: 'Global Equities', symbols: ['SPY', 'QQQ', 'IWM'], anchor: 'SPY' },
  { label: 'US Fixed Income', symbols: ['TLT'],               anchor: 'TLT' },
  { label: 'Commodities',     symbols: ['GLD', 'USO'],        anchor: 'GLD' },
]

/**
 * Map the live engine matrix into CTA allocation gauges.  Returns null when no
 * usable rows exist so the caller can fall back to the static panel.
 */
function deriveGaugesFromEngine(rows: CTAEngineRow[]): CTAGaugeRow[] | null {
  if (!rows.length) return null
  const byAsset = new Map(rows.map(r => [r.asset, r]))

  const gauges: CTAGaugeRow[] = []
  for (const group of GAUGE_GROUPS) {
    const members = group.symbols
      .map(s => byAsset.get(s))
      .filter((r): r is CTAEngineRow => !!r && r.currentPrice > 0)
    if (members.length === 0) continue

    const avgPos = avgN(members.map(m => m.positioningScore))   // 0..100 crowding percentile
    const avgEma = avgN(members.map(m => m.emaSpreadPct))       // signed 50d-vs-200d %
    const avgMom = avgN(members.map(m => m.ema50vsPricePct))    // price vs 50d (recent drift)

    // Net allocation: positioning percentile centred at 50 → −100..+100, with
    // the EMA spread confirming / tilting the trend direction.
    const posExposure = (avgPos - 50) * 2
    const emaAdj      = clampN(-15, 15, avgEma * 2)
    const exposure    = Math.round(clampN(-100, 100, posExposure + emaAdj))

    // Recent-momentum proxy for the W/W delta (price drift off the 50d anchor).
    const delta        = Math.round(clampN(-20, 20, avgMom))
    const prevExposure = Math.round(clampN(-100, 100, exposure - delta))

    const signal: CTAGaugeRow['signal'] =
      avgPos >= 85 && avgEma > 0 ? 'exhaustion_risk' :
      exposure < 0               ? 'bearish'         :
      exposure > 70              ? 'bullish'         : 'neutral'

    // CTA flip price anchored to the representative ETF's OWN live price — a
    // ~4.5% break either flips a long short (below) or covers a short (above).
    const anchor = byAsset.get(group.anchor)
    let ctaFlip: CTAFlipMeta | undefined
    if (anchor && anchor.currentPrice > 0) {
      const direction: 'below' | 'above' = exposure >= 0 ? 'below' : 'above'
      const pctFromSpot = direction === 'below' ? -4.5 : 4.5
      const flipLevel   = anchor.currentPrice * (1 + pctFromSpot / 100)
      ctaFlip = { level: `$${flipLevel.toFixed(2)}`, pctFromSpot, direction }
    }

    gauges.push({ label: group.label, exposure, prevExposure, signal, ctaFlip })
  }

  return gauges.length ? gauges : null
}

export function CTAGaugesPanel({ gauges }: { gauges: CTAGaugeRow[] }) {
  // Derive the gauges live from the CTA exposure engine matrix; fall back to the
  // static `gauges` prop until (or unless) the live feed resolves.
  const [liveGauges, setLiveGauges] = useState<CTAGaugeRow[] | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const res = await fetch('/api/market/cta-engine', { cache: 'no-store' })
        if (!res.ok) return
        const body = await res.json() as { rows?: CTAEngineRow[] }
        if (!alive) return
        const derived = deriveGaugesFromEngine(body.rows ?? [])
        if (derived) setLiveGauges(derived)
      } catch {
        /* network error — keep static fallback */
      }
    }
    load()
    // Same 1h heartbeat as the engine's server cache cadence.
    const id = setInterval(load, 60 * 60 * 1000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const isLive = liveGauges !== null
  const rows   = liveGauges ?? gauges

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">Systematic Execution Playbook</h3>
          {isLive
            ? <StatusBadge variant="live" label="LIVE ENGINE" title="Trail-stop directives derived live from the CTA exposure engine — positioning percentile + 50/200d EMA spread" />
            : <StatusBadge variant="disconnected" label="SIMULATED" title="Displaying simulated CTA directives — live feed pending" />}
        </div>
        <span className="text-[12px] font-mono text-slate-400">Trail-stop directives</span>
      </div>

      {/* ── Column headers ── */}
      <div className="grid grid-cols-12 gap-2 px-2 text-[10px] font-mono text-slate-600 uppercase tracking-widest">
        <div className="col-span-2">Asset</div>
        <div className="col-span-2">Regime</div>
        <div className="col-span-2">Trail Stop · Flip</div>
        <div className="col-span-1">Dist</div>
        <div className="col-span-5">Order Execution Directive</div>
      </div>

      {/* ── Rows ── */}
      <div>{rows.map((g) => <PlaybookRow key={g.label} row={g} />)}</div>

      <p className="text-[12px] text-slate-400 font-mono border-t border-[#1a2540] pt-3">
        {isLive
          ? 'Trail-stop / flip levels anchored to each ETF proxy from the live CTA exposure engine. Distance = live spot vs flip trigger.'
          : 'Estimated CTA / trend-follower execution levels derived from futures open interest and managed-money flows.'}
      </p>
    </div>
  )
}


// ─── Tech Skew Panel with Search ──────────────────────────────────────────────

const DEFAULT_SKEW_TICKERS = ['NVDA', 'MU', 'SNDK']
const ALL_TICKERS = Object.keys(SKEW_DB)

function SkewBar({ row, liveQuote }: { row: SkewTicker; liveQuote?: AlpacaQuote }) {
  const { ticker, callPct, putPct, impliedMove, signal } = row
  const signalConfig = {
    upside_demand: { label: 'UPSIDE DEMAND', color: '#38bdf8',  bg: 'rgba(56,189,248,0.12)',  border: 'rgba(56,189,248,0.35)' },
    balanced:      { label: 'BALANCED',      color: '#94a3b8',  bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.25)' },
    hedging:       { label: 'HEDGING',       color: '#fbbf24',  bg: 'rgba(251,191,36,0.12)',  border: 'rgba(251,191,36,0.35)' },
  }[signal]

  const livePrice = liveQuote?.price
  const livePct   = liveQuote?.changePercent
  const priceColor = livePct == null ? '#94a3b8' : livePct > 0 ? '#34d399' : livePct < 0 ? '#f87171' : '#94a3b8'

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm text-slate-100 font-semibold w-12">{ticker}</span>
          {livePrice != null && (
            <span className="font-mono text-[12px] tabular-nums" style={{ color: priceColor }}>
              {livePrice >= 1000
                ? livePrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                : livePrice.toFixed(2)}
              {livePct != null && (
                <span className="ml-1 text-[11px]">
                  {livePct >= 0 ? '+' : ''}{livePct.toFixed(2)}%
                </span>
              )}
            </span>
          )}
          <span className="text-[12px] font-mono font-bold px-1.5 py-0.5 rounded border" style={{ color: signalConfig.color, backgroundColor: signalConfig.bg, borderColor: signalConfig.border }}>{signalConfig.label}</span>
        </div>
        <div className="text-[10px] font-mono text-slate-300">±{impliedMove.toFixed(1)}% wk IV</div>
      </div>
      <div className="relative h-2.5 w-full bg-[#111827] rounded-full overflow-hidden flex">
        <div className="h-full rounded-l" style={{ width: `${putPct}%`, backgroundColor: '#fbbf24', opacity: 0.7 }} />
        <div className="h-full rounded-r" style={{ width: `${callPct}%`, backgroundColor: '#38bdf8', opacity: 0.8 }} />
      </div>
      <div className="flex justify-between text-[12px] font-mono">
        <span style={{ color: '#fbbf2499' }}>Puts {putPct}%</span>
        <span style={{ color: '#38bdf899' }}>Calls {callPct}%</span>
      </div>
    </div>
  )
}

export function TechSkewPanel({ skew: _skew }: { skew: SkewTicker[] }) {
  const [selected, setSelected] = usePersistState<string[]>('cm.techSkewTickers', DEFAULT_SKEW_TICKERS)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Live Alpaca quotes for whichever tickers are currently selected
  const liveSymbols = selected.length > 0 ? selected : DEFAULT_SKEW_TICKERS
  const { quoteMap } = useAlpacaData({
    symbols:      liveSymbols,
    assetClass:   'us_equity',
    type:         'snapshot',
    pollInterval: 300_000,
  })

  const suggestions = useMemo(
    () => ALL_TICKERS.filter((t) => t.includes(query.toUpperCase()) && !selected.includes(t)).slice(0, 8),
    [query, selected],
  )

  const add = (ticker: string) => {
    if (!selected.includes(ticker) && selected.length < 8) setSelected((p) => [...p, ticker])
    setQuery('')
    setOpen(false)
    inputRef.current?.focus()
  }

  const remove = (ticker: string) => setSelected((p) => p.filter((t) => t !== ticker))

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handle)
    return () => document.removeEventListener('mousedown', handle)
  }, [])

  const displaySkew = selected.map((t) => SKEW_DB[t]).filter(Boolean)

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">High-Beta Tech Options Skew</h3>
          <StatusBadge variant="disconnected" label="SIMULATED" title="Displaying simulated options skew data — live feed pending" />
        </div>
        <div className="flex items-center gap-2 text-[12px] font-mono">
          <span style={{ color: 'rgba(251,191,36,0.6)' }}>■ Puts</span>
          <span style={{ color: 'rgba(56,189,248,0.7)' }}>■ Calls</span>
        </div>
      </div>

      <div ref={dropdownRef} className="relative">
        <div className="flex flex-wrap items-center gap-1.5 px-2 py-1.5 bg-[#080d18] border border-[#1a2540] rounded-lg focus-within:border-amber-400/40 transition-colors">
          {selected.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded border text-amber-400 border-amber-400/30 bg-amber-400/10">
              {t}
              <button
                className="text-amber-400/60 hover:text-amber-400 ml-0.5 leading-none"
                onClick={() => remove(t)}
                aria-label={`Remove ${t}`}
              >×</button>
            </span>
          ))}
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value.toUpperCase()); setOpen(true) }}
            onFocus={() => setOpen(true)}
            placeholder={selected.length < 8 ? 'Add ticker…' : ''}
            className="flex-1 min-w-[6rem] bg-transparent text-[11px] font-mono text-slate-300 placeholder:text-slate-400 outline-none"
          />
          <span className="text-[12px] text-slate-400 font-mono shrink-0">{selected.length}/8</span>
        </div>
        {open && suggestions.length > 0 && (
          <div className="absolute z-20 top-full mt-1 left-0 right-0 bg-[#0c1221] border border-[#2a3f64] rounded-lg shadow-xl overflow-hidden">
            {suggestions.map((t) => {
              const d = SKEW_DB[t]
              return (
                <button
                  key={t}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-[11px] font-mono hover:bg-[#1a2540] transition-colors"
                  onMouseDown={(e) => { e.preventDefault(); add(t) }}
                >
                  <span className="text-slate-200 font-semibold">{t}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-300">±{d.impliedMove.toFixed(1)}% IV</span>
                    <span className={cn('text-[12px] px-1.5 py-0.5 rounded',
                      d.signal === 'upside_demand' ? 'text-sky-400 bg-sky-400/10' :
                      d.signal === 'hedging'       ? 'text-amber-400 bg-amber-400/10' :
                                                     'text-slate-500 bg-slate-700/20'
                    )}>
                      {d.signal === 'upside_demand' ? 'CALLS' : d.signal === 'hedging' ? 'PUTS' : 'BAL'}
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      <div className="space-y-5">
        {displaySkew.length === 0 ? (
          <div className="text-center text-[11px] text-slate-400 font-mono py-4">Search and add tickers above</div>
        ) : (
          displaySkew.map((s) => <SkewBar key={s.ticker} row={s} liveQuote={quoteMap.get(s.ticker)} />)
        )}
      </div>

      <div className="mt-auto border border-[#1a2540] bg-[#080d18] rounded-xl p-3 space-y-1">
        <div className="text-[12px] font-mono text-slate-400 uppercase tracking-widest">Aggregate Skew Signal</div>
        <div className="text-[11px] font-mono text-slate-400">
          {displaySkew.filter(s => s.signal === 'upside_demand').length > displaySkew.length / 2
            ? 'Call skew dominates — institutions positioning for continued upside in high-beta tech.'
            : displaySkew.filter(s => s.signal === 'hedging').length > displaySkew.length / 2
            ? 'Put skew elevated — defensive hedging into upcoming macro event risk.'
            : 'Mixed skew signals — no clear directional bias across selected names.'}
        </div>
      </div>

      <p className="text-[12px] text-slate-400 font-mono border-t border-[#1a2540] pt-3">
        Call/put skew derived from OI and premium distribution across ATM ±5% strikes. Weekly expiry.
      </p>
    </div>
  )
}

// ─── Public Props ─────────────────────────────────────────────────────────────

export interface InstitutionalFlowsSectionProps {
  data?: FlowsData
}

// ─── Main Component: Unified Institutional Macro Terminal ──────────────────────
// Consolidates all institutional flows into a single widescreen terminal interface

export function InstitutionalFlowsSection({ data = FLOWS_MOCK }: InstitutionalFlowsSectionProps) {
  return (
    <div className="space-y-3">
      {/* Institutional Macro Positioning & Squeeze Engine — Unified Full-Width Matrix */}
      <UnifiedPositioningMatrix cot={data.cot} />

      {/* CTA Systematic & High-Beta Tech Skew — Split 50/50 */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-stretch">
        <CTAGaugesPanel gauges={data.ctaGauges} />
        <TechSkewPanel skew={data.techSkew} />
      </div>
    </div>
  )
}
