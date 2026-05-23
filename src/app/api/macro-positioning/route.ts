import { NextResponse } from 'next/server'
import fs   from 'node:fs'
import path from 'node:path'
import os   from 'node:os'

// Force Next.js App Router to never cache this route handler
export const dynamic = 'force-dynamic'

// ─── Cache ────────────────────────────────────────────────────────────────────

const CACHE_PATH   = path.join(os.tmpdir(), 'cot_cache.json')
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000

// ─── Socrata dataset identifiers ─────────────────────────────────────────────
//
//   gpe5-46if  Traders in Financial Futures (TFF)
//              Lev funds: lev_money_positions_long / lev_money_positions_short
//              Dealers:   dealer_positions_long_all / dealer_positions_short_all
//
//   72hh-3qpy  Disaggregated COT (physical commodities)
//              Managed money: m_money_positions_long_all / m_money_positions_short_all
//              Prod/Merch:    prod_merc_positions_long_all / prod_merc_positions_short_all
//
// Contract codes verified live through 2026-05-19:
//   EQUITY BETA      ES 13874A | NQ 20974+ | RTY 239742 | VX 1170E1
//   COST OF CAPITAL  SR3 134741 | ZT 042601 | ZF 044601 | ZN 043602 | ZB 020601
//   FIAT FLOWS       DX 098662 | 6E 099741 | 6J 097741 | 6A 232741 | 6C 090741
//   HARD ASSETS      CL 067651 | NG 023391 | GC 088691 | SI 084691 | HG 085692
//   CRYPTO LIQUIDITY BTC 133741

const BASE = 'https://publicreporting.cftc.gov/resource'
const TFF  = 'gpe5-46if'
const DIS  = '72hh-3qpy'

// TFF column aliases
const TFF_LONG       = 'lev_money_positions_long'
const TFF_SHORT      = 'lev_money_positions_short'
const TFF_COMM_LONG  = 'dealer_positions_long_all'
const TFF_COMM_SHORT = 'dealer_positions_short_all'

// Disaggregated column aliases
const DIS_LONG       = 'm_money_positions_long_all'
const DIS_SHORT      = 'm_money_positions_short_all'
const DIS_COMM_LONG  = 'prod_merc_positions_long_all'
const DIS_COMM_SHORT = 'prod_merc_positions_short_all'

// ─── Types ────────────────────────────────────────────────────────────────────

// Four structural macro themes (BTC merged into 'currency' alongside FX)
export type Category   = 'indexes' | 'treasuries' | 'currency' | 'commodity'
export type AccelGlyph = '▲▲' | '△' | '▼▼' | '▽' | '⇅'

interface ContractDef {
  symbol:    string
  label:     string
  category:  Category
  dataset:   string
  code:      string
  longCol:   string
  shortCol:  string
  commLong:  string
  commShort: string
}

// ─── 20 Production Contracts ──────────────────────────────────────────────────

const CONTRACTS: ContractDef[] = [
  // ── EQUITY BETA ──────────────────────────────────────────────────────────────
  { symbol:'ES',  label:'S&P 500 (ES)',       category:'indexes',     dataset:TFF, code:'13874A', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  { symbol:'NQ',  label:'Nasdaq-100 (NQ)',    category:'indexes',     dataset:TFF, code:'20974+', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  { symbol:'RTY', label:'Russell 2000 (RTY)', category:'indexes',     dataset:TFF, code:'239742', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  { symbol:'VX',  label:'VIX Futures (VX)',   category:'indexes',     dataset:TFF, code:'1170E1', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  // ── COST OF CAPITAL ──────────────────────────────────────────────────────────
  { symbol:'SR3', label:'SOFR 3M (SR3)',       category:'treasuries',     dataset:TFF, code:'134741', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  { symbol:'ZT',  label:'2Y T-Note (ZT)',      category:'treasuries',     dataset:TFF, code:'042601', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  { symbol:'ZF',  label:'5Y T-Note (ZF)',      category:'treasuries',     dataset:TFF, code:'044601', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  { symbol:'ZN',  label:'10Y T-Note (ZN)',     category:'treasuries',     dataset:TFF, code:'043602', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  { symbol:'ZB',  label:'30Y T-Bond (ZB)',     category:'treasuries',     dataset:TFF, code:'020601', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  // ── FIAT FLOWS ───────────────────────────────────────────────────────────────
  { symbol:'DX',  label:'Dollar Index (DX)',   category:'currency',        dataset:TFF, code:'098662', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  { symbol:'6E',  label:'Euro (6E)',            category:'currency',        dataset:TFF, code:'099741', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  { symbol:'6J',  label:'Yen (6J)',             category:'currency',        dataset:TFF, code:'097741', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  { symbol:'6A',  label:'Aussie Dollar (6A)',   category:'currency',        dataset:TFF, code:'232741', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  { symbol:'6C',  label:'Cdn Dollar (6C)',      category:'currency',        dataset:TFF, code:'090741', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  // ── CRYPTO LIQUIDITY ─────────────────────────────────────────────────────────
  { symbol:'BTC', label:'Bitcoin (BTC)',          category:'currency',    dataset:TFF, code:'133741', longCol:TFF_LONG, shortCol:TFF_SHORT, commLong:TFF_COMM_LONG, commShort:TFF_COMM_SHORT },
  // ── HARD ASSETS ──────────────────────────────────────────────────────────────
  { symbol:'CL',  label:'Crude Oil (WTI)',        category:'commodity', dataset:DIS, code:'067651', longCol:DIS_LONG, shortCol:DIS_SHORT, commLong:DIS_COMM_LONG, commShort:DIS_COMM_SHORT },
  { symbol:'NG',  label:'Nat Gas (NG)',          category:'commodity', dataset:DIS, code:'023391', longCol:DIS_LONG, shortCol:DIS_SHORT, commLong:DIS_COMM_LONG, commShort:DIS_COMM_SHORT },
  { symbol:'GC',  label:'Gold (GC)',             category:'commodity', dataset:DIS, code:'088691', longCol:DIS_LONG, shortCol:DIS_SHORT, commLong:DIS_COMM_LONG, commShort:DIS_COMM_SHORT },
  { symbol:'SI',  label:'Silver (SI)',           category:'commodity', dataset:DIS, code:'084691', longCol:DIS_LONG, shortCol:DIS_SHORT, commLong:DIS_COMM_LONG, commShort:DIS_COMM_SHORT },
  { symbol:'HG',  label:'Copper (HG)',           category:'commodity', dataset:DIS, code:'085692', longCol:DIS_LONG, shortCol:DIS_SHORT, commLong:DIS_COMM_LONG, commShort:DIS_COMM_SHORT },
]

// ─── Shared exported types ────────────────────────────────────────────────────

export interface PositioningRow {
  // Identity
  symbol:                string
  label:                 string
  category:              Category
  date:                  string
  // Leveraged fund positioning
  leveragedNet:          number
  leveragedNetFormatted: string
  weeklyChange:          number
  weeklyChangeFormatted: string
  positioningScale:      number   // 0–100 percentile in 3-yr range
  zeroLinePosition:      number   // where net=0 sits on the 0–100 scale
  historicalMin:         number
  historicalMax:         number
  // 1-Week velocity
  accelerationGlyph:     AccelGlyph
  // Divergence signal
  divergenceVector:      'SQUEEZE' | null
  // Commercial / open-interest
  commercialNet:         number
  openInterest:          number
  openInterestChange:    number
  // Bias narrative
  marketBias:            'LONG' | 'SHORT' | 'NEUTRAL'
  biasExplanation:       string
  // Meta
  ok:                    boolean
  error?:                string
}

export interface MacroPositioningData {
  rows:       PositioningRow[]
  status:     'AUTHENTICATED' | 'DEMO_FALLBACK'
  timestamp:  string
  liveCount:  number
  totalCount: number
  cacheHit:   boolean
}

// ─── File cache ───────────────────────────────────────────────────────────────

interface CacheEnvelope { writtenAt: number; rows: PositioningRow[] }

function readCache(): CacheEnvelope | null {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8')
    const env = JSON.parse(raw) as CacheEnvelope
    if (Date.now() - env.writtenAt < CACHE_TTL_MS) return env
    return null
  } catch { return null }
}

function writeCache(rows: PositioningRow[]): void {
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify({ writtenAt: Date.now(), rows }), 'utf8') }
  catch (err) { console.warn('[macro-positioning] cache write failed:', err) }
}

// ─── CFTC Socrata fetch ───────────────────────────────────────────────────────

interface CftcRow { report_date_as_yyyy_mm_dd: string; [k: string]: string }

async function fetchCftcHistory(def: ContractDef): Promise<CftcRow[]> {
  // Core columns — proven working across both TFF and DIS datasets
  const coreCols = [
    'report_date_as_yyyy_mm_dd',
    'open_interest_all',
    def.longCol,
    def.shortCol,
  ]
  // Full columns — adds commercial longs/shorts; may fail if column names differ per dataset
  const fullCols = [...coreCols, def.commLong, def.commShort]

  const attempt = (cols: string[]) => {
    const params = new URLSearchParams({
      $limit:  '156',
      $where:  `cftc_contract_market_code="${def.code}" AND futonly_or_combined="FutOnly"`,
      $order:  'report_date_as_yyyy_mm_dd DESC',
      $select: cols.join(','),
    })
    return fetch(`${BASE}/${def.dataset}.json?${params}`, {
      cache:  'no-store',
      signal: AbortSignal.timeout(15_000),
    })
  }

  // First attempt: full column set (lev funds + OI + commercial)
  let res = await attempt(fullCols)

  // Graceful degradation: if commercial column names don't exist on this dataset,
  // fall back to core-only so the contract still loads live (commercialNet → 0).
  if (!res.ok) {
    console.warn(`[macro-positioning] ${def.symbol} full query failed (HTTP ${res.status}), retrying core-only`)
    res = await attempt(coreCols)
  }

  if (!res.ok) throw new Error(`CFTC HTTP ${res.status} for ${def.symbol}`)
  return res.json() as Promise<CftcRow[]>
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function fmtK(v: number): string {
  const r = Math.round(v / 1_000)
  if (r === 0) return '~0K'
  return `${r > 0 ? '+' : ''}${r}K`
}

function fmtKwk(v: number): string {
  const r = Math.round(v / 1_000)
  if (r === 0) return '~0K/wk'
  return `${r > 0 ? '+' : ''}${r}K/wk`
}

// ─── Narrative builder ────────────────────────────────────────────────────────

function buildNarrative(
  net:      number,
  change:   number,
  scale:    number,
  commNet:  number,
  oi:       number,
  oiChg:    number,
  glyph:    AccelGlyph,
  squeeze:  'SQUEEZE' | null,
): string {
  const dir      = net >= 0 ? 'long' : 'short'
  const scaleLbl = scale < 20
    ? `historically compressed (${scale.toFixed(0)}th percentile — bottom quintile)`
    : scale > 80
    ? `historically stretched (${scale.toFixed(0)}th percentile — top quintile)`
    : `mid-range (${scale.toFixed(0)}th percentile)`
  const adding   = change >= 0 ? 'adding' : 'trimming'
  const commDir  = commNet >= 0 ? 'long' : 'short'
  const oiTrend  = oiChg >= 0 ? 'expanding' : 'contracting'
  const velLabel = glyph === '▲▲' ? 'accelerating higher'
    : glyph === '△'  ? 'decelerating — upward momentum fading'
    : glyph === '▼▼' ? 'accelerating lower'
    : glyph === '▽'  ? 'decelerating — downward momentum fading'
    : 'oscillating with no clear directional bias'

  let text =
    `Leveraged funds are net ${dir} ${Math.abs(Math.round(net / 1_000))}K contracts, ${scaleLbl}. ` +
    `This week they are ${adding} ${Math.abs(Math.round(change / 1_000))}K — velocity is ${velLabel}. ` +
    `Open interest is ${oiTrend} (${oiChg >= 0 ? '+' : ''}${Math.round(oiChg / 1_000)}K WoW to ${Math.round(oi / 1_000)}K total). ` +
    `Commercials are net ${commDir} ${Math.abs(Math.round(commNet / 1_000))}K.`

  if (squeeze === 'SQUEEZE') {
    text +=
      ' ⚡ REVERSAL SQUEEZE ACTIVE: positioning is at a multi-year extreme while' +
      ' commercials are positioned in the opposite direction — historically a high-probability mean-reversion catalyst.'
  }
  return text
}

// ─── Signal math ──────────────────────────────────────────────────────────────

function buildRow(def: ContractDef, rows: CftcRow[]): PositioningRow {
  if (rows.length < 3) throw new Error(`Only ${rows.length} weeks of data for ${def.symbol}`)

  // Leveraged fund net series (newest first)
  const nets = rows.map(r =>
    (parseFloat(r[def.longCol]) || 0) - (parseFloat(r[def.shortCol]) || 0),
  )
  const current      = nets[0]
  const prev         = nets[1]
  const prev2        = nets[2]
  const weeklyChange = current - prev
  const priorChange  = prev - prev2

  // 3-year rolling bounds
  const histMax = Math.max(...nets)
  const histMin = Math.min(...nets)
  const range   = histMax - histMin

  const posScale    = range > 0 ? ((current - histMin) / range) * 100 : 50
  const zeroLinePct = range > 0 ? ((0       - histMin) / range) * 100 : 50
  const positioningScale = Math.max(0, Math.min(100, posScale))
  const zeroLinePosition = Math.max(0, Math.min(100, zeroLinePct))

  // 1-Week acceleration glyph
  let accelerationGlyph: AccelGlyph = '⇅'
  if      (weeklyChange > 0 && weeklyChange > priorChange)  accelerationGlyph = '▲▲'
  else if (weeklyChange > 0 && weeklyChange <= priorChange) accelerationGlyph = '△'
  else if (weeklyChange < 0 && weeklyChange < priorChange)  accelerationGlyph = '▼▼'
  else if (weeklyChange < 0 && weeklyChange >= priorChange) accelerationGlyph = '▽'

  // Commercial net (Dealer for TFF, Prod/Merch for Disaggregated)
  const commercialNet = (parseFloat(rows[0][def.commLong]) || 0) - (parseFloat(rows[0][def.commShort]) || 0)

  // Open interest + week-over-week change
  const openInterest       = parseFloat(rows[0]['open_interest_all']) || 0
  const openInterestChange = rows.length > 1
    ? openInterest - (parseFloat(rows[1]['open_interest_all']) || 0)
    : 0

  // Divergence vector: extreme COT index + commercial inversion = SQUEEZE
  const isExtreme  = positioningScale < 10 || positioningScale > 90
  const isInverted = (current > 0 && commercialNet < 0) || (current < 0 && commercialNet > 0)
  const divergenceVector: 'SQUEEZE' | null = (isExtreme && isInverted) ? 'SQUEEZE' : null

  // Market bias
  const marketBias: 'LONG' | 'SHORT' | 'NEUTRAL' =
    current > 0 ? 'LONG' : current < 0 ? 'SHORT' : 'NEUTRAL'

  return {
    symbol:                def.symbol,
    label:                 def.label,
    category:              def.category,
    date:                  rows[0].report_date_as_yyyy_mm_dd.split('T')[0],
    leveragedNet:          current,
    leveragedNetFormatted: fmtK(current),
    weeklyChange,
    weeklyChangeFormatted: fmtKwk(weeklyChange),
    positioningScale:      parseFloat(positioningScale.toFixed(1)),
    zeroLinePosition:      parseFloat(zeroLinePosition.toFixed(1)),
    historicalMin:         histMin,
    historicalMax:         histMax,
    accelerationGlyph,
    divergenceVector,
    commercialNet,
    openInterest,
    openInterestChange,
    marketBias,
    biasExplanation: buildNarrative(
      current, weeklyChange, positioningScale,
      commercialNet, openInterest, openInterestChange,
      accelerationGlyph, divergenceVector,
    ),
    ok: true,
  }
}

// ─── Mock fallback rows (one per CONTRACTS entry, same order) ─────────────────

const _d = new Date().toISOString().split('T')[0]
const _m = (
  symbol: string, label: string, category: Category,
  leveragedNet: number, weeklyChange: number,
  positioningScale: number, zeroLinePosition: number,
  historicalMin: number, historicalMax: number,
): PositioningRow => ({
  symbol, label, category, date: _d,
  leveragedNet,          leveragedNetFormatted: fmtK(leveragedNet),
  weeklyChange,          weeklyChangeFormatted: fmtKwk(weeklyChange),
  positioningScale,      zeroLinePosition,
  historicalMin,         historicalMax,
  accelerationGlyph:     '⇅',
  divergenceVector:      null,
  commercialNet:         0,
  openInterest:          0,
  openInterestChange:    0,
  marketBias:            leveragedNet > 0 ? 'LONG' : leveragedNet < 0 ? 'SHORT' : 'NEUTRAL',
  biasExplanation:       'Demo data — live CFTC feed unavailable for this contract.',
  ok: false,
})

const MOCK_ROWS: PositioningRow[] = [
  // EQUITY BETA
  _m('ES',  'S&P 500 (ES)',       'indexes',      -401554,   30884,  45,    100,  -576131,  -188500),
  _m('NQ',  'Nasdaq-100 (NQ)',    'indexes',       -65822,    5133,  40,     95,  -180000,   -20000),
  _m('RTY', 'Russell 2000 (RTY)', 'indexes',       -67429,    1200,  38,     90,  -130000,        0),
  _m('VX',  'VIX Futures (VX)',   'indexes',       -51904,   -4594,  30,     85,  -120000,    10000),
  // COST OF CAPITAL
  _m('SR3', 'SOFR 3M (SR3)',      'treasuries',     -1610423,  -85000,  30,    100, -3500000,  -200000),
  _m('ZT',  '2Y T-Note (ZT)',     'treasuries',     -1878632,   -9184,  35,    100, -2500000,  -600000),
  _m('ZF',  '5Y T-Note (ZF)',     'treasuries',     -2306447,   50000,  38,    100, -3800000,  -800000),
  _m('ZN',  '10Y T-Note (ZN)',    'treasuries',     -1952737,    4205,  39,    100, -2534616, -1066372),
  _m('ZB',  '30Y T-Bond (ZB)',    'treasuries',      -326383,   11324,  42,    100,  -480000,   -80000),
  // FIAT FLOWS
  _m('DX',  'Dollar Index (DX)',  'currency',          -11716,    2800,  30,     60,   -55000,    40000),
  _m('6E',  'Euro (6E)',          'currency',           16317,    3100,  55,     45,  -120000,   150000),
  _m('6J',  'Yen (6J)',           'currency',          -64945,   -8500,  35,     65,  -130000,    60000),
  _m('6A',  'Aussie Dollar (6A)', 'currency',           61178,    5000,  70,     40,   -80000,   120000),
  _m('6C',  'Cdn Dollar (6C)',    'currency',          -38654,   -3000,  30,     55,   -90000,    50000),
  // CRYPTO LIQUIDITY
  _m('BTC', 'Bitcoin (BTC)',      'currency',        -8961,   -1500,  25,     60,   -30000,    20000),
  // HARD ASSETS
  _m('CL',  'Crude Oil (WTI)',    'commodity',    98219,   20233,  40,     11,   -38154,   301660),
  _m('NG',  'Nat Gas (NG)',       'commodity',   383979,  -13032,  65,     20,  -200000,   800000),
  _m('GC',  'Gold (GC)',          'commodity',    93540,   -4475,  48,     10,   -26767,   219029),
  _m('SI',  'Silver (SI)',        'commodity',    11564,     850,  55,     15,   -20000,    60000),
  _m('HG',  'Copper (HG)',        'commodity',    74188,    -300,  98,     36,   -43928,    75619),
]

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET() {
  // 1. Try file cache
  const cached = readCache()
  if (cached) {
    // Reject stale caches that have fewer rows than current CONTRACTS count
    if (cached.rows.length === CONTRACTS.length) {
      const liveCount = cached.rows.filter(r => r.ok).length
      console.info(`[macro-positioning] cache HIT — ${liveCount}/${cached.rows.length} live`)
      return NextResponse.json({
        rows:       cached.rows,
        status:     liveCount > 0 ? 'AUTHENTICATED' : 'DEMO_FALLBACK',
        timestamp:  new Date(cached.writtenAt).toISOString(),
        liveCount,
        totalCount: cached.rows.length,
        cacheHit:   true,
      } satisfies MacroPositioningData)
    }
    console.info(`[macro-positioning] cache STALE (${cached.rows.length} rows vs ${CONTRACTS.length} expected) — re-fetching`)
  }

  // 2. Fetch all contracts concurrently
  console.info(`[macro-positioning] cache MISS — fetching ${CONTRACTS.length} contracts from CFTC`)
  const settled = await Promise.allSettled(CONTRACTS.map(fetchCftcHistory))

  const rows: PositioningRow[] = CONTRACTS.map((def, i) => {
    const result = settled[i]
    if (result.status === 'fulfilled') {
      try { return buildRow(def, result.value) }
      catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.warn(`[macro-positioning] ${def.symbol} buildRow error: ${msg}`)
        return { ...MOCK_ROWS[i], error: msg }
      }
    }
    const msg = result.reason instanceof Error ? result.reason.message : String(result.reason)
    console.warn(`[macro-positioning] ${def.symbol} fetch error: ${msg}`)
    return { ...MOCK_ROWS[i], error: msg }
  })

  writeCache(rows)

  const liveCount = rows.filter(r => r.ok).length
  const status: MacroPositioningData['status'] = liveCount > 0 ? 'AUTHENTICATED' : 'DEMO_FALLBACK'

  console.info(
    `[macro-positioning] ${status} — ` +
    rows.map(r => `${r.symbol}:${r.leveragedNetFormatted}${r.ok ? '' : '*'}`).join(' '),
  )

  return NextResponse.json({
    rows,
    status,
    timestamp:  new Date().toISOString(),
    liveCount,
    totalCount: rows.length,
    cacheHit:   false,
  } satisfies MacroPositioningData)
}
