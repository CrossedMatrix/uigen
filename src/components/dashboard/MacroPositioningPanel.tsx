'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { PositioningRow, MacroPositioningData, AccelGlyph } from '@/app/api/macro-positioning/route'
import { StatusBadge } from '@/components/dashboard/StatusBadge'

// ─── Section structure ────────────────────────────────────────────────────────
// Four macro buckets: BTC merged into CURRENCY alongside DX/6E/6J/6A/6C

type Category = 'indexes' | 'treasuries' | 'currency' | 'commodity'

const SECTION_ORDER: Category[] = ['indexes', 'treasuries', 'currency', 'commodity']

const SECTION_META: Record<Category, { label: string; accent: string; bg: string; text: string; border: string }> = {
  indexes:    { label: 'INDEXES',     accent: '#60a5fa', bg: '#3b82f615', text: '#60a5fa', border: '#3b82f630' },
  treasuries: { label: 'TREASURIES',  accent: '#a78bfa', bg: '#8b5cf615', text: '#a78bfa', border: '#8b5cf630' },
  currency:   { label: 'CURRENCY',    accent: '#34d399', bg: '#34d39915', text: '#34d399', border: '#34d39930' },
  commodity:  { label: 'HARD ASSETS', accent: '#fbbf24', bg: '#f59e0b15', text: '#fbbf24', border: '#f59e0b30' },
}

const CAT_CHIPS = [
  { key: 'ALL',        label: 'ALL'        },
  { key: 'indexes',    label: 'INDEXES'    },
  { key: 'treasuries', label: 'TREASURIES' },
  { key: 'currency',   label: 'CURRENCY'   },
  { key: 'commodity',  label: 'HARD ASSETS'},
]

// ─── Velocity glyph styles ────────────────────────────────────────────────────

const VELOCITY_STYLE: Record<AccelGlyph, { color: string; glow?: string }> = {
  '▲▲': { color: '#00ff88', glow: '#00ff8850' },
  '△':  { color: '#6ee7b7' },
  '▼▼': { color: '#ff3366', glow: '#ff336650' },
  '▽':  { color: '#fca5a5' },
  '⇅':  { color: '#475569' },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmtKClient(v: number): string {
  const r = Math.round(v / 1_000)
  if (r === 0) return '~0K'
  return `${r > 0 ? '+' : ''}${r}K`
}

// ─── Column tooltip shell ─────────────────────────────────────────────────────
// Shared wrapper for all column info popovers.
// `align='left'`  → tooltip drops from the left edge of the icon (columns 2–4)
// `align='right'` → tooltip drops from the right edge of the icon (columns 5–6)

function TooltipShell({
  title,
  align,
  width = 'w-[290px]',
  children,
}: {
  title: string
  align: 'left' | 'right'
  width?: string
  children: React.ReactNode
}) {
  const pos   = align === 'right' ? 'right-0' : 'left-0'
  const arrow = align === 'right'
    ? 'absolute -top-1.5 right-3 w-3 h-3 rotate-45 bg-slate-900 border-l border-t border-slate-700/60'
    : 'absolute -top-1.5 left-3 w-3 h-3 rotate-45 bg-slate-900 border-l border-t border-slate-700/60'

  return (
    <div className={`absolute top-full ${pos} mt-2 ${width} z-[100] invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all duration-150 pointer-events-none`}>
      <div className={arrow} />
      <div className="bg-slate-900 border border-slate-700/60 rounded-lg shadow-2xl overflow-hidden">
        <div className="px-3 py-1.5 border-b border-slate-800 bg-slate-950/80">
          <span className="text-[10px] font-mono font-bold text-slate-400 uppercase tracking-[0.2em]">{title}</span>
        </div>
        <div className="px-3 py-2.5 space-y-2">{children}</div>
      </div>
    </div>
  )
}

// ─── Reusable tooltip row ─────────────────────────────────────────────────────

function TRow({
  glyph,
  glyphColor,
  glyphGlow,
  label,
  desc,
}: {
  glyph: React.ReactNode
  glyphColor?: string
  glyphGlow?: string
  label: string
  desc: React.ReactNode
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div
        className="shrink-0 mt-0.5 w-10 text-center font-mono text-[12px] leading-tight tabular-nums"
        style={{ color: glyphColor, textShadow: glyphGlow ? `0 0 8px ${glyphGlow}` : undefined }}
      >
        {glyph}
      </div>
      <div>
        <span className="text-[12px] font-mono font-bold text-slate-200">{label}</span>
        <p className="text-[11px] font-mono text-slate-400 leading-snug mt-0.5">{desc}</p>
      </div>
    </div>
  )
}

function TDivider() { return <div className="h-px bg-slate-800" /> }

// ─── Per-column tooltip content ───────────────────────────────────────────────

function LevFundsTooltip() {
  return (
    <TooltipShell title="Leveraged Fund Net Position" align="left">
      <TRow
        glyph="+XK"
        glyphColor="#34d399"
        label="Net Long — Bullish"
        desc={<>Funds hold more longs than shorts.<br /><span className="text-slate-300">Expectation: prices rise.</span></>}
      />
      <TDivider />
      <TRow
        glyph="−XK"
        glyphColor="#f87171"
        label="Net Short — Bearish"
        desc={<>Funds hold more shorts than longs.<br /><span className="text-slate-300">Expectation: prices fall.</span></>}
      />
      <TDivider />
      <TRow
        glyph="~0K"
        glyphColor="#475569"
        label="Flat — No Conviction"
        desc="Longs ≈ Shorts. No dominant directional bet from leveraged money."
      />
      <TDivider />
      <p className="text-[10px] font-mono text-slate-600 leading-relaxed">
        Source: CFTC Commitments of Traders (COT). Leveraged funds = hedge funds &amp; managed money.
      </p>
    </TooltipShell>
  )
}

function WkChangeTooltip() {
  return (
    <TooltipShell title="Week-Over-Week Position Change" align="left">
      <TRow
        glyph="+XK/wk"
        glyphColor="#34d399"
        label="Adding Net Longs"
        desc={<>Funds bought longs or covered shorts vs. prior week.<br /><span className="text-slate-300">Bullish conviction is growing.</span></>}
      />
      <TDivider />
      <TRow
        glyph="−XK/wk"
        glyphColor="#f87171"
        label="Adding Net Shorts"
        desc={<>Funds sold longs or added shorts vs. prior week.<br /><span className="text-slate-300">Bearish conviction is growing.</span></>}
      />
      <TDivider />
      <TRow
        glyph="~0K/wk"
        glyphColor="#475569"
        label="Position Holds"
        desc="Minimal repositioning this week. Existing bias maintained."
      />
      <TDivider />
      <p className="text-[10px] font-mono text-slate-600 leading-relaxed">
        Compares the latest CFTC report to the prior week&apos;s filing. Large swings signal conviction shifts.
      </p>
    </TooltipShell>
  )
}

function ScaleTooltip() {
  return (
    <TooltipShell title="3-Year COT Positioning Index" align="left" width="w-[310px]">
      <TRow
        glyph=">90%"
        glyphColor="#f87171"
        label="Extreme Long — Exhaustion Risk"
        desc="Near 3-year high. Crowded trade; limited new buyers. Watch for reversal."
      />
      <TDivider />
      <TRow
        glyph="<10%"
        glyphColor="#34d399"
        label="Extreme Short — Squeeze Risk"
        desc="Near 3-year low. Short side crowded; potential for rapid short-covering rally."
      />
      <TDivider />
      <TRow
        glyph="50%"
        glyphColor="#94a3b8"
        label="Mid-Range — Neutral"
        desc="Positioning neither stretched nor compressed. No positioning edge."
      />
      <TDivider />
      <div className="space-y-1">
        <div className="flex items-center gap-2 text-[11px] font-mono">
          <span className="text-[10px]">●</span>
          <span className="text-slate-400">Dot = current net position on the 0–100% scale</span>
        </div>
        <div className="flex items-center gap-2 text-[11px] font-mono">
          <span className="text-slate-500 text-[10px]">│</span>
          <span className="text-slate-400">Tick = zero line (net = 0; above = long, below = short)</span>
        </div>
      </div>
    </TooltipShell>
  )
}

function VelocityTooltip() {
  return (
    <TooltipShell title="1-Week Acceleration Signal" align="right">
      <TRow glyph="▲▲" glyphColor="#00ff88" glyphGlow="#00ff8840" label="Accelerating Higher" desc={<><span className="text-slate-300">Strong institutional buying.</span> Current week's inflow exceeds last week's. Ride the trend.</>} />
      <TDivider />
      <TRow glyph="△" glyphColor="#6ee7b7" label="Decelerating Up" desc="Funds still adding longs but pace is slowing. Fragile — profit-taking may be starting." />
      <TDivider />
      <TRow glyph="▼▼" glyphColor="#ff3366" glyphGlow="#ff336640" label="Accelerating Lower" desc={<><span className="text-slate-300">Strong institutional selling.</span> Current week's outflow exceeds last week's. Ride the trend.</>} />
      <TDivider />
      <TRow glyph="▽" glyphColor="#fca5a5" label="Decelerating Down" desc="Funds still adding shorts but pace is slowing. Fragile — covering may be starting." />
      <TDivider />
      <TRow glyph="⇅" glyphColor="#475569" label="Neutral / Oscillating" desc="No clear directional acceleration. Positioning is shifting without conviction." />
    </TooltipShell>
  )
}

function CommDeltaTooltip() {
  return (
    <TooltipShell title="Net Commercial Positioning" align="left" width="w-[300px]">
      <TRow
        glyph="+XK"
        glyphColor="#34d399"
        label="Net Long Commercials"
        desc={<>Producers/merchants or dealers are net long.<br /><span className="text-slate-300">Unusual — they are natural sellers. Signals supply reduction or hedging unwind.</span></>}
      />
      <TDivider />
      <TRow
        glyph="−XK"
        glyphColor="#f87171"
        label="Net Short Commercials"
        desc={<>Producers/merchants hedging future production (commodities) or dealers hedging inventory (financial). <span className="text-slate-300">Normal operating posture.</span></>}
      />
      <TDivider />
      <p className="text-[10px] font-mono text-slate-600 leading-relaxed">
        TFF contracts: Dealer/Intermediary net. Disaggregated: Producer/Merchant net.
        Commercials are the most informed participants — they trade on fundamental supply/demand.
      </p>
    </TooltipShell>
  )
}

function OverhangTooltip() {
  return (
    <TooltipShell title="Leveraged Fund Overhang %" align="left" width="w-[300px]">
      <TRow
        glyph=">25%"
        glyphColor="#f87171"
        label="High Overhang — Crowded"
        desc="Leveraged funds control >25% of total open interest. Trade is crowded; any sentiment shift may trigger outsized unwinding."
      />
      <TDivider />
      <TRow
        glyph="10–25%"
        glyphColor="#fbbf24"
        label="Moderate Overhang"
        desc="Meaningful leveraged positioning relative to the overall market. Monitor for acceleration that pushes into the high zone."
      />
      <TDivider />
      <TRow
        glyph="<10%"
        glyphColor="#475569"
        label="Low Overhang — Dispersed"
        desc="Leveraged funds are a small fraction of open interest. Market is broadly held; crowding risk is low."
      />
      <TDivider />
      <p className="text-[10px] font-mono text-slate-600 leading-relaxed">
        Formula: |Leveraged Net| ÷ Total Open Interest × 100.
        Source: CFTC COT weekly report.
      </p>
    </TooltipShell>
  )
}

function RegimeTooltip() {
  return (
    <TooltipShell title="COT Regime Classification" align="right" width="w-[320px]">
      <TRow
        glyph={<span style={{ color: '#34d399', fontSize: 9 }}>BULL EXP.</span>}
        glyphColor="#34d399"
        label="BULL EXPANSION"
        desc="Managed money accumulating net longs with conviction. Both net position and weekly flow point higher — trend-following long entry conditions."
      />
      <TDivider />
      <TRow
        glyph={<span style={{ color: '#f87171', fontSize: 9 }}>BEAR CON.</span>}
        glyphColor="#f87171"
        label="BEAR CONTRACTION"
        desc="Managed money distributing and adding net shorts. Net position negative and weekly flow negative — trend-following short entry conditions."
      />
      <TDivider />
      <TRow
        glyph={<span style={{ color: '#fbbf24', fontSize: 9 }}>SQ.</span>}
        glyphColor="#fbbf24"
        label="SHORT SQUEEZE"
        desc="Forced covering; violent reversal potential. Extreme COT index with commercial inversion, or 3-month MM/Commercial spread extreme — contrarian fade setup."
      />
      <TDivider />
      <TRow
        glyph={<span style={{ color: '#64748b', fontSize: 9 }}>—</span>}
        glyphColor="#64748b"
        label="NEUTRAL"
        desc="No dominant directional positioning from leveraged funds. Net position and weekly flow are mixed — no structural edge from COT data."
      />
    </TooltipShell>
  )
}

// ─── Column header cell ───────────────────────────────────────────────────────

type ColDef = { label: string; sub?: string; tooltip?: React.ReactNode }

// 6 columns — WK/WK folded as a sub-line under MM NET to reclaim a full column
const COL_DEFS: ColDef[] = [
  { label: 'ASSET'                                                               },
  { label: 'MM NET',    sub: 'wk Δ',  tooltip: <LevFundsTooltip />             },
  { label: 'COMM.',     sub: 'delta', tooltip: <CommDeltaTooltip />             },
  { label: 'OVERHANG',  sub: '%OI',   tooltip: <OverhangTooltip />             },
  { label: 'POSITIONING SCALE',        tooltip: <ScaleTooltip />                },
  { label: 'VEL.',      sub: '1w',    tooltip: <VelocityTooltip />             },
  { label: 'REGIME',                   tooltip: <RegimeTooltip />               },
]

function ColHeader({ label, sub, tooltip }: ColDef) {
  const inner = (
    <div className="flex items-baseline gap-1 leading-none">
      <span className="text-[10px] font-mono text-slate-400 uppercase tracking-[0.18em]">{label}</span>
      {sub && <span className="text-[9px] font-mono text-slate-600 uppercase tracking-[0.1em]">{sub}</span>}
    </div>
  )
  if (!tooltip) return inner
  return (
    <div className="relative group flex items-center gap-1 cursor-default select-none">
      {inner}
      <svg
        className="w-2.5 h-2.5 shrink-0 opacity-30 group-hover:opacity-80 transition-opacity"
        style={{ color: '#64748b' }}
        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
      >
        <circle cx="12" cy="12" r="10" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 16v-4M12 8h.01" />
      </svg>
      {tooltip}
    </div>
  )
}

// ─── PositioningBar ───────────────────────────────────────────────────────────
//
// Two-zone bar chart layout:
//
//   ◀──────── SHORT ZONE (red bg) ──────│──────── LONG ZONE (green bg) ────────▶
//                              ██████████│  ← active fill (net long example)
//                                        │ zero-line
//
// The active fill always shoots from the zero-line tick in the direction
// of the current position — red leftward for short, green rightward for long.

function PositioningBar({ positioningScale, zeroLinePosition }: {
  positioningScale: number
  zeroLinePosition: number
}) {
  const isLong    = positioningScale >= zeroLinePosition
  const fillColor = isLong ? '#34d399' : '#f87171'
  // Active fill: left edge = closer of the two points, width = distance between them
  const fillLeft  = Math.min(positioningScale, zeroLinePosition)
  const fillWidth = Math.abs(positioningScale - zeroLinePosition)

  return (
    <div className="relative w-full" style={{ height: '16px' }}>

      {/* ── Short zone background (left of zero-line) ─── */}
      <div className="absolute" style={{
        left: 0, width: `${zeroLinePosition}%`,
        top: '50%', transform: 'translateY(-50%)', height: '12px',
        backgroundColor: '#f8717114',
        borderRadius: '3px 0 0 3px',
      }} />

      {/* ── Long zone background (right of zero-line) ─── */}
      <div className="absolute" style={{
        left: `${zeroLinePosition}%`, right: 0,
        top: '50%', transform: 'translateY(-50%)', height: '12px',
        backgroundColor: '#34d39914',
        borderRadius: '0 3px 3px 0',
      }} />

      {/* ── Active fill: zero → current position ──────── */}
      <div className="absolute transition-all duration-500" style={{
        left: `${fillLeft}%`, width: `${fillWidth}%`,
        top: '50%', transform: 'translateY(-50%)', height: '12px',
        backgroundColor: fillColor, opacity: 0.82,
      }} />

      {/* ── Zero-line divider ─────────────────────────── */}
      <div className="absolute" style={{
        left: `${zeroLinePosition}%`, top: 0, bottom: 0,
        width: '2px', backgroundColor: '#64748b',
        transform: 'translateX(-50%)', zIndex: 10,
      }} />

    </div>
  )
}

// ─── Regime classification ────────────────────────────────────────────────────
//
// Four mutually exclusive regimes derived from existing PositioningRow fields.
// SHORT SQUEEZE takes priority because it overrides directional bias entirely.

type Regime = 'BULL_EXPANSION' | 'BEAR_CONTRACTION' | 'SHORT_SQUEEZE' | 'NEUTRAL'

const REGIME_META: Record<Regime, {
  label:   string
  color:   string
  bg:      string
  border:  string
  glow?:   string
  desc:    string
}> = {
  BULL_EXPANSION: {
    label:  'BULL EXPANSION',
    color:  '#34d399',
    bg:     '#34d39912',
    border: '#34d39940',
    glow:   '#34d39918',
    desc:   'Managed money accumulating net longs with conviction. Net position positive and weekly flow positive — trend-following long entry conditions present.',
  },
  BEAR_CONTRACTION: {
    label:  'BEAR CONTRACTION',
    color:  '#f87171',
    bg:     '#f8717112',
    border: '#f8717140',
    desc:   'Managed money distributing and adding net shorts. Net position negative and weekly flow negative — trend-following short entry conditions present.',
  },
  SHORT_SQUEEZE: {
    label:  'SHORT SQUEEZE',
    color:  '#fbbf24',
    bg:     '#fbbf2412',
    border: '#fbbf2445',
    glow:   '#fbbf2420',
    desc:   'Forced covering; violent reversal potential. Extreme COT positioning with commercial inversion, or 3-month MM/Commercial spread at an extreme — high-probability contrarian fade setup.',
  },
  NEUTRAL: {
    label:  'NEUTRAL',
    color:  '#475569',
    bg:     'transparent',
    border: '#1e293b',
    desc:   'No dominant directional positioning from leveraged funds. Net position and weekly flow are mixed or flat — no structural COT edge in either direction.',
  },
}

function classifyRegime(row: PositioningRow): Regime {
  // Squeeze signals override all directional reads
  if (row.divergenceVector === 'SQUEEZE' || row.convergenceAlarm) return 'SHORT_SQUEEZE'
  // Conviction long: net long AND still adding this week
  if (row.leveragedNet > 0 && row.weeklyChange > 0) return 'BULL_EXPANSION'
  // Conviction short: net short AND still adding shorts this week
  if (row.leveragedNet < 0 && row.weeklyChange < 0) return 'BEAR_CONTRACTION'
  return 'NEUTRAL'
}

// ─── Regime badge ─────────────────────────────────────────────────────────────
// Compact coloured label + inline ? icon whose popover shows the full description.
// The ? is always present but only visible (opacity) on hover so it stays clean.

function RegimeBadge({ row }: { row: PositioningRow }) {
  const regime = classifyRegime(row)
  const meta   = REGIME_META[regime]

  return (
    <div className="flex items-center gap-1 min-w-0">
      {/* Coloured label chip */}
      <div
        className="inline-flex items-center px-1.5 py-0.5 rounded border shrink-0"
        style={{
          backgroundColor: meta.bg,
          borderColor:     meta.border,
          boxShadow:       meta.glow ? `0 0 6px ${meta.glow}` : undefined,
        }}
      >
        <span
          className="text-[10px] font-mono font-bold tracking-widest uppercase leading-none"
          style={{ color: meta.color }}
        >
          {meta.label}
        </span>
      </div>

      {/* ? icon — inline hover tooltip with full description */}
      <div className="relative group shrink-0">
        <span className="text-[10px] font-mono text-slate-700 group-hover:text-slate-400 transition-colors cursor-help select-none leading-none">
          ?
        </span>
        {/* Popover */}
        <div className="absolute bottom-full right-0 mb-2 w-[230px] z-[200] invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all duration-150 pointer-events-none">
          {/* Arrow */}
          <div className="absolute -bottom-1.5 right-1 w-3 h-3 rotate-45 bg-slate-900 border-r border-b border-slate-700/60" />
          <div className="bg-slate-900 border border-slate-700/60 rounded-lg shadow-2xl overflow-hidden">
            <div className="px-2.5 py-1 border-b border-slate-800 flex items-center gap-1.5">
              <span
                className="text-[9px] font-mono font-bold uppercase tracking-widest"
                style={{ color: meta.color }}
              >
                {meta.label}
              </span>
            </div>
            <p className="px-2.5 py-2 text-[11px] font-mono text-slate-400 leading-relaxed">
              {meta.desc}
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── OI Exhaustion badge ──────────────────────────────────────────────────────
// Rendered inline next to the Lev. Funds Net value when exhaustion is detected.

function OIExhaustionBadge() {
  return (
    <div
      title="OI Exhaustion: active repositioning + falling open interest — short covering / position unwind"
      className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[8px] font-mono font-bold uppercase tracking-wider ml-1 cursor-help"
      style={{ backgroundColor: '#f97316' + '18', borderWidth: 1, borderStyle: 'solid', borderColor: '#f97316' + '50', color: '#f97316' }}
    >
      OI↓
    </div>
  )
}

// ─── Data-source badge ────────────────────────────────────────────────────────

function DataBadge({ status }: { status: MacroPositioningData['status'] | undefined }) {
  if (status === 'AUTHENTICATED') {
    return (
      <StatusBadge
        variant="live"
        label="LIVE · CFTC"
        title="Live CFTC Commitments of Traders data"
      />
    )
  }
  return (
    <StatusBadge
      variant="disconnected"
      label="DEMO DATA"
      title="Add CFTC credentials to .env.local to enable live data"
    />
  )
}

// ─── Accordion drawer ─────────────────────────────────────────────────────────

function AccordionDrawer({ row }: { row: PositioningRow }) {
  const commColor = row.commercialNet >= 0 ? '#34d399' : '#f87171'
  const oiColor   = row.openInterestChange >= 0 ? '#34d399' : '#f87171'
  const regime    = classifyRegime(row)
  const regimeMeta = REGIME_META[regime]

  return (
    <div className="px-5 pt-3 pb-4 bg-[#06091566] border-t border-[#1a2540]/40">
      <div className="grid grid-cols-4 gap-4 mb-3">
        <div>
          <div className="text-[10px] font-mono text-slate-500 uppercase tracking-[0.18em] mb-1">COMMERCIAL NET</div>
          <div className="text-[13px] font-mono font-bold tabular-nums" style={{ color: commColor }}>{fmtKClient(row.commercialNet)}</div>
          <div className="text-[10px] font-mono text-slate-600 mt-0.5">
            {row.category === 'commodity' ? 'Prod / Merch' : 'Dealer / Intermed'}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-mono text-slate-500 uppercase tracking-[0.18em] mb-1">OPEN INTEREST</div>
          <div className="text-[13px] font-mono font-bold tabular-nums text-slate-200">{fmtKClient(row.openInterest)}</div>
          <div className="text-[10px] font-mono mt-0.5" style={{ color: oiColor }}>
            {row.openInterestChange >= 0 ? '+' : ''}{Math.round(row.openInterestChange / 1_000)}K WoW
          </div>
        </div>
        <div>
          <div className="text-[10px] font-mono text-slate-500 uppercase tracking-[0.18em] mb-1">COT REGIME</div>
          <div
            className="text-[11px] font-mono font-bold uppercase tracking-wider"
            style={{ color: regimeMeta.color }}
          >
            {regimeMeta.label}
          </div>
          <div className="text-[10px] font-mono text-slate-600 mt-0.5">
            spread {row.spreadPct.toFixed(0)}th %ile
          </div>
        </div>
        <div>
          <div className="text-[10px] font-mono text-slate-500 uppercase tracking-[0.18em] mb-1">CFTC DATE</div>
          <div className="text-[11px] font-mono text-slate-300">{row.ok ? row.date : '—'}</div>
          <div className="text-[10px] font-mono text-slate-600 mt-0.5">report week</div>
        </div>
      </div>
      <div className="border-t border-[#1a2540]/30 pt-2.5">
        <div className="text-[10px] font-mono text-slate-500 uppercase tracking-[0.18em] mb-1.5">AUTOMATED BIAS ANALYSIS</div>
        <p className="text-[12px] font-mono text-slate-400 leading-relaxed">{row.biasExplanation}</p>
      </div>
    </div>
  )
}

// ─── Section divider row ──────────────────────────────────────────────────────

function SectionHeader({ category, count }: { category: Category; count: number }) {
  const meta = SECTION_META[category]
  return (
    <div className="flex items-center gap-3 px-5 py-1.5 border-y" style={{ backgroundColor: meta.bg, borderColor: meta.border }}>
      <div className="h-px flex-1" style={{ backgroundColor: meta.accent, opacity: 0.3 }} />
      <span className="text-[11px] font-mono font-bold tracking-[0.25em] uppercase" style={{ color: meta.accent }}>
        {meta.label}
      </span>
      <span className="text-[10px] font-mono text-slate-600">({count})</span>
      <div className="h-px flex-1" style={{ backgroundColor: meta.accent, opacity: 0.3 }} />
    </div>
  )
}

// ─── Sector Breadth module ────────────────────────────────────────────────────
//
// Aggregates directional bias by macro category using ALL rows (not the filtered
// view) so the summary always reflects the full COT universe.
// Placed between the scrollable body and the footer.

function SectorBreadth({ rows }: { rows: PositioningRow[] }) {
  const grouped = useMemo(() => {
    const map: Partial<Record<Category, PositioningRow[]>> = {}
    for (const row of rows) {
      if (!map[row.category]) map[row.category] = []
      map[row.category]!.push(row)
    }
    return map
  }, [rows])

  return (
    <div className="px-4 py-3 border-t border-[#1a2540] bg-[#060915]/50 shrink-0">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-[10px] font-mono text-slate-500 uppercase tracking-[0.2em]">
          SECTOR BREADTH
        </span>
        <div className="h-px flex-1 bg-[#1a2540]" />
        <span className="text-[10px] font-mono text-slate-700 uppercase tracking-widest">
          MACRO BIAS
        </span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
        {SECTION_ORDER.map(cat => {
          const catRows = grouped[cat] ?? []
          if (catRows.length === 0) return null

          const meta         = SECTION_META[cat]
          const longCount    = catRows.filter(r => r.leveragedNet > 0).length
          const shortCount   = catRows.filter(r => r.leveragedNet < 0).length
          const totalCount   = catRows.length
          const squeezeCount = catRows.filter(r => r.convergenceAlarm || r.divergenceVector === 'SQUEEZE').length
          const avgScale     = catRows.reduce((sum, r) => sum + r.positioningScale, 0) / totalCount
          const longPct      = totalCount > 0 ? (longCount / totalCount) * 100 : 50

          let biasLabel: string
          let biasColor: string
          if      (longCount > shortCount) { biasLabel = 'NET LONG';  biasColor = '#34d399' }
          else if (shortCount > longCount) { biasLabel = 'NET SHORT'; biasColor = '#f87171' }
          else                             { biasLabel = 'MIXED';     biasColor = '#94a3b8' }

          return (
            <div
              key={cat}
              className="rounded-lg border px-3 py-2.5"
              style={{ backgroundColor: meta.bg, borderColor: meta.border }}
            >
              {/* Category label + bias */}
              <div className="flex items-center justify-between mb-2">
                <span
                  className="text-[10px] font-mono font-bold uppercase tracking-wider"
                  style={{ color: meta.text }}
                >
                  {meta.label}
                </span>
                <span
                  className="text-[10px] font-mono font-bold uppercase tracking-widest"
                  style={{ color: biasColor }}
                >
                  {biasLabel}
                </span>
              </div>

              {/* Long/Short proportion bar */}
              <div
                className="h-1.5 rounded-full overflow-hidden mb-2"
                style={{ backgroundColor: '#f8717128' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${longPct}%`, backgroundColor: '#34d399' }}
                />
              </div>

              {/* Stats row */}
              <div className="flex items-center justify-between text-[10px] font-mono">
                <span className="text-slate-500">
                  <span style={{ color: '#34d399cc' }}>{longCount}L</span>
                  {' / '}
                  <span style={{ color: '#f87171cc' }}>{shortCount}S</span>
                </span>
                <span className="text-slate-600">
                  avg {avgScale.toFixed(0)}
                  <span className="text-slate-700">%ile</span>
                </span>
                {squeezeCount > 0 ? (
                  <span
                    className="font-bold"
                    style={{ color: '#fbbf24' }}
                    title={`${squeezeCount} contract${squeezeCount > 1 ? 's' : ''} in SHORT SQUEEZE regime`}
                  >
                    {squeezeCount} SQ
                  </span>
                ) : (
                  <span className="text-slate-700">—</span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

// 7 columns: Asset | MM Net (+ wk Δ sub) | Comm Delta | Overhang %OI | Scale | Velocity | Regime
const GRID_COLS = '11rem 7rem 5.5rem 4rem 1fr 4.5rem 10rem'

export function MacroPositioningPanel() {
  const [data,           setData]           = useState<MacroPositioningData | null>(null)
  const [isLoading,      setIsLoading]      = useState(true)
  const [activeFilter,   setActiveFilter]   = useState<string>('indexes')  // default: INDEXES
  const [searchText,     setSearchText]     = useState('')
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null)
  const [showCommFlow,   setShowCommFlow]   = useState(false)

  // ── Data fetch ───────────────────────────────────────────────────────────────
  const fetchData = useCallback(async () => {
    setIsLoading(true)
    try {
      const res = await fetch('/api/macro-positioning', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setData(await res.json() as MacroPositioningData)
    } catch (err) {
      console.warn('[MacroPositioningPanel] fetch failed:', err)
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const t = setInterval(fetchData, 15 * 60_000)
    return () => clearInterval(t)
  }, [fetchData])

  // ── Filter ───────────────────────────────────────────────────────────────────
  const filteredRows = useMemo<PositioningRow[]>(() => {
    const rows = data?.rows ?? []
    return rows.filter(row => {
      if (activeFilter !== 'ALL' && row.category !== activeFilter) return false
      if (searchText.trim()) {
        const q = searchText.trim().toUpperCase()
        return row.symbol.toUpperCase().includes(q) || row.label.toUpperCase().includes(q)
      }
      return true
    })
  }, [data?.rows, activeFilter, searchText])

  // Group by section in canonical order (always, even in filtered view)
  const sections = useMemo(() =>
    SECTION_ORDER
      .map(cat => ({ cat, rows: filteredRows.filter(r => r.category === cat) }))
      .filter(s => s.rows.length > 0),
  [filteredRows])

  // ── Render ───────────────────────────────────────────────────────────────────
  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl flex flex-col">

      {/* ── Header ────────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-[#1a2540] shrink-0">
        <div>
          <div className="flex items-baseline gap-2.5 flex-wrap">
            <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
              CFTC / COT — Institutional Positioning
            </h3>
            <span className="text-[10px] font-mono text-slate-600">3-yr scale · 13-wk extreme · weekly CFTC</span>
            {data?.timestamp && (
              <span className="text-[10px] font-mono text-slate-700">
                · {new Date(data.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <DataBadge status={data?.status} />
          {isLoading && <span className="text-[11px] font-mono text-slate-500 animate-pulse">fetching…</span>}
        </div>
      </div>

      {/* ── Filter strip ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 border-b border-[#1a2540] bg-[#080d18]/60 shrink-0">
        <div className="flex flex-wrap items-center gap-1.5">
          {CAT_CHIPS.map(chip => {
            const isActive = activeFilter === chip.key
            const meta     = chip.key !== 'ALL' ? SECTION_META[chip.key as Category] : null
            return (
              <button
                key={chip.key}
                onClick={() => { setActiveFilter(chip.key); setSearchText(''); setExpandedSymbol(null) }}
                className="text-[11px] font-mono px-2.5 py-0.5 rounded-md border transition-all duration-150 uppercase tracking-wider font-bold whitespace-nowrap"
                style={isActive
                  ? { backgroundColor: meta?.bg ?? '#ffffff18', color: meta?.text ?? '#f1f5f9', borderColor: meta?.border ?? '#ffffff40', boxShadow: meta ? `0 0 8px ${meta.accent}30` : undefined }
                  : { backgroundColor: 'transparent', color: '#475569', borderColor: '#1e293b' }
                }
              >
                {chip.label}
              </button>
            )
          })}
        </div>

        <div className="h-4 w-px bg-[#1a2540] hidden sm:block" />

        {/* Search */}
        <div className="relative flex items-center">
          <svg className="absolute left-2 w-3 h-3 text-slate-500 pointer-events-none" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11A6 6 0 1 1 5 11a6 6 0 0 1 12 0z" />
          </svg>
          <input
            type="text"
            value={searchText}
            onChange={e => { setSearchText(e.target.value); setActiveFilter('ALL'); setExpandedSymbol(null) }}
            placeholder="Search assets…"
            className="pl-6 pr-3 py-1 bg-[#080d18] border border-[#1a2540] rounded-md text-[12px] font-mono text-slate-300 placeholder-slate-600 focus:outline-none focus:border-[#2a3f64] w-32 transition-colors"
          />
          {searchText && (
            <button onClick={() => setSearchText('')} className="absolute right-2 text-slate-500 hover:text-slate-300 transition-colors">
              <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          )}
        </div>

        {/* Commercial Flow toggle */}
        <button
          onClick={() => setShowCommFlow(v => !v)}
          className="text-[11px] font-mono px-2.5 py-0.5 rounded-md border transition-all duration-150 uppercase tracking-wider font-bold whitespace-nowrap"
          style={showCommFlow
            ? { backgroundColor: '#f59e0b15', color: '#fbbf24', borderColor: '#f59e0b40', boxShadow: '0 0 8px #f59e0b20' }
            : { backgroundColor: 'transparent', color: '#475569', borderColor: '#1e293b' }
          }
          title="Highlight rows where commercials oppose leveraged funds"
        >
          {showCommFlow ? '↕ COMM FLOW ON' : '↕ COMM FLOW'}
        </button>

        {data && (
          <span className="ml-auto text-[11px] font-mono text-slate-600 shrink-0">
            {data.liveCount}/{data.totalCount} live
          </span>
        )}
      </div>

      {/* ── Column headers ─────────────────────────────────────────────────────── */}
      {/* overflow-visible so the tooltip can escape downward into the table area */}
      <div
        className="grid px-4 py-1.5 border-b border-[#1a2540] bg-[#080d18]/40 shrink-0 overflow-visible"
        style={{ gridTemplateColumns: GRID_COLS }}
      >
        {COL_DEFS.map(col => (
          <ColHeader key={col.label} label={col.label} tooltip={col.tooltip} />
        ))}
      </div>

      {/* ── Scrollable body ────────────────────────────────────────────────────── */}
      <div className="overflow-y-auto overflow-x-hidden" style={{ maxHeight: '520px' }}>

        {isLoading && !data ? (
          <div>
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="grid px-4 py-2.5 border-b border-[#1a2540]/50 animate-pulse" style={{ gridTemplateColumns: GRID_COLS }}>
                {Array.from({ length: 7 }).map((_, j) => (
                  <div key={j} className="h-4 bg-[#1a2540] rounded w-3/4" />
                ))}
              </div>
            ))}
          </div>

        ) : filteredRows.length === 0 ? (
          <div className="px-4 py-10 text-center text-[10px] text-slate-500 font-mono">
            No contracts match "{searchText || activeFilter}"
          </div>

        ) : (
          <div>
            {sections.map(({ cat, rows }) => (
              <div key={cat}>
                <SectionHeader category={cat} count={rows.length} />

                <div className="divide-y divide-[#1a2540]/40">
                  {rows.map((row, idx) => {
                    const meta       = SECTION_META[row.category as Category] ?? SECTION_META.commodity
                    const velStyle   = VELOCITY_STYLE[row.accelerationGlyph]
                    const netColor   = row.leveragedNet >= 0 ? '#34d399' : '#f87171'
                    const chgColor   = row.weeklyChange  >= 0 ? '#34d399' : '#f87171'
                    const commColor  = row.commercialNet >= 0 ? '#34d399' : '#f87171'
                    const isExpanded = expandedSymbol === row.symbol

                    // Commercial Flow: commercials opposing leveraged funds?
                    const isOpposed = (row.leveragedNet > 0 && row.commercialNet < 0) ||
                                      (row.leveragedNet < 0 && row.commercialNet > 0)

                    // Overhang %OI
                    const overhangPct = row.openInterest > 0
                      ? (Math.abs(row.leveragedNet) / row.openInterest) * 100
                      : null
                    const overhangColor = overhangPct === null   ? '#475569'
                      : overhangPct > 25                         ? '#f87171'
                      : overhangPct > 10                         ? '#fbbf24'
                      :                                            '#475569'

                    return (
                      <div
                        key={row.symbol ?? idx}
                        className={`transition-colors ${isExpanded ? 'bg-[#0d1629]/80' : ''} ${showCommFlow && isOpposed ? 'border-l-2' : ''}`}
                        style={showCommFlow && isOpposed ? { borderLeftColor: '#f59e0b80' } : undefined}
                      >

                        {/* Main row */}
                        <div
                          className="grid px-4 py-2 cursor-pointer hover:bg-[#0d1629]/60 transition-colors"
                          style={{ gridTemplateColumns: GRID_COLS }}
                          onClick={() => setExpandedSymbol(isExpanded ? null : row.symbol)}
                        >

                          {/* ASSET */}
                          <div className="flex items-center gap-2 min-w-0 pr-2">
                            <svg
                              className="w-2 h-2 shrink-0 transition-transform duration-200"
                              style={{ color: '#334155', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                            </svg>
                            <div
                              className="shrink-0 px-1.5 py-0.5 rounded text-[11px] font-mono font-bold uppercase tracking-wider border"
                              style={{ color: meta.text, borderColor: meta.border, backgroundColor: meta.bg }}
                            >
                              {row.symbol}
                            </div>
                            <div className="min-w-0">
                              <div className="text-[10px] text-slate-300 font-mono truncate leading-tight">{row.label}</div>
                            </div>
                          </div>

                          {/* MM NET  +  wk Δ sub-line  +  OI exhaustion badge */}
                          <div className="flex flex-col justify-center gap-0.5">
                            <div className="flex items-center gap-1">
                              <span className="text-[12px] font-mono font-bold tabular-nums leading-none" style={{ color: netColor }}>
                                {row.leveragedNetFormatted}
                              </span>
                              {row.exhaustion && <OIExhaustionBadge />}
                            </div>
                            <span className="text-[10px] font-mono tabular-nums leading-none" style={{ color: chgColor + 'aa' }}>
                              {row.weeklyChangeFormatted}
                            </span>
                          </div>

                          {/* COMM. DELTA */}
                          <div className="flex flex-col justify-center gap-0.5">
                            <span
                              className="text-[12px] font-mono font-semibold tabular-nums leading-none"
                              style={{ color: commColor }}
                            >
                              {fmtKClient(row.commercialNet)}
                            </span>
                            {showCommFlow && isOpposed && (
                              <span
                                className="text-[9px] font-mono font-bold uppercase tracking-wider leading-none"
                                style={{ color: '#fbbf24' }}
                              >
                                ↕ OPP
                              </span>
                            )}
                          </div>

                          {/* OVERHANG %OI */}
                          <div className="flex flex-col justify-center">
                            {overhangPct !== null ? (
                              <span
                                className="text-[12px] font-mono font-semibold tabular-nums"
                                style={{ color: overhangColor }}
                              >
                                {overhangPct.toFixed(1)}%
                              </span>
                            ) : (
                              <span className="text-[12px] font-mono text-slate-600">—</span>
                            )}
                          </div>

                          {/* POSITIONING SCALE — bar + centred percentile only */}
                          <div className="flex flex-col justify-center gap-1 pr-3">
                            <PositioningBar positioningScale={row.positioningScale} zeroLinePosition={row.zeroLinePosition} />
                            <div className="text-center text-[10px] font-mono tabular-nums"
                              style={{ color: row.positioningScale >= row.zeroLinePosition ? '#34d399cc' : '#f87171cc' }}>
                              {row.positioningScale.toFixed(0)}%
                            </div>
                          </div>

                          {/* VELOCITY */}
                          <div className="flex items-center">
                            <span
                              className="text-[15px] font-mono leading-none"
                              style={{ color: velStyle.color, textShadow: velStyle.glow ? `0 0 8px ${velStyle.glow}` : undefined }}
                            >
                              {row.accelerationGlyph}
                            </span>
                          </div>

                          {/* REGIME */}
                          <div className="flex items-center">
                            <RegimeBadge row={row} />
                          </div>

                        </div>

                        {/* Accordion drawer */}
                        {isExpanded && <AccordionDrawer row={row} />}

                      </div>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Sector Breadth ────────────────────────────────────────────────────── */}
      {data && data.rows.length > 0 && <SectorBreadth rows={data.rows} />}

      {/* ── Footer ────────────────────────────────────────────────────────────── */}
      <div className="px-4 py-2 border-t border-[#1a2540] bg-[#080d18]/40 flex items-center justify-between gap-2 flex-wrap shrink-0">
        <p className="text-[10px] font-mono text-slate-700">
          <span style={{ color: '#34d39960' }}>■</span> BULL EXPANSION &nbsp;·&nbsp;
          <span style={{ color: '#f8717160' }}>■</span> BEAR CONTRACTION &nbsp;·&nbsp;
          <span style={{ color: '#fbbf2460' }}>■</span> SHORT SQUEEZE = forced covering &nbsp;·&nbsp;
          <span style={{ color: '#f9731660' }}>OI↓</span> = exhaustion
        </p>
        {data?.liveCount != null && (
          <span className="text-[11px] font-mono text-slate-600 shrink-0">
            {data.liveCount}/{data.totalCount} series live
          </span>
        )}
      </div>

    </div>
  )
}
