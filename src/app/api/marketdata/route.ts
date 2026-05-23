/**
 * /api/marketdata — Interactive Brokers Client Portal Proxy
 *
 * All IB gateway calls happen here on the server so the browser never touches
 * https://localhost:5000 directly (no CORS, no mixed-content, no cert errors).
 *
 * Node.js rejects self-signed TLS certificates by default.
 * We solve this cleanly by creating a persistent https.Agent with
 * `rejectUnauthorized: false` and passing it to every gateway request.
 * This is intentional and safe because the target is always localhost:5000.
 *
 * ─── IB Gateway setup reminder ────────────────────────────────────────────────
 * 1. Download & run the Client Portal Gateway from ibkr.com/cpwebapi
 * 2. Open https://localhost:5000 in your browser → log in with IBKR credentials
 * 3. Leave the gateway running — this route handles the rest
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { type NextRequest, NextResponse }   from 'next/server'
import https, { type RequestOptions }       from 'node:https'
import { type IncomingMessage }             from 'node:http'

// ─── Runtime Config ──────────────────────────────────────────────────────────

export const runtime = 'nodejs'        // Must be Node.js — Edge runtime has no https module
export const dynamic = 'force-dynamic' // Never cache; every request goes to the live gateway

// ─── IB Gateway Constants ────────────────────────────────────────────────────

const IB_GATEWAY = 'https://localhost:5000/v1/api'

/**
 * IB market-data field codes for the snapshot endpoint.
 *  31   = Last Price          (the real-time trade price)
 *  70   = Day High
 *  71   = Day Low
 *  83   = Change %            (comes as "+0.49%")
 *  84   = Bid
 *  86   = Ask
 *  7741 = Change (absolute $)
 *  7295 = Open
 */
const IB_SNAPSHOT_FIELDS = '31,70,71,83,84,86,7741,7295'

/**
 * Persistent TLS agent — rejectUnauthorized: false bypasses IB's self-signed cert.
 * keepAlive reuses the TCP connection across 4-second polls (saves ~60 ms handshake).
 *
 * ⚠️  rejectUnauthorized: false is ONLY safe because this agent is exclusively
 *     used to reach our own localhost:5000 process, never external hosts.
 */
const IB_AGENT = new https.Agent({
  rejectUnauthorized: false,
  keepAlive:          true,
  keepAliveMsecs:     15_000,
  maxSockets:         4,
})

// ─── Conid Registry ──────────────────────────────────────────────────────────
//
// Contract IDs for the instruments this dashboard tracks.
//
// IMPORTANT — Futures conids rotate quarterly on the CME roll date.
// To look up the current front-month conid:
//   POST https://localhost:5000/v1/api/iserver/secdef/search
//   Content-Type: application/json
//   { "symbol": "ES", "secType": "FUT", "exchange": "CME" }
//
// The response includes a "conid" field for each expiry.  Pick the one with
// the nearest expiry date that is still in the future.

const CONID_REGISTRY = {
  // ── Equity-Index Futures (CME, quarterly roll: Mar/Jun/Sep/Dec) ───────────
  '495512572': { symbol: 'ES=F',  name: 'S&P E-Mini',    assetClass: 'future'    as const },
  '551601555': { symbol: 'NQ=F',  name: 'NQ E-Mini',     assetClass: 'future'    as const },
  '627547492': { symbol: 'YM=F',  name: 'DOW E-Mini',    assetClass: 'future'    as const },
  '495512573': { symbol: 'RTY=F', name: 'Russell Mini',  assetClass: 'future'    as const },
  // ── Cash Indices (for Cross-Asset Ratio cards) ────────────────────────────
  '416904':    { symbol: '^GSPC', name: 'S&P 500',        assetClass: 'equity'    as const },
  '416905':    { symbol: '^NDX',  name: 'NASDAQ 100',     assetClass: 'equity'    as const },
  // ── Commodity Futures (COMEX/NYMEX front months) ──────────────────────────
  '69067924':  { symbol: 'GC=F',  name: 'Gold',           assetClass: 'commodity' as const },
  '69067925':  { symbol: 'SI=F',  name: 'Silver',         assetClass: 'commodity' as const },
  '69067926':  { symbol: 'HG=F',  name: 'Copper',         assetClass: 'commodity' as const },
  '69067927':  { symbol: 'CL=F',  name: 'WTI Crude',      assetClass: 'commodity' as const },
} satisfies Record<string, { symbol: string; name: string; assetClass: 'future' | 'equity' | 'commodity' }>

type ConidKey   = keyof typeof CONID_REGISTRY
type AssetClass = (typeof CONID_REGISTRY)[ConidKey]['assetClass']

/** Reverse map: Yahoo-style symbol → IB conid string */
const SYMBOL_TO_CONID: Record<string, string> = Object.fromEntries(
  Object.entries(CONID_REGISTRY).map(([cid, { symbol }]) => [symbol, cid])
)

/** Decimal places to use when rounding each instrument's price / change */
const TICK_DECIMALS: Record<string, number> = {
  'ES=F': 2, 'NQ=F': 2, 'YM=F': 0, 'RTY=F': 2,
  '^GSPC': 2, '^NDX': 2,
  'GC=F': 2, 'SI=F': 3, 'HG=F': 4, 'CL=F': 2,
}

/** Symbols returned when the client sends no ?symbols= param */
const DEFAULT_SYMBOLS = [
  'ES=F', 'NQ=F', '^GSPC', '^NDX',
  'GC=F', 'SI=F', 'HG=F', 'CL=F',
]

// ─── Public Response Types ────────────────────────────────────────────────────

export interface IBQuote {
  conid:         string
  symbol:        string
  name:          string
  assetClass:    AssetClass
  price:         number
  change:        number        // absolute $ / point change from prior close
  changePercent: number        // e.g. 0.49 represents +0.49 %
  high?:         number
  low?:          number
  open?:         number
  bid?:          number
  ask?:          number
}

export interface MarketDataResponse {
  authenticated: boolean
  snapshot:      IBQuote[]
  timestamp:     number
  partial?:      boolean   // true when IB returned blank fields (warm-up tick)
  error?:        string
}

// ─── Low-Level HTTPS Helpers ──────────────────────────────────────────────────

/** Wraps https.request in a Promise, using the shared IB_AGENT. */
function ibFetch(
  method:  'GET' | 'POST',
  path:    string,
  body?:   Record<string, unknown>,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const target  = new URL(`${IB_GATEWAY}${path}`)
    const payload = body ? Buffer.from(JSON.stringify(body), 'utf8') : null

    const opts: RequestOptions = {
      hostname: target.hostname,
      port:     Number(target.port) || 443,
      path:     target.pathname + target.search,
      method,
      agent:    IB_AGENT,
      timeout:  5_000,   // 5 s hard timeout — don't hang the poll cycle
      headers: {
        'Accept':       'application/json',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': String(payload.byteLength) } : {}),
      },
    }

    const req = https.request(opts, (res: IncomingMessage) => {
      const chunks: Buffer[] = []
      res.on('data',  (c: Buffer) => chunks.push(c))
      res.on('end',   () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json: unknown = text
        try { json = JSON.parse(text) } catch { /* leave as string */ }
        resolve({ status: res.statusCode ?? 200, json })
      })
      res.on('error', reject)
    })

    req.on('timeout', () => { req.destroy(); reject(new Error('IB gateway request timed out')) })
    req.on('error',   reject)
    if (payload) req.write(payload)
    req.end()
  })
}

// ─── IB Auth Check ────────────────────────────────────────────────────────────

async function checkIBAuth(): Promise<boolean> {
  // IB uses POST (not GET) for auth status
  const { status, json } = await ibFetch('POST', '/iserver/auth/status')
  if (status !== 200 || typeof json !== 'object' || json === null) return false
  return (json as Record<string, unknown>).authenticated === true
}

// ─── Data Transformation ──────────────────────────────────────────────────────

/** IB snapshot raw row — field keys are numeric strings ("31", "83", etc.) */
type IBRawRow = Record<string, unknown> & { conid: number }

/**
 * parseIBNumber
 *
 * IB returns numbers in several quirky formats:
 *   "5,823.25"   — locale-formatted with commas
 *   "+0.49%"     — change percent with leading + and trailing %
 *   "-1.78%"
 *   5823.25      — already a number (rare)
 *   ""           — field not yet available (warm-up)
 */
function parseIBNumber(raw: unknown): number {
  if (raw === undefined || raw === null || raw === '') return 0
  const cleaned = String(raw)
    .replace(/,/g, '')     // remove thousands separators
    .replace(/%/g, '')     // remove percent sign
    .replace(/^\+/, '')    // remove leading +
  return parseFloat(cleaned) || 0
}

/**
 * transformRow
 *
 * Converts one IB snapshot row into a clean IBQuote.
 * Returns null if the conid isn't in our registry.
 */
function transformRow(row: IBRawRow): IBQuote | null {
  const conid = String(row.conid)
  const meta  = CONID_REGISTRY[conid as ConidKey]
  if (!meta) return null

  const dec   = TICK_DECIMALS[meta.symbol] ?? 2
  const round = (n: number) => parseFloat(n.toFixed(dec))

  const price  = round(parseIBNumber(row['31']))
  const high   = round(parseIBNumber(row['70']))
  const low    = round(parseIBNumber(row['71']))
  const open   = round(parseIBNumber(row['7295']))
  const bid    = round(parseIBNumber(row['84']))
  const ask    = round(parseIBNumber(row['86']))
  // Field 83 arrives as "+0.49%" → parseIBNumber yields 0.49 (already percent, not decimal)
  const changePct = round(parseIBNumber(row['83']))
  let   changeAbs = round(parseIBNumber(row['7741']))

  // Cross-derive if one of the two change fields is missing
  if (!changeAbs && changePct && price)  changeAbs = round((price * changePct) / 100)
  const changePercent = changePct || (changeAbs && open ? round((changeAbs / open) * 100) : 0)

  return {
    conid,
    symbol:     meta.symbol,
    name:       meta.name,
    assetClass: meta.assetClass,
    price,
    change:     changeAbs,
    changePercent,
    ...(high > 0 ? { high } : {}),
    ...(low  > 0 ? { low  } : {}),
    ...(open > 0 ? { open } : {}),
    ...(bid  > 0 ? { bid  } : {}),
    ...(ask  > 0 ? { ask  } : {}),
  }
}

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse<MarketDataResponse>> {
  const url = new URL(req.url)

  // Parse ?symbols=ES=F,NQ=F,GC=F  (default: everything in CONID_REGISTRY)
  const requestedSymbols = url.searchParams.has('symbols')
    ? url.searchParams.get('symbols')!.split(',').map(s => s.trim()).filter(Boolean)
    : DEFAULT_SYMBOLS

  const conids = requestedSymbols
    .map(sym => SYMBOL_TO_CONID[sym])
    .filter(Boolean)

  if (conids.length === 0) {
    return NextResponse.json(
      { authenticated: false, snapshot: [], timestamp: Date.now(), error: 'No valid symbols requested' },
      { status: 400 }
    )
  }

  // ── Step 1: Verify the IB gateway is reachable and authenticated ────────────
  let authenticated = false
  try {
    authenticated = await checkIBAuth()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      {
        authenticated: false,
        snapshot:      [],
        timestamp:     Date.now(),
        error: `IB gateway unreachable (${msg}). ` +
               'Start the Client Portal Gateway and log in at https://localhost:5000.',
      },
      { status: 503 }
    )
  }

  if (!authenticated) {
    return NextResponse.json(
      {
        authenticated: false,
        snapshot:      [],
        timestamp:     Date.now(),
        error: 'IB session not authenticated. Open https://localhost:5000 and log in.',
      },
      { status: 401 }
    )
  }

  // ── Step 2: Fetch market-data snapshot ─────────────────────────────────────
  //
  // IB note: the first snapshot call for a new conid often returns empty fields
  // because IB streams market data lazily.  The hook handles this with a
  // double-fetch on first connect; this route just returns what IB gives us.
  let rawRows: IBRawRow[] = []
  try {
    const path = `/iserver/marketdata/snapshot?conids=${conids.join(',')}&fields=${IB_SNAPSHOT_FIELDS}`
    const { status, json } = await ibFetch('GET', path)
    if (status !== 200) throw new Error(`HTTP ${status} from IB snapshot endpoint`)
    rawRows = Array.isArray(json) ? (json as IBRawRow[]) : []
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return NextResponse.json(
      { authenticated: true, snapshot: [], timestamp: Date.now(), error: `Snapshot failed: ${msg}` },
      { status: 502 }
    )
  }

  // ── Step 3: Transform and respond ──────────────────────────────────────────
  const snapshot = rawRows.flatMap(row => {
    const quote = transformRow(row)
    return quote ? [quote] : []
  })

  // partial=true signals the hook to schedule an immediate re-poll
  const partial = snapshot.length < conids.length || snapshot.some(q => q.price === 0)

  return NextResponse.json({
    authenticated: true,
    snapshot,
    timestamp: Date.now(),
    ...(partial ? { partial: true } : {}),
  })
}
