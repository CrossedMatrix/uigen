/**
 * /api/live-futures — Thin proxy to the local Python main.py (port 8000)
 * ──────────────────────────────────────────────────────────────────────────────
 * Python server (bridge/main.py) connects to IB Gateway Paper Trading on
 * port 4002 and exposes a dict-keyed tick snapshot at port 8000.
 *
 * Response when Python server is UP:
 *   {
 *     connected: true,
 *     timestamp: "...",
 *     data: {
 *       "ES": { last, bid, ask, change, change_pct },
 *       "NQ": { ... },
 *       "ZN": { ... }
 *     }
 *   }
 *
 * Response when Python server is DOWN / IBKR not connected:
 *   { connected: false, timestamp: "...", data: {}, error: "<reason>" }  HTTP 503
 *
 * NOTE: useLiveFutures.ts now polls http://localhost:8000 directly from the
 * browser (CORS is enabled on the Python server).  This Next.js route remains
 * available as a server-side fallback/proxy if needed, but the hook bypasses it.
 */

import { NextResponse } from 'next/server'
import type { IBTickFields, LiveFuturesResponse } from '@/types/futures'

export const runtime = 'nodejs'        // AbortSignal.timeout requires Node.js
export const dynamic = 'force-dynamic' // Never cache — every call wants fresh ticks

const IB_SERVER_URL = 'http://127.0.0.1:8000/api/live-futures'
const TIMEOUT_MS    = 3_000

// Re-export for backward compatibility (any callers importing from this route)
export type { IBTickFields, LiveFuturesResponse } from '@/types/futures'

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse<LiveFuturesResponse>> {
  try {
    const res = await fetch(IB_SERVER_URL, {
      cache:  'no-store',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!res.ok) {
      throw new Error(`IB server returned HTTP ${res.status}`)
    }

    const data: LiveFuturesResponse = await res.json()
    return NextResponse.json(data)

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)

    // Log at warn level — a missing Python server is expected during dev
    // when only Yahoo data is being used.
    console.warn(`[live-futures] Python server unreachable: ${message}`)

    return NextResponse.json(
      {
        connected: false,
        timestamp: new Date().toISOString(),
        data:      {},
        error:     `IB server unavailable: ${message}`,
      },
      { status: 503 }
    )
  }
}
