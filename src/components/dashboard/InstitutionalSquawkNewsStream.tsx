'use client'

import { useRef, useId } from 'react'
import { useFedLiquidity } from '@/lib/hooks/useFedLiquidity'

// ─── Types (re-exported from shared server-safe module) ───────────────────────
// All interfaces and SQUAWK_NEWS_MOCK now live in @/lib/squawk-types so API
// routes can import them without crossing the 'use client' boundary.

export type {
  SquawkArticle,
  TopMover,
  FedLiquidityDiagnostic,
  FedLiquidityMeta,
  FedLiquiditySnapshot,
  SquawkNewsData,
} from '@/lib/squawk-types'

export { SQUAWK_NEWS_MOCK } from '@/lib/squawk-types'

// ─── Local imports for internal use ──────────────────────────────────────────
import type {
  SquawkArticle,
  TopMover,
  FedLiquiditySnapshot,
  SquawkNewsData,
} from '@/lib/squawk-types'
import { SQUAWK_NEWS_MOCK } from '@/lib/squawk-types'

// ─── Whitelist Firewall ────────────────────────────────────────────────────────

const ALLOWED_SOURCES = [
  { handle: '@zerohedge', name: 'ZeroHedge', color: '#94a3b8' },
  { handle: '@FirstSquawk', name: 'First Squawk', color: '#60a5fa' },
  { handle: '@FinancialJuice', name: 'FinancialJuice', color: '#34d399' },
  { handle: '@DeltaOne', name: 'DeltaOne', color: '#fbbf24' },
  { handle: 'BLOOMBERG', name: 'Bloomberg Terminal', color: '#fbbf24', isBloomberg: true },
]

// ─── Headline Sanitization ────────────────────────────────────────────────────
// Uses String.fromCharCode to avoid parser conflicts with literal quote chars.
// fromCharCode(39) = single quote | fromCharCode(34) = double quote

const sanitizeHeadlineText = (text: string): string => {
  if (!text) return ""
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&#x2019;/g, String.fromCharCode(39))
    .replace(/&#x201C;/g, String.fromCharCode(34))
    .replace(/&#x201D;/g, String.fromCharCode(34))
    .replace(/&#x2014;/g, " — ")
}

// (Mock data lives in @/lib/squawk-types and is imported as SQUAWK_NEWS_MOCK above)

// ─── Top Movers Card ───────────────────────────────────────────────────────────

function TopMoversCard({ movers }: { movers: TopMover[] }) {
  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4">
      <div className="mb-4">
        <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
          🔥 Top 5 Market Movers · 3-Minute Heatmap
        </h3>
        <p className="text-[12px] text-slate-400 font-mono mt-1">
          Algorithmic keyword heat-mapping across whitelisted institutional sources
        </p>
      </div>

      <div className="space-y-2">
        {(movers || []).map((mover, idx) => {
          const heatColor = mover.heatScore >= 80 ? '#f87171' : mover.heatScore >= 65 ? '#fbbf24' : '#34d399'
          return (
            <div
              key={idx}
              className="border border-[#1a2540] rounded-lg p-3 bg-[#080d18] hover:border-[#2a3f64] transition-colors"
            >
              <div className="flex items-start gap-3">
                {/* Rank circle */}
                <div
                  className="flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center font-mono text-[10px] font-bold text-white"
                  style={{ backgroundColor: heatColor }}
                >
                  {mover.rank}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="font-mono text-[10px] font-bold text-amber-400 uppercase tracking-wider">
                      {mover.keyword}
                    </span>
                    <div className="flex items-center gap-1 flex-wrap">
                      {mover.sources.map((src) => {
                        const srcConfig = ALLOWED_SOURCES.find((s) => s.handle === src || s.name === src)
                        return (
                          <span
                            key={src}
                            className="text-[11px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wider border"
                            style={{
                              color: srcConfig?.color || '#94a3b8',
                              borderColor: `${srcConfig?.color || '#94a3b8'}40`,
                              backgroundColor: `${srcConfig?.color || '#94a3b8'}10`,
                            }}
                          >
                            {srcConfig?.isBloomberg ? '📊 BLOOMBERG' : src}
                          </span>
                        )
                      })}
                    </div>
                  </div>

                  <p className="text-[10px] text-slate-300 font-mono leading-snug mb-2">{sanitizeHeadlineText(mover.headline)}</p>

                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-slate-500 font-mono">
                      {new Date(mover.latestTimestamp).toLocaleTimeString('en-US', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                        hour12: false,
                      })}
                    </span>
                    <div className="flex items-center gap-1">
                      <div className="h-1.5 w-20 bg-[#1a2540] rounded-full overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{ width: `${mover.heatScore}%`, backgroundColor: heatColor }}
                        />
                      </div>
                      <span className="text-[11px] text-slate-400 font-mono tabular-nums w-8 text-right">
                        {mover.heatScore}°
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── News Terminal Feed ────────────────────────────────────────────────────────

function NewsTerminalFeed({ articles }: { articles: SquawkArticle[] }) {
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const uid = useId()

  return (
    <div className="bg-[#0c1221] border border-[#1a2540] rounded-2xl p-4">
      <div className="mb-4">
        <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
          ⚡ Institutional Squawk Feed · Live Terminal
        </h3>
        <p className="text-[12px] text-slate-400 font-mono mt-1">
          Whitelisted sources: ZeroHedge · First Squawk · FinancialJuice · DeltaOne · Bloomberg Terminal
        </p>
      </div>

      <div
        ref={scrollContainerRef}
        className="h-[380px] overflow-y-auto border border-[#1a2540] rounded-lg bg-[#080d18] p-3 space-y-2"
        style={{
          scrollBehavior: 'smooth',
          backgroundImage: `repeating-linear-gradient(
            0deg,
            transparent,
            transparent 1.5rem,
            #1a2540 1.5rem,
            #1a2540 1px
          )`,
        }}
      >
        {(articles || []).map((article) => {
          const sourceConfig = ALLOWED_SOURCES.find(
            (s) => s.handle === article.sourceHandle || s.name === article.source
          )
          const importanceColor =
            article.importance === 'high' ? '#f87171' : article.importance === 'medium' ? '#fbbf24' : '#34d399'

          return (
            <div key={article.id} className="border-l-2 px-3 py-2 rounded-sm" style={{ borderColor: importanceColor }}>
              {/* Header: Time + Source + Importance */}
              <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
                <span className="text-[11px] font-mono text-slate-500 tracking-wider">
                  {new Date(article.timestamp).toLocaleTimeString('en-US', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hour12: false,
                  })}
                </span>
                {sourceConfig && (
                  <span
                    className="text-[12px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wider border font-bold"
                    style={{
                      color: sourceConfig.color,
                      borderColor: `${sourceConfig.color}50`,
                      backgroundColor: `${sourceConfig.color}12`,
                    }}
                  >
                    {sourceConfig.isBloomberg ? '📊 BLOOMBERG' : sourceConfig.handle}
                  </span>
                )}
                <span
                  className="text-[11px] font-mono px-1.5 py-0.5 rounded uppercase tracking-wider border"
                  style={{ color: importanceColor, borderColor: `${importanceColor}40`, backgroundColor: `${importanceColor}10` }}
                >
                  {article.importance.toUpperCase()}
                </span>
              </div>

              {/* Headline */}
              <p className="text-[10px] text-slate-200 font-mono leading-snug mb-2">
                {sanitizeHeadlineText(article.headline)}
              </p>

              {/* Keywords */}
              {article.macroKeywords.length > 0 && (
                <div className="flex items-center gap-1 flex-wrap">
                  {article.macroKeywords.map((kw) => (
                    <span
                      key={kw}
                      className="text-[11px] font-mono px-1 py-0.5 rounded border border-slate-600 text-slate-400 uppercase tracking-wider"
                    >
                      #{kw}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── Federal Reserve Liquidity Monitor ──────────────────────────────────────────

// ─── Verification Badge ───────────────────────────────────────────────────────

function DataSourceBadge({ meta }: { meta?: FedLiquiditySnapshot['meta'] }) {
  const isLive = meta?.status === 'AUTHENTICATED'

  if (isLive) {
    return (
      <div
        className="flex items-center gap-1 px-1.5 py-0.5 rounded-md border"
        style={{
          borderColor: '#34d39960',
          backgroundColor: '#34d39912',
        }}
        title={`FRED API · WALCL as of ${meta?.seriesDates.walcl ?? '—'} · fetched ${meta?.timestamp ? new Date(meta.timestamp).toLocaleTimeString() : '—'}`}
      >
        {/* Glowing green dot */}
        <span
          className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
          style={{
            backgroundColor: '#34d399',
            boxShadow: '0 0 6px #34d399, 0 0 12px #34d39980',
          }}
        />
        <span className="text-[11px] font-mono font-bold tracking-widest uppercase text-emerald-400">
          REAL-TIME FRED
        </span>
      </div>
    )
  }

  return (
    <div
      className="flex items-center gap-1 px-1.5 py-0.5 rounded-md border"
      style={{ borderColor: '#fbbf2460', backgroundColor: '#fbbf2410' }}
      title="Add FRED_API_KEY to .env.local to enable live data"
    >
      <span
        className="inline-block w-1.5 h-1.5 rounded-full border flex-shrink-0"
        style={{ borderColor: '#fbbf24' }}
      />
      <span className="text-[11px] font-mono font-bold tracking-widest uppercase text-amber-400">
        DEMO / FALLBACK
      </span>
    </div>
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
      {/* Series ID chip */}
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

function FedLiquidityMonitor({
  snapshot,
  isLoading = false,
}: {
  snapshot: FedLiquiditySnapshot
  isLoading?: boolean
}) {
  const momentumColor =
    snapshot.momentumDirection === 'expanding'   ? '#34d399' :
    snapshot.momentumDirection === 'contracting' ? '#f87171' : '#94a3b8'

  const momentumArrow =
    snapshot.momentumDirection === 'expanding'   ? '▲' :
    snapshot.momentumDirection === 'contracting' ? '▼' : '→'

  const sd = snapshot.meta?.seriesDates

  return (
    <div
      className="bg-[#0c1221] border rounded-2xl p-4 transition-colors duration-500"
      style={{
        borderColor: snapshot.meta?.status === 'AUTHENTICATED' ? '#34d39930' : '#1a2540',
      }}
    >
      {/* ── Header ── */}
      <div className="flex items-start justify-between mb-4 gap-2">
        <div className="min-w-0">
          <h3 className="text-[10px] font-mono text-amber-400/80 uppercase tracking-widest">
            Federal Reserve Liquidity Monitor
          </h3>
          <p className="text-[12px] text-slate-400 font-mono mt-1">
            Net Liquidity = WALCL − WTREGEN − RRPONTSYD
          </p>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          {isLoading && (
            <span className="text-[11px] font-mono text-slate-500 animate-pulse">
              fetching…
            </span>
          )}
          <DataSourceBadge meta={snapshot.meta} />
        </div>
      </div>

      {/* ── Metric Grid ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <LiquidityCard
          label="Fed Balance Sheet Total Assets"
          seriesId="WALCL"
          value={`$${(snapshot.balanceSheetTotal / 1_000).toFixed(2)}T`}
          sub={`As of ${snapshot.date}`}
          seriesDate={sd?.walcl !== '—' ? sd?.walcl : undefined}
          large
        />

        <LiquidityCard
          label="Net Liquidity Gauge"
          seriesId="WALCL − WTREGEN − RRPONTSYD"
          value={`$${(snapshot.netLiquidity / 1_000).toFixed(2)}T`}
          sub="Global dollar engine"
          valueColor="#34d399"
          large
        />

        <LiquidityCard
          label="Treasury General Account"
          seriesId={snapshot.meta?.diagnostics?.tga.resolvedSeriesId ?? 'WTREGEN'}
          value={`$${(snapshot.tga / 1_000).toFixed(2)}T${snapshot.meta?.diagnostics?.tga.usedFallback ? '*' : ''}`}
          sub={
            snapshot.meta?.diagnostics?.tga.usedFallback && snapshot.meta.diagnostics.tga.ok
              ? `via ${snapshot.meta.diagnostics.tga.resolvedSeriesId} fallback`
              : 'Capital reserves'
          }
          seriesDate={sd?.wtregen !== '—' ? sd?.wtregen : undefined}
        />

        <LiquidityCard
          label="Reverse Repo Outstanding"
          seriesId="RRPONTSYD"
          value={`$${(snapshot.rrp / 1_000).toFixed(2)}T`}
          sub="Short-term operations"
          seriesDate={sd?.rrpontsyd !== '—' ? sd?.rrpontsyd : undefined}
        />
      </div>

      {/* ── 14-Day Momentum Footer ── */}
      <div className="mt-4 pt-3 border-t border-[#1a2540] flex items-center justify-between">
        <div>
          <span className="text-[12px] text-slate-400 font-mono uppercase tracking-wider">
            14-Day Momentum · WALCL
          </span>
          {snapshot.meta?.status === 'AUTHENTICATED' && (
            <span className="ml-2 text-[10px] font-mono text-slate-600">
              live calculation
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xl font-mono font-bold" style={{ color: momentumColor }}>
            {momentumArrow}
          </span>
          <span className="font-mono text-sm font-bold" style={{ color: momentumColor }}>
            {snapshot.momentum14d >= 0 ? '+' : ''}{snapshot.momentum14d.toFixed(2)}%
          </span>
          <span
            className="text-[11px] font-mono px-1.5 py-0.5 rounded border"
            style={{
              color: momentumColor,
              borderColor: `${momentumColor}50`,
              backgroundColor: `${momentumColor}10`,
            }}
          >
            {snapshot.momentumDirection.toUpperCase()}
          </span>
        </div>
      </div>
    </div>
  )
}


// ─── Main Component ────────────────────────────────────────────────────────────

export interface InstitutionalSquawkNewsStreamProps {
  data?: SquawkNewsData
}

export function InstitutionalSquawkNewsStream({
  data = SQUAWK_NEWS_MOCK,
}: InstitutionalSquawkNewsStreamProps) {
  // Fed Liquidity has its own dedicated fetch pipeline – independent of the
  // squawk bundle – so it can show a verified AUTHENTICATED badge.
  const { snapshot: fedSnapshot, isLoading: fedLoading } = useFedLiquidity(5 * 60_000)

  return (
    <section className="space-y-3">
      {/* Top 5 Movers */}
      <TopMoversCard movers={data.topMovers} />

      {/* News Terminal Feed */}
      <NewsTerminalFeed articles={data.articles} />

      {/* Fed Liquidity Monitor */}
      <FedLiquidityMonitor snapshot={fedSnapshot} isLoading={fedLoading} />
    </section>
  )
}
