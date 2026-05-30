'use client'

import type { FedLiquiditySnapshot } from '@/lib/types/fed-liquidity'
import { fmtBillions } from '@/lib/format/fedLiquidity'
import { StatusBadge } from '@/components/dashboard/StatusBadge'
import { useFedLiquidity } from '@/lib/hooks/useFedLiquidity'

// ─── Liquidity Explanation Engine ────────────────────────────────────────────
//
// Priority ordering (first matching condition wins):
//   1. TGA drain   — high TGA + WALCL contracting
//   2. RRP release — low RRP + WALCL expanding
//   3. WALCL up    — balance sheet expansion (QE / re-injection)
//   4. WALCL down  — balance sheet runoff (QT)
//   5. Flat        — no dominant impulse
//
// TGA > 700B in current regime signals active Treasury cash-build/drain.
// RRP < 200B signals the overnight RRP facility has largely been drained.

function getLiquidityExplanation(snapshot: FedLiquiditySnapshot): string {
  const { tga, rrp, momentum14d } = snapshot

  if (tga > 700 && momentum14d < 0) {
    return 'Treasury is draining liquidity from the system by refilling the TGA.'
  }
  if (rrp < 200 && momentum14d > 0) {
    return 'Release of RRP funds is providing a liquidity buffer to the system.'
  }
  if (momentum14d > 0.10) {
    return 'Fed balance sheet expansion is injecting fresh liquidity into the global system.'
  }
  if (momentum14d < -0.10) {
    return 'Fed balance sheet runoff is actively tightening global liquidity.'
  }
  return 'Fed liquidity conditions are stable with no dominant impulse.'
}

// ─── Macro Signal Block ───────────────────────────────────────────────────────
//
// The first visible element inside the monitor card.
// Renders a high-contrast SIGNAL badge + one-line "Why?" explanation so users
// immediately understand the current liquidity regime before reading the metrics.

function MacroSignalBlock({ snapshot }: { snapshot: FedLiquiditySnapshot }) {
  const { momentum14d, momentumDirection } = snapshot

  const isExpanding   = momentumDirection === 'expanding'
  const isContracting = momentumDirection === 'contracting'

  // Color tokens
  const COLOR = isExpanding
    ? { bg: 'rgba(52,211,153,0.10)', border: 'rgba(52,211,153,0.35)', text: '#34d399', glow: '0 0 8px rgba(52,211,153,0.40)' }
    : isContracting
      ? { bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.35)', text: '#f87171', glow: '0 0 8px rgba(248,113,113,0.35)' }
      : { bg: 'rgba(148,163,184,0.07)', border: 'rgba(148,163,184,0.25)', text: '#94a3b8', glow: 'none' }

  const label = isExpanding
    ? 'LIQUIDITY EXPANSION'
    : isContracting
      ? 'LIQUIDITY CONTRACTION'
      : 'LIQUIDITY NEUTRAL'

  const arrow  = isExpanding ? '▲' : isContracting ? '▼' : '→'
  const why    = getLiquidityExplanation(snapshot)

  return (
    <div
      className="rounded-xl border p-3 mb-4 transition-colors duration-300"
      style={{ backgroundColor: COLOR.bg, borderColor: COLOR.border }}
    >
      {/* ── Primary signal badge ── */}
      <div className="flex items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2">
          {/* Pulsing dot */}
          <span
            className="inline-block w-2 h-2 rounded-full shrink-0"
            style={{ backgroundColor: COLOR.text, boxShadow: COLOR.glow }}
          />
          {/* SIGNAL: label */}
          <span
            className="text-[10px] font-mono text-slate-500 uppercase tracking-widest"
          >
            Signal
          </span>
          {/* Bias text — large + bold */}
          <span
            className="font-mono text-[13px] font-bold tracking-wider uppercase leading-none"
            style={{ color: COLOR.text }}
          >
            {label}
          </span>
        </div>

        {/* Momentum value */}
        <span
          className="font-mono text-sm font-bold tabular-nums shrink-0"
          style={{ color: COLOR.text }}
        >
          {arrow} {momentum14d >= 0 ? '+' : ''}{momentum14d.toFixed(2)}%
        </span>
      </div>

      {/* ── Why? explanation ── */}
      <div className="flex items-start gap-1.5">
        <span
          className="text-[9px] font-mono uppercase tracking-widest shrink-0 mt-0.5"
          style={{ color: `${COLOR.text}80` }}
        >
          Why?
        </span>
        <p
          className="text-[11px] font-mono leading-snug"
          style={{ color: 'rgba(203,213,225,0.75)' }}
        >
          {why}
        </p>
      </div>
    </div>
  )
}

// ─── Verification Badge ───────────────────────────────────────────────────────
//
// Three-state rendering that matches the YieldCurve's FredLiveBadge system:
//   ● REAL-TIME FRED  — WALCL / TGA / RRP fetched from FRED API successfully
//   ▲ LOADING         — initial mount fetch in-flight (brief, ~1-2 s)
//   ■ DEMO DATA       — FRED_API_KEY absent or all fetch attempts failed

function DataSourceBadge({
  meta,
  isLoading,
}: {
  meta?:      FedLiquiditySnapshot['meta']
  isLoading?: boolean
}) {
  const isLive   = meta?.status === 'AUTHENTICATED'
  const isCached = meta?.status === 'CACHED'

  if (isLive) {
    return (
      <StatusBadge
        variant="live"
        label="REAL-TIME FRED"
        title={`FRED API · FTA as of ${meta?.seriesDates.fta ?? '—'} · fetched ${meta?.timestamp ? new Date(meta.timestamp).toLocaleTimeString() : '—'}`}
      />
    )
  }

  if (isCached) {
    return (
      <StatusBadge
        variant="awaiting"
        marker="◐"
        label="CACHED · FRED"
        title={`Last successful FRED fetch: ${meta?.timestamp ? new Date(meta.timestamp).toLocaleString() : '—'} — FRED rate-limited or timed out; showing real (cached) data`}
      />
    )
  }

  if (isLoading) {
    return (
      <StatusBadge
        variant="awaiting"
        label="LOADING"
        title="Fetching live WALCL / TGA / RRP data from FRED…"
      />
    )
  }

  return (
    <StatusBadge
      variant="disconnected"
      label="DEMO DATA"
      title="Add FRED_API_KEY to .env.local to enable live data"
    />
  )
}

// ─── Metric Card ──────────────────────────────────────────────────────────────

function LiquidityCard({
  label,
  seriesId,
  value,
  sub,
  valueColor = '#f1f5f9',
  large = false,
  seriesDate,
}: {
  label: string
  seriesId: string
  value: string
  sub: string
  valueColor?: string
  large?: boolean
  seriesDate?: string
}) {
  return (
    <div className="bg-[#080d18] border border-[#1a2540] rounded-lg p-3 relative group">
      {/* Series ID chip (visible on hover) */}
      <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity">
        <span
          className="text-[10px] font-mono px-1 py-0.5 rounded border"
          style={{ color: '#64748b', borderColor: '#1e293b' }}
        >
          {seriesId}
        </span>
      </div>

      <div className="text-[11px] text-slate-400 font-mono uppercase tracking-widest mb-1">
        {label}
      </div>
      <div
        className={`font-mono font-bold tabular-nums ${large ? 'text-2xl' : 'text-lg'}`}
        style={{ color: valueColor }}
      >
        {value}
      </div>
      <div className="text-[12px] text-slate-500 font-mono mt-1">
        {seriesDate ? `FRED obs. ${seriesDate}` : sub}
      </div>
    </div>
  )
}

// ─── FedLiquidityMonitor ──────────────────────────────────────────────────────
//
// Self-contained: owns its own useFedLiquidity subscription so it can never
// be orphaned by a parent refactor. The component polls /api/fed-liquidity
// every 5 minutes and flips the status badge to ● REAL-TIME FRED as soon as
// the first authenticated response arrives.
//
// No props required — the component is fully self-fetching.

export function FedLiquidityMonitor() {
  const { snapshot, isLoading } = useFedLiquidity(5 * 60_000)
  const sd = snapshot.meta?.seriesDates

  return (
    <div
      className="bg-[#0c1221] border rounded-2xl p-4 transition-colors duration-500"
      style={{
        borderColor: snapshot.meta?.status === 'AUTHENTICATED' ? '#34d39930' : '#1a2540',
      }}
    >
      {/* ── Title & status badge — always at the very top ── */}
      <div className="flex items-start justify-between mb-1 gap-2">
        <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
          Federal Reserve Liquidity Monitor
        </h3>
        <div className="flex items-center gap-2 flex-shrink-0">
          <DataSourceBadge meta={snapshot.meta} isLoading={isLoading} />
        </div>
      </div>

      {/* ── Formula — sits directly under the title ── */}
      <p className="text-[12px] text-slate-400 font-mono mb-4">
        Net Liquidity = FTA − TGA − RRO
      </p>

      {/* ══ MACRO SIGNAL — regime indicator, below title/formula ══ */}
      <MacroSignalBlock snapshot={snapshot} />

      {/* ── Metric Grid ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <LiquidityCard
          label="FTA · FED TOTAL ASSETS"
          seriesId="FTA"
          value={fmtBillions(snapshot.balanceSheetTotal)}
          sub={`As of ${snapshot.date}`}
          seriesDate={sd?.fta !== '—' ? sd?.fta : undefined}
          large
        />
        <LiquidityCard
          label="Net Liquidity Gauge"
          seriesId="FTA − TGA − RRO"
          value={fmtBillions(snapshot.netLiquidity)}
          sub="Global dollar engine"
          valueColor="#34d399"
          large
        />
        <LiquidityCard
          label="TGA · TREASURY GENERAL ACCOUNT"
          seriesId="TGA"
          value={`${fmtBillions(snapshot.tga)}${snapshot.meta?.diagnostics?.tga.usedFallback ? '*' : ''}`}
          sub={
            snapshot.meta?.diagnostics?.tga.usedFallback && snapshot.meta.diagnostics.tga.ok
              ? `via ${snapshot.meta.diagnostics.tga.resolvedSeriesId} fallback`
              : 'Capital reserves'
          }
          seriesDate={sd?.tga !== '—' ? sd?.tga : undefined}
        />
        <LiquidityCard
          label="RRO · REVERSE REPO OUTSTANDING"
          seriesId="RRO"
          value={fmtBillions(snapshot.rrp)}
          sub="Short-term operations"
          seriesDate={sd?.rro !== '—' ? sd?.rro : undefined}
        />
      </div>

      {/* ── Credit & systemic stress overlay (FRED supplementary series) ─────
          Both are best-effort: if the API didn't return a value the card
          simply hides itself rather than rendering a "—" placeholder.   */}
      {(snapshot.hyOasSpread != null || snapshot.stlfsi != null) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-3">
          {snapshot.hyOasSpread != null && (
            <LiquidityCard
              label="ICE BofA High Yield Spread"
              seriesId="BAMLH0A0HYM2"
              value={`${snapshot.hyOasSpread.toFixed(2)}%`}
              sub={
                snapshot.hyOasSpread < 3.5
                  ? 'Credit benign · risk-on'
                  : snapshot.hyOasSpread < 5
                    ? 'Mid-cycle normal'
                    : snapshot.hyOasSpread < 7
                      ? 'Stress widening'
                      : 'Recession / default risk'
              }
              valueColor={
                snapshot.hyOasSpread < 3.5 ? '#34d399' :
                snapshot.hyOasSpread < 5   ? '#a3e635' :
                snapshot.hyOasSpread < 7   ? '#fbbf24' : '#f87171'
              }
              seriesDate={snapshot.hyOasDate}
            />
          )}
          {snapshot.stlfsi != null && (
            <LiquidityCard
              label="St. Louis Fed Financial Stress Index"
              seriesId="STLFSI4"
              value={`${snapshot.stlfsi >= 0 ? '+' : ''}${snapshot.stlfsi.toFixed(2)}`}
              sub={
                snapshot.stlfsi < -0.5 ? 'Calm · below avg stress' :
                snapshot.stlfsi <  0.5 ? 'Average stress regime'   :
                snapshot.stlfsi <  1.5 ? 'Warning · elevated'       :
                                          'Crisis · acute stress'
              }
              valueColor={
                snapshot.stlfsi < -0.5 ? '#34d399' :
                snapshot.stlfsi <  0.5 ? '#94a3b8' :
                snapshot.stlfsi <  1.5 ? '#fbbf24' : '#f87171'
              }
              seriesDate={snapshot.stlfsiDate}
            />
          )}
        </div>
      )}

      {/* ── Fed Ledger Breakdown Bar ──────────────────────────────────────────
          Proportional horizontal bar showing how the total balance sheet is
          allocated.  Fills the remaining vertical space so the card matches
          the Yield Curve sparkline card height.
          Segments:
            TGA   (WTREGEN)   — amber   — Treasury's cash account drains liquidity
            RRP   (RRPONTSYD) — indigo  — overnight reverse repo absorbs reserves
            Net   (residual)  — teal    — freely circulating net liquidity
      ────────────────────────────────────────────────────────────────────── */}
      {(() => {
        const total = snapshot.balanceSheetTotal
        if (!total || total <= 0) return null

        const tgaPct  = Math.max(0, Math.min(100, (snapshot.tga  / total) * 100))
        const rrpPct  = Math.max(0, Math.min(100, (snapshot.rrp  / total) * 100))
        const netPct  = Math.max(0, Math.min(100, (snapshot.netLiquidity / total) * 100))
        // drain = everything that isn't net liquidity (TGA + RRP)
        const drainPct = Math.min(100, tgaPct + rrpPct)

        return (
          <div className="mt-5 pt-4" style={{ borderTop: '1px solid #1a2540' }}>
            {/* Bar track */}
            <div
              className="w-full h-3 rounded-full overflow-hidden flex"
              style={{ background: '#0a1628' }}
              title={`TGA ${tgaPct.toFixed(1)}% · RRP ${rrpPct.toFixed(1)}% · Net ${netPct.toFixed(1)}%`}
            >
              {/* TGA segment — amber */}
              <div
                className="h-full transition-all duration-700 ease-out"
                style={{ width: `${tgaPct}%`, background: 'linear-gradient(90deg, #f59e0b, #fbbf24)' }}
              />
              {/* RRP segment — indigo */}
              <div
                className="h-full transition-all duration-700 ease-out"
                style={{ width: `${rrpPct}%`, background: 'linear-gradient(90deg, #6366f1, #818cf8)' }}
              />
              {/* Net Liquidity segment — teal */}
              <div
                className="h-full transition-all duration-700 ease-out flex-1"
                style={{ background: 'linear-gradient(90deg, #0d9488, #34d399)' }}
              />
            </div>

            {/* Legend row */}
            <div className="flex items-center justify-between mt-2">
              <div className="flex items-center gap-3">
                <span className="flex items-center gap-1 text-[10px] font-mono text-slate-400">
                  <span className="inline-block w-2 h-2 rounded-sm" style={{ background: '#fbbf24' }} />
                  TGA&nbsp;<span style={{ color: '#fbbf24' }}>{tgaPct.toFixed(1)}%</span>
                </span>
                <span className="flex items-center gap-1 text-[10px] font-mono text-slate-400">
                  <span className="inline-block w-2 h-2 rounded-sm" style={{ background: '#818cf8' }} />
                  RRP&nbsp;<span style={{ color: '#818cf8' }}>{rrpPct.toFixed(1)}%</span>
                </span>
                <span className="flex items-center gap-1 text-[10px] font-mono text-slate-400">
                  <span className="inline-block w-2 h-2 rounded-sm" style={{ background: '#34d399' }} />
                  NET&nbsp;<span style={{ color: '#34d399' }}>{netPct.toFixed(1)}%</span>
                </span>
              </div>
              {/* Drain label — right-aligned, custom Tailwind hover card */}
              <span
                className="relative group cursor-help text-[10px] font-mono border-b border-dashed border-neutral-400/60 pb-px select-none"
                style={{ color: drainPct > 20 ? '#fbbf24' : '#94a3b8' }}
              >
                {drainPct.toFixed(1)}% drained
                <span className="absolute bottom-full left-1/2 z-50 mb-2 w-64 -translate-x-1/2 rounded-md bg-neutral-900 border border-neutral-700 p-2 text-xs font-normal text-neutral-200 shadow-xl opacity-0 pointer-events-none group-hover:opacity-100 transition-opacity duration-150 ease-in-out whitespace-normal normal-case">
                  The percentage of the Fed&apos;s total balance sheet currently locked up in idle safety valves (TGA + Repo) rather than actively circulating to support commercial bank lending and market risk assets.
                </span>
              </span>
            </div>
          </div>
        )
      })()}

    </div>
  )
}
