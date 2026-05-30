/**
 * /api/circuit-breaker/reset
 * ─────────────────────────────────────────────────────────────────────────────
 * GET  — returns current circuit-breaker state + last 5 system errors
 * POST — resets one or both circuit breakers and clears the error log
 *
 * Body (POST): { "target": "all" | "ibkr" | "fmp" }   (default: "all")
 *
 * Circuit-breaker state lives on globalThis.__ctaCB (owned by cta-engine route).
 * FMP skip-list lives on globalThis.__fmpSkippedSymbols (owned by fmpFetcher).
 * Error log lives on globalThis.__systemErrors (owned by errorLog.ts).
 *
 * This route never imports those modules directly — it reads/mutates the globals
 * in-process so no circular dependency is introduced.
 */

import { NextRequest, NextResponse } from 'next/server'
import { getSystemErrors, clearSystemErrors } from '@/lib/errorLog'

// ─── GET — status ─────────────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const cb  = globalThis.__ctaCB ?? { ibkrOpenUntil: 0, fmpOpenUntil: 0 }
  const now = Date.now()

  return NextResponse.json({
    ibkr: {
      open:      now < cb.ibkrOpenUntil,
      resetsAt:  cb.ibkrOpenUntil,
      remainsMs: Math.max(0, cb.ibkrOpenUntil - now),
    },
    fmp: {
      open:           now < cb.fmpOpenUntil,
      resetsAt:       cb.fmpOpenUntil,
      remainsMs:      Math.max(0, cb.fmpOpenUntil - now),
      // __fmpSkippedSymbols is now a Map<symbol, expiresAt>; spread .keys() to
      // return only the symbol strings (not the [symbol, expiry] tuple pairs).
      skippedSymbols: [...(globalThis.__fmpSkippedSymbols?.keys() ?? [])],
    },
    lastErrors: getSystemErrors().slice(-5).reverse(),   // most recent first
    ts:         now,
  })
}

// ─── POST — reset ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  let target: string = 'all'
  try {
    const body = await req.json() as { target?: string }
    target = body.target ?? 'all'
  } catch {
    // body parse failure → default to resetting everything
  }

  const reset: string[] = []

  // Reset IBKR circuit breaker
  if ((target === 'all' || target === 'ibkr') && globalThis.__ctaCB) {
    globalThis.__ctaCB.ibkrOpenUntil = 0
    reset.push('ibkr-cb')
  }

  // Reset FMP circuit breaker + clear the 402 skip-list
  if (target === 'all' || target === 'fmp') {
    if (globalThis.__ctaCB) globalThis.__ctaCB.fmpOpenUntil = 0
    globalThis.__fmpSkippedSymbols?.clear()
    globalThis.__fmp402Logged = false
    reset.push('fmp-cb', 'fmp-skip-list')
  }

  // Clear error log on full reset
  if (target === 'all') {
    clearSystemErrors()
    reset.push('error-log')
  }

  console.info(`[circuit-breaker] Manual reset: ${reset.join(', ')}`)

  return NextResponse.json({ ok: true, reset, ts: Date.now() })
}
