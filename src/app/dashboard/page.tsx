'use client'

import { useState, useEffect, useId, useCallback, useRef, useMemo, memo } from 'react'
import { usePersistState } from '@/lib/hooks/usePersistState'
import { useFredMarkets } from '@/lib/hooks/useFredMarkets'
import { useMarketNodes } from '@/lib/hooks/useMarketNodes'
import { useLiveFutures } from '@/hooks/useLiveFutures'
import { useVolRisk } from '@/hooks/useVolRisk'
import { useAlpacaData } from '@/hooks/useAlpacaData'
import type { AlpacaQuote } from '@/app/api/alpaca/route'
import type { YieldCurveSignal } from '@/lib/market/macroSignals'
import type { MacroSignal } from '@/lib/macro-engine'
import { FedLiquidityMonitor } from '@/components/dashboard/FedLiquidityMonitor'
import { CTAExposureEngine } from '@/components/dashboard/CTAExposureEngine'
import { MarketNodeRow } from '@/components/market/MarketNodeRow'
import type { FredMarketsData, YieldCurveData, DXYData } from '@/types/fred-markets'
import { CrossAssetRatiosPanel } from '@/components/dashboard/CrossAssetRatios'
import {
  InstitutionalFlowsSection,
  UnifiedPositioningMatrix,
  CTAGaugesPanel,
  TechSkewPanel,
  FLOWS_MOCK,
} from '@/components/dashboard/InstitutionalFlowsSection'
import {
  IndexSkewHeads,
  OIWallsGrid,
  INDEX_SKEW_MOCK,
} from '@/components/dashboard/OptionsSection'
import { MacroRiskMatrix, MACRO_RISK_MOCK, type MacroRiskMetrics } from '@/components/dashboard/MacroRiskMatrix'
import { StatusBadge } from '@/components/dashboard/StatusBadge'

// ─── System Health ────────────────────────────────────────────────────────────
//
// Polls /api/circuit-breaker/reset every 15 s to surface 402/502 errors and
// circuit-breaker state to the dashboard header without opening the terminal.

interface CBStatus {
  ibkr:       { open: boolean; remainsMs: number }
  fmp:        { open: boolean; remainsMs: number; skippedSymbols: string[] }
  lastErrors: Array<{ ts: number; source: string; code: number; msg: string }>
}

function useSystemHealth() {
  const [status, setStatus] = useState<CBStatus | null>(null)

  useEffect(() => {
    let cancelled = false

    async function poll() {
      try {
        const res = await fetch('/api/circuit-breaker/reset', { cache: 'no-store' })
        if (res.ok && !cancelled) setStatus(await res.json() as CBStatus)
      } catch { /* network unavailable — keep last known state */ }
    }

    poll()
    const id = setInterval(poll, 15_000)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  const reset = useCallback(async (target: 'all' | 'ibkr' | 'fmp' = 'all') => {
    await fetch('/api/circuit-breaker/reset', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ target }),
    })
    // Re-poll immediately after reset
    const res = await fetch('/api/circuit-breaker/reset', { cache: 'no-store' })
    if (res.ok) setStatus(await res.json() as CBStatus)
  }, [])

  return { status, reset }
}

/**
 * Permanent three-pill provider status row — always visible in the header toolbar.
 * Shows a colour-coded dot + label for IBKR, Alpaca, and FMP so the user never
 * needs to open the terminal to know which feed is live.
 *
 * State logic:
 *   IBKR   🟢 LIVE when ibConnected=true AND CB not open
 *           🟡 CB   when circuit breaker is open
 *           🔴 OFF  when not connected
 *   Alpaca 🟢 LIVE always (proxy is always reachable); 🔴 ERR on recent error
 *   FMP    🟢 OK   when no CB and no skipped symbols
 *           🟡 SKIP when symbols are 402-blacklisted
 *           🔴 CB   when CB is open
 */
function ProviderStatusPills({
  ibConnected,
  status,
}: {
  ibConnected: boolean
  status: CBStatus | null
}) {
  type PillState = 'live' | 'warn' | 'err' | 'unknown'

  const ibkrState: PillState =
    status?.ibkr.open  ? 'warn' :
    ibConnected         ? 'live' : 'err'

  const recentAlpacaErr = status?.lastErrors.find(e => e.source === 'alpaca')
  const alpacaState: PillState = recentAlpacaErr ? 'warn' : 'live'

  const fmpState: PillState =
    status?.fmp.open                    ? 'err'  :
    (status?.fmp.skippedSymbols.length ?? 0) > 0 ? 'warn' : 'live'

  // Design-system token map aligned with StatusBadge: live=green, warn=amber, err=red
  const COLORS: Record<PillState, { dot: string; text: string; border: string; bg: string; glow?: string }> = {
    live:    { dot: '#34d399', text: '#34d399', border: 'rgba(52,211,153,0.40)',  bg: 'rgba(52,211,153,0.10)',  glow: '0 0 6px rgba(52,211,153,0.60)' },
    warn:    { dot: '#fbbf24', text: '#fbbf24', border: 'rgba(251,191,36,0.38)', bg: 'rgba(251,191,36,0.08)' },
    err:     { dot: '#ef4444', text: '#ef4444', border: 'rgba(239,68,68,0.38)',  bg: 'rgba(239,68,68,0.08)'  },
    unknown: { dot: '#475569', text: '#475569', border: 'rgba(71,85,105,0.30)',  bg: 'rgba(71,85,105,0.06)'  },
  }

  const pills: Array<{ key: string; label: string; state: PillState; sub?: string }> = [
    { key: 'ibkr',   label: 'IBKR',   state: ibkrState,   sub: ibkrState === 'warn' ? 'CB' : ibkrState === 'live' ? 'LIVE' : 'OFF'  },
    { key: 'alpaca', label: 'ALPACA', state: alpacaState, sub: alpacaState === 'live' ? 'LIVE' : 'ERR' },
    { key: 'fmp',    label: 'FMP',    state: fmpState,    sub: fmpState === 'err' ? 'CB' : fmpState === 'warn' ? 'SKIP' : 'OK'  },
  ]

  return (
    <div className="hidden md:flex items-center gap-2">
      {pills.map(({ key, label, state, sub }) => {
        const c = COLORS[state]
        const isLive = state === 'live'
        const radius = state === 'err' ? 'rounded-sm' : state === 'warn' ? 'rounded-md' : 'rounded-full'
        return (
          <div
            key={key}
            className={`flex items-center gap-1 px-1.5 py-0.5 border ${radius}`}
            style={{ borderColor: c.border, backgroundColor: c.bg }}
            title={`${label}: ${sub}`}
          >
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0${isLive ? ' animate-pulse' : ''}`}
              style={{ backgroundColor: c.dot, boxShadow: isLive ? c.glow : undefined }}
            />
            <span className="text-[9px] font-mono tracking-widest uppercase" style={{ color: c.text }}>
              {label}
            </span>
            <span className="text-[8px] font-mono" style={{ color: `${c.text}90` }}>
              {sub}
            </span>
          </div>
        )
      })}
    </div>
  )
}

/** Compact error + circuit-breaker strip rendered inside the sticky header. */
function SystemHealthStrip({ status, onReset }: { status: CBStatus | null; onReset: (t: 'all' | 'ibkr' | 'fmp') => void }) {
  if (!status) return null

  const ibkrOpen  = status.ibkr.open
  const fmpOpen   = status.fmp.open
  const lastError = status.lastErrors[0] ?? null
  const anyOpen   = ibkrOpen || fmpOpen

  // Only render the strip when there's something worth showing
  if (!anyOpen && !lastError) return null

  const fmtMs = (ms: number) => ms > 60_000 ? `${Math.ceil(ms / 60_000)}m` : `${Math.ceil(ms / 1_000)}s`

  return (
    <div className="border-t border-[#1a2540] bg-[#05080f] px-8 py-1 flex items-center gap-3 overflow-x-auto">
      {/* Circuit breaker pills */}
      {ibkrOpen && (
        <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-orange-400/90 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-orange-400/80 shrink-0" />
          IBKR CB OPEN · resets in {fmtMs(status.ibkr.remainsMs)}
          <button
            onClick={() => onReset('ibkr')}
            className="ml-1 px-1.5 py-0.5 rounded border border-orange-400/30 hover:border-orange-400/60 text-orange-400/70 hover:text-orange-400 transition-colors"
          >
            Reset
          </button>
        </span>
      )}
      {fmpOpen && (
        <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-amber-400/90 shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-amber-400/80 shrink-0" />
          FMP CB OPEN · resets in {fmtMs(status.fmp.remainsMs)}
          {status.fmp.skippedSymbols.length > 0 && (
            <span className="text-amber-500/60 ml-0.5">
              ({status.fmp.skippedSymbols.join(', ')} skipped)
            </span>
          )}
          <button
            onClick={() => onReset('fmp')}
            className="ml-1 px-1.5 py-0.5 rounded border border-amber-400/30 hover:border-amber-400/60 text-amber-400/70 hover:text-amber-400 transition-colors"
          >
            Reset
          </button>
        </span>
      )}
      {/* Separator */}
      {anyOpen && lastError && (
        <span className="text-[#1a2540] shrink-0">│</span>
      )}
      {/* Last error */}
      {lastError && (
        <span className="inline-flex items-center gap-1.5 text-[10px] font-mono text-slate-500 min-w-0">
          <span
            className="shrink-0 px-1 py-0.5 rounded text-[9px] font-bold"
            style={{
              color:           lastError.code >= 500 ? '#f87171' : lastError.code >= 400 ? '#fbbf24' : '#94a3b8',
              backgroundColor: lastError.code >= 500 ? 'rgba(248,113,113,0.10)' : lastError.code >= 400 ? 'rgba(251,191,36,0.10)' : 'rgba(148,163,184,0.10)',
            }}
          >
            {lastError.code || 'ERR'}
          </span>
          <span className="text-slate-600 uppercase tracking-wider shrink-0">{lastError.source}</span>
          <span className="text-slate-500 truncate">{lastError.msg}</span>
          <span className="text-slate-700 shrink-0">{new Date(lastError.ts).toLocaleTimeString()}</span>
        </span>
      )}
      {/* Full reset (all) — only when something is open */}
      {anyOpen && (
        <button
          onClick={() => onReset('all')}
          className="ml-auto shrink-0 text-[10px] font-mono px-2 py-0.5 rounded border border-[#1a2540] hover:border-slate-600 text-slate-500 hover:text-slate-300 transition-colors"
        >
          Reset All
        </button>
      )}
    </div>
  )
}

// ─── Types ────────────────────────────────────────────────────────────────────

type Timeframe = '1D' | '5D' | '1M' | '3M'

interface Instrument {
  symbol: string
  name: string
  price: number | null
  change: number | null
  changePercent: number | null
  high?: number
  low?: number
  sparkline: number[]
  sparklines?: Record<Timeframe, number[]>
}

interface FuturesInstrument {
  symbol: string
  name: string
  price: number | null
  change: number | null
  changePercent: number | null
  high?: number
  low?: number
  sparklines: Record<Timeframe, number[]>
}

interface VolatilityData {
  vix: Instrument
  vvix: Instrument
  skew: Instrument
  putCallRatio: number
  macroRisk?: MacroRiskMetrics // Extended macro risk metrics
}

interface CrossAssetRatios {
  copperGoldRatio: number
  goldSilverRatio: number
  vixVvixRatio: number
  btcGoldRatio: number
  oilGoldRatio: number
  yield2y10y: number
}

interface MarketData {
  futures?: FuturesInstrument[]
  equities: Instrument[]
  rates: Instrument[]
  fx: Instrument[]
  commodities: Instrument[]
  volatility: VolatilityData
  ratios: CrossAssetRatios
  timestamp: number
  isMarketOpen: boolean
  /** Yield-curve macro signal from FRED DGS10/DGS2 — null when key absent */
  yieldCurveSignal?: YieldCurveSignal | null
  /** Unified liquidity × curve macro signal — always present in API response */
  macroSignal?: MacroSignal | null
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function cn(...classes: (string | undefined | false | null)[]) {
  return classes.filter(Boolean).join(' ')
}

function fmtPrice(price: number | null | undefined): string {
  if (price === null || price === undefined) return '--'
  if (price === 0) return '--'
  if (price > 10000) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (price > 100) return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  if (price > 10) return price.toFixed(2)
  if (price > 1) return price.toFixed(4)
  return price.toFixed(4)
}

function fmtChange(n: number | null | undefined, dec = 2): string {
  if (n === null || n === undefined) return '--'
  return `${n >= 0 ? '+' : ''}${n.toFixed(dec)}`
}

function fmtPct(n: number | null | undefined): string {
  if (n === null || n === undefined) return '--'
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`
}

function changeColor(n: number | null | undefined) {
  if (n === null || n === undefined) return 'text-slate-500/60'
  if (n > 0) return 'text-emerald-400'
  if (n < 0) return 'text-red-400'
  return 'text-[#7ca5a5]'
}

function changeBg(n: number | null | undefined) {
  if (n === null || n === undefined) return 'bg-slate-800/40 text-slate-500/60'
  if (n > 0) return 'bg-emerald-400/10 text-emerald-400'
  if (n < 0) return 'bg-red-400/10 text-red-400'
  return 'bg-slate-700/50 text-slate-400'
}

function calcPeriodReturn(sparkline: number[]): number {
  if (sparkline.length < 2) return 0
  const first = sparkline[0]
  const last = sparkline[sparkline.length - 1]
  if (!first || first === 0) return 0
  return ((last - first) / first) * 100
}

// ─── Sparkline ────────────────────────────────────────────────────────────────

function Sparkline({
  data,
  positive,
  w = 120,
  h = 40,
}: {
  data: number[]
  positive: boolean
  w?: number
  h?: number
}) {
  const uid = useId()
  const gid = `sg${uid.replace(/:/g, '')}`

  if (data.length < 2) {
    return <div style={{ width: w, height: h }} className="rounded bg-slate-800/40" />
  }

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const pad = 2

  const pts = data.map((v, i) => ({
    x: (i / (data.length - 1)) * w,
    y: h - pad - ((v - min) / range) * (h - pad * 2),
  }))

  const line = pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')
  const area = `M${pts[0].x},${h} ${pts.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')} L${pts[pts.length - 1].x},${h} Z`
  const color = positive ? '#34d399' : '#f87171'
  const last = pts[pts.length - 1]

  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last.x} cy={last.y} r="2.5" fill={color} />
    </svg>
  )
}

// ─── Live Clock ───────────────────────────────────────────────────────────────

function LiveClock() {
  // mounted gate prevents SSR/CSR hydration mismatch.
  // The server renders at one wall-clock time, the browser hydrates at
  // another — toLocaleTimeString diverges by 1+ seconds and React panics.
  // We render nothing on the server, then swap in the live clock on the
  // client only after the first effect fires.
  const [mounted, setMounted] = useState(false)
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    setMounted(true)
    const t = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(t)
  }, [])

  if (!mounted) {
    // Stable placeholder of the exact same dimensions to avoid layout shift
    return (
      <div className="text-right hidden sm:block" suppressHydrationWarning>
        <div className="font-mono text-sm text-slate-200 tracking-wider">
          --:--:-- <span className="text-slate-300 text-xs">ET</span>
        </div>
        <div className="text-[10px] text-slate-300">&nbsp;</div>
      </div>
    )
  }

  const time = now.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
  const date = now.toLocaleDateString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <div className="text-right hidden sm:block" suppressHydrationWarning>
      <div className="font-mono text-sm text-slate-200 tracking-wider">
        {time} <span className="text-slate-300 text-xs">ET</span>
      </div>
      <div className="text-[10px] text-slate-300">{date}</div>
    </div>
  )
}

// ─── Timeframe Bar ────────────────────────────────────────────────────────────

function TimeframeBar({ value, onChange }: { value: Timeframe; onChange: (tf: Timeframe) => void }) {
  const tfs: Timeframe[] = ['1D', '5D', '1M', '3M']
  return (
    <div className="flex items-center gap-1 bg-[#080d18] border border-[#1a2540] rounded-lg p-0.5">
      {tfs.map((tf) => (
        <button
          key={tf}
          onClick={() => onChange(tf)}
          className={cn(
            'text-[10px] font-mono px-2.5 py-1 rounded-md transition-colors font-semibold tracking-wider',
            value === tf
              ? 'bg-amber-400/15 text-amber-400 border border-amber-400/30'
              : 'text-slate-300 hover:text-slate-400',
          )}
        >
          {tf}
        </button>
      ))}
    </div>
  )
}

// ─── Ticker Tape ──────────────────────────────────────────────────────────────
//
// 6-token Alpaca-native tape (active while secondary IBKR account is pending):
//   BTC/USD   — Bitcoin spot    → Alpaca /v1beta3/crypto/us/snapshots
//   SPY · QQQ · DIA · IWM      → Alpaca /v2/stocks/snapshots?feed=iex (us_equity)
//   VIXY      — VIX short-term futures ETF (vol proxy)  → same equity endpoint
//
// Routing rules (enforced by /api/alpaca):
//   asset_class=crypto   → /v1beta3/crypto/us/snapshots  (BTC/USD, verified set)
//   asset_class=us_equity → /v2/stocks/snapshots?feed=iex (SPY…VIXY)
//
// BTC/USD uses a SEPARATE useAlpacaData call from all equity symbols.
// Equity change % is session-over-session (q.changePercent from Alpaca).
// BTC change % is computed as pure intraday (price − dailyBar.o) / open × 100
// to avoid overnight-gap distortion on a 24/7 instrument.

// Display labels for each tape token.
const TAPE_LABELS: Record<string, string> = {
  'BTC/USD': 'BITCOIN',
  SPY:       'S&P 500',
  QQQ:       'NASDAQ 100',
  DIA:       'DOW JONES',
  IWM:       'RUSSELL 2K',
  VIXY:      'VIX SHORT-TERM',
}

/** Intraday-only change percent: (price − sessionOpen) / sessionOpen × 100.
 *  Falls back to the hook's `changePercent` when `open` is not yet populated. */
function intradayPct(q: AlpacaQuote): number | null {
  if (q.open != null && q.price !== null && q.open > 0) {
    const dailyChangeDollars = q.price - q.open
    const dailyChangePercent = (dailyChangeDollars / q.open) * 100
    return parseFloat(dailyChangePercent.toFixed(4))
  }
  return q.changePercent   // graceful fallback when session open not yet available
}

interface TapeToken {
  symbol:        string
  label:         string
  price:         number | null
  changePercent: number | null
}

// Module-level constants — stable references that never change across renders.
// Hoisting the animation style out of the render keeps React from rewriting the
// `style` attribute on every data poll, which is what restarts (jumps back) the
// CSS marquee in WebKit/Blink.  The animation now lives entirely in CSS state,
// fully decoupled from the data-driven props below.
const TICKER_ANIM_STYLE: React.CSSProperties = { animation: 'ticker 40s linear infinite' }

// Fixed token order — never reordered, so DOM keys stay 1:1 across refreshes.
const TAPE_ORDER = ['BTC/USD', 'SPY', 'QQQ', 'DIA', 'IWM', 'VIXY'] as const

/**
 * Single tape cell.  Wrapped in React.memo so a data poll only re-renders the
 * cells whose price/changePercent actually changed — the surrounding marquee
 * container (and its running animation) is never touched.  All props are
 * primitives, so the default shallow comparison is exact.
 */
const TapeItem = memo(function TapeItem({
  symbol,
  label,
  price,
  changePercent,
  showSeparator,
}: TapeToken & { showSeparator: boolean }) {
  return (
    <span className="flex items-center gap-1.5 shrink-0">
      {/* Separator dot between repeats */}
      {showSeparator && <span className="text-slate-700 select-none mr-6">·</span>}
      <span className="text-amber-400/80 text-[10px] uppercase tracking-wider font-semibold">
        {label}
        <span className="text-amber-400/45 font-normal"> ({symbol})</span>
      </span>
      <span className={price === null ? 'text-slate-500/50' : 'text-slate-200 tabular-nums'}>
        {fmtPrice(price)}
      </span>
      <span className={cn('text-[10px] tabular-nums font-semibold', changeColor(changePercent))}>
        {fmtPct(changePercent)}
      </span>
    </span>
  )
})

function TickerTape({
  cryptoQuotes,
  etfQuotes,
}: {
  /** BTC/USD snapshot from Alpaca crypto endpoint. Separate call — never
   *  batch with forex-routed symbols (XAUUSD/XAGUSD) or the proxy silently
   *  routes everything through /v1beta1/forex/snapshots. */
  cryptoQuotes: AlpacaQuote[]
  /** SPY · QQQ · DIA · IWM · VIXY from Alpaca us_equity IEX feed. */
  etfQuotes:    AlpacaQuote[]
}) {
  // Build the canonical 6-token list in a fixed order.  Recomputed only when the
  // underlying quote arrays change, but the array LENGTH and ordering are always
  // identical — only the numeric fields inside each token vary.
  const tokens: TapeToken[] = useMemo(() => {
    const cryptoMap = new Map(cryptoQuotes.map(q => [q.symbol, q]))
    const etfMap    = new Map(etfQuotes.map(q  => [q.symbol, q]))

    return TAPE_ORDER.map((sym): TapeToken => {
      if (sym === 'BTC/USD') {
        // BTC/USD — Alpaca crypto feed; intradayPct avoids overnight-gap
        // distortion on a 24/7 asset.
        const btcQ = cryptoMap.get('BTC/USD')
        return {
          symbol:        'BTC/USD',
          label:         TAPE_LABELS['BTC/USD'],
          price:         btcQ?.price ?? null,
          changePercent: btcQ ? intradayPct(btcQ) : null,
        }
      }
      // Equity / ETF — session-over-session Δ% from Alpaca IEX feed.
      const q = etfMap.get(sym)
      return {
        symbol:        sym,
        label:         TAPE_LABELS[sym] ?? sym,
        price:         q?.price         ?? null,
        changePercent: q?.changePercent ?? null,
      }
    })
  }, [cryptoQuotes, etfQuotes])

  // Triple the token list so the tape fills the viewport without a gap even
  // on ultrawide monitors.  Render directly from the fixed-length `tokens`
  // array across three passes — keys are derived from (pass, symbol) so they
  // are stable for the lifetime of the component and never force a remount.
  const PASSES = [0, 1, 2]

  return (
    <div className="border-b border-[#1a2540] bg-[#080c15] overflow-hidden h-7 flex items-center">
      <div
        className="flex items-center gap-8 whitespace-nowrap text-[11px] font-mono px-4"
        style={TICKER_ANIM_STYLE}
      >
        {PASSES.map(pass =>
          tokens.map((token, idx) => (
            <TapeItem
              key={`${pass}-${token.symbol}`}
              symbol={token.symbol}
              label={token.label}
              price={token.price}
              changePercent={token.changePercent}
              showSeparator={pass > 0 && idx === 0}
            />
          )),
        )}
      </div>
    </div>
  )
}

// ─── (EquityCard and FuturesCard removed — index instruments live exclusively in TickerTape) ───

// ─── FRED Live Badge (reusable) ───────────────────────────────────────────────

function FredLiveBadge({
  isLive,
  isCached = false,
  isLoading,
  usingBaseline = false,
  cachedAt,
}: {
  isLive:         boolean
  /** True when the server returned a CACHED (real but not fresh) snapshot */
  isCached?:      boolean
  isLoading?:     boolean
  /** True when both FRED and market API failed and we are showing static baseline values */
  usingBaseline?: boolean
  /** ISO timestamp of the cached fetch, shown in the tooltip */
  cachedAt?:      string
}) {
  if (isLive) {
    return (
      <StatusBadge
        variant="live"
        label="REAL-TIME FRED"
        title="Live data from FRED API"
      />
    )
  }
  if (isCached) {
    return (
      <StatusBadge
        variant="awaiting"
        marker="◐"
        label="CACHED · FRED"
        title={`Real FRED data from server cache${cachedAt ? ` · fetched ${new Date(cachedAt).toLocaleString()}` : ''} — FRED rate-limited or timed out`}
      />
    )
  }
  if (isLoading) {
    return (
      <StatusBadge
        variant="awaiting"
        label="LOADING"
        title="Fetching live yield curve data from FRED…"
      />
    )
  }
  if (usingBaseline) {
    return (
      <StatusBadge
        variant="disconnected"
        label="BASELINE"
        title="Showing estimated 2025 reference values — add FRED_API_KEY to .env.local for live data"
      />
    )
  }
  return (
    <StatusBadge
      variant="disconnected"
      label="DEMO DATA"
      title="Add FRED_API_KEY to .env.local for live data"
    />
  )
}

// ─── Regime Explainer ────────────────────────────────────────────────────────
//
// Small '?' icon rendered inline with the "Yield Curve" heading.
// Hover (or click on mobile) reveals a one-sentence institutional description
// of the current yield-curve regime derived from our macro signal engine.
//
// Regime copy matches the signal-engine definitions in macroSignals.ts exactly
// so the tooltip always agrees with the YieldSignalBadge below the spread card.

const REGIME_COPY: Record<string, string> = {
  BEAR_STEEPENER: 'Inflation fears rising; the 10Y is rising faster than the 2Y, indicating duration risk.',
  BULL_STEEPENER: 'Market pricing in potential Fed cuts; the 2Y is falling faster than the 10Y.',
  BEAR_FLATTENER: 'Tightening financial conditions; the 2Y is rising faster than the 10Y as the market prices in a restrictive Fed policy. Generally negative for growth assets.',
  BULL_FLATTENER: 'Flight-to-safety posturing; the 10Y is falling faster than the 2Y, indicating recession concerns.',
  NEUTRAL:        'No dominant curve driver — balanced macro backdrop, no structural steepening or flattening in force.',
}

function RegimeExplainer({ signal }: { signal: YieldCurveSignal | null | undefined }) {
  const [open, setOpen] = useState(false)

  const regime = signal?.regime ?? null
  const copy   = regime ? (REGIME_COPY[regime] ?? 'No regime data available.') : 'Yield curve signal not yet loaded.'

  return (
    <div className="relative inline-flex items-center">
      <button
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onClick={() => setOpen(v => !v)}
        className="w-4 h-4 rounded-full flex items-center justify-center border transition-colors shrink-0"
        style={{
          borderColor:     open ? 'rgba(251,191,36,0.60)' : 'rgba(100,116,139,0.35)',
          backgroundColor: open ? 'rgba(251,191,36,0.10)' : 'rgba(15,23,42,0.60)',
          color:           open ? '#fbbf24' : '#64748b',
        }}
        aria-label="Explain current yield-curve regime"
      >
        <span className="text-[9px] font-mono font-bold leading-none">?</span>
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-1.5 z-50 w-72 rounded-lg border p-2.5 shadow-xl"
          style={{
            backgroundColor: '#070d1a',
            borderColor:     'rgba(251,191,36,0.30)',
            boxShadow:       '0 8px 24px rgba(0,0,0,0.55)',
          }}
        >
          {/* Regime label */}
          {regime && (
            <div className="text-[9px] font-mono text-amber-400/80 uppercase tracking-widest mb-1.5">
              {regime.replace(/_/g, ' ')}
            </div>
          )}
          {/* One-sentence copy */}
          <p className="text-[11px] font-mono text-slate-200 leading-snug">{copy}</p>
          {/* Velocity shock note */}
          {signal?.velocityShock && (
            <p className="text-[10px] font-mono text-orange-400/80 mt-1.5 leading-snug">
              ⚡ 10Y velocity shock active — intraday duration risk elevated.
            </p>
          )}
          {/* Arrow pointer pointing up */}
          <div
            className="absolute bottom-full left-3 w-0 h-0"
            style={{
              borderLeft:   '5px solid transparent',
              borderRight:  '5px solid transparent',
              borderBottom: '5px solid rgba(251,191,36,0.30)',
            }}
          />
        </div>
      )}
    </div>
  )
}

// ─── Yield Curve Signal Badge ─────────────────────────────────────────────────

/**
 * Renders a compact signal badge in the Yield Curve header.
 * Hovering reveals a tooltip that explains the mathematical reasoning behind
 * the current signal using live 10Y, 2Y, and spread values from FRED.
 *
 * Color scheme:
 *   RISK_ON   → emerald  (#34d399) — supportive macro backdrop
 *   RISK_OFF  → red      (#f87171) — avoid risk assets
 *   CAUTION   → amber    (#fbbf24) — mixed / de-risk
 *   DEFENSIVE → slate    (#94a3b8) — Fed-pivot / flight-to-safety
 *
 * The ⚡ shock icon appears when a 1.5σ velocity shock is detected on the
 * 10Y tenor, signalling elevated intraday duration risk.
 */
function YieldSignalBadge({
  signal,
  rate2y,
  rate10y,
}: {
  signal:   YieldCurveSignal | null | undefined
  /** Resolved 2-Year yield in % (e.g. 4.621) — sourced from FRED DGS2 */
  rate2y?:  number | null
  /** Resolved 10-Year yield in % (e.g. 4.502) — sourced from FRED DGS10 */
  rate10y?: number | null
}) {
  const [hovered, setHovered] = useState(false)

  if (!signal) return null

  const { signalBias, regime, velocityShock, spreadValue } = signal

  // ── Unified style map (RISK_ON included so tooltip border uses same token) ──
  const STYLE: Record<string, { color: string; bg: string; border: string }> = {
    RISK_ON:   { color: '#34d399', bg: 'rgba(52,211,153,0.10)',  border: 'rgba(52,211,153,0.30)'  },
    RISK_OFF:  { color: '#f87171', bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.30)' },
    CAUTION:   { color: '#fbbf24', bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.30)'  },
    DEFENSIVE: { color: '#94a3b8', bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.25)' },
  }
  const { color, bg, border } = STYLE[signalBias] ?? STYLE.DEFENSIVE

  // ── Tooltip text — all values mapped from live FRED state ─────────────────
  // Signal state label: "RISK ON", "RISK OFF", "CAUTION", "DEFENSIVE"
  const signalLabel = signalBias.replace('_', ' ')

  // Regime word: inversion (spread < 0) takes priority over steepen/flatten
  const regimeWord =
    spreadValue < -0.05        ? 'inverted'    :
    regime.includes('STEEPEN') ? 'steepening'  :
    regime.includes('FLATTEN') ? 'flattening'  :
    /* NEUTRAL */                 'transitional'

  // "higher" vs "lower" — reflects actual curve direction in the sentence
  const higherOrLower = spreadValue >= 0 ? 'higher' : 'lower'

  // Formatted rate values from live FRED observations
  const tenY = rate10y != null ? rate10y.toFixed(3) : '—'
  const twoY = rate2y  != null ? rate2y.toFixed(3)  : '—'
  const sprd = spreadValue >= 0
    ? `+${spreadValue.toFixed(2)}`
    : spreadValue.toFixed(2)

  // Final clause adapts to the spread direction so the sentence stays coherent
  // regardless of whether the curve is normal, inverted, or flat
  const lastClause =
    spreadValue > 0.05
      ? 'market participants are pricing in future economic growth and inflation rather than hiding in short-term safe havens.'
      : spreadValue < -0.05
        ? 'bond markets are pricing in recession risk, with investors fleeing to short-duration safe havens over long-term growth assets.'
        : 'the market is in a transitional regime with no dominant directional bias between growth expectations and near-term risk.'

  const tooltipText =
    `The ${signalLabel} signal fires because the yield curve is currently in a ${regimeWord} regime, ` +
    `where long-term yields (10-Year at ${tenY}%) are ${higherOrLower} than short-term yields ` +
    `(2-Year at ${twoY}%). This spread (${sprd}%) indicates that ${lastClause}`

  return (
    <div
      className="relative"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* ── Badge — RISK_ON gets rounded-full pill; others get pulsing-dot pill ── */}
      {signalBias === 'RISK_ON' ? (
        <div
          className="inline-flex items-center gap-1 border border-green-500 bg-green-950/30 text-green-400 px-2.5 py-0.5 rounded-full text-xs font-mono font-semibold tracking-widest uppercase w-fit cursor-default select-none"
        >
          RISK ON
          {velocityShock && (
            <span className="text-[10px] leading-none">⚡</span>
          )}
        </div>
      ) : (
        <div
          className="flex items-center gap-1.5 px-2 py-1 rounded-md border w-fit cursor-default select-none"
          style={{ backgroundColor: bg, borderColor: border }}
        >
          <span
            className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
            style={{ backgroundColor: color, boxShadow: `0 0 5px ${color}` }}
          />
          <span className="text-[10px] font-mono font-bold tracking-widest uppercase leading-none" style={{ color }}>
            {signalBias.replace('_', ' ')}
          </span>
          <span className="text-[9px] font-mono leading-none" style={{ color: 'rgba(148,163,184,0.55)' }}>
            {regime.replace('_', ' ')}
          </span>
          {velocityShock && (
            <span className="text-[10px] leading-none">⚡</span>
          )}
        </div>
      )}

      {/* ── Hover tooltip — absolute-positioned below the badge ────────────── */}
      {hovered && (
        <div
          className="absolute right-0 top-full mt-2 z-50 w-80 rounded-xl border p-3.5 shadow-2xl"
          style={{
            backgroundColor: '#070d1a',
            borderColor:     border,
            boxShadow:       `0 16px 48px rgba(0,0,0,0.70), 0 0 0 1px ${border}`,
          }}
        >
          {/* ── Header row: signal label + regime chip ── */}
          <div className="flex items-center justify-between mb-2.5 gap-2">
            <span
              className="text-[10px] font-mono font-bold tracking-widest uppercase leading-none"
              style={{ color }}
            >
              {signalLabel}
            </span>
            <span
              className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded border leading-none shrink-0"
              style={{
                color:           `${color}bb`,
                borderColor:     border,
                backgroundColor: bg,
              }}
            >
              {regimeWord}
            </span>
          </div>

          {/* ── Explanation body — fully dynamic from live FRED state ── */}
          <p
            className="text-[11px] font-mono leading-relaxed"
            style={{ color: 'rgba(203,213,225,0.82)' }}
          >
            {tooltipText}
          </p>

          {/* ── Velocity shock footnote (conditional) ── */}
          {velocityShock && (
            <div
              className="flex items-center gap-1.5 mt-2.5 pt-2.5 border-t"
              style={{ borderColor: 'rgba(251,191,36,0.18)' }}
            >
              <span className="text-[10px] leading-none shrink-0">⚡</span>
              <span
                className="text-[10px] font-mono leading-snug"
                style={{ color: 'rgba(251,191,36,0.65)' }}
              >
                10Y velocity shock active — intraday duration risk elevated.
              </span>
            </div>
          )}

          {/* ── Arrow pointer — anchored to the top-right, above the tooltip ── */}
          <div
            className="absolute right-3 bottom-full w-0 h-0"
            style={{
              borderLeft:   '5px solid transparent',
              borderRight:  '5px solid transparent',
              borderBottom: `5px solid ${border}`,
            }}
          />
        </div>
      )}
    </div>
  )
}

// ─── Yield Curve Baseline ────────────────────────────────────────────────────
//
// Indicative mid-2025 US Treasury yield levels used as the last-resort
// display fallback when both FRED and the /api/market rate feed are
// unavailable.  Displayed with a ■ BASELINE badge so users know to
// reconnect their FRED key for authoritative live data.
//
// These are not financial advice — purely cosmetic placeholders that prevent
// blank '—' dashes while the feeds are initialising or temporarily offline.
const YIELD_BASELINE = {
  r2y:  3.88,
  r10y: 4.40,
  rows: [
    { label: '3M',  rate: 4.30, seriesId: 'DTB3',  maturity:  0.25 },
    { label: '2Y',  rate: 3.88, seriesId: 'DGS2',  maturity:  2    },
    { label: '5Y',  rate: 4.05, seriesId: 'DGS5',  maturity:  5    },
    { label: '10Y', rate: 4.40, seriesId: 'DGS10', maturity: 10    },
    { label: '30Y', rate: 4.95, seriesId: 'DGS30', maturity: 30    },
  ],
} as const

// ─── Yield Curve ──────────────────────────────────────────────────────────────

function YieldCurveSection({
  rates,
  fredData,
  isLoading,
  yieldCurveSignal,
}: {
  rates:             Instrument[]
  fredData?:         YieldCurveData | null
  isLoading?:        boolean
  yieldCurveSignal?: YieldCurveSignal | null
}) {
  const isLive   = fredData?.meta.status === 'AUTHENTICATED'
  const isCached = fredData?.meta.status === 'CACHED'

  // ── Last-known-good cache ───────────────────────────────────────────────────
  // Refs mutated synchronously during render — no useEffect needed.
  // Survives FRED re-fetch windows (~15 min) so the UI never blanks out.
  const prevR2y  = useRef<number | null>(null)
  const prevR10y = useRef<number | null>(null)

  // Resolved FRED / market-API points
  const p2y  = fredData?.points.find(p => p.seriesId === 'DGS2')
  const p10y = fredData?.points.find(p => p.seriesId === 'DGS10')

  // /api/market has no 2-Year entry — 2Y comes exclusively from FRED (DGS2).
  // 10-Year falls back to ^TNX when FRED is offline.
  const rate10y_ = p10y ?? rates.find(r => r.symbol === '^TNX')

  // Raw live readings (null when the feed hasn't resolved yet)
  const r2yLive  = p2y  ? p2y.rate   : null
  const r10yLive = p10y ? p10y.rate  : ((rate10y_ as Instrument | undefined)?.price ?? null)

  // Warm the cache every render when live values are present
  if (r2yLive  != null) prevR2y.current  = r2yLive
  if (r10yLive != null) prevR10y.current = r10yLive

  // Final display values: live → cached → static baseline (never blank)
  const r2yVal  = r2yLive  ?? prevR2y.current  ?? YIELD_BASELINE.r2y
  const r10yVal = r10yLive ?? prevR10y.current ?? YIELD_BASELINE.r10y

  // True only when we have no live data AND no cached data for 2Y
  const usingBaseline = r2yLive == null && prevR2y.current == null

  const spreadNum = fredData
    ? fredData.spread2y10y
    : r10yVal - r2yVal

  const spreadChg = fredData ? fredData.spread2y10yChange : null
  const inverted  = spreadNum != null && spreadNum < 0

  const spreadColor = spreadNum == null ? '#94a3b8' : inverted ? '#f87171' : '#34d399'

  /**
   * Shared Δ1d color for any spread-change field.
   * Both the 10Y-2Y and 10Y-3M cards call this same function so they are
   * guaranteed to render identically for equivalent delta values:
   *   null / undefined → muted slate  (#94a3b8)
   *   delta >= 0       → emerald      (#34d399)
   *   delta <  0       → red          (#f87171)
   *
   * The previous context-aware logic returned amber (#fbbf24) when the spread
   * level was positive but the daily change was negative, causing the 10Y-3M
   * card to render orange while the 10Y-2Y card rendered red — inconsistent UX.
   * Standard financial convention: negative delta = red, regardless of the
   * current spread level.
   */
  const spreadDeltaColor = (delta: number | null | undefined): string => {
    if (delta == null) return '#94a3b8'
    return delta >= 0 ? '#34d399' : '#f87171'
  }

  // ── Full curve rows ──────────────────────────────────────────────────────────
  // Priority: FRED (all 5 tenors with full metadata)
  //         → market API (3M / 5Y / 10Y / 30Y) + 2Y injected from cache/baseline
  //         → full static baseline (all 5 tenors) when market API also has no data
  const curveRows = fredData
    ? fredData.points
    : (() => {
        // /api/market gives: 3M (^IRX), 5Y (^FVX), 10Y (^TNX), 30Y (^TYX) — no 2Y
        const mkRows = rates.slice(0, 4).map(r => ({
          label:     r.name.replace(/-Year.*/,'Y').replace('3-Month','3M'),
          rate:      r.price     ?? null,
          seriesId:  r.symbol,
          change:    r.change    ?? null,
          changeBps: (r.change   ?? 0) * 100,
          maturity:  0,
          prevRate:  r.price     ?? null,
          date:      '—',
          high52w:   undefined as number | undefined,
          low52w:    undefined as number | undefined,
        }))

        // Inject 2Y between 3M (index 0) and 5Y using the cached/baseline value
        const r2yFallback = prevR2y.current ?? YIELD_BASELINE.r2y
        const twoYRow = {
          label: '2Y', rate: r2yFallback, seriesId: 'DGS2',
          change: null, changeBps: 0, maturity: 2,
          prevRate: r2yFallback, date: '—',
          high52w: undefined as number | undefined,
          low52w:  undefined as number | undefined,
        }

        if (mkRows.length > 0) {
          // [3M, 2Y, 5Y, 10Y, 30Y]
          return [mkRows[0], twoYRow, ...mkRows.slice(1)]
        }

        // Full static baseline when even the market API has no data
        return YIELD_BASELINE.rows.map(b => ({
          label: b.label, rate: b.rate, seriesId: b.seriesId,
          change: null, changeBps: 0, maturity: b.maturity,
          prevRate: b.rate, date: '—',
          high52w: undefined as number | undefined,
          low52w:  undefined as number | undefined,
        }))
      })()

  // ── Sparkline geometry (shared by the curve-shape panel below) ─────────────
  const sparkRates = curveRows
    .map(p => ('rate' in p ? (p as typeof curveRows[0]).rate : null))
    .filter((r): r is number => r != null)

  const sparkPts = (() => {
    if (sparkRates.length < 2) return null
    const minR = Math.min(...sparkRates)
    const maxR = Math.max(...sparkRates)
    const rng  = maxR - minR || 0.01
    const W = 300, H = 52, padY = 6
    const pts = sparkRates.map((r, i) => ({
      x: (i / (sparkRates.length - 1)) * W,
      y: (H - padY) - ((r - minR) / rng) * (H - padY * 2),
    }))
    return { pts, W, H }
  })()

  return (
    <div
      className="border rounded-2xl p-4 flex flex-col min-h-full transition-colors duration-300"
      style={{
        backgroundColor: '#0c1221',
        borderColor: isLive ? '#34d39928' : '#1a2540',
      }}
    >
      {/* ══ HEADER ════════════════════════════════════════════════════════════════
          Left:  section label + regime ? explainer
          Right: signal bias badge (CAUTION · BEAR FLATTENER) + obs date + FRED badge
          The signal badge acts as the section's regime label, top-right corner.  */}
      <div className="flex items-start justify-between flex-shrink-0 pb-3 border-b border-[#1a2540] gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest shrink-0">
            Yield Curve
          </h3>
          <RegimeExplainer signal={yieldCurveSignal} />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <YieldSignalBadge signal={yieldCurveSignal} rate2y={r2yVal} rate10y={r10yVal} />
          {(isLive || isCached) && fredData && (
            <span className="text-[9px] font-mono text-slate-300 shrink-0">
              obs. {fredData.observationDate}
            </span>
          )}
          <FredLiveBadge
            isLive={isLive}
            isCached={isCached}
            isLoading={isLoading}
            usingBaseline={usingBaseline}
            cachedAt={isCached ? fredData?.meta.timestamp : undefined}
          />
        </div>
      </div>

      {/* ── Context line — one sentence placing the indicator in macro context ──
          Dynamic: changes with the live spread state so it always reads as a
          real-time observation rather than static boilerplate.                  */}
      <p className="text-[11px] font-mono text-slate-300 pt-2.5 pb-0.5 flex-shrink-0 leading-snug">
        {spreadNum === null
          ? 'Measures the term premium between long and short-dated Treasuries — a leading indicator for economic cycles and Fed policy shifts.'
          : spreadNum < -0.1
            ? `Spread inverted at ${spreadNum.toFixed(2)}% — bond markets are historically signalling recession risk 12–18 months ahead.`
            : spreadNum < 0.1
              ? `Spread near-flat at ${spreadNum >= 0 ? '+' : ''}${spreadNum.toFixed(2)}% — transitional regime; watch for a directional break toward steepening or inversion.`
              : spreadNum < 0.75
                ? `Positive term premium (+${spreadNum.toFixed(2)}%) — markets pricing long-run growth over short-term risk; curve normalising.`
                : `Curve steepening (+${spreadNum.toFixed(2)}%) — strong long-run growth expectations or inflation being priced into the long end.`
        }
      </p>

      {/* ══ SPREADS (compact inline row) ══════════════════════════════════════════ */}
      <div className="flex gap-3 pt-3 flex-shrink-0">
        {/* 10Y-2Y */}
        <div className="flex-1 bg-[#070d1a] border border-[#1a2540] rounded-lg px-3 py-2 flex items-center justify-between">
          <div>
            <div className="text-[9px] font-mono text-slate-300 uppercase tracking-wider mb-0.5">
              10Y – 2Y
            </div>
            <div
              className="text-sm font-mono font-bold tabular-nums leading-none"
              style={{ color: spreadColor }}
            >
              {spreadNum != null
                ? `${spreadNum >= 0 ? '+' : ''}${spreadNum.toFixed(3)}%`
                : '—'}
            </div>
            {inverted && (
              <div className="text-[8px] text-red-400 font-mono mt-0.5 tracking-wide">
                INVERTED
              </div>
            )}
          </div>
          {spreadChg != null && (
            <div className="text-right">
              <div className="text-[8px] font-mono text-slate-300">Δ 1d</div>
              <div
                className="text-[10px] font-mono tabular-nums"
                style={{ color: spreadDeltaColor(spreadChg) }}
              >
                {spreadChg >= 0 ? '+' : ''}{spreadChg.toFixed(3)}pp
              </div>
            </div>
          )}
        </div>

        {/* 10Y-3M */}
        {fredData?.spread10y3m != null && (
          <div className="flex-1 bg-[#070d1a] border border-[#1a2540] rounded-lg px-3 py-2 flex items-center justify-between">
            <div>
              <div className="text-[9px] font-mono text-slate-300 uppercase tracking-wider mb-0.5">
                10Y – 3M
              </div>
              <div
                className="text-sm font-mono font-bold tabular-nums leading-none"
                style={{ color: fredData.spread10y3m >= 0 ? '#34d399' : '#f87171' }}
              >
                {fredData.spread10y3m >= 0 ? '+' : ''}{fredData.spread10y3m.toFixed(3)}%
              </div>
              <div className="text-[8px] font-mono text-slate-300 mt-0.5">Banking</div>
            </div>
            {fredData.spread10y3mChange != null && (
              <div className="text-right">
                <div className="text-[8px] font-mono text-slate-300">Δ 1d</div>
                <div
                  className="text-[10px] font-mono tabular-nums"
                  style={{ color: spreadDeltaColor(fredData.spread10y3mChange) }}
                >
                  {fredData.spread10y3mChange >= 0 ? '+' : ''}
                  {fredData.spread10y3mChange.toFixed(3)}pp
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ══ MATURITY MATRIX (expanded hero row) ═══════════════════════════════════
          Now the primary visual anchor of the card (the old 2Y/10Y hero blocks
          were removed).  Taller padding + large tabular yields make this row the
          dominant element; the sparkline below absorbs all remaining height.     */}
      <div className="flex gap-2 mt-3 flex-shrink-0">
        {curveRows.map(p => {
          const ch = ('change' in p ? (p as typeof curveRows[0]).change : 0) ?? 0
          return (
            <div
              key={p.seriesId}
              className="flex-1 bg-[#070c18] rounded-lg px-2 py-4 border border-[#1a2540]/60
                         flex flex-col items-center gap-2"
            >
              {/* Maturity label — prominent, high-contrast */}
              <div className="text-[12px] text-slate-300 font-mono font-semibold leading-none tracking-widest uppercase">
                {p.label}
              </div>
              {/* Rate — large hero numeral */}
              <div className="flex items-baseline gap-0.5 leading-none">
                <span className="text-2xl xl:text-3xl font-mono font-bold text-white tabular-nums tracking-tight">
                  {'rate' in p ? ((p as typeof curveRows[0]).rate ?? 0).toFixed(2) : '—'}
                </span>
                <span className="text-[13px] font-mono text-slate-400">%</span>
              </div>
              {/* Daily change */}
              {isLive && (
                <div
                  className={`text-[11px] font-mono tabular-nums leading-none ${
                    ch >= 0 ? 'text-red-400' : 'text-emerald-400'
                  }`}
                >
                  {ch >= 0 ? '+' : ''}{ch.toFixed(2)}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ══ CURVE SHAPE SPARKLINE ═════════════════════════════════════════════════
          Last element in the flex-col — flex-1 + min-h-[120px] makes it absorb
          all remaining card height. The inner SVG is flex-1 + h-full so it
          stretches to fill every pixel of the panel, leaving no gap.             */}
      {sparkPts && (
        <div className="flex-1 min-h-[120px] mt-3 bg-[#060b15] border border-[#1a2540]/60
                        rounded-lg px-3 pt-2 pb-2 flex flex-col">
          {/* Panel header */}
          <div className="flex items-center justify-between mb-1.5 flex-shrink-0">
            <span className="text-[8px] font-mono text-slate-300 uppercase tracking-[0.15em]">
              Curve Shape
            </span>
            <span className="text-[8px] font-mono text-slate-300 tabular-nums">
              {sparkRates[0]?.toFixed(2)}%&nbsp;→&nbsp;
              {sparkRates[sparkRates.length - 1]?.toFixed(2)}%
            </span>
          </div>
          {/* SVG — flex-1 + w-full fills the remaining panel height */}
          <svg
            viewBox={`0 0 ${sparkPts.W} ${sparkPts.H}`}
            preserveAspectRatio="none"
            className="w-full flex-1"
            style={{ display: 'block', minHeight: 0 }}
          >
            <defs>
              <linearGradient id="yc-spark-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%"   stopColor={spreadColor} stopOpacity="0.22" />
                <stop offset="100%" stopColor={spreadColor} stopOpacity="0.02" />
              </linearGradient>
            </defs>
            <path
              d={
                `M${sparkPts.pts[0].x.toFixed(1)},${sparkPts.H} ` +
                sparkPts.pts.map(p => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ') +
                ` L${sparkPts.pts[sparkPts.pts.length - 1].x.toFixed(1)},${sparkPts.H} Z`
              }
              fill="url(#yc-spark-fill)"
            />
            <polyline
              points={sparkPts.pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ')}
              fill="none"
              stroke={spreadColor}
              strokeWidth="1.5"
              strokeLinejoin="round"
              strokeLinecap="round"
              opacity="0.80"
            />
            {sparkPts.pts.map((pt, i) => (
              <circle key={i} cx={pt.x} cy={pt.y} r="2.5" fill={spreadColor} opacity="0.60" />
            ))}
          </svg>
        </div>
      )}
    </div>
  )
}

// ─── (CommodityTable removed — live commodity nodes rendered via MarketNodeRow from useMarketNodes hook) ───

// ─── VIX Regime Gauge ────────────────────────────────────────────────────────

function VixGauge({ vix }: { vix: Instrument }) {
  const { price, change, changePercent } = vix
  const regime = price === null
    ? { label: '——', color: '#64748b', bg: '#64748b20' }
    : price < 15 ? { label: 'RISK ON', color: '#34d399', bg: '#34d39920' }
    : price < 20 ? { label: 'LOW VOL', color: '#fbbf24', bg: '#fbbf2420' }
    : price < 28 ? { label: 'CAUTION', color: '#f97316', bg: '#f9731620' }
    : { label: 'RISK OFF', color: '#f87171', bg: '#f8717120' }

  const pct = price !== null ? Math.min(100, (price / 45) * 100) : 0

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-[10px] text-slate-300 font-mono uppercase tracking-wider">VIX</span>
        <span
          className="text-[10px] font-mono px-2 py-0.5 rounded border font-semibold tracking-wider"
          style={{ color: regime.color, backgroundColor: regime.bg, borderColor: `${regime.color}30` }}
        >
          {regime.label}
        </span>
      </div>
      <div className={cn('font-mono text-3xl font-semibold tabular-nums leading-none mb-1', price === null ? 'text-slate-500/60' : 'text-slate-100')}>
        {price === null ? '--' : price.toFixed(2)}
      </div>
      <div className={cn('text-xs font-mono mb-3', changeColor(change))}>
        {fmtChange(change)} ({fmtPct(changePercent)})
      </div>
      <div className="space-y-1">
        <div className="h-2 bg-[#111827] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${pct}%`, backgroundColor: regime.color }}
          />
        </div>
        <div className="flex justify-between text-[12px] text-slate-400 font-mono">
          <span>0</span>
          <span>15</span>
          <span>28</span>
          <span>45+</span>
        </div>
      </div>
    </div>
  )
}

// ─── Put/Call Ratio ───────────────────────────────────────────────────────────

function PutCallGauge({ ratio }: { ratio: number }) {
  const sentiment =
    ratio > 1.1 ? { label: 'BEARISH', color: '#f87171' }
    : ratio > 0.85 ? { label: 'NEUTRAL', color: '#94a3b8' }
    : ratio > 0.7 ? { label: 'NEUTRAL', color: '#94a3b8' }
    : { label: 'BULLISH', color: '#34d399' }

  const pct = Math.min(100, (ratio / 1.6) * 100)

  return (
    <div>
      <div className="text-[10px] text-slate-300 font-mono uppercase tracking-wider mb-1">Put/Call Ratio</div>
      <div className="font-mono text-3xl font-semibold tabular-nums leading-none mb-1" style={{ color: sentiment.color }}>
        {ratio.toFixed(2)}
      </div>
      <div className="text-xs font-mono mb-3" style={{ color: sentiment.color }}>
        {sentiment.label}
      </div>
      <div className="space-y-1">
        <div className="h-2 bg-[#111827] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-700"
            style={{ width: `${pct}%`, backgroundColor: sentiment.color }}
          />
        </div>
        <div className="flex justify-between text-[12px] text-slate-400 font-mono">
          <span>Bullish 0.5</span>
          <span>Neutral 0.85</span>
          <span>Bearish 1.2+</span>
        </div>
      </div>
    </div>
  )
}

// ─── Risk Section ─────────────────────────────────────────────────────────────

function RiskSection({ vol }: { vol: VolatilityData }) {
  const { vix, vvix, skew, putCallRatio } = vol

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4">
      <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest mb-4">
        Risk &amp; Volatility Indicators
      </h3>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
        <VixGauge vix={vix} />

        <div>
          <div className="text-[10px] text-slate-300 font-mono uppercase tracking-wider mb-1">VVIX</div>
          <div className={cn('font-mono text-3xl font-semibold tabular-nums leading-none mb-1', vvix.price === null ? 'text-slate-500/60' : 'text-slate-100')}>
            {vvix.price === null ? '--' : vvix.price.toFixed(1)}
          </div>
          <div className={cn('text-xs font-mono mb-2', changeColor(vvix.change))}>
            {fmtChange(vvix.change, 1)} ({fmtPct(vvix.changePercent)})
          </div>
          <div className="text-[10px] text-slate-400 leading-snug">
            Volatility of VIX.
            <br />
            {vvix.price !== null && vvix.price > 100 ? '⚠ Elevated VIX uncertainty' : 'Normal range'}
          </div>
        </div>

        <div>
          <div className="text-[10px] text-slate-300 font-mono uppercase tracking-wider mb-1">CBOE SKEW</div>
          <div
            className={cn(
              'font-mono text-3xl font-semibold tabular-nums leading-none mb-1',
              skew.price === null ? 'text-slate-500/60' : skew.price > 145 ? 'text-orange-400' : 'text-slate-100'
            )}
          >
            {skew.price === null ? '--' : skew.price.toFixed(1)}
          </div>
          <div className={cn('text-xs font-mono mb-2', changeColor(skew.change))}>
            {fmtChange(skew.change, 1)} ({fmtPct(skew.changePercent)})
          </div>
          <div className="text-[10px] text-slate-400 leading-snug">
            Tail risk premium.
            <br />
            {skew.price === null ? '--' : skew.price > 145 ? '⚠ Elevated left-tail risk' : skew.price < 120 ? 'Compressed tails' : 'Normal skew'}
          </div>
        </div>

        <PutCallGauge ratio={putCallRatio} />
      </div>
    </div>
  )
}

// ─── Waiting-for-sync badge ───────────────────────────────────────────────────
// Small inline pill rendered in every MonitoringFooter section header.
// Communicates clearly that the section is waiting for overnight IBKR bar sync
// rather than appearing broken or empty.

function WaitingBadge() {
  return (
    <StatusBadge
      variant="awaiting"
      label="AWAITING SYNC"
      title="Waiting for IBKR overnight historical bar sync. Live price feed active via Alpaca ticker tape."
    />
  )
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

function Pulse({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded bg-slate-800/50', className)} />
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 space-y-3">
            <Pulse className="h-3 w-20" />
            <Pulse className="h-7 w-32" />
            <Pulse className="h-3 w-16" />
            <Pulse className="h-9 w-full" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 space-y-3">
            <Pulse className="h-3 w-24" />
            {[0, 1, 2, 3].map((j) => <Pulse key={j} className="h-5 w-full" />)}
          </div>
        ))}
      </div>
      <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4 space-y-3">
        <Pulse className="h-3 w-32" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-6">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2">
              <Pulse className="h-3 w-16" />
              <Pulse className="h-8 w-24" />
              <Pulse className="h-3 w-20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const [data, setData] = useState<MarketData | null>(null)
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null)
  const [usingFallback, setUsingFallback] = useState(false)
  const [commTF,            setCommTF]            = usePersistState<Timeframe>('cm.commTF',            '1D')
  const [selectedOIAssets,  setSelectedOIAssets]  = usePersistState<string[]>('cm.selectedOIAssets',  ['SPX', 'NDX'])

  // Live FRED yields (15-min refresh – FRED daily series)
  const {
    data:       fredMarkets,
    isLoading:  fredLoading,
  } = useFredMarkets()

  // Market Abstraction Layer: Commodities with automatic polling and liveness indicators
  const { data: commodityData, isLoading: commodityLoading } = useMarketNodes('commodity', 300_000, commTF)

  // Live IBKR futures feed — polls the Python ib_server.py bridge every 2 s.
  // When connected: overrides the Alpaca futures grid with sub-second IBKR ticks.
  // When disconnected: falls back silently to Alpaca data; no UI disruption.
  const { futures: ibFutures, connected: ibConnected } = useLiveFutures()

  // System health: circuit-breaker state + last errors — polls every 15 s.
  const { status: sysHealth, reset: resetCB } = useSystemHealth()

  // Real-time volatility & risk indicators — polls /api/vol-risk every 60 s.
  // Returns null until first successful fetch; falls back to MACRO_RISK_MOCK.
  const volRisk = useVolRisk()

  // ── Ticker tape data sources ─────────────────────────────────────────────────
  // Two separate hooks — routing diverges at /api/alpaca:
  //   crypto   → /v1beta3/crypto/us/snapshots  (BTC/USD)
  //   us_equity → /v2/stocks/snapshots?feed=iex (SPY … VIXY)
  //
  // BTC/USD is intentionally isolated from any forex-routed symbols (XAUUSD,
  // XAGUSD).  If they shared a call the proxy's hasForex promotion would route
  // the entire batch through /v1beta1/forex/snapshots and BTC/USD would 404.

  const { quotes: cryptoQuotes } = useAlpacaData({
    symbols:      ['BTC/USD'],
    assetClass:   'crypto',
    type:         'snapshot',
    pollInterval: 300_000,
  })

  // SPY · QQQ · DIA · IWM · VIXY — standard liquid US equity / ETF proxies.
  // VIXY fills the vol-proxy slot while the secondary IBKR account (CL futures)
  // is pending approval.  All five share a single IEX snapshot request.
  const { quotes: etfQuotes, quoteMap: etfQuoteMap } = useAlpacaData({
    symbols:      ['SPY', 'QQQ', 'DIA', 'IWM', 'VIXY'],
    assetClass:   'us_equity',
    type:         'snapshot',
    pollInterval: 300_000,
  })

  // Alpaca-backed ETF fallbacks for FMP index symbols.
  // When FMP returns 402 (subscription-walled) for ^NDX / ^GSPC, pass the live
  // ETF prices instead.  CrossAssetRatiosPanel applies the NDX_SPX_SCALAR (4.10)
  // internally, so these are raw share-price levels (QQQ ≈ $480, SPY ≈ $530).
  // The panel prefers real ^NDX/^GSPC when non-null, so there is zero regression
  // when FMP is healthy.
  const alpacaQqq = etfQuoteMap.get('QQQ')?.price ?? null
  const alpacaSpy = etfQuoteMap.get('SPY')?.price ?? null

  const load = useCallback(async () => {
    try {
      const marketRes = await fetch('/api/market', { cache: 'no-store' })
      if (!marketRes.ok) throw new Error('market fetch failed')
      const marketJson: MarketData = await marketRes.json()
      setData(marketJson)
      setLastUpdate(new Date())
      setUsingFallback(!marketJson.isMarketOpen && marketJson.equities[0]?.price === 5847.32)
    } catch {
      setUsingFallback(true)
    }
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 300_000)
    return () => clearInterval(t)
  }, [load])

  return (
    <div className="min-h-screen bg-[#070b14] text-slate-200" style={{ fontFamily: 'var(--font-geist-sans)' }}>
      <style>{`
        @keyframes ticker {
          from { transform: translateX(0) }
          to   { transform: translateX(-50%) }
        }
      `}</style>

      {/* ── Header ── */}
      <header className="sticky top-0 z-40 bg-[#070b14]/95 backdrop-blur-sm border-b border-[#1a2540]">
        <div className="max-w-[1920px] mx-auto px-8 py-3 flex items-center justify-between gap-4">
          {/* ─ Left: wordmark + market status ─ */}
          <div className="flex items-center gap-3">
            <div
              className={cn('w-2 h-2 rounded-full shrink-0', data?.isMarketOpen ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600')}
              style={data?.isMarketOpen ? { boxShadow: '0 0 8px #34d399' } : undefined}
            />
            <h1
              className="font-mono text-base font-bold tracking-[0.18em] uppercase"
              style={{ fontFamily: 'var(--font-geist-mono)' }}
            >
              <span className="text-slate-100">CROSSED</span>
              <span className="text-amber-400 ml-2">MATRIX</span>
            </h1>
            {data && (
              <span
                className={cn(
                  'hidden sm:inline text-[10px] font-mono px-2 py-0.5 rounded-md border tracking-widest uppercase',
                  data.isMarketOpen
                    ? 'text-emerald-400 border-emerald-400/30 bg-emerald-400/10'
                    : 'text-slate-300 border-slate-700 bg-slate-800/40'
                )}
              >
                {data.isMarketOpen ? 'NYSE Open' : 'Market Closed'}
              </span>
            )}
          </div>

          {/* ─ Right: utility toolbar ─ */}
          <div className="flex items-center gap-3">
            {lastUpdate && (
              <span className="hidden md:block text-[10px] text-slate-400 font-mono">
                Refreshed {lastUpdate.toLocaleTimeString()}
              </span>
            )}
            {usingFallback && (
              <span className="text-[10px] text-amber-500/70 font-mono hidden md:block">demo data</span>
            )}
            <ProviderStatusPills ibConnected={ibConnected} status={sysHealth} />
            <LiveClock />

            <button
              onClick={load}
              className="text-[11px] font-mono text-slate-300 hover:text-slate-400 border border-[#1a2540] hover:border-slate-600 px-2 py-1 rounded-md transition-colors"
              aria-label="Refresh market data"
            >
              ↻
            </button>
          </div>
        </div>

        {/* ── Live market-data ticker — directly under the CROSSED MATRIX
             wordmark and above the system-health / FMP error strip. */}
        <TickerTape
          cryptoQuotes={cryptoQuotes ?? []}
          etfQuotes={etfQuotes ?? []}
        />

        {/* ── Last Error / Circuit-Breaker strip — hidden when everything is healthy ── */}
        <SystemHealthStrip status={sysHealth} onReset={resetCB} />
      </header>

      {/* ── Main ── */}
      <main className="max-w-[1920px] mx-auto px-8 py-4 space-y-3">
        {/* ── Systematic CTA Exposure Engine — promoted to the top so it renders
             above the live market-data ticker banner.  Self-fetching, so it can
             render outside the `data` gate.  (Was previously in the monitoring
             footer below the fold.) */}
        <CTAExposureEngine />

        {!data ? (
          <DashboardSkeleton />
        ) : (
          <>
            {/* ══════════════════════════════════════════════════════════════
                ▸ LIVE SECTION
                  Real-time data: FRED · Alpaca · CFTC · Cross-Asset
                ══════════════════════════════════════════════════════════════ */}

            {/* ── Live Section header ── */}
            <div className="flex items-center gap-3 mb-3">
              <span
                className="inline-block w-1.5 h-1.5 rounded-full shrink-0"
                style={{ backgroundColor: '#34d399', boxShadow: '0 0 6px #34d399' }}
              />
              <span className="text-[10px] font-mono text-emerald-400/80 uppercase tracking-[0.2em] font-semibold">
                Live Market Data
              </span>
              <div className="flex-1 h-px" style={{ background: 'linear-gradient(to right, rgba(52,211,153,0.15), transparent)' }} />
            </div>

            {/* ── Yield Curve + Fed Liquidity — 2-column side-by-side ──
                items-start lets each panel grow to its natural content height
                independently. The Yield Curve's sparkline fills its own
                internal space; the Fed Liquidity panel shows all metric cards
                and the optional credit overlay without being clipped by an
                equal-height constraint from the neighbouring column.           */}
            <section>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">

                <YieldCurveSection
                  rates={data.rates}
                  fredData={fredMarkets?.yieldCurve}
                  isLoading={fredLoading}
                  yieldCurveSignal={data.yieldCurveSignal}
                />

                <FedLiquidityMonitor />

              </div>
            </section>

            {/* ── CFTC COT · Institutional Positioning & Squeeze Engine ──
                PROMOTED to live section — CFTC data is published weekly and
                does not depend on the IBKR overnight bar sync.
                UnifiedPositioningMatrix fetches live from /api/macro-positioning
                and renders its own complete header + status badge. */}
            <UnifiedPositioningMatrix cot={FLOWS_MOCK.cot} />

            {/* ── Commodities — PROMOTED to live section
                Feed is fully live via Alpaca (Gold · Silver · Crude · etc.).
                Spot prices stream in real-time — no dependency on IBKR sync. */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">
                    Commodities
                  </div>
                  {commodityData && (commodityData.health.liveCount + commodityData.health.staleCount) > 0 ? (
                    commodityData.health.liveCount > 0 ? (
                      <StatusBadge
                        variant="live"
                        label={`REAL-TIME · ${commodityData.health.liveCount}/${commodityData.health.totalNodes} LIVE`}
                        title={`${commodityData.health.liveCount} of ${commodityData.health.totalNodes} nodes streaming live via Alpaca`}
                      />
                    ) : (
                      <StatusBadge
                        variant="live"
                        label={`MARKET CLOSED · ${commTF}`}
                        title={`Last session data · ${commodityData.health.staleCount}/${commodityData.health.totalNodes} nodes with data`}
                      />
                    )
                  ) : (
                    <WaitingBadge />
                  )}
                </div>
                <TimeframeBar value={commTF} onChange={setCommTF} />
              </div>
              <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-2.5">
                {commodityLoading && !commodityData ? (
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
                    {[0, 1, 2, 3, 4, 5].map((i) => (
                      <Pulse key={i} className="h-14 w-full" />
                    ))}
                  </div>
                ) : commodityData ? (
                  // Live/Health counts moved entirely to the header badge
                  // (● REAL-TIME · n/n LIVE) — no duplicate status sub-row here.
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
                    {Object.values(commodityData.nodes).map((node) => (
                      <MarketNodeRow key={node.id} node={node} compact={true} timeframe={commTF} />
                    ))}
                  </div>
                ) : (
                  <div className="text-slate-400 text-[11px] font-mono p-4 text-center">No data available</div>
                )}
              </div>
            </section>

            {/* ── Cross-Asset Ratios — grouped directly with the commodities
                panel above.  Requires FMP (^VIX, ^GSPC, ^NDX) + Alpaca commodity
                ETFs.  Shows baseline zeroes until both providers are configured.
                CrossAssetRatiosPanel renders its own heading; badge passed as prop. */}
            <section>
              <CrossAssetRatiosPanel
                ndx={data.equities.find(e => e.symbol === '^NDX')?.price ?? alpacaQqq}
                spx={data.equities.find(e => e.symbol === '^GSPC')?.price ?? alpacaSpy}
                vix={data.volatility.vix.price}
                rate10y={data.rates.find(r => r.symbol === '^TNX')?.price ?? null}
                rate5y={data.rates.find(r => r.symbol === '^FVX')?.price ?? null}
                fredSpread={fredMarkets?.yieldCurve?.spread2y10y ?? null}
                statusBadge={
                  // Cross-asset ratios derive from Alpaca commodity nodes + market
                  // equities — no IBKR dependency. Show live once commodity prices
                  // are available (either intraday-live or last-session stale).
                  commodityData && (commodityData.health.liveCount + commodityData.health.staleCount) > 0
                    ? <StatusBadge
                        variant="live"
                        label="LIVE · ALPACA"
                        title="Cu/Au and Au/Ag ratios from live Alpaca commodity ETF prices; NDX/SPX from market equities feed"
                      />
                    : <WaitingBadge />
                }
              />
            </section>

            {/* ══════════════════════════════════════════════════════════════
                ▸ MONITORING FOOTER
                  Sections awaiting IBKR overnight historical-bar sync.
                  Live spot prices are already streaming in the ticker tape
                  above (Gold · Silver · Crude via Alpaca).
                  Historical chart data populates after midnight sync.
                ══════════════════════════════════════════════════════════════ */}

            {/* ── MonitoringFooter header ── */}
            <div className="flex items-center gap-3 pt-6 pb-3">
              {/* Left rule */}
              <div
                className="hidden sm:block w-6 h-px shrink-0"
                style={{ background: 'rgba(100,116,139,0.25)' }}
              />

              {/* Section wordmark + badge */}
              <div className="flex items-center gap-2.5 shrink-0 flex-wrap gap-y-1">
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full border shrink-0"
                  style={{ borderColor: 'rgba(251,191,36,0.45)', backgroundColor: 'rgba(251,191,36,0.08)' }}
                />
                <span className="text-[10px] font-mono text-amber-400/60 uppercase tracking-[0.2em] font-semibold">
                  Monitoring Footer
                </span>
                {/* Section-level status pill */}
                <StatusBadge
                  variant="awaiting"
                  label="AWAITING HISTORICAL SYNC"
                  pulse={false}
                  title="These sections are awaiting the IBKR overnight historical bar sync. Live spot prices for Gold, Silver and Crude are already streaming in the ticker tape via Alpaca."
                />
              </div>

              {/* Right rule */}
              <div
                className="flex-1 h-px"
                style={{ background: 'linear-gradient(to right, rgba(251,191,36,0.12), transparent)' }}
              />
            </div>

            {/* ── Volatility & Risk Indicators ── */}
            <section>
              <div className="flex items-center gap-2 mb-2">
                <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">
                  Volatility &amp; Risk Indicators
                </div>
                {/* volRisk.timestamp > 0 means Alpaca VIXY resolved successfully.
                    timestamp === 0 is the cold-start baseline fallback.
                    VVIX / MOVE / SKEW are β-projected from live VIX, not direct feeds. */}
                {volRisk && volRisk.timestamp > 0 ? (
                  <StatusBadge
                    variant="live"
                    label="LIVE · VIXY · DERIVED"
                    title="VIX from Alpaca VIXY snapshot; VVIX / MOVE / SKEW derived via VIX β-projection"
                  />
                ) : volRisk ? (
                  <StatusBadge
                    variant="disconnected"
                    label="BASELINE"
                    title="Showing historical medians — VIXY not yet loaded from Alpaca"
                  />
                ) : (
                  <WaitingBadge />
                )}
              </div>
              <div className="space-y-3">
                <MacroRiskMatrix
                  metrics={volRisk ?? MACRO_RISK_MOCK}
                  liveVixyPrice={etfQuoteMap.get('VIXY')?.price ?? null}
                  liveVixyChangePct={etfQuoteMap.get('VIXY')?.changePercent ?? null}
                />
                <IndexSkewHeads skewData={INDEX_SKEW_MOCK} />
              </div>
            </section>

            {/* ── Options Open Interest Walls ── */}
            <section>
              <div className="flex items-center gap-2 mb-2">
                <div className="text-[10px] font-mono text-slate-400 uppercase tracking-widest">
                  Options Open Interest Walls
                </div>
                <WaitingBadge />
              </div>
              <OIWallsGrid selectedAssets={selectedOIAssets} onAssetsChange={setSelectedOIAssets} />
            </section>

            {/* ── CTA Systematic Gauges + Options Tech Skew ──
                Each inner component (CTAGaugesPanel, TechSkewPanel) renders
                its own complete heading + ■ SIMULATED badge. */}
            <section>
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 items-stretch">
                <CTAGaugesPanel gauges={FLOWS_MOCK.ctaGauges} />
                <TechSkewPanel skew={FLOWS_MOCK.techSkew} />
              </div>
            </section>

          </>
        )}

        <p className="text-center text-[10px] text-slate-500 font-mono pb-6 pt-2">
          CROSSED MATRIX · For informational purposes only · Not financial advice · Data sourced from public market feeds
        </p>
      </main>
    </div>
  )
}
