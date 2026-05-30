// ─── Dev TLS bypass — module-level (runs on import, before register()) ───────
//
// NODE_TLS_REJECT_UNAUTHORIZED=0 is set here at module evaluation time so it
// is in place before any async work begins.  next.config.ts sets the same flag
// even earlier (config load), so this is a belt-and-suspenders guarantee for
// the instrumentation runtime specifically.
//
// Scoped to non-production only — never weakens TLS in deployed builds.
if (process.env.NODE_ENV !== 'production') {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
}

/**
 * Next.js Instrumentation Hook — runs once per runtime before any route handler.
 *
 * By the time register() is called the env flag above is already set.
 * The undici dispatcher attempt below is a best-effort extra layer for
 * environments where undici is available as a standalone module.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'edge') return
  if (process.env.NODE_ENV === 'production') return

  // Best-effort undici dispatcher override (no-op if module is unavailable).
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const undici = (Function('m', 'return require(m)'))('undici') as {
      setGlobalDispatcher: (d: unknown) => void
      Agent: new (opts: { connect: Record<string, unknown> }) => unknown
    }
    undici.setGlobalDispatcher(new undici.Agent({ connect: { rejectUnauthorized: false } }))
    console.info('[instrumentation] undici dispatcher: rejectUnauthorized=false')
  } catch {
    // Not available — NODE_TLS_REJECT_UNAUTHORIZED=0 covers all code paths.
  }

  console.info('[instrumentation] Dev TLS bypass confirmed: NODE_TLS_REJECT_UNAUTHORIZED=0')
}
