/**
 * useMarketLiveFeed — Integration Example
 *
 * Shows the minimal changes to src/app/dashboard/page.tsx needed to inject
 * live IB prices into FuturesCard (Equity Indices) and CommodityTable.
 *
 * The key design principle:
 *   livePrices is MERGED on top of the base API data.
 *   If IB is offline, base data wins → zero UI breakage.
 *
 * This file is documentation only — it is NOT imported anywhere.
 */

'use client'

import { useMemo } from 'react'
import { useMarketLiveFeed }  from '@/hooks/useMarketLiveFeed'
import type { LiveInstrument } from '@/hooks/useMarketLiveFeed'

// ─── 1. Import the hook at the top of dashboard/page.tsx ─────────────────────

/*
  import { useMarketLiveFeed } from '@/hooks/useMarketLiveFeed'
*/

// ─── 2. Call the hook inside DashboardPage() ─────────────────────────────────

function DashboardPageExample() {
  // Existing API state (Yahoo Finance / mock fallback)
  // const [data, setData] = useState<MarketData | null>(null)
  // ...existing load() useEffect stays exactly as-is...

  // Add the live feed alongside it:
  const { livePrices, isLoading: liveLoading, connectionError, reconnect } =
    useMarketLiveFeed()

  // ─── 3. Merge live prices on top of base API data ────────────────────────
  //
  // useMemo rebuilds the merged slice only when either source changes.
  // All other MarketData fields (rates, fx, volatility, etc.) are untouched.

  // Type aliases matching dashboard/page.tsx interfaces
  type Instrument        = { symbol: string; name: string; price: number; change: number; changePercent: number; high?: number; low?: number; sparkline: number[]; sparklines?: Record<string, number[]> }
  type FuturesInstrument = { symbol: string; name: string; price: number; change: number; changePercent: number; high?: number; low?: number; sparklines: Record<string, number[]> }

  // data comes from the existing useState<MarketData> — stub it here for the example
  const data = null as null | { futures?: FuturesInstrument[]; equities: Instrument[]; commodities: Instrument[]; rates: unknown[]; fx: unknown[]; volatility: unknown; timestamp: number; isMarketOpen: boolean }

  /** Merge a LiveInstrument into an existing Instrument/FuturesInstrument */
  function mergeInto<T extends Instrument | FuturesInstrument>(
    base:  T,
    live?: LiveInstrument,
  ): T {
    if (!live || live.price === 0) return base
    return {
      ...base,
      price:         live.price,
      change:        live.change,
      changePercent: live.changePercent,
      high:          live.high  ?? base.high,
      low:           live.low   ?? base.low,
      // Preserve existing multi-TF sparklines; overlay intraday sparkline
      sparkline:     live.sparkline.length > 0 ? live.sparkline : (base as Instrument).sparkline ?? [],
    }
  }

  const mergedFutures = useMemo(() => {
    if (!data?.futures) return data?.futures
    const liveMap = new Map(livePrices?.futures.map(f => [f.symbol, f]) ?? [])
    return data.futures.map(f => mergeInto(f, liveMap.get(f.symbol)))
  }, [data, livePrices])

  const mergedEquities = useMemo(() => {
    if (!data?.equities) return data?.equities
    const liveMap = new Map(livePrices?.equities.map(e => [e.symbol, e]) ?? [])
    return data.equities.map(e => mergeInto(e, liveMap.get(e.symbol)))
  }, [data, livePrices])

  const mergedCommodities = useMemo(() => {
    if (!data?.commodities) return data?.commodities
    const liveMap = new Map(livePrices?.commodities.map(c => [c.symbol, c]) ?? [])
    return data.commodities.map(c => mergeInto(c, liveMap.get(c.symbol)))
  }, [data, livePrices])

  // Combine into a single merged data object — pass anywhere `data` was used
  const mergedData = useMemo(() => {
    if (!data) return null
    return {
      ...data,
      futures:     mergedFutures     ?? data.futures,
      equities:    mergedEquities    ?? data.equities,
      commodities: mergedCommodities ?? data.commodities,
    }
  }, [data, mergedFutures, mergedEquities, mergedCommodities])

  // ─── 4. Optional status banner ─────────────────────────────────────────────
  //
  // Render this in the header alongside the existing clock / refresh button.
  //
  // const LiveFeedStatus = () => (
  //   <div className="hidden md:flex items-center gap-2">
  //     {livePrices ? (
  //       <span className="flex items-center gap-1.5 text-[10px] font-mono text-emerald-400">
  //         <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
  //         IB LIVE · {new Date(livePrices.lastUpdated).toLocaleTimeString()}
  //       </span>
  //     ) : connectionError ? (
  //       <button
  //         onClick={reconnect}
  //         className="text-[10px] font-mono text-amber-500/80 hover:text-amber-400 flex items-center gap-1"
  //         title={connectionError}
  //       >
  //         ⚠ IB offline · retry
  //       </button>
  //     ) : liveLoading ? (
  //       <span className="text-[10px] font-mono text-slate-600">Connecting IB…</span>
  //     ) : null}
  //   </div>
  // )

  // ─── 5. Pass mergedData to existing components unchanged ──────────────────
  //
  // Replace every reference to `data` with `mergedData` in the JSX.
  // Nothing else changes — no component rewrite needed.
  //
  //  Before:
  //    <FuturesCard key={f.symbol} inst={f} timeframe={equityTF} />
  //    — where data.futures is iterated
  //
  //  After:
  //    <FuturesCard key={f.symbol} inst={f} timeframe={equityTF} />
  //    — where mergedData.futures is iterated  (same JSX, different source)
  //
  //  Before:
  //    <CommodityTable commodities={data.commodities} timeframe={commTF} />
  //
  //  After:
  //    <CommodityTable commodities={mergedData.commodities} timeframe={commTF} />

  return (
    <div>
      {/* The rest of the JSX is IDENTICAL to the current dashboard/page.tsx.
          Just swap `data` → `mergedData` everywhere in the render tree. */}

      {/* Example of the connection error banner (add near header buttons): */}
      {connectionError && (
        <div className="flex items-center gap-2 text-[10px] font-mono text-amber-500/80 px-3 py-1 bg-amber-500/10 border-b border-amber-500/20">
          <span>⚠ IB feed: {connectionError.split('.')[0]}</span>
          <button onClick={reconnect} className="underline hover:text-amber-400">Retry</button>
        </div>
      )}
    </div>
  )
}

// ─── 6. Exact diff — what to add/change in dashboard/page.tsx ────────────────
//
//  +  import { useMarketLiveFeed } from '@/hooks/useMarketLiveFeed'
//
//  Inside DashboardPage():
//  +  const { livePrices, connectionError, reconnect } = useMarketLiveFeed()
//  +
//  +  const liveFutMap  = new Map(livePrices?.futures.map(f => [f.symbol, f]))
//  +  const liveEquMap  = new Map(livePrices?.equities.map(e => [e.symbol, e]))
//  +  const liveCommMap = new Map(livePrices?.commodities.map(c => [c.symbol, c]))
//  +
//  +  // Merge helper — keeps existing sparklines, overlays live price/change
//  +  const merge = <T extends { symbol: string; price: number; change: number; changePercent: number }>(
//  +    base: T, liveMap: Map<string, { price: number; change: number; changePercent: number; high?: number; low?: number }>
//  +  ): T => {
//  +    const live = liveMap.get(base.symbol)
//  +    return live && live.price > 0 ? { ...base, ...live } : base
//  +  }
//
//  In the Futures section JSX:
//  -  {data.futures?.map((f) => <FuturesCard key={f.symbol} inst={f} timeframe={equityTF} />)}
//  +  {data.futures?.map((f) => <FuturesCard key={f.symbol} inst={merge(f, liveFutMap)} timeframe={equityTF} />)}
//
//  In the Commodities section JSX:
//  -  <CommodityTable commodities={data.commodities} timeframe={commTF} />
//  +  <CommodityTable commodities={data.commodities.map(c => merge(c, liveCommMap))} timeframe={commTF} />

export {}  // make this a module
