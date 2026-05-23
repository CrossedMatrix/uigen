'use client'

import { useId, useState, useMemo, useRef, useEffect } from 'react'
import { usePersistState } from '@/lib/hooks/usePersistState'
import type { PositioningRow, MacroPositioningData } from '@/app/api/macro-positioning/route'

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

export interface CTAGaugeRow {
  label: string
  exposure: number
  prevExposure: number
  signal: 'neutral' | 'exhaustion_risk' | 'bearish' | 'bullish'
}

export interface SkewTicker {
  ticker: string
  callPct: number
  putPct: number
  impliedMove: number
  signal: 'upside_demand' | 'balanced' | 'hedging'
}

export interface BottleneckSide {
  label: string
  tickers: string[]
  peRatio: number
  revenueGrowthPct: number
  return30dPct: number
  return90dPct: number
  epsGrowthPct: number
}

export interface BottleneckData {
  breadth: BottleneckSide
  concentration: BottleneckSide
  ratio: number
  ratioTrend: 'concentration_rising' | 'breadth_expanding' | 'balanced'
  ratioChange30d: number
  sparkline: number[]
}

export interface FlowsData {
  cot: COTAsset[]
  ctaGauges: CTAGaugeRow[]
  techSkew: SkewTicker[]
  bottleneck: BottleneckData
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
    { label: 'Global Equities',  exposure:  87, prevExposure: 79, signal: 'exhaustion_risk' },
    { label: 'Emerging Markets', exposure:  34, prevExposure: 28, signal: 'neutral'         },
    { label: 'US Fixed Income',  exposure: -22, prevExposure: -18, signal: 'bearish'        },
    { label: 'Commodities',      exposure:  61, prevExposure: 65, signal: 'neutral'         },
  ],
  techSkew: [],
  bottleneck: {
    breadth: {
      label: 'Market Breadth',
      tickers: ['BRK.B','JPM','UNH','XOM','JNJ','PG','COST','AMGN','HD','MMM','GE','BA','LMT','CAT','NSC','UPS','EMR','ABT','MCD','PEP'],
      peRatio: 18.3,
      revenueGrowthPct: 6.2,
      epsGrowthPct: 7.4,
      return30dPct: 2.1,
      return90dPct: 5.8,
    },
    concentration: {
      label: 'Mega-Cap Concentration',
      tickers: ['MSFT','NVDA','AAPL','GOOGL','AMZN','META','AVGO','TSLA','LLY','NFLX'],
      peRatio: 42.8,
      revenueGrowthPct: 24.6,
      epsGrowthPct: 31.2,
      return30dPct: 8.4,
      return90dPct: 18.6,
    },
    ratio: 2.34,
    ratioTrend: 'concentration_rising',
    ratioChange30d: +0.18,
    sparkline: [1.92,1.98,2.05,2.12,2.18,2.21,2.26,2.29,2.31,2.32,2.33,2.33,2.34,2.34,2.34],
  },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(' ')
}

function fmtK(n: number): string {
  const sign = n >= 0 ? '+' : '−'
  return `${sign}${Math.abs(Math.round(n / 1000)).toLocaleString()}K`
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

function UnifiedMatrixRow({ row, isExtreme, hasCommericalInversion }: { row: PositioningRow; isExtreme: boolean; hasCommericalInversion: boolean }) {
  const displayName = SYMBOL_NAME_MAP[row.symbol] || row.symbol
  const accelerationPct = row.weeklyChange !== undefined ? ((row.weeklyChange / (Math.abs(row.leveragedNet) + 1)) * 100).toFixed(0) : '0'
  const weeksAtExtreme = 0
  const posScale = row.positioningScale ?? 50
  const isShort = row.leveragedNet < 0
  const isLong = row.leveragedNet > 0

  // Extract momentum vectors for dynamic thesis injection
  const velocity1W = row.weeklyChange ? fmtK(row.weeklyChange) : '0K'
  const acceleration3W = accelerationPct

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
          thesis={`CORE THESIS: Structural Inversion Detected. Speculators are max SHORT (structural exhaustion), while Commercials are max LONG (supply injection). Aggressor Direction: Specs pushed prices DOWN, but commercials have positioned to absorb further selling. Exhaustion Direction: The SHORT thesis is terminally exhausted—every spec short hit becomes a commercial bid. Reversal Direction: Specs trapped in shorts face a liquidity trap; the market snaps UP sharply. With 1W momentum at ${velocity1W} and 3W acceleration at ${Number(acceleration3W) >= 0 ? '+' : ''}${acceleration3W}%, the squeeze mechanics are actively firing. Path of least resistance = UP.`}
          execution="Enter tight long above the technical break. Exit short positions immediately. Target: nearest resistance above supply injection zone. Stop: close below structural lows."
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
          thesis={`CORE THESIS: Structural Inversion Detected. Speculators are max LONG (structural exhaustion), while Commercials are max SHORT (demand destruction). Aggressor Direction: Specs pushed prices UP, but commercials have positioned to absorb further buying. Exhaustion Direction: The LONG thesis is terminally exhausted—every spec long hit becomes a commercial offer. Reversal Direction: Specs trapped in longs face a liquidity trap; the market snaps DOWN sharply. With 1W momentum at ${velocity1W} and 3W acceleration at ${Number(acceleration3W) >= 0 ? '+' : ''}${acceleration3W}%, the squeeze mechanics are actively firing. Path of least resistance = DOWN.`}
          execution="Enter tight short below the technical break. Exit long positions immediately. Target: nearest support below demand destruction zone. Stop: close above structural highs."
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
          thesis={`CORE THESIS: Aggressor Direction: Institutions drove prices DOWN aggressively, piling specs into maximum short positioning (< 10% scale). Exhaustion Direction: The DOWN move can no longer be sustained—selling capacity is exhausted, every new seller finds fewer willing buyers at lower prices. Reversal Direction: The path of least resistance flips UP. With 1W momentum at ${velocity1W} and 3W acceleration at ${Number(acceleration3W) >= 0 ? '+' : ''}${acceleration3W}%, any fresh buying pressure will snap prices upward sharply as the market discovers structural support. This is where distribution rallies ignite.`}
          execution="Distribute into any UP rallies. Target exits on recoveries above the 25th percentile. Monitor for the inevitable breakdown reversal once capitulation selling dries up."
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
          thesis={`CORE THESIS: Aggressor Direction: Institutions drove prices UP aggressively, piling specs into maximum long positioning (> 90% scale). Exhaustion Direction: The UP move can no longer be sustained—buying capacity is exhausted, every new buyer finds fewer willing sellers at higher prices. Reversal Direction: The path of least resistance flips DOWN. With 1W momentum at ${velocity1W} and 3W acceleration at ${Number(acceleration3W) >= 0 ? '+' : ''}${acceleration3W}%, any fresh selling pressure will snap prices downward sharply as the market discovers structural resistance. This is where accumulation pullbacks ignite.`}
          execution="Accumulate into any DOWN pullbacks. Target entries on dips below the 75th percentile. Monitor for the inevitable breakdown reversal once capitulation buying dries up."
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
        thesis={`CORE THESIS: Institutional positioning is fundamentally balanced relative to its 3-year history. Currently, big money is moving at a 1W velocity of ${velocity1W} with a 3W acceleration pace of ${Number(acceleration3W) >= 0 ? '+' : ''}${acceleration3W}%. This shows institutional flows are peacefully validating current market spot trends with zero structural friction.`}
        execution="Avoid forcing mean-reversion setups; follow active trend-following parameters."
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

      {/* MOMENTUM VECTOR: 1W Velocity + 3W % Acceleration */}
      <div className="text-right">
        <div className="font-mono text-xs text-slate-200">
          <span style={{ color: row.weeklyChange >= 0 ? '#34d399' : '#f87171' }}>
            {row.weeklyChange >= 0 ? '+' : ''}{fmtK(row.weeklyChange)}
          </span>
          <span className="text-slate-400"> / </span>
          <span style={{ color: Number(accelerationPct) >= 0 ? '#34d399' : '#f87171' }}>
            {Number(accelerationPct) >= 0 ? '+' : ''}{accelerationPct}%
          </span>
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

      {/* TRIGGER SIGNAL */}
      <div className="flex justify-end">
        {signalBadge || <div className="text-slate-600 text-[10px]">—</div>}
      </div>
    </div>
  )
}

// ─── Unified Institutional Matrix ──────────────────────────────────────────────

export function UnifiedPositioningMatrix({ cot: defaultCot }: { cot: COTAsset[] }) {
  const [liveData, setLiveData] = useState<PositioningRow[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set(['indexes']))

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
            <div className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-lg border border-emerald-400/30 bg-emerald-400/8">
              <div className="h-2.5 w-2.5 rounded-full bg-emerald-500 animate-pulse ring-2 ring-emerald-400/50" />
              <span className="text-[9px] font-mono text-emerald-400 font-semibold uppercase tracking-wider">Live Sync</span>
            </div>
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

      {/* Category filter pills */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <span className="text-[10px] font-mono text-slate-500 uppercase tracking-wider">Categories:</span>
        {[
          { key: 'indexes', label: 'Indices', color: '#60a5fa' },
          { key: 'treasuries', label: 'Rates', color: '#a78bfa' },
          { key: 'currency', label: 'FX', color: '#34d399' },
          { key: 'commodity', label: 'Commodities', color: '#fbbf24' },
        ].map(({ key, label, color }) => {
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
          <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Asset</div>
          <div className="text-right text-[10px] font-mono text-slate-400 uppercase tracking-widest">Lev. Funds</div>
          <div className="text-right text-[10px] font-mono text-slate-400 uppercase tracking-widest">Momentum</div>
          <div className="flex items-center gap-1.5">
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
          <div className="flex items-center gap-1.5 justify-end">
            <span className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">Signal</span>
            <Tooltip text="SQUEEZE: extreme + commercials opposed. EXHAUSTION: extreme without commercial inversion.">
              (?)
            </Tooltip>
          </div>
        </div>
      </div>

      {/* Table body */}
      {filtered.length === 0 ? (
        <div className="text-center py-6 text-[11px] text-slate-500 font-mono">No assets in selected categories</div>
      ) : (
        <div className="divide-y divide-slate-800/30">
          {filtered.map((row) => {
            const isExtreme = (row.positioningScale ?? 50) < 10 || (row.positioningScale ?? 50) > 90
            const hasCommericalInversion = true // Simplified for now
            return (
              <UnifiedMatrixRow
                key={row.symbol}
                row={row}
                isExtreme={isExtreme}
                hasCommericalInversion={hasCommericalInversion}
              />
            )
          })}
        </div>
      )}

      {/* Footer explanation */}
      <div className="mt-4 pt-3 border-t border-slate-800/50">
        <p className="text-[10px] text-slate-500 font-mono leading-relaxed">
          <strong>Squeeze Engine:</strong> Identifies moments when leveraged funds hold structural extremes (&gt;90% long or &lt;10%) coinciding with commercial hedger opposition.
          <strong className="text-amber-400/70"> Weeks at Extreme</strong> measure coil duration—prolonged extremes precede explosive reversals.
          <strong className="text-red-400/70"> SQUEEZE signals</strong> fire when positioned contra to commercials; revert when alignment shifts.
        </p>
      </div>
    </div>
  )
}

// ─── CTA Gauge ────────────────────────────────────────────────────────────────

function CTAGauge({ row }: { row: CTAGaugeRow }) {
  const { label, exposure, prevExposure, signal } = row
  const isNegative = exposure < 0
  const pctAbs = Math.abs(exposure)
  const barColor = signal === 'exhaustion_risk' ? '#f87171' : signal === 'bearish' ? '#f87171' : pctAbs > 70 ? '#fbbf24' : '#34d399'
  const delta = exposure - prevExposure
  const deltaColor = delta > 0 ? '#34d399' : delta < 0 ? '#f87171' : '#94a3b8'
  const deltaArrow = delta > 0 ? '▲' : delta < 0 ? '▼' : '→'
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-300 font-mono">{label}</span>
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-mono" style={{ color: deltaColor }}>{deltaArrow} {Math.abs(delta).toFixed(0)}pp</span>
          <span className="font-mono text-sm font-semibold tabular-nums" style={{ color: barColor }}>{exposure > 0 ? '+' : ''}{exposure.toFixed(0)}%</span>
          {signal === 'exhaustion_risk' && (
            <span className="text-[12px] font-mono font-bold px-1.5 py-0.5 rounded border animate-pulse" style={{ color: '#f87171', borderColor: 'rgba(248,113,113,0.4)', backgroundColor: 'rgba(248,113,113,0.12)', boxShadow: '0 0 8px rgba(248,113,113,0.3)' }}>EXHAUSTION</span>
          )}
        </div>
      </div>
      {isNegative ? (
        <div className="relative h-2 bg-[#111827] rounded-full overflow-hidden">
          <div className="absolute left-1/2 top-0 w-px h-full bg-slate-700 z-10" />
          <div className="absolute right-1/2 top-0 h-full rounded-l transition-all" style={{ width: `${pctAbs / 2}%`, backgroundColor: barColor, opacity: 0.8 }} />
        </div>
      ) : (
        <div className="relative h-2 bg-[#111827] rounded-full overflow-hidden">
          {signal === 'exhaustion_risk' && <div className="absolute top-0 w-px h-full bg-red-400/60 z-10" style={{ left: '85%' }} />}
          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pctAbs}%`, backgroundColor: barColor, opacity: 0.85 }} />
        </div>
      )}
      <div className="flex justify-between text-[11px] text-slate-400 font-mono">
        {isNegative ? <><span>−100%</span><span>0%</span><span>+100%</span></> : <><span>0%</span>{signal === 'exhaustion_risk' && <span style={{ color: 'rgba(248,113,113,0.5)' }}>85% ←</span>}<span>100%</span></>}
      </div>
    </div>
  )
}

export function CTAGaugesPanel({ gauges }: { gauges: CTAGaugeRow[] }) {
  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">CTA / Systematic Exposure</h3>
        <span className="text-[12px] font-mono text-slate-400">Est. % of max allocation</span>
      </div>
      <div className="space-y-5">{gauges.map((g) => <CTAGauge key={g.label} row={g} />)}</div>
      <p className="text-[12px] text-slate-400 font-mono border-t border-[#1a2540] pt-3">
        Estimated CTA / trend-follower positioning derived from futures open interest and managed-money flows.
      </p>
    </div>
  )
}

// ─── Ratio Sparkline SVG ──────────────────────────────────────────────────────

function RatioSparkline({ data, color, h = 44 }: { data: number[]; color: string; h?: number }) {
  const uid = useId()
  const gid = `rsg${uid.replace(/:/g, '')}`
  if (data.length < 2) return null
  const min = Math.min(...data), max = Math.max(...data), rng = max - min || 0.01
  const pad = 3
  const pts = data.map((v, i) => ({ x: (i / (data.length - 1)) * 100, y: h - pad - ((v - min) / rng) * (h - pad * 2) }))
  const line = pts.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')
  const area = `M0,${h} ${pts.map((p) => `L${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(' ')} L100,${h} Z`
  return (
    <svg width="100%" height={h} viewBox={`0 0 100 ${h}`} preserveAspectRatio="none" className="overflow-visible">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.20" />
          <stop offset="100%" stopColor={color} stopOpacity="0"    />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
      <circle cx={pts[pts.length-1].x} cy={pts[pts.length-1].y} r="2.5" fill={color} vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

// ─── Bottleneck Side Card ─────────────────────────────────────────────────────

const AACORP_YIELD = 5.0

function diliddoFairPE(g: number, r = 5.0): number {
  return (8.5 + 2 * g) * (4.4 / r)
}

function marginOfSafety(fairPE: number, actualPE: number): number {
  if (fairPE <= 0) return 0
  return ((fairPE - actualPE) / fairPE) * 100
}

function momentumSignal(return30d: number, return90d: number): { label: string; color: string; detail: string } {
  const ann30 = return30d * 4
  const ann90 = return90d * (365 / 90)
  if (ann30 > ann90 * 1.15) return { label: '▲ ACCELERATING', color: '#34d399', detail: '30d outpacing 90d trend' }
  if (ann30 < ann90 * 0.85) return { label: '▼ DECELERATING', color: '#f87171', detail: '30d lagging 90d trend' }
  return { label: '→ STEADY', color: '#94a3b8', detail: 'Consistent momentum' }
}

function BottleneckSideCard({ side, accentColor, isBreadth }: { side: BottleneckSide; accentColor: string; isBreadth: boolean }) {
  const [showAll, setShowAll] = useState(false)
  const displayTickers = showAll ? side.tickers : side.tickers.slice(0, 20)
  const hasMore = side.tickers.length > 20

  const fairPE   = diliddoFairPE(side.epsGrowthPct, AACORP_YIELD)
  const mos      = marginOfSafety(fairPE, side.peRatio)
  const mosColor = mos > 20 ? '#34d399' : mos > 0 ? '#fbbf24' : '#f87171'
  const momentum = momentumSignal(side.return30dPct, side.return90dPct)

  const diliddoLabel = isBreadth ? 'DiLiddo Breadth P/E' : 'DiLiddo Concentration P/E'
  const growthLabel = isBreadth ? 'EPS Growth (RSP)' : 'EPS Growth (Top 10)'

  return (
    <div className="rounded-xl border p-3 space-y-2.5" style={{ borderColor: `${accentColor}22`, backgroundColor: `${accentColor}08` }}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="w-1 h-4 rounded-full shrink-0" style={{ backgroundColor: accentColor }} />
          <span className="text-[10px] font-mono font-semibold uppercase tracking-widest" style={{ color: accentColor }}>{side.label}</span>
        </div>
        <span className="text-[12px] font-mono text-slate-400">{side.tickers.length} names</span>
      </div>

      <div className="flex flex-wrap gap-1">
        {displayTickers.map((t) => (
          <span key={t} className="text-[12px] font-mono px-1.5 py-0.5 rounded border" style={{ color: accentColor, borderColor: `${accentColor}30`, backgroundColor: `${accentColor}10` }}>
            {t}
          </span>
        ))}
        {hasMore && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="text-[12px] font-mono px-1.5 py-0.5 rounded border text-slate-300 border-slate-500/40 hover:text-slate-400 transition-colors"
          >
            {showAll ? '▲ less' : `+${side.tickers.length - 20} more`}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2 pt-1 border-t border-[#1a2540]">
        <div className="rounded-lg border border-[#1a2540] bg-[#080d18] p-2 space-y-0.5">
          <div className="text-[11px] text-slate-400 font-mono uppercase tracking-wider">{diliddoLabel}</div>
          <div className="flex items-baseline gap-1.5 flex-wrap">
            <span className="font-mono text-sm font-bold" style={{ color: mosColor }}>{fairPE.toFixed(1)}×</span>
            <span className="text-[12px] text-slate-300 font-mono">vs {side.peRatio.toFixed(1)}× actual</span>
          </div>
          <div className="flex items-center gap-1">
            <div
              className="text-[12px] font-mono font-bold px-1.5 py-0.5 rounded border"
              style={{ color: mosColor, borderColor: `${mosColor}40`, backgroundColor: `${mosColor}12` }}
            >
              {mos >= 0 ? '+' : ''}{mos.toFixed(1)}% MOS
            </div>
          </div>
          <div className="text-[11px] text-slate-400 font-mono leading-snug">
            (8.5+2×{side.epsGrowthPct.toFixed(0)}%)×(4.4/{AACORP_YIELD})
          </div>
        </div>

        <div className="rounded-lg border border-[#1a2540] bg-[#080d18] p-2 space-y-0.5">
          <div className="text-[11px] text-slate-400 font-mono uppercase tracking-wider">Momentum</div>
          <div className="font-mono text-[11px] font-bold" style={{ color: momentum.color }}>{momentum.label}</div>
          <div className="text-[12px] text-slate-300 font-mono">{momentum.detail}</div>
          <div className="flex items-center gap-2 text-[12px] font-mono mt-1">
            <span className={side.return30dPct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
              30d: {side.return30dPct >= 0 ? '+' : ''}{side.return30dPct.toFixed(1)}%
            </span>
            <span className="text-slate-400">|</span>
            <span className={side.return90dPct >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}>
              90d: {side.return90dPct >= 0 ? '+' : ''}{side.return90dPct.toFixed(1)}%
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between pt-1 border-t border-[#1a2540]">
        <div className="text-[12px] text-slate-400 font-mono">{growthLabel}</div>
        <div className="font-mono text-sm text-emerald-400">+{side.revenueGrowthPct.toFixed(1)}%</div>
      </div>
    </div>
  )
}

// ─── Bottleneck Panel ─────────────────────────────────────────────────────────

function BottleneckPanel({ data }: { data: BottleneckData }) {
  const { breadth, concentration, ratio, ratioTrend, ratioChange30d, sparkline } = data
  const BREADTH_COLOR       = '#10b981'
  const CONCENTRATION_COLOR = '#ef4444'
  const ratioColor = ratioTrend === 'concentration_rising' ? CONCENTRATION_COLOR : ratioTrend === 'breadth_expanding' ? BREADTH_COLOR : '#94a3b8'
  const ratioLabel = ratioTrend === 'concentration_rising' ? '↗ CONCENTRATION RISING' : ratioTrend === 'breadth_expanding' ? '↘ BREADTH EXPANDING' : '→ BALANCED'

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
          Market Breadth vs. Mega-Cap Concentration · Ratio Analysis
        </h3>
        <div className="text-[10px] font-mono font-bold px-2.5 py-1 rounded-lg border" style={{ color: ratioColor, borderColor: `${ratioColor}40`, backgroundColor: `${ratioColor}12` }}>
          {ratioLabel}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <BottleneckSideCard side={breadth} accentColor={BREADTH_COLOR} isBreadth={true} />
        <BottleneckSideCard side={concentration} accentColor={CONCENTRATION_COLOR} isBreadth={false} />
      </div>

      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 rounded-xl border border-[#1a2540] bg-[#080d18] p-4">
        <div className="shrink-0">
          <div className="text-[12px] font-mono text-slate-400 uppercase tracking-widest mb-1">Concentration Ratio</div>
          <div className="flex items-baseline gap-2.5">
            <span className="font-mono text-4xl font-bold tabular-nums" style={{ color: ratioColor }}>
              {ratio.toFixed(2)}<span className="text-2xl">×</span>
            </span>
            <div>
              <div className="font-mono text-xs" style={{ color: ratioChange30d >= 0 ? '#f87171' : '#34d399' }}>
                {ratioChange30d >= 0 ? '+' : ''}{ratioChange30d.toFixed(2)} 30d
              </div>
              <div className="text-[12px] text-slate-400 font-mono">
                {ratio > 2.0 ? 'Narrowing market' : ratio < 1.5 ? 'Broad participation' : 'Moderate concentration'}
              </div>
            </div>
          </div>
        </div>

        <div className="flex-1 min-w-0 w-full">
          <div className="text-[12px] font-mono text-slate-400 mb-1">15-Day Trend (SPY/RSP Proxy)</div>
          <RatioSparkline data={sparkline} color={ratioColor} h={44} />
        </div>

        <div className="shrink-0 max-w-[220px] border-l border-[#1a2540] pl-4 hidden lg:block">
          <div className="text-[12px] font-mono text-slate-400 uppercase tracking-widest mb-1">Thesis</div>
          <p className="text-[10px] text-slate-500 font-mono leading-relaxed">
            Tracking the velocity of capital concentration in top mega-cap equities relative to broader market participation. Watch for sharp ratio spikes as signals of structural exhaustion, and ratio breakdowns as confirmation of healthy, broad-based bull market participation.
          </p>
        </div>
      </div>

      <p className="text-[12px] text-slate-400 font-mono border-t border-[#1a2540] pt-2">
        DiLiddo Fair P/E = (8.5 + 2g) × (4.4/r) · Graham-based formula · g = EPS growth % · r = AAA yield {AACORP_YIELD}% · MOS = Margin of Safety
      </p>
    </div>
  )
}

// ─── Tech Skew Panel with Search ──────────────────────────────────────────────

const DEFAULT_SKEW_TICKERS = ['NVDA', 'MU', 'SNDK']
const ALL_TICKERS = Object.keys(SKEW_DB)

function SkewBar({ row }: { row: SkewTicker }) {
  const { ticker, callPct, putPct, impliedMove, signal } = row
  const signalConfig = {
    upside_demand: { label: 'UPSIDE DEMAND', color: '#38bdf8',  bg: 'rgba(56,189,248,0.12)',  border: 'rgba(56,189,248,0.35)' },
    balanced:      { label: 'BALANCED',      color: '#94a3b8',  bg: 'rgba(148,163,184,0.08)', border: 'rgba(148,163,184,0.25)' },
    hedging:       { label: 'HEDGING',       color: '#fbbf24',  bg: 'rgba(251,191,36,0.12)',  border: 'rgba(251,191,36,0.35)' },
  }[signal]
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm text-slate-100 font-semibold w-12">{ticker}</span>
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
        <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">High-Beta Tech Options Skew</h3>
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
          displaySkew.map((s) => <SkewBar key={s.ticker} row={s} />)
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

      {/* Market Breadth vs Concentration — Secondary Analysis */}
      <BottleneckPanel data={data.bottleneck} />
    </div>
  )
}
