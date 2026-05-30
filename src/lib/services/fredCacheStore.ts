/**
 * fredCacheStore — Two-level persistent cache for FRED API payloads
 * ─────────────────────────────────────────────────────────────────
 *
 * Solves two distinct problems:
 *
 *   1. Dev hot-reload thrashing
 *      Every file save triggers a Next.js module re-evaluation.  Without
 *      persistence those re-evaluations each fire a live FRED request, which
 *      burns the free-tier rate limit in minutes.
 *
 *   2. FRED 429 / 504 downtime
 *      FRED is occasionally rate-limited or slow.  Rather than collapsing to
 *      static demo data, the cache serves the last real snapshot tagged CACHED.
 *
 * ── Architecture ─────────────────────────────────────────────────────────────
 *
 *   L1 Memory  (globalThis Map, MEM_TTL = 5 min)
 *     • Zero-cost for rapid in-process requests.
 *     • Survives hot-reload cycles because globalThis is never re-initialised
 *       by the Next.js module system.
 *     • Lost on Ctrl-C / server restart — that's fine; L2 picks it up.
 *
 *   L2 File    (.fred-cache/<key>.json, FILE_TTL = 24 h)
 *     • Survives `Ctrl-C` + `npm run dev` restart cycles.
 *     • Written atomically (temp-file + rename) to avoid partial reads.
 *     • Safe to delete manually; the next request simply re-fetches from FRED.
 *     • In CI / read-only filesystems the write silently no-ops; the memory
 *       layer still provides in-session caching.
 *
 * ── Cache key convention ─────────────────────────────────────────────────────
 *   'fed-liquidity'   →  /api/fed-liquidity payload  (FedLiquiditySnapshot)
 *   'fred-markets'    →  /api/fred-markets payload   (FredMarketsData)
 *
 * ── Caller contract ──────────────────────────────────────────────────────────
 *   const result = fredCacheRead<T>(key)
 *
 *   if (result?.fresh)  → serve immediately, no FRED call needed
 *   if (result?.stale)  → call FRED; if FRED fails, serve result.data as CACHED
 *   if (!result)        → call FRED; if FRED fails, serve static mock
 *
 *   On successful FRED fetch: fredCacheWrite(key, freshData)
 */

import fs   from 'fs'
import path from 'path'

// ─── Public types ─────────────────────────────────────────────────────────────

export interface FredCacheEntry<T> {
  /** Opaque string key identifying which endpoint this belongs to */
  key:       string
  /** The deserialized FRED API response body */
  data:      T
  /** Unix-ms wall-clock of the moment the live FRED fetch succeeded */
  fetchedAt: number
}

export interface FredCacheReadResult<T> {
  entry:  FredCacheEntry<T>
  /** true  → within FILE_TTL; safe to serve as AUTHENTICATED            */
  /** false → beyond FILE_TTL; attempt live FRED, serve as CACHED if fail */
  fresh:  boolean
  /** Which storage layer satisfied this read */
  source: 'memory' | 'file'
}

// ─── TTL constants ────────────────────────────────────────────────────────────

/**
 * L1 memory TTL: how long a hot entry stays in the globalThis Map before we
 * check the file again.  Short so a just-written file entry is noticed quickly
 * without adding file-read overhead to every single request.
 */
const MEM_TTL_MS = 5 * 60_000       // 5 minutes

/**
 * L2 file TTL: how long a cache file is treated as "fresh".
 * FRED daily series update once per business day (~4 PM ET); 24 hours is
 * tight enough to pick up fresh prints and conservative enough not to hit
 * the free-tier rate limit even on a day of active development.
 */
export const FILE_TTL_MS = 24 * 60 * 60_000  // 24 hours

// ─── File layer helpers ───────────────────────────────────────────────────────

/**
 * .fred-cache/ lives at the project root (next to package.json).
 * It is gitignored and can be deleted at any time.
 */
const CACHE_DIR = path.join(process.cwd(), '.fred-cache')

interface FilePayload<T> {
  /** Schema version — bump if the on-disk shape changes incompatibly */
  v:     1
  entry: FredCacheEntry<T>
}

function cacheFilePath(key: string): string {
  // Sanitize key to a safe filename (keys are already simple strings)
  const safe = key.replace(/[^a-z0-9-_]/gi, '_')
  return path.join(CACHE_DIR, `${safe}.json`)
}

function readFileLayer<T>(key: string): FredCacheEntry<T> | null {
  try {
    const raw     = fs.readFileSync(cacheFilePath(key), 'utf-8')
    const payload = JSON.parse(raw) as FilePayload<T>
    if (payload?.v !== 1 || !payload.entry?.fetchedAt) return null
    return payload.entry
  } catch {
    // File absent or malformed — treat as cache miss
    return null
  }
}

function writeFileLayer<T>(key: string, entry: FredCacheEntry<T>): void {
  try {
    // Ensure directory exists (no-op if already present)
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true })
    }
    const payload: FilePayload<T> = { v: 1, entry }
    const serialised = JSON.stringify(payload, null, 2)
    // Atomic write: write to .tmp then rename so readers never see a partial file
    const tmp  = cacheFilePath(key) + '.tmp'
    const dest = cacheFilePath(key)
    fs.writeFileSync(tmp, serialised, 'utf-8')
    fs.renameSync(tmp, dest)
  } catch (err) {
    // Non-fatal: read-only FS in CI, permission error, etc.
    console.warn(`[fredCache] Could not write cache file for "${key}":`, err)
  }
}

// ─── Memory layer helpers ─────────────────────────────────────────────────────

interface MemSlot<T> {
  entry:    FredCacheEntry<T>
  loadedAt: number   // when this slot was last populated (NOT when FRED was fetched)
}

/**
 * The globalThis Map survives Next.js hot-module-replacement because globalThis
 * is never re-initialised by the module evaluator — only a full process restart
 * clears it.
 */
const gMem = globalThis as typeof globalThis & {
  __fredCacheMemStore?: Map<string, MemSlot<unknown>>
}

function getMemStore(): Map<string, MemSlot<unknown>> {
  if (!gMem.__fredCacheMemStore) {
    gMem.__fredCacheMemStore = new Map()
  }
  return gMem.__fredCacheMemStore
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Read from L1 (memory) then L2 (file).
 *
 * Returns null only when there is no cached data at either layer — i.e., this
 * is the very first request after a clean checkout or after manually deleting
 * `.fred-cache/`.
 *
 * `result.fresh` indicates whether the entry is within FILE_TTL.
 * Stale entries MUST still be offered as fallback data when FRED fails.
 */
export function fredCacheRead<T>(key: string): FredCacheReadResult<T> | null {
  const now   = Date.now()
  const store = getMemStore()

  // ── L1: memory ─────────────────────────────────────────────────────────
  const slot = store.get(key) as MemSlot<T> | undefined
  if (slot && (now - slot.loadedAt) < MEM_TTL_MS) {
    const age   = now - slot.entry.fetchedAt
    const fresh = age < FILE_TTL_MS
    return { entry: slot.entry, fresh, source: 'memory' }
  }

  // ── L2: file ───────────────────────────────────────────────────────────
  const fileEntry = readFileLayer<T>(key)
  if (!fileEntry) return null

  // Warm L1 so the next request in this session skips the file read
  store.set(key, { entry: fileEntry as FredCacheEntry<unknown>, loadedAt: now })

  const age   = now - fileEntry.fetchedAt
  const fresh = age < FILE_TTL_MS
  return { entry: fileEntry, fresh, source: 'file' }
}

/**
 * Persist a freshly-fetched FRED payload to both L1 (memory) and L2 (file).
 * Call this immediately after every successful live FRED response.
 */
export function fredCacheWrite<T>(key: string, data: T): FredCacheEntry<T> {
  const entry: FredCacheEntry<T> = { key, data, fetchedAt: Date.now() }
  const store = getMemStore()

  // L1
  store.set(key, { entry: entry as FredCacheEntry<unknown>, loadedAt: Date.now() })

  // L2 (non-blocking; failures are logged but don't reject the write)
  writeFileLayer(key, entry)

  return entry
}

/**
 * Human-readable age label for console diagnostics.
 * Examples: "3m", "1h 12m", "23h"
 */
export function cacheAgeLabel(fetchedAt: number): string {
  const totalMin = Math.round((Date.now() - fetchedAt) / 60_000)
  if (totalMin < 60) return `${totalMin}m`
  const hr  = Math.floor(totalMin / 60)
  const min = totalMin % 60
  return min > 0 ? `${hr}h ${min}m` : `${hr}h`
}

// ─── L3: Committed seed file ──────────────────────────────────────────────────

/**
 * Path to the committed seed file — checked into source control, always present.
 * Fields starting with "_" are metadata; top-level keys match FRED cache keys
 * ('fred-markets', 'fed-liquidity').
 */
const SEED_PATH = path.join(process.cwd(), 'src', 'data', 'cache', 'fred-initial-seed.json')

interface SeedFile {
  _seedDate?:    string
  _description?: string
  [cacheKey: string]: unknown
}

/**
 * Read from the committed seed file (L3 — last-resort cold-start fallback).
 *
 * Returns a FredCacheEntry whose `fetchedAt` is set to the seed's `_seedDate`
 * so that console logs show a meaningful "age: 5d" instead of "age: 20222h".
 *
 * The returned entry is ALWAYS logically "stale" (fresh === false) because its
 * age will always exceed FILE_TTL_MS — callers must never use it as a cache-hit
 * bypass for live FRED fetches.  It is only offered as a fallback when both L1
 * memory and L2 file are empty AND the live FRED call failed.
 *
 * The data's meta.status fields say 'AUTHENTICATED' on disk; the route handler's
 * serveStaleCache() stamps them 'CACHED' before sending the response.
 */
export function fredCacheSeedRead<T>(key: string): FredCacheEntry<T> | null {
  try {
    const raw  = fs.readFileSync(SEED_PATH, 'utf-8')
    const seed = JSON.parse(raw) as SeedFile

    const data = seed[key] as T | undefined
    if (data === undefined || data === null) return null

    // Resolve fetchedAt from the _seedDate metadata field.
    // If absent, fall back to "30 days ago" so the age label is still readable.
    const seedDateMs = seed._seedDate
      ? new Date(seed._seedDate).getTime()
      : Date.now() - 30 * 24 * 60 * 60_000

    return { key, data, fetchedAt: seedDateMs }
  } catch {
    // Seed file absent, malformed JSON, or key missing — non-fatal
    return null
  }
}
