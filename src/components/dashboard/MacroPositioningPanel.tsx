'use client'

import { useState, useEffect, useCallback, useMemo } from 'react'
import type { PositioningRow, MacroPositioningData, AccelGlyph } from '@/app/api/macro-positioning/route'

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

function TriggerTooltip() {
  return (
    <TooltipShell title="Divergence Signal" align="right">
      <div className="flex items-start gap-2.5">
        <div className="shrink-0 mt-0.5">
          <div className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[11px] font-mono font-bold" style={{ backgroundColor: '#fbbf2410', borderColor: '#fbbf2450', color: '#fbbf24' }}>
            ⚡ REVERSAL SQUEEZE
          </div>
        </div>
      </div>
      <p className="text-[11px] font-mono text-slate-400 leading-snug">
        Fires when <span className="text-slate-300">COT Index is at a multi-year extreme</span> (&lt;10% or &gt;90%) AND <span className="text-slate-300">commercials are positioned opposite</span> leveraged funds.
      </p>
      <TDivider />
      <p className="text-[11px] font-mono text-slate-400 leading-snug">
        Strategy: <span className="text-slate-300">Contrarian fade.</span> The crowd is maximally one-sided while informed hedgers lean the other way — historically a high-probability mean-reversion setup.
      </p>
      <TDivider />
      <p className="text-[10px] font-mono text-slate-600">— = No active setup. Position within historical norms.</p>
    </TooltipShell>
  )
}

// ─── Column header cell ───────────────────────────────────────────────────────

type ColDef = { label: string; tooltip?: React.ReactNode }

const COL_DEFS: ColDef[] = [
  { label: 'ASSET'             },
  { label: 'LEV. FUNDS NET',    tooltip: <LevFundsTooltip />    },
  { label: 'WK/WK CHANGE',      tooltip: <WkChangeTooltip />    },
  { label: 'POSITIONING SCALE', tooltip: <ScaleTooltip />       },
  { label: '1W VELOCITY',       tooltip: <VelocityTooltip />    },
  { label: 'TRIGGER',           tooltip: <TriggerTooltip />     },
]

function ColHeader({ label, tooltip }: ColDef) {
  if (!tooltip) {
    return <div className="text-[10px] font-mono text-slate-500 uppercase tracking-[0.18em]">{label}</div>
  }
  return (
    <div className="relative group flex items-center gap-1 cursor-default select-none">
      <span className="text-[10px] font-mono text-slate-500 uppercase tracking-[0.18em]">{label}</span>
      {/* Info icon — dims to 40% opacity at rest, full on hover */}
      <svg
        className="w-2.5 h-2.5 shrink-0 opacity-40 group-hover:opacity-100 transition-opacity"
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

// ─── Trigger badge ────────────────────────────────────────────────────────────

function TriggerBadge({ squeeze }: { squeeze: 'SQUEEZE' | null }) {
  if (!squeeze) return <span className="text-slate-600 font-mono text-[11px]">—</span>
  return (
    <div
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded border"
      style={{ backgroundColor: '#fbbf2410', borderColor: '#fbbf2450', boxShadow: '0 0 8px #fbbf2420' }}
    >
      <span className="text-[10px]">⚡</span>
      <span className="text-[12px] font-mono font-bold text-amber-400 tracking-wider uppercase">REVERSAL SQUEEZE</span>
    </div>
  )
}

// ─── Data-source badge ────────────────────────────────────────────────────────

function DataBadge({ status }: { status: MacroPositioningData['status'] | undefined }) {
  if (status === 'AUTHENTICATED') {
    return (
      <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md border shrink-0" style={{ borderColor:'#34d39960', backgroundColor:'#34d39912' }}>
        <span className="w-1.5 h-1.5 rounded-full inline-block shrink-0" style={{ backgroundColor:'#34d399', boxShadow:'0 0 6px #34d399, 0 0 12px #34d39980' }} />
        <span className="text-[11px] font-mono font-bold text-emerald-400 tracking-widest uppercase">LIVE · CFTC</span>
      </div>
    )
  }
  return (
    <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md border shrink-0" style={{ borderColor:'#fbbf2460', backgroundColor:'#fbbf2410' }}>
      <span className="w-1.5 h-1.5 rounded-full border inline-block shrink-0" style={{ borderColor:'#fbbf24' }} />
      <span className="text-[11px] font-mono font-bold text-amber-400 tracking-widest uppercase">DEMO / FALLBACK</span>
    </div>
  )
}

// ─── Accordion drawer ─────────────────────────────────────────────────────────

function AccordionDrawer({ row }: { row: PositioningRow }) {
  const commColor = row.commercialNet >= 0 ? '#34d399' : '#f87171'
  const oiColor   = row.openInterestChange >= 0 ? '#34d399' : '#f87171'
  const biasColor = row.marketBias === 'LONG' ? '#34d399' : row.marketBias === 'SHORT' ? '#f87171' : '#fbbf24'

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
          <div className="text-[10px] font-mono text-slate-500 uppercase tracking-[0.18em] mb-1">MARKET BIAS</div>
          <div className="text-[13px] font-mono font-bold" style={{ color: biasColor }}>{row.marketBias}</div>
          <div className="text-[10px] font-mono text-slate-600 mt-0.5">lev fund direction</div>
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

// ─── Main panel ───────────────────────────────────────────────────────────────

const GRID_COLS = '11rem 6.5rem 6.5rem 1fr 5.5rem 9rem'

export function MacroPositioningPanel() {
  const [data,           setData]           = useState<MacroPositioningData | null>(null)
  const [isLoading,      setIsLoading]      = useState(true)
  const [activeFilter,   setActiveFilter]   = useState<string>('indexes')  // default: INDEXES
  const [searchText,     setSearchText]     = useState('')
  const [expandedSymbol, setExpandedSymbol] = useState<string | null>(null)

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
          <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
            CFTC / COT — Institutional Positioning Matrix
          </h3>
          <p className="text-[12px] text-slate-500 font-mono mt-0.5">
            Leveraged fund net · 3-yr percentile · 1-week velocity · divergence signal
            {data?.timestamp && (
              <span className="ml-2 text-slate-600">
                · refreshed {new Date(data.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
              </span>
            )}
          </p>
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
              <div key={i} className="grid px-4 py-3 border-b border-[#1a2540]/50 animate-pulse" style={{ gridTemplateColumns: GRID_COLS }}>
                {Array.from({ length: 6 }).map((_, j) => (
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
                    const meta     = SECTION_META[row.category as Category] ?? SECTION_META.commodity
                    const velStyle = VELOCITY_STYLE[row.accelerationGlyph]
                    const netColor = row.leveragedNet >= 0 ? '#34d399' : '#f87171'
                    const chgColor = row.weeklyChange  >= 0 ? '#34d399' : '#f87171'
                    const isExpanded = expandedSymbol === row.symbol

                    return (
                      <div key={row.symbol ?? idx} className={`transition-colors ${isExpanded ? 'bg-[#0d1629]/80' : ''}`}>

                        {/* Main row */}
                        <div
                          className="grid px-4 py-2.5 cursor-pointer hover:bg-[#0d1629]/60 transition-colors"
                          style={{ gridTemplateColumns: GRID_COLS }}
                          onClick={() => setExpandedSymbol(isExpanded ? null : row.symbol)}
                        >

                          {/* ASSET */}
                          <div className="flex items-center gap-2 min-w-0 pr-2">
                            <svg
                              className="w-2.5 h-2.5 shrink-0 transition-transform duration-200"
                              style={{ color: '#334155', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}
                              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                            </svg>
                            <div
                              className="shrink-0 px-1.5 py-0.5 rounded text-[12px] font-mono font-bold uppercase tracking-wider border"
                              style={{ color: meta.text, borderColor: meta.border, backgroundColor: meta.bg }}
                            >
                              {row.symbol}
                            </div>
                            <div className="min-w-0">
                              <div className="text-[10px] text-slate-200 font-mono truncate leading-tight">{row.label}</div>
                            </div>
                          </div>

                          {/* LEV. FUNDS NET */}
                          <div className="flex flex-col justify-center">
                            <span className="text-[13px] font-mono font-bold tabular-nums leading-tight" style={{ color: netColor }}>
                              {row.leveragedNetFormatted}
                            </span>
                          </div>

                          {/* WK/WK CHANGE */}
                          <div className="flex flex-col justify-center">
                            <span className="text-[11px] font-mono font-semibold tabular-nums" style={{ color: chgColor }}>
                              {row.weeklyChangeFormatted}
                            </span>
                          </div>

                          {/* POSITIONING SCALE */}
                          <div className="flex flex-col justify-center gap-1 pr-4">
                            <PositioningBar positioningScale={row.positioningScale} zeroLinePosition={row.zeroLinePosition} />
                            <div className="flex items-center justify-between text-[10px] font-mono tabular-nums">
                              <span className="text-red-900/80">◀ SHORT</span>
                              <span style={{ color: row.positioningScale >= row.zeroLinePosition ? '#34d399' : '#f87171' }}>
                                {row.positioningScale.toFixed(1)}%
                              </span>
                              <span className="text-emerald-900/80">LONG ▶</span>
                            </div>
                          </div>

                          {/* 1W VELOCITY */}
                          <div className="flex items-center">
                            <span
                              className="text-[16px] font-mono leading-none"
                              style={{ color: velStyle.color, textShadow: velStyle.glow ? `0 0 8px ${velStyle.glow}` : undefined }}
                            >
                              {row.accelerationGlyph}
                            </span>
                          </div>

                          {/* TRIGGER */}
                          <div className="flex items-center">
                            <TriggerBadge squeeze={row.divergenceVector} />
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

      {/* ── Footer ────────────────────────────────────────────────────────────── */}
      <div className="px-4 py-2 border-t border-[#1a2540] bg-[#080d18]/40 flex items-center justify-between gap-2 flex-wrap shrink-0">
        <p className="text-[11px] font-mono text-slate-600">
          ⚡ REVERSAL SQUEEZE = COT Index at multi-year extreme (&lt;10% or &gt;90%) with commercials positioned opposite leveraged funds.
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
