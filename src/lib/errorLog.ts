/**
 * System Error Ring Buffer
 * ─────────────────────────────────────────────────────────────────────────────
 * A lightweight, globalThis-backed ring buffer that any API route or fetcher
 * can import to surface errors to the dashboard "Last Error" strip without
 * opening the terminal.
 *
 * Usage:
 *   import { logSystemError } from '@/lib/errorLog'
 *   logSystemError('fmp', 402, 'Plan limit — skipping: ^VIX, ^MOVE')
 *
 * The buffer holds the last MAX_ERRORS entries.  getSystemErrors() is called
 * by /api/circuit-breaker/reset (GET) to expose the log to the frontend.
 */

export interface SystemError {
  ts:     number   // Date.now() at log time
  source: string   // 'fmp' | 'alpaca' | 'ibkr' | 'fred' | ...
  code:   number   // HTTP status or 0 for non-HTTP errors
  msg:    string   // short description (≤200 chars)
}

const MAX_ERRORS = 20

declare global {
  // eslint-disable-next-line no-var
  var __systemErrors: SystemError[] | undefined
}

function getBuffer(): SystemError[] {
  if (!globalThis.__systemErrors) globalThis.__systemErrors = []
  return globalThis.__systemErrors
}

/** Append an error to the ring buffer. Thread-safe within Node's event loop. */
export function logSystemError(source: string, code: number, msg: string): void {
  const buf = getBuffer()
  buf.push({ ts: Date.now(), source, code, msg: msg.slice(0, 200) })
  // Trim oldest entries when buffer overflows
  if (buf.length > MAX_ERRORS) {
    globalThis.__systemErrors = buf.slice(-MAX_ERRORS)
  }
}

/** Return all buffered errors, oldest first. */
export function getSystemErrors(): SystemError[] {
  return [...getBuffer()]
}

/** Clear the error buffer (called on circuit-breaker reset). */
export function clearSystemErrors(): void {
  globalThis.__systemErrors = []
}
