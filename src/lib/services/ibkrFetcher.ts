/**
 * IBKR TWS API — Persistent Socket Client (historical bars + snapshot quotes)
 * ─────────────────────────────────────────────────────────────────────────────
 * REPLACES the previous Client-Portal HTTP implementation (axios → /v1/api).
 * The old code pointed an HTTP client at http://127.0.0.1:4002/v1/api, but
 * port 4002 is the IB **Gateway socket API** (the TWS API), not the Client
 * Portal Web gateway — so it speaks a length-prefixed binary protocol, not
 * HTTP/JSON.  We now hold a single persistent TCP socket to the Gateway via
 * the @stoqey/ib client and bridge its event callbacks to Promises.
 *
 * Environment variables (.env.local)
 *   IB_SOCKET_HOST  — Gateway host   (default: 127.0.0.1)
 *   IB_SOCKET_PORT  — Gateway port   (default: 4002 — IBKR paper-trading API)
 *   IB_CLIENT_ID    — TWS API client id (default: 7 — any unused int 0-999)
 *
 * Architecture notes
 *   • ONE socket per Node process, stored on globalThis so Turbopack HMR in
 *     dev doesn't open a new connection on every reload (the Gateway caps
 *     concurrent client ids).
 *   • The TWS API is asynchronous and request-id correlated: each request is
 *     tagged with a monotonic tickerId, and results arrive as events keyed by
 *     that id.  ensureConnected() + the per-request event bridges below turn
 *     that into ordinary awaitable functions.
 *   • Caveat: a long-lived socket lives naturally in `next dev` (single Node
 *     process).  Under a serverless/multi-worker deploy each worker would hold
 *     its own connection with a distinct client id — fine, but size the
 *     Gateway's client-id budget accordingly.
 *
 * The public surface (fetchIBKRBarsMulti / fetchIBKRHistoricalBars /
 * fetchIBKRSnapshotQuotes / IBKR_CONIDS / IBKR_SNAPSHOT_CONIDS /
 * getActiveIBKRAccount / IBKRSnapshotQuote) is unchanged so existing callers
 * (e.g. /api/market/cta-engine) keep working without edits.
 */

import { IBApi, EventName } from '@stoqey/ib'
import type { Contract } from '@stoqey/ib'
import type { DailyBar } from '@/lib/market/ctaEngine'

// ─── Config ─────────────────────────────────────────────────────────────────

const IB_HOST      = process.env.IB_SOCKET_HOST?.trim() || '127.0.0.1'
const IB_PORT      = Number(process.env.IB_SOCKET_PORT?.trim() || '4002')
const IB_CLIENT_ID = Number(process.env.IB_CLIENT_ID?.trim() || '7')

console.info(`[ibkrFetcher] TWS socket target = ${IB_HOST}:${IB_PORT} (clientId=${IB_CLIENT_ID})`)

// Typed aliases for the enum-typed reqHistoricalData params that @stoqey/ib
// does not re-export from its package root.  Deriving them from the method
// signature keeps us type-safe without importing the unexported enums.
type ReqHistArgs   = Parameters<IBApi['reqHistoricalData']>
type BarSizeArg    = ReqHistArgs[4]          // BarSizeSetting enum
type ContractSecType = NonNullable<Contract['secType']>

// ─── Symbol → conid mapping (historical bars — ETFs) ──────────────────────────

export const IBKR_CONIDS: Record<string, number> = {
  SPY: 756733,
  QQQ: 32022752,
  IWM: 13361421,
  TLT: 14415501,
  GLD: 27065961,
  USO: 32314515,
}

// ─── Snapshot conid map (indices / rates / vol) ───────────────────────────────

export const IBKR_SNAPSHOT_CONIDS: Record<string, number> = {
  '^VIX':  134557686,
  '^VVIX': 416904,
  '^SKEW': 211794816,
  '^PCCE': 185877,
  '^GSPC': 3691937,
  '^NDX':  3691992,
  '^DJI':  3578636,
  '^RUT':  416892,
  '^IRX':  3691994,
  '^FVX':  3691993,
  '^TNX':  3691995,
  '^TYX':  3691996,
}

const CONID_TO_SNAPSHOT_SYM = new Map<number, string>(
  Object.entries(IBKR_SNAPSHOT_CONIDS).map(([sym, conid]) => [conid, sym]),
)

// Index contracts need a primary exchange + secType=IND on the TWS API
// (unlike ETFs which route via SMART/STK).  Caret-prefixed symbols are the
// cash indices in IBKR_SNAPSHOT_CONIDS; most list on CBOE.  Adjust here if a
// specific index reports "No security definition" from the Gateway.
const INDEX_EXCHANGE: Record<string, string> = {
  '^VIX':  'CBOE',
  '^VVIX': 'CBOE',
  '^SKEW': 'CBOE',
  '^PCCE': 'CBOE',
  '^GSPC': 'CBOE',   // S&P 500 cash index (SPX)
  '^NDX':  'NASDAQ',
  '^DJI':  'CBOE',
  '^RUT':  'RUSSELL',
  '^IRX':  'CBOE',
  '^FVX':  'CBOE',
  '^TNX':  'CBOE',
  '^TYX':  'CBOE',
}

/** Build a TWS Contract from a conid. ETFs → SMART/STK; caret indices → IND. */
function contractFor(symbol: string, conid: number): Contract {
  const isIndex = symbol.startsWith('^')
  return {
    conId:    conid,
    secType:  (isIndex ? 'IND' : 'STK') as ContractSecType,
    exchange: isIndex ? (INDEX_EXCHANGE[symbol] ?? 'CBOE') : 'SMART',
    currency: 'USD',
  }
}

// ─── Persistent socket singleton ──────────────────────────────────────────────

interface IBConnection {
  api:        IBApi
  connected:  boolean
  connecting: Promise<IBApi> | null
  nextReqId:  number
}

declare global {
  // eslint-disable-next-line no-var
  var __ibSocket: IBConnection | undefined
  // eslint-disable-next-line no-var
  var __ibkrActiveAccount: string | undefined
}

function getConn(): IBConnection {
  if (!globalThis.__ibSocket) {
    globalThis.__ibSocket = {
      api:        new IBApi({ host: IB_HOST, port: IB_PORT, clientId: IB_CLIENT_ID }),
      connected:  false,
      connecting: null,
      nextReqId:  1,
    }
    wirePersistentHandlers(globalThis.__ibSocket)
  }
  return globalThis.__ibSocket
}

/** Connection-lifecycle handlers attached once for the life of the socket. */
function wirePersistentHandlers(conn: IBConnection): void {
  conn.api.on(EventName.connected, () => {
    conn.connected = true
    console.info('[ibkrFetcher] TWS socket connected')
  })
  conn.api.on(EventName.disconnected, () => {
    conn.connected = false
    console.warn('[ibkrFetcher] TWS socket disconnected')
  })
  conn.api.on(EventName.connectionClosed, () => {
    conn.connected = false
    conn.connecting = null
    console.warn('[ibkrFetcher] TWS socket connection closed')
  })
  conn.api.on(EventName.managedAccounts, (accountsList: string) => {
    const first = accountsList.split(',').map(s => s.trim()).filter(Boolean)[0]
    if (first) {
      globalThis.__ibkrActiveAccount = first.replace(/\.$/, '')   // strip IB trailing-dot quirk
      console.info(`[ibkrFetcher] active account: ${globalThis.__ibkrActiveAccount}`)
    }
  })
}

/** Returns the active IB account id once the socket has reported one, else null. */
export function getActiveIBKRAccount(): string | null {
  return globalThis.__ibkrActiveAccount ?? null
}

const CONNECT_TIMEOUT_MS = 8_000

/** Resolve once the socket is connected (and the API is ready), connecting if needed. */
function ensureConnected(): Promise<IBApi> {
  const conn = getConn()
  if (conn.connected) return Promise.resolve(conn.api)
  if (conn.connecting) return conn.connecting

  conn.connecting = new Promise<IBApi>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      conn.connecting = null
      reject(new Error(`IBKR socket connect timeout (${CONNECT_TIMEOUT_MS}ms) — is IB Gateway running on ${IB_HOST}:${IB_PORT}?`))
    }, CONNECT_TIMEOUT_MS)

    // `nextValidId` is the canonical "API handshake complete" signal.
    const onReady = () => { cleanup(); conn.connected = true; resolve(conn.api) }
    const onErr   = (err: Error) => {
      // Only reject the connect attempt on a hard connection error; per-request
      // errors are dispatched to their own bridges by code/reqId below.
      const msg = err?.message ?? String(err)
      if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|socket|connect/i.test(msg)) {
        cleanup(); conn.connecting = null
        reject(new Error(`IBKR Gateway unreachable: ${msg}`))
      }
    }
    function cleanup() {
      clearTimeout(timer)
      conn.api.removeListener(EventName.nextValidId, onReady)
      conn.api.removeListener(EventName.connected, onReady)
      conn.api.removeListener(EventName.error, onErr)
    }

    conn.api.once(EventName.nextValidId, onReady)
    conn.api.once(EventName.connected, onReady)
    conn.api.on(EventName.error, onErr)

    try {
      conn.api.connect(IB_CLIENT_ID)
    } catch (e) {
      cleanup(); conn.connecting = null
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })

  return conn.connecting
}

/** Monotonic request id for correlating TWS responses to a single request. */
function nextReqId(): number {
  const conn = getConn()
  const id = conn.nextReqId++
  if (conn.nextReqId > 2_000_000) conn.nextReqId = 1   // wrap defensively
  return id
}

// ─── Historical-bar request bridge ────────────────────────────────────────────
// @stoqey/ib's low-level IBApi emits `historicalData` once per bar in the
// classic TWS form (reqId, time, open, high, low, close, volume, count, WAP,
// hasGaps), terminating with a synthetic bar whose `time` begins with
// "finished".  We accumulate matching-reqId bars until that sentinel.

const HIST_REQ_TIMEOUT_MS = 15_000

function requestHistoricalBars(contract: Contract, durationStr: string): Promise<DailyBar[]> {
  return new Promise<DailyBar[]>((resolve, reject) => {
    const conn  = getConn()
    const reqId = nextReqId()
    const bars: DailyBar[] = []

    const timer = setTimeout(() => {
      cleanup()
      try { conn.api.cancelHistoricalData(reqId) } catch { /* already done */ }
      reject(new Error(`IBKR historical request timeout (${HIST_REQ_TIMEOUT_MS}ms)`))
    }, HIST_REQ_TIMEOUT_MS)

    const onBar = (
      id: number, time: string,
      open: number, high: number, low: number, close: number, volume: number,
    ) => {
      if (id !== reqId) return
      // End-of-data sentinel: time === "finished-<start>-<end>"
      if (typeof time === 'string' && time.startsWith('finished')) {
        cleanup()
        resolve(bars)
        return
      }
      if (Number.isFinite(close) && close > 0) {
        bars.push({
          t: normaliseBarDate(time),
          o: open, h: high, l: low, c: close, v: volume,
        })
      }
    }

    const onErr = (err: Error, _code: number, id: number) => {
      if (id !== reqId) return
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    }

    function cleanup() {
      clearTimeout(timer)
      conn.api.removeListener(EventName.historicalData, onBar)
      conn.api.removeListener(EventName.error, onErr)
    }

    conn.api.on(EventName.historicalData, onBar)
    conn.api.on(EventName.error, onErr)

    // endDateTime='' → now; barSize '1 day'; whatToShow TRADES; useRTH=1;
    // formatDate=1 → date strings are 'YYYYMMDD'; keepUpToDate=false.
    conn.api.reqHistoricalData(
      reqId, contract, '', durationStr,
      '1 day' as BarSizeArg, 'TRADES', 1, 1, false,
    )
  })
}

/** Convert a TWS daily-bar date ('YYYYMMDD' or epoch-seconds string) to ISO 'YYYY-MM-DD'. */
function normaliseBarDate(time: string): string {
  if (/^\d{8}$/.test(time)) {
    return `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`
  }
  const asNum = Number(time)
  if (Number.isFinite(asNum) && asNum > 0) {
    return new Date(asNum * 1_000).toISOString().slice(0, 10)
  }
  return time
}

// ─── Historical cache ─────────────────────────────────────────────────────────

const HIST_TTL_MS = 60 * 60 * 1_000

interface IBKRHistCacheEntry { bars: DailyBar[]; expiresAt: number }

declare global {
  // eslint-disable-next-line no-var
  var __ibkrHistCache: Map<string, IBKRHistCacheEntry> | undefined
  // eslint-disable-next-line no-var
  var __ibkrBarsInFlight: Map<string, Promise<Record<string, DailyBar[]>>> | undefined
}

function getIBKRCache(): Map<string, IBKRHistCacheEntry> {
  if (!globalThis.__ibkrHistCache) globalThis.__ibkrHistCache = new Map()
  return globalThis.__ibkrHistCache
}

// ─── Public API — Historical Bars ─────────────────────────────────────────────

export async function fetchIBKRHistoricalBars(
  symbol:  string,
  numBars = 300,
): Promise<DailyBar[]> {
  const sym   = symbol.toUpperCase()
  const conid = IBKR_CONIDS[sym]

  if (!conid) {
    throw new Error(`[ibkrFetcher] No conid mapped for "${sym}". Add it to IBKR_CONIDS.`)
  }

  const cacheKey = `${sym}:${numBars}`
  const cache    = getIBKRCache()
  const now      = Date.now()
  const entry    = cache.get(cacheKey)

  if (entry && entry.expiresAt > now) {
    console.info(`[ibkrFetcher] CACHE HIT — ${sym} (${entry.bars.length} bars)`)
    return entry.bars
  }

  await ensureConnected()

  // 1 Y covers ≤252 daily bars; otherwise pull 2 Y of history.
  const durationStr = numBars <= 252 ? '1 Y' : '2 Y'
  const raw = await requestHistoricalBars(contractFor(sym, conid), durationStr)

  const bars = raw
    .filter(b => Number.isFinite(b.c) && b.c > 0)
    .sort((a, b) => a.t.localeCompare(b.t))
  const trimmed = bars.length > numBars ? bars.slice(-numBars) : bars

  cache.set(cacheKey, { bars: trimmed, expiresAt: now + HIST_TTL_MS })
  console.info(
    `[ibkrFetcher] FRESH — ${sym} conid=${conid}: ${trimmed.length} bars ` +
    `(duration=${durationStr}), latest=${trimmed[trimmed.length - 1]?.t ?? 'n/a'}, cached 1h`,
  )
  return trimmed
}

function getBarsInFlightMap(): Map<string, Promise<Record<string, DailyBar[]>>> {
  if (!globalThis.__ibkrBarsInFlight) globalThis.__ibkrBarsInFlight = new Map()
  return globalThis.__ibkrBarsInFlight
}

export async function fetchIBKRBarsMulti(
  symbols: string[],
  numBars = 300,
): Promise<Record<string, DailyBar[]>> {
  const dedupeKey = [...symbols].map(s => s.toUpperCase()).sort().join(',') + `:${numBars}`
  const inFlight  = getBarsInFlightMap()

  if (inFlight.has(dedupeKey)) {
    console.info(`[ibkrFetcher] BARS DEDUP — ${symbols.length} symbol(s) already in flight, awaiting`)
    return inFlight.get(dedupeKey)!
  }

  const work = (async () => {
    // Requests are serialised lightly via Promise.allSettled — the single
    // socket multiplexes them by reqId, so concurrent reqHistoricalData calls
    // are safe.
    const settled = await Promise.allSettled(
      symbols.map(async sym => ({
        sym:  sym.toUpperCase(),
        bars: await fetchIBKRHistoricalBars(sym, numBars),
      })),
    )
    const out: Record<string, DailyBar[]> = {}
    for (const r of settled) {
      if (r.status === 'fulfilled') out[r.value.sym] = r.value.bars
      else console.warn(`[ibkrFetcher] fetch failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
    }
    return out
  })()

  inFlight.set(dedupeKey, work)
  work.finally(() => inFlight.delete(dedupeKey))
  return work
}

// ─── Snapshot quote type ──────────────────────────────────────────────────────

export interface IBKRSnapshotQuote {
  symbol:        string
  price:         number
  change:        number
  changePercent: number
  high:          number
  low:           number
}

// ─── Snapshot request bridge (reqMktData) ─────────────────────────────────────
// TWS tick types we care about: 1=BID 2=ASK 4=LAST 6=HIGH 7=LOW 9=CLOSE(prev).
// snapshot=true makes the Gateway send one batch of ticks then `tickSnapshotEnd`.

const SNAPSHOT_REQ_TIMEOUT_MS = 8_000
const TICK = { BID: 1, ASK: 2, LAST: 4, HIGH: 6, LOW: 7, CLOSE: 9 } as const

interface TickAccumulator { last: number; close: number; high: number; low: number }

function requestSnapshot(symbol: string, contract: Contract): Promise<IBKRSnapshotQuote | null> {
  return new Promise<IBKRSnapshotQuote | null>((resolve) => {
    const conn  = getConn()
    const reqId = nextReqId()
    const acc: TickAccumulator = { last: 0, close: 0, high: 0, low: 0 }

    const finish = () => {
      cleanup()
      try { conn.api.cancelMktData(reqId) } catch { /* already cancelled */ }
      const price = acc.last > 0 ? acc.last : acc.close
      if (price <= 0) { resolve(null); return }
      const change = acc.close > 0 ? price - acc.close : 0
      const changePercent = acc.close > 0 ? (change / acc.close) * 100 : 0
      resolve({
        symbol, price,
        change, changePercent,
        high: acc.high, low: acc.low,
      })
    }

    const timer = setTimeout(finish, SNAPSHOT_REQ_TIMEOUT_MS)

    const onTick = (id: number, field: number, value: number) => {
      if (id !== reqId || !Number.isFinite(value) || value < 0) return
      switch (field) {
        case TICK.LAST:  acc.last  = value; break
        case TICK.CLOSE: acc.close = value; break
        case TICK.HIGH:  acc.high  = value; break
        case TICK.LOW:   acc.low   = value; break
      }
    }
    const onEnd = (id: number) => { if (id === reqId) finish() }
    const onErr = (_err: Error, _code: number, id: number) => { if (id === reqId) finish() }

    function cleanup() {
      clearTimeout(timer)
      conn.api.removeListener(EventName.tickPrice, onTick)
      conn.api.removeListener(EventName.tickSnapshotEnd, onEnd)
      conn.api.removeListener(EventName.error, onErr)
    }

    conn.api.on(EventName.tickPrice, onTick)
    conn.api.on(EventName.tickSnapshotEnd, onEnd)
    conn.api.on(EventName.error, onErr)

    // genericTickList='' , snapshot=true , regulatorySnapshot=false
    conn.api.reqMktData(reqId, contract, '', true, false)
  })
}

// ─── Snapshot cache ───────────────────────────────────────────────────────────

const SNAPSHOT_TTL_MS = 5 * 60 * 1_000

interface IBKRSnapshotCacheEntry { quote: IBKRSnapshotQuote; expiresAt: number }

declare global {
  // eslint-disable-next-line no-var
  var __ibkrSnapshotCache: Map<string, IBKRSnapshotCacheEntry> | undefined
}

function getSnapshotCache(): Map<string, IBKRSnapshotCacheEntry> {
  if (!globalThis.__ibkrSnapshotCache) globalThis.__ibkrSnapshotCache = new Map()
  return globalThis.__ibkrSnapshotCache
}

// ─── Public API — Snapshot Quotes ─────────────────────────────────────────────

export async function fetchIBKRSnapshotQuotes(
  symbols: string[],
): Promise<Map<string, IBKRSnapshotQuote>> {
  const cache  = getSnapshotCache()
  const now    = Date.now()
  const result = new Map<string, IBKRSnapshotQuote>()
  const pending: Array<{ sym: string; conid: number }> = []

  for (const sym of symbols) {
    const entry = cache.get(sym)
    if (entry && entry.expiresAt > now) {
      result.set(sym, entry.quote)
      console.info(`[ibkrFetcher] SNAPSHOT CACHE HIT — ${sym}`)
      continue
    }
    const conid = IBKR_SNAPSHOT_CONIDS[sym]
    if (conid !== undefined) pending.push({ sym, conid })
    else console.warn(`[ibkrFetcher] No snapshot conid for "${sym}" — will fall back`)
  }

  if (pending.length === 0) return result

  await ensureConnected()

  const expiresAt = now + SNAPSHOT_TTL_MS
  const settled = await Promise.allSettled(
    pending.map(async ({ sym, conid }) => ({
      sym,
      quote: await requestSnapshot(sym, contractFor(sym, conid)),
    })),
  )

  let fetched = 0
  for (const r of settled) {
    if (r.status === 'fulfilled' && r.value.quote) {
      cache.set(r.value.sym, { quote: r.value.quote, expiresAt })
      result.set(r.value.sym, r.value.quote)
      fetched++
    } else if (r.status === 'rejected') {
      console.warn(`[ibkrFetcher] snapshot failed: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`)
    }
  }
  // Reference CONID_TO_SNAPSHOT_SYM so the reverse map stays a maintained export
  void CONID_TO_SNAPSHOT_SYM
  console.info(
    `[ibkrFetcher] SNAPSHOT FRESH — ${fetched}/${pending.length} quotes ` +
    `(cached ${SNAPSHOT_TTL_MS / 60_000}min)`,
  )
  return result
}
