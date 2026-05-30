import { NextRequest, NextResponse } from 'next/server'
import { fetchMarketData } from '@/lib/services/marketFetcher'
import type { MarketDataSnapshot } from '@/lib/types/market'

// ─── Cold-start fallback ───────────────────────────────────────────────────────
// Returned as 200 OK when the provider is unreachable AND no prior cache entry
// exists.  An empty nodes map renders as "--" placeholders in the UI — far
// better than a 503 that crashes the client data hooks.
function buildEmptySnapshot(): MarketDataSnapshot {
  return {
    timestamp: Date.now(),
    nodes: {},
    health: { totalNodes: 0, liveCount: 0, staleCount: 0, disconnectedCount: 0, healthPercent: 0 },
    sources: {
      alpaca: { healthy: false, lastSuccessMs: 0, errorMsg: 'cold-start: no data yet' },
      fred:   { healthy: false, lastSuccessMs: 0 },
    },
  }
}

/**
 * Market Nodes API Route
 * ─────────────────────────────────────────────────────────────────────────────
 * Server-side endpoint for the Market Data Abstraction Layer.
 * URL: /api/market-nodes?category=fx&timeframe=1D
 *
 * Caching strategy — Stale-While-Reauthorizing (SWR):
 *
 *   WEEKDAY TTL  =  60 000 ms  (1 minute)
 *   WEEKEND TTL  = 600 000 ms  (10 minutes)
 *
 *   On cache miss the handler attempts a fresh provider fetch.
 *   If that fetch returns all-null prices (provider unavailable / not yet configured) OR
 *   throws entirely (network error, auth failure), the handler serves
 *   the last successfully stored entry as a STALE response rather than
 *   blanking the dashboard.  The stale payload keeps all metric rows
 *   visible until the provider becomes available.
 *
 *   Only a truly successful fetch with ≥1 live price updates the cache
 *   timestamp — preventing a cascade where a poisoned null-payload resets
 *   the TTL clock and permanently evicts good data.
 */

// ─── TTL constants ─────────────────────────────────────────────────────────────
const TTL_WEEKDAY_MS = 60_000        //  1 minute   — active trading hours
const TTL_WEEKEND_MS = 14_400_000    //  4 hours    — once good weekend data is cached, hold all day
//
// Why 4 hours on weekends?
//   Markets are closed Sat/Sun — no new prices to fetch.
//   A 4-hour TTL means we attempt at most 12 refreshes over a full weekend (vs 144×).
//   When the market-hours window resumes (Monday), isWeekendWindow() → false
//   drops the effective TTL to 60s, forcing an immediate fresh fetch.

// ─── Weekend detection ────────────────────────────────────────────────────────
// Uses UTC day so the server TZ never skews the result.
// Sat = 6, Sun = 0.  Extended to cover Friday after 22:00 UTC (NY close ~5pm ET)
// and Sunday before 22:00 UTC (futures re-open ~6pm ET) for accuracy.
function isWeekendWindow(): boolean {
  const now  = new Date()
  const day  = now.getUTCDay()   // 0 = Sun, 6 = Sat
  const hour = now.getUTCHours()
  return (
    day === 6 ||                            // Saturday (all day)
    day === 0 ||                            // Sunday (all day)
    (day === 5 && hour >= 22) ||            // Friday after 22:00 UTC  (~5pm ET close)
    (day === 1 && hour < 1)                 // Monday before 01:00 UTC (~8pm ET re-open buffer)
  )
}

// ─── Cache entry ──────────────────────────────────────────────────────────────
interface CacheEntry {
  data:      MarketDataSnapshot
  timestamp: number   // ms — time of last SUCCESSFUL write with live prices
}

// Module-scope cache persists across requests within the same Node.js process.
// Uses globalThis so Next.js Hot-Module-Replacement in dev doesn't evict it.
declare global {
  // eslint-disable-next-line no-var
  var __marketNodesCache: Record<string, CacheEntry> | undefined
}
const cache: Record<string, CacheEntry> = globalThis.__marketNodesCache ?? {}
if (!globalThis.__marketNodesCache) globalThis.__marketNodesCache = cache

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** True when the snapshot contains at least one node with a non-null price */
function snapshotHasLiveData(snapshot: MarketDataSnapshot): boolean {
  return Object.values(snapshot.nodes).some(n => n.price !== null)
}

function buildStaleResponse(
  entry: CacheEntry,
  reason: string
): NextResponse {
  const staleAgeS = Math.round((Date.now() - entry.timestamp) / 1000)
  console.warn(`[market-nodes] SWR STALE — ${reason} (age ${staleAgeS}s)`)
  return NextResponse.json<MarketDataSnapshot>(entry.data, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      'X-Cache':       'STALE',
      'X-Cache-Age':   String(staleAgeS),
      'X-Stale-Reason': reason,
    },
  })
}

// ─── Route Handler ─────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const category  = searchParams.get('category')?.toLowerCase()
  const timeframe = searchParams.get('timeframe')?.toUpperCase() || '1D'

  // ── Input validation ────────────────────────────────────────────────────────
  if (!category || !['fx', 'commodity', 'index'].includes(category)) {
    return NextResponse.json(
      { error: 'Invalid or missing category parameter',
        message: 'Must provide category=fx, category=commodity, or category=index' },
      { status: 400 }
    )
  }
  if (!['1D', '5D', '1M', '3M'].includes(timeframe)) {
    return NextResponse.json(
      { error: 'Invalid timeframe parameter',
        message: 'Must provide timeframe=1D, 5D, 1M, or 3M' },
      { status: 400 }
    )
  }

  const cacheKey  = `${category}_${timeframe}`
  const cached    = cache[cacheKey]
  const ageMs     = cached ? Date.now() - cached.timestamp : Infinity
  const weekend   = isWeekendWindow()
  const effectiveTTL = weekend ? TTL_WEEKEND_MS : TTL_WEEKDAY_MS

  // ── Cache hit — serve instantly ─────────────────────────────────────────────
  if (cached && ageMs < effectiveTTL) {
    console.info(
      `[market-nodes] CACHE HIT  ${cacheKey} ` +
      `(age ${Math.round(ageMs / 1000)}s / TTL ${effectiveTTL / 1000}s` +
      `${weekend ? ' WEEKEND' : ''})`
    )
    return NextResponse.json<MarketDataSnapshot>(cached.data, {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type': 'application/json',
        'X-Cache':     'HIT',
        'X-Cache-Age': String(Math.round(ageMs / 1000)),
      },
    })
  }

  // ── Cache miss — attempt fresh fetch ────────────────────────────────────────
  console.info(
    `[market-nodes] CACHE MISS ${cacheKey} ` +
    `(${cached ? `expired ${Math.round(ageMs / 1000)}s ago` : 'cold start'})`
  )

  try {
    const snapshot = await fetchMarketData(
      category as 'fx' | 'commodity' | 'index',
      timeframe as '1D' | '5D' | '1M' | '3M'
    )

    // ── Path A: fresh live data — write to cache and return ─────────────────
    //    CRITICAL: only update the cache when there is at least one real price.
    //    Writing a null-snapshot would poison the cache: the next request would
    //    see it as a fresh HIT and the SWR stale path would never trigger.
    if (snapshotHasLiveData(snapshot)) {
      cache[cacheKey] = { data: snapshot, timestamp: Date.now() }
      return NextResponse.json<MarketDataSnapshot>(snapshot, {
        headers: {
          'Cache-Control': 'no-store, max-age=0',
          'Content-Type': 'application/json',
          'X-Cache': 'MISS',
        },
      })
    }

    // ── Path B: all-null snapshot (provider unavailable / not configured) ────
    if (cached) {
      // Serve the last good snapshot as stale.
      //
      // Weekend special: re-timestamp the cached entry so the NEXT request
      // gets a cache HIT rather than a cache miss → another failed fetch.
      // This extends the effective TTL by TTL_WEEKEND_MS on each stale hit,
      // meaning we won't hammer the provider again for 4 hours.
      if (weekend) {
        cache[cacheKey] = { data: cached.data, timestamp: Date.now() }
        console.info(
          `[market-nodes] WEEKEND STALE: TTL extended +${TTL_WEEKEND_MS / 3_600_000}h ` +
          `for ${cacheKey} (original age ${Math.round((Date.now() - cached.timestamp) / 1000)}s)`
        )
      }
      return buildStaleResponse(cached, 'all-null prices (provider unavailable)')
    }

    // ── Path C: cold start + provider unavailable — serve empty snapshot ──────
    //    Return 200 with an empty nodes map so client hooks don't crash.
    //    Do NOT write to cache: leaving it empty means the next request retries
    //    rather than serving stale nulls for the full TTL window.
    console.warn(
      `[market-nodes] Cold start with no data for ${cacheKey} — ` +
      `serving empty snapshot. Dashboard shows "--" until provider responds.`
    )
    return NextResponse.json<MarketDataSnapshot>(buildEmptySnapshot(), {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type':  'application/json',
        'X-Cache':       'FALLBACK',
        'X-Stale-Reason': 'cold-start: provider unavailable',
      },
    })

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[market-nodes] Fetch error for ${cacheKey}:`, message)

    // ── SWR fallback: if a prior successful entry exists, return it as stale
    //    rather than blanking the dashboard.  Covers 401 auth failures,
    //    network timeouts, and any hard throw from fetchMarketData.
    if (cached) {
      // Also re-timestamp stale error responses in the weekend window
      if (weekend) {
        cache[cacheKey] = { data: cached.data, timestamp: Date.now() }
      }
      return buildStaleResponse(cached, `fetch error: ${message}`)
    }

    // No stale entry available — serve empty snapshot rather than an error status
    console.warn(`[market-nodes] No cache + fetch error for ${cacheKey} — serving empty snapshot`)
    return NextResponse.json<MarketDataSnapshot>(buildEmptySnapshot(), {
      headers: {
        'Cache-Control': 'no-store',
        'Content-Type':  'application/json',
        'X-Cache':       'FALLBACK',
        'X-Stale-Reason': `fetch error: ${message}`,
      },
    })
  }
}
