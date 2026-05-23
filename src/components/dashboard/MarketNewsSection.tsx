'use client'

/**
 * MarketNewsSection
 *
 * Bloomberg Terminal × Robinhood style market intelligence panel.
 * Aggregates headlines from 8+ financial RSS feeds + key X accounts,
 * categorized and summarized by Claude into:
 *   GEOPOLITICS · MACRO · EARNINGS · SENTIMENT
 *
 * Refreshes every 5 minutes (news cache on server is also 5 min).
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { NewsResponse, NewsArticle, ArticleCategory } from '@/app/api/news/route'

// ─── Constants ────────────────────────────────────────────────────────────────

const REFRESH_MS = 5 * 60 * 1_000   // 5 min client-side refresh

type Tab = 'all' | ArticleCategory

// ─── Category Config ──────────────────────────────────────────────────────────

const CATEGORY_CONFIG = {
  geopolitics: {
    label:     'GEOPOLITICS',
    short:     'GEO',
    icon:      '⬡',
    color:     '#f97316',   // orange
    dim:       'text-orange-500/70',
    badge:     'bg-orange-500/10 text-orange-400 border-orange-500/20',
    border:    'border-orange-500/30',
    glow:      'bg-orange-500/5',
  },
  macro: {
    label:     'MACRO',
    short:     'MAC',
    icon:      '◈',
    color:     '#38bdf8',   // sky
    dim:       'text-sky-400/70',
    badge:     'bg-sky-500/10 text-sky-400 border-sky-500/20',
    border:    'border-sky-500/30',
    glow:      'bg-sky-500/5',
  },
  earnings: {
    label:     'EARNINGS',
    short:     'ERN',
    icon:      '◆',
    color:     '#34d399',   // emerald
    dim:       'text-emerald-400/70',
    badge:     'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    border:    'border-emerald-500/30',
    glow:      'bg-emerald-500/5',
  },
  sentiment: {
    label:     'SENTIMENT',
    short:     'SEN',
    icon:      '◉',
    color:     '#c084fc',   // purple
    dim:       'text-purple-400/70',
    badge:     'bg-purple-500/10 text-purple-400 border-purple-500/20',
    border:    'border-purple-500/30',
    glow:      'bg-purple-500/5',
  },
  other: {
    label:     'OTHER',
    short:     'OTH',
    icon:      '·',
    color:     '#64748b',
    dim:       'text-slate-500',
    badge:     'bg-slate-700/30 text-slate-500 border-slate-600/20',
    border:    'border-slate-500/30',
    glow:      'bg-slate-800/30',
  },
} satisfies Record<ArticleCategory, {
  label: string; short: string; icon: string; color: string
  dim: string; badge: string; border: string; glow: string
}>

const SENTIMENT_CONFIG = {
  'RISK-ON':  { label: 'RISK-ON',  color: '#34d399', bg: 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400', dot: 'bg-emerald-400' },
  'RISK-OFF': { label: 'RISK-OFF', color: '#f87171', bg: 'bg-red-500/10 border-red-500/30 text-red-400',             dot: 'bg-red-400'     },
  'NEUTRAL':  { label: 'NEUTRAL',  color: '#94a3b8', bg: 'bg-slate-700/40 border-slate-600/30 text-slate-400',       dot: 'bg-slate-400'   },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const m    = Math.floor(diff / 60_000)
  const h    = Math.floor(diff / 3_600_000)
  if (diff < 60_000)   return 'just now'
  if (m < 60)          return `${m}m ago`
  if (h < 24)          return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function impactArrow(impact: NewsArticle['marketImpact']): { glyph: string; cls: string } {
  if (impact === 'bullish') return { glyph: '↑', cls: 'text-emerald-400' }
  if (impact === 'bearish') return { glyph: '↓', cls: 'text-red-400'     }
  return                           { glyph: '→', cls: 'text-slate-500'   }
}

// ─── Sub-Components ───────────────────────────────────────────────────────────

function SourceBadge({ article }: { article: NewsArticle }) {
  if (article.sourceType === 'x') {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[12px] text-sky-400/80">
        <span className="text-sky-400 font-bold">𝕏</span>
        {article.handle}
      </span>
    )
  }
  return (
    <span className="font-mono text-[12px] text-slate-500 uppercase tracking-wider">
      {article.source}
    </span>
  )
}

function ArticleRow({ article, index }: { article: NewsArticle; index: number }) {
  const cfg    = CATEGORY_CONFIG[article.category]
  const arrow  = impactArrow(article.marketImpact)
  const isEven = index % 2 === 0

  return (
    <a
      href={article.url !== '#' ? article.url : undefined}
      target="_blank"
      rel="noopener noreferrer"
      className={[
        'group flex items-start gap-3 px-4 py-2.5 border-b border-[#0f1829]',
        'hover:bg-[#0f1829]/60 transition-colors cursor-pointer',
        isEven ? 'bg-[#070d1a]' : 'bg-[#080e1c]',
      ].join(' ')}
    >
      {/* Timestamp */}
      <span className="shrink-0 font-mono text-[12px] text-slate-300 pt-0.5 w-[52px] text-right">
        {relativeTime(article.publishedAt)}
      </span>

      {/* Category stripe */}
      <span
        className="shrink-0 w-[3px] self-stretch rounded-full mt-0.5"
        style={{ backgroundColor: cfg.color + '60' }}
      />

      {/* Content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <p className="font-mono text-[11px] text-slate-300 group-hover:text-white leading-tight transition-colors line-clamp-2">
            {article.title}
          </p>
          <span className={`shrink-0 font-mono text-[11px] font-bold ${arrow.cls}`}>
            {arrow.glyph}
          </span>
        </div>

        <div className="flex items-center gap-2 mt-1">
          <SourceBadge article={article} />
          <span className="text-slate-400 text-[12px]">·</span>
          <span
            className={`font-mono text-[12px] uppercase tracking-widest px-1.5 py-0.5 rounded border ${cfg.badge}`}
          >
            {cfg.short}
          </span>
          {article.summary && (
            <>
              <span className="text-slate-400 text-[12px]">·</span>
              <span className="font-mono text-[12px] text-slate-300 truncate hidden md:block">
                {article.summary}
              </span>
            </>
          )}
        </div>
      </div>
    </a>
  )
}

function CategorySummaryCard({
  category,
  data,
}: {
  category: ArticleCategory
  data: { aiSummary: string; keyEvent: string; count: number }
}) {
  const cfg = CATEGORY_CONFIG[category]

  return (
    <div className={`mx-4 mb-3 rounded-xl border ${cfg.border} ${cfg.glow} p-3.5`}>
      <div className="flex items-center gap-2 mb-2">
        <span style={{ color: cfg.color }} className="text-sm">{cfg.icon}</span>
        <span className="font-mono text-[12px] uppercase tracking-widest" style={{ color: cfg.color }}>
          {cfg.label} SUMMARY
        </span>
        <span className="font-mono text-[12px] text-slate-300 ml-auto">{data.count} events</span>
      </div>
      <p className="font-mono text-[11px] text-slate-300 leading-relaxed mb-2">
        {data.aiSummary}
      </p>
      <div className="flex items-start gap-1.5">
        <span className="font-mono text-[12px] text-slate-300 shrink-0 mt-0.5">KEY EVENT</span>
        <span className="font-mono text-[12px]" style={{ color: cfg.color }}>
          {data.keyEvent}
        </span>
      </div>
    </div>
  )
}

function SkeletonRow() {
  return (
    <div className="flex items-start gap-3 px-4 py-2.5 border-b border-[#0f1829] animate-pulse">
      <div className="w-[52px] h-2.5 bg-slate-800 rounded mt-0.5 shrink-0" />
      <div className="w-[3px] self-stretch bg-slate-800 rounded-full" />
      <div className="flex-1 space-y-1.5">
        <div className="h-2.5 bg-slate-800 rounded w-full" />
        <div className="h-2.5 bg-slate-800 rounded w-3/4" />
        <div className="h-2 bg-slate-800/60 rounded w-1/3" />
      </div>
    </div>
  )
}

function MasterPulseCard({ data }: { data: NewsResponse }) {
  const sc = SENTIMENT_CONFIG[data.marketSentiment]

  return (
    <div className="mx-4 mb-3 rounded-xl bg-[#0a1020] border border-[#1a2540] p-4">
      <div className="flex items-start justify-between gap-4 mb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-amber-400 text-sm">⚡</span>
          <span className="font-mono text-[12px] text-amber-400/80 uppercase tracking-widest">
            Market Pulse
          </span>
          {data.aiEnhanced && (
            <span className="font-mono text-[12px] text-slate-300 border border-slate-500/50 px-1.5 py-0.5 rounded">
              AI
            </span>
          )}
        </div>
        <span className={`font-mono text-[12px] font-bold px-2 py-1 rounded border flex items-center gap-1.5 ${sc.bg}`}>
          <span className={`w-1.5 h-1.5 rounded-full ${sc.dot} ${data.marketSentiment === 'RISK-OFF' ? '' : 'animate-pulse'}`} />
          {sc.label}
        </span>
      </div>

      <p className="font-mono text-[11px] text-slate-300 leading-relaxed mb-3">
        {data.masterSummary}
      </p>

      {/* Category counts strip */}
      <div className="flex items-center gap-1 flex-wrap">
        {(Object.keys(CATEGORY_CONFIG) as ArticleCategory[])
          .filter(c => c !== 'other')
          .map(cat => {
            const cfg = CATEGORY_CONFIG[cat]
            const count = data.categories[cat as keyof typeof data.categories]?.count ?? 0
            if (count === 0) return null
            return (
              <span
                key={cat}
                className={`font-mono text-[12px] px-2 py-0.5 rounded border ${cfg.badge}`}
              >
                {cfg.icon} {cfg.short} {count}
              </span>
            )
          })}
        <span className="font-mono text-[12px] text-slate-400 ml-auto">
          {data.totalSources} sources · {data.totalArticles} articles
        </span>
      </div>
    </div>
  )
}

function TopMoversSection({ articles }: { articles: NewsArticle[] }) {
  if (articles.length === 0) return null

  return (
    <div className="mx-4 mb-3 rounded-xl border-2 border-amber-500/50 bg-amber-500/5 p-3.5 overflow-hidden">
      <div className="flex items-center gap-2 mb-2.5">
        <span className="text-amber-400 text-lg animate-bounce">★</span>
        <span className="font-mono text-[12px] text-amber-400/90 uppercase tracking-widest font-bold">
          Top {articles.length} Market Movers
        </span>
        <span className="text-amber-500/40 font-mono text-[11px]">most impactful</span>
      </div>

      <div className="space-y-1.5">
        {articles.map((article, i) => {
          const cfg = CATEGORY_CONFIG[article.category]
          const arrow = impactArrow(article.marketImpact)

          return (
            <a
              key={article.id}
              href={article.url !== '#' ? article.url : undefined}
              target="_blank"
              rel="noopener noreferrer"
              className="group flex items-start gap-2 p-2 rounded-lg bg-amber-500/10 hover:bg-amber-500/15 border border-amber-500/20 hover:border-amber-500/40 transition-all cursor-pointer"
            >
              {/* Rank badge */}
              <span className="shrink-0 font-mono text-[12px] font-bold text-amber-400 w-6 text-center pt-0.5">
                {i + 1}.
              </span>

              {/* Category indicator */}
              <span
                className="shrink-0 w-[2px] self-stretch rounded-full"
                style={{ backgroundColor: cfg.color + '80' }}
              />

              {/* Content */}
              <div className="flex-1 min-w-0">
                <p className="font-mono text-[10px] text-slate-200 group-hover:text-white leading-tight transition-colors line-clamp-2">
                  {article.title}
                </p>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className={`font-mono text-[11px] px-1 py-0.5 rounded border ${cfg.badge}`}>
                    {cfg.short}
                  </span>
                  <span className={`font-mono text-[12px] font-bold ${arrow.cls}`}>
                    {arrow.glyph}
                  </span>
                  <SourceBadge article={article} />
                </div>
              </div>
            </a>
          )
        })}
      </div>
    </div>
  )
}

// ─── Main Component ───────────────────────────────────────────────────────────

export function MarketNewsSection() {
  const [data,         setData]         = useState<NewsResponse | null>(null)
  const [isLoading,    setIsLoading]    = useState(true)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const [error,        setError]        = useState<string | null>(null)
  const [activeTab,    setActiveTab]    = useState<Tab>('all')
  const [lastUpdated,  setLastUpdated]  = useState<number>(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setIsLoading(true)
    else        setIsRefreshing(true)
    setError(null)

    try {
      const res = await fetch('/api/news', { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: NewsResponse = await res.json()
      setData(json)
      setLastUpdated(Date.now())
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load news'
      setError(msg)
    } finally {
      setIsLoading(false)
      setIsRefreshing(false)
    }
  }, [])

  useEffect(() => {
    load()
    timerRef.current = setInterval(() => load(true), REFRESH_MS)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [load])

  // ── Filtered article list for current tab ────────────────────────────────────
  const displayArticles: NewsArticle[] = data
    ? activeTab === 'all'
      ? data.articles
      : data.articles.filter(a => a.category === activeTab)
    : []

  // ── Tab definitions ──────────────────────────────────────────────────────────
  const tabs: Array<{ id: Tab; label: string; count: number; color?: string }> = [
    { id: 'all', label: 'ALL', count: data?.totalArticles ?? 0 },
    ...(['geopolitics', 'macro', 'earnings', 'sentiment'] as ArticleCategory[]).map(cat => ({
      id:    cat as Tab,
      label: CATEGORY_CONFIG[cat].short,
      count: data?.categories[cat as keyof typeof data.categories]?.count ?? 0,
      color: CATEGORY_CONFIG[cat].color,
    })),
  ]

  // ── Formatted last-updated time ──────────────────────────────────────────────
  const updatedStr = lastUpdated
    ? new Date(lastUpdated).toLocaleTimeString('en-US', {
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
        timeZone: 'America/New_York',
      }) + ' ET'
    : '—'

  return (
    <section className="rounded-2xl border border-[#1a2540] bg-[#070d1a] overflow-hidden">

      {/* ── Section Header ── */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[#1a2540] bg-[#080e1c]">
        <div className="flex items-center gap-2.5">
          <span className="text-[10px] font-mono text-slate-300 uppercase tracking-widest">
            Market Intelligence
          </span>
          <span className="text-slate-400 font-mono text-[12px]">·</span>
          <span className="text-[12px] font-mono text-slate-400">Last 12h</span>
          {/* Live indicator */}
          <span className="flex items-center gap-1 text-[12px] font-mono text-emerald-500/70 ml-1">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
            LIVE
          </span>
        </div>

        <div className="flex items-center gap-3">
          {data && (
            <span className="font-mono text-[12px] text-slate-400 hidden md:block">
              {data.aiEnhanced ? '✦ AI' : 'KW'} · {updatedStr}
            </span>
          )}
          <button
            onClick={() => load(true)}
            disabled={isRefreshing || isLoading}
            className="font-mono text-[12px] text-slate-300 hover:text-slate-400 border border-[#1a2540] hover:border-slate-600 px-2 py-1 rounded transition-colors disabled:opacity-40"
          >
            {isRefreshing ? '…' : '↻'}
          </button>
        </div>
      </div>

      {/* ── Loading skeleton ── */}
      {isLoading && (
        <div>
          <div className="mx-4 my-3 h-24 rounded-xl bg-slate-800/30 animate-pulse" />
          <div className="mx-4 mb-3 flex gap-2">
            {[1,2,3,4,5].map(i => <div key={i} className="h-7 w-16 bg-slate-800/40 rounded-lg animate-pulse" />)}
          </div>
          {Array.from({ length: 8 }).map((_, i) => <SkeletonRow key={i} />)}
        </div>
      )}

      {/* ── Error state ── */}
      {!isLoading && error && (
        <div className="px-4 py-8 text-center">
          <p className="font-mono text-[11px] text-red-400/70 mb-3">{error}</p>
          <button
            onClick={() => load()}
            className="font-mono text-[10px] text-slate-500 hover:text-slate-400 border border-slate-500 px-3 py-1.5 rounded-lg transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Main content ── */}
      {!isLoading && data && (
        <>
          {/* Master Pulse Summary */}
          <div className="pt-3">
            <MasterPulseCard data={data} />
          </div>

          {/* Top 5 Market Movers */}
          <TopMoversSection articles={data.topMovers} />

          {/* Tab Bar */}
          <div className="flex items-center gap-1 px-4 pb-2 flex-wrap">
            {tabs.map(tab => {
              const isActive = activeTab === tab.id
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={[
                    'font-mono text-[10px] px-2.5 py-1 rounded-lg border transition-all',
                    isActive
                      ? 'border-slate-600 bg-slate-700/50 text-slate-200'
                      : 'border-[#1a2540] text-slate-300 hover:text-slate-400 hover:border-slate-500',
                  ].join(' ')}
                  style={isActive && tab.color ? { borderColor: tab.color + '40', color: tab.color } : {}}
                >
                  {tab.label}
                  {tab.count > 0 && (
                    <span className="ml-1.5 text-[12px] opacity-60">{tab.count}</span>
                  )}
                </button>
              )
            })}
          </div>

          {/* Category summary (shown when a specific category tab is active) */}
          {activeTab !== 'all' && activeTab in data.categories && (
            <CategorySummaryCard
              category={activeTab as ArticleCategory}
              data={data.categories[activeTab as keyof typeof data.categories]}
            />
          )}

          {/* Horizontal divider with column headers */}
          <div className="flex items-center gap-3 px-4 py-1.5 border-y border-[#0f1829] bg-[#06090f]">
            <span className="font-mono text-[11px] text-slate-400 uppercase tracking-widest w-[52px] text-right shrink-0">TIME</span>
            <span className="w-[3px] shrink-0" />
            <span className="font-mono text-[11px] text-slate-400 uppercase tracking-widest flex-1">HEADLINE</span>
            <span className="font-mono text-[11px] text-slate-400 uppercase tracking-widest shrink-0 pr-1">±</span>
          </div>

          {/* Article list */}
          <div className="max-h-[520px] overflow-y-auto scrollbar-thin scrollbar-track-[#06090f] scrollbar-thumb-slate-800">
            {displayArticles.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="font-mono text-[11px] text-slate-400">
                  No {activeTab !== 'all' ? activeTab + ' ' : ''}events in the last 12 hours.
                </p>
              </div>
            ) : (
              displayArticles.map((article, i) => (
                <ArticleRow key={article.id} article={article} index={i} />
              ))
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-4 py-2 border-t border-[#0f1829] bg-[#06090f]">
            <span className="font-mono text-[11px] text-slate-800 uppercase">
              Sources: Bloomberg · Reuters · CNBC · WSJ · MarketWatch · Yahoo Finance · X
            </span>
            <span className="font-mono text-[11px] text-slate-800">
              {data.fromCache ? 'CACHED' : 'LIVE'} · Refreshes every 5 min
            </span>
          </div>
        </>
      )}
    </section>
  )
}
