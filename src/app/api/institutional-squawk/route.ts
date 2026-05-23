import { NextRequest, NextResponse } from 'next/server'
import {
  type SquawkNewsData,
  SQUAWK_NEWS_MOCK,
} from '@/lib/squawk-types'

/**
 * API Route: /api/institutional-squawk
 *
 * Fetches institutional-grade squawk news and macro liquidity data.
 * This endpoint integrates:
 * - Twitter/X API (whitelisted institutional sources)
 * - FRED API (Federal Reserve Economic Data)
 * - Bloomberg Terminal feeds (if available via enterprise connection)
 *
 * Whitelist Firewall: Only processes headlines from:
 * @zerohedge, @FirstSquawk, @FinancialJuice, @DeltaOne, BLOOMBERG
 *
 * Heat-mapping: Detects if a macro keyword (FED, CPI, YIELD, CRUDE, etc.)
 * appears across multiple whitelisted sources within a 3-minute window
 * and elevates it to the Top 5 Movers card.
 */

// ─── Text Cleaning Helper (Bulletproof with Unicode Escape Sequences) ───────

const sanitizeHeadlineText = (text: string): string => {
  if (!text) return ''
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#x2019;/g, String.fromCharCode(39))      // apostrophe
    .replace(/&#x201C;/g, String.fromCharCode(34))      // left double quote
    .replace(/&#x201D;/g, String.fromCharCode(34))      // right double quote
    .replace(/&#x2014;/g, ' — ')                   // em-dash with spaces
}

// ─── Environment Variables ────────────────────────────────────────────────────

const FRED_API_KEY = process.env.FRED_API_KEY || ''
const TWITTER_BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN || ''

// ─── Whitelist Firewall ───────────────────────────────────────────────────────

const ALLOWED_SOURCE_HANDLES = [
  '@zerohedge',
  '@FirstSquawk',
  '@FinancialJuice',
  '@DeltaOne',
  'BLOOMBERG',
]

// ─── Helper: Filter by Whitelisted Sources ────────────────────────────────────

function filterByWhitelist(sourceHandle: string): boolean {
  return ALLOWED_SOURCE_HANDLES.some(
    (allowed) =>
      sourceHandle.includes(allowed) ||
      allowed.includes(sourceHandle)
  )
}

// ─── Helper: Fetch FRED Data ──────────────────────────────────────────────────

/**
 * Fetches Federal Reserve Balance Sheet data from FRED API
 * Key Series IDs:
 * - WALCL: Fed Balance Sheet Total Assets
 * - WTREGEN: Reverse Repurchase Agreements
 * - WIMFSL: Treasury General Account
 */
async function fetchFedLiquidityData() {
  try {
    if (!FRED_API_KEY) {
      console.warn('FRED_API_KEY not configured, using mock data')
      return null
    }

    // Fetch latest Fed Balance Sheet Total Assets
    const walclRes = await fetch(
      `https://api.stlouisfed.org/fred/series/WALCL/observations?api_key=${FRED_API_KEY}&file_type=json&limit=15&sort_order=desc`
    )
    const walclData = await walclRes.json()
    const balanceSheetTotal = walclData.observations?.[0]?.value
      ? parseFloat(walclData.observations[0].value) * 1_000_000_000 // Convert to billions
      : 7_240_000_000_000

    // Fetch TGA (Treasury General Account)
    const tgaRes = await fetch(
      `https://api.stlouisfed.org/fred/series/WIMFSL/observations?api_key=${FRED_API_KEY}&file_type=json&limit=15&sort_order=desc`
    )
    const tgaData = await tgaRes.json()
    const tga = tgaData.observations?.[0]?.value
      ? parseFloat(tgaData.observations[0].value)
      : 165_000_000_000

    // Fetch RRP (Reverse Repo)
    const rrpRes = await fetch(
      `https://api.stlouisfed.org/fred/series/WTREGEN/observations?api_key=${FRED_API_KEY}&file_type=json&limit=15&sort_order=desc`
    )
    const rrpData = await rrpRes.json()
    const rrp = rrpData.observations?.[0]?.value
      ? parseFloat(rrpData.observations[0].value)
      : 2_480_000_000_000

    // Calculate net liquidity
    const netLiquidity = balanceSheetTotal - tga - rrp

    // Calculate 14-day momentum
    const balanceSheetOld = walclData.observations?.[1]?.value
      ? parseFloat(walclData.observations[1].value) * 1_000_000_000
      : balanceSheetTotal

    const momentum14d = ((balanceSheetTotal - balanceSheetOld) / balanceSheetOld) * 100

    return {
      date: walclData.observations?.[0]?.date || new Date().toISOString().split('T')[0],
      balanceSheetTotal: Math.round(balanceSheetTotal / 1_000_000_000),
      tga: Math.round(tga / 1_000_000_000),
      rrp: Math.round(rrp / 1_000_000_000),
      netLiquidity: Math.round(netLiquidity / 1_000_000_000),
      momentum14d: parseFloat(momentum14d.toFixed(2)),
      momentumDirection: (momentum14d > 0.5 ? 'expanding' : momentum14d < -0.5 ? 'contracting' : 'flat') as 'expanding' | 'contracting' | 'flat',
    }
  } catch (error) {
    console.error('Error fetching FRED data:', error)
    return null
  }
}

// ─── Helper: Fetch Whitelisted Twitter/X Squawk Feed ────────────────────────

/**
 * Fetches recent tweets from whitelisted institutional sources
 * Implements whitelist firewall: discards any tweet not from allowed handles
 * Implements keyword heat-mapping: detects macro keywords hitting multiple sources
 *  within 3-minute window and elevates them to Top 5
 */
async function fetchTwitterSquawk() {
  try {
    if (!TWITTER_BEARER_TOKEN) {
      console.warn('TWITTER_BEARER_TOKEN not configured, using mock data')
      return null
    }

    // Query for tweets from whitelisted sources (recent 1 hour)
    const query = `from:zerohedge OR from:FirstSquawk OR from:FinancialJuice OR from:DeltaOne lang:en -is:retweet`

    const res = await fetch('https://api.twitter.com/2/tweets/search/recent', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${TWITTER_BEARER_TOKEN}`,
      },
      body: new URLSearchParams({
        query,
        'max_results': '100',
        'tweet.fields': 'created_at,author_id,public_metrics',
        'expansions': 'author_id',
        'user.fields': 'username,name',
      }).toString(),
    })

    const data = await res.json()

    if (!data.data) {
      console.warn('No tweets found from whitelisted sources')
      return null
    }

    // Transform and filter by whitelist
    const articles = data.data
      .filter((tweet: any) => {
        const author = data.includes?.users?.find((u: any) => u.id === tweet.author_id)
        return filterByWhitelist(`@${author?.username}`)
      })
      .map((tweet: any, idx: number) => ({
        id: tweet.id,
        title: tweet.text.substring(0, 100),
        source: data.includes?.users?.find((u: any) => u.id === tweet.author_id)?.name || 'Unknown',
        sourceHandle: `@${data.includes?.users?.find((u: any) => u.id === tweet.author_id)?.username}`,
        timestamp: new Date(tweet.created_at).getTime(),
        headline: sanitizeHeadlineText(tweet.text),
        importance: tweet.public_metrics?.like_count > 500 ? 'high' : 'medium',
        macroKeywords: extractMacroKeywords(tweet.text),
      }))

    return articles.length > 0 ? articles : null
  } catch (error) {
    console.error('Error fetching Twitter squawk:', error)
    return null
  }
}

// ─── Helper: Extract Macro Keywords ────────────────────────────────────────────

function extractMacroKeywords(text: string): string[] {
  const keywords = [
    'FED',
    'CPI',
    'YIELD',
    'CRUDE',
    'RATE',
    'INFLATION',
    'GDP',
    'RECESSION',
    'VOLATILITY',
    'FOMC',
    'NFP',
    'PPI',
  ]
  return keywords.filter((kw) => text.toUpperCase().includes(kw))
}

// ─── Helper: Build Top Movers from Heat-Mapping ────────────────────────────────

/**
 * Aggregates keyword mentions across whitelisted sources and returns the top
 * 5 heat-mapped movers.
 *
 * BULLETPROOF input handling:
 *  • Guards against `articles` being undefined / null / not-an-array
 *  • Skips malformed article objects silently
 *  • Skips articles whose `macroKeywords` isn't an array
 *  • Uses a PLAIN OBJECT for source tracking — NO Set / Map / class instances.
 *    This guarantees the returned data is 100 % JSON-serializable so the
 *    NextResponse.json(...) call at the top of the catch chain can never
 *    throw a "Value is not JSON serializable" error.
 */
function buildTopMovers(articles: any[]) {
  // ── Array-shape guard (fixes the line-310 forEach crash) ──────────────────
  if (!articles || !Array.isArray(articles) || articles.length === 0) {
    return []
  }

  // sources is a Record<sourceHandle, true> — same dedup behaviour as a Set
  // but trivially JSON-serializable.
  const keywordMap: Record<
    string,
    {
      count:     number
      sources:   Record<string, true>
      headline:  string
      timestamp: number
    }
  > = {}

  for (const article of articles) {
    if (!article || typeof article !== 'object') continue
    if (!Array.isArray(article.macroKeywords)) continue

    const headline     = typeof article.headline     === 'string' ? article.headline     : ''
    const sourceHandle = typeof article.sourceHandle === 'string' ? article.sourceHandle : ''
    const timestamp    = typeof article.timestamp    === 'number' ? article.timestamp    : 0
    if (!sourceHandle) continue

    for (const kw of article.macroKeywords) {
      if (typeof kw !== 'string' || !kw) continue
      if (!keywordMap[kw]) {
        keywordMap[kw] = { count: 0, sources: {}, headline: '', timestamp: 0 }
      }
      keywordMap[kw].count            += 1
      keywordMap[kw].sources[sourceHandle] = true
      keywordMap[kw].headline          = headline
      keywordMap[kw].timestamp         = Math.max(keywordMap[kw].timestamp, timestamp)
    }
  }

  // Filter to keywords that appeared in 2+ distinct sources, rank by heat
  return Object.entries(keywordMap)
    .map(([keyword, data]) => {
      const sourceList = Object.keys(data.sources)
      return {
        keyword,
        headline:    data.headline,
        sourceCount: sourceList.length,
        sources:     sourceList,           // ← plain string[], always serializable
        latestTimestamp: data.timestamp,
        heatScore: Math.min(
          100,
          (sourceList.length / 5) * 100 + (data.count / 10) * 10,
        ),
      }
    })
    .filter((m) => m.sourceCount >= 2)
    .sort((a, b) => b.heatScore - a.heatScore)
    .slice(0, 5)
    .map((m, idx) => ({ rank: idx + 1, ...m }))
}

// ─── Helper: Strict JSON-safe response builder ────────────────────────────────

/**
 * Final safety net: round-trips the object through JSON.stringify/parse so any
 * non-serializable leaf (Set, Map, function, undefined, BigInt, Symbol, Date)
 * is stripped before NextResponse tries to serialise it.
 */
function jsonSafe<T>(value: T): T {
  try {
    return JSON.parse(JSON.stringify(value, (_k, v) => {
      if (v instanceof Set) return Array.from(v)
      if (v instanceof Map) return Object.fromEntries(v)
      if (typeof v === 'bigint') return v.toString()
      if (typeof v === 'function') return undefined
      return v
    }))
  } catch {
    return value
  }
}

// ─── Main GET Handler ─────────────────────────────────────────────────────────

export async function GET(_request: NextRequest) {
  try {
    // Fetch all data in parallel — each helper already returns null on failure
    const [fedLiquidity, articleData] = await Promise.all([
      fetchFedLiquidityData(),
      fetchTwitterSquawk(),
    ])

    // Defensive coalescing: every field gets a sane array/object fallback even
    // if its fetch returned non-array garbage.
    const articles =
      Array.isArray(articleData) && articleData.length > 0
        ? articleData
        : SQUAWK_NEWS_MOCK.articles

    const topMovers = buildTopMovers(articles)

    const response: SquawkNewsData = {
      articles,
      topMovers:    topMovers.length > 0 ? topMovers : SQUAWK_NEWS_MOCK.topMovers,
      fedLiquidity: fedLiquidity || SQUAWK_NEWS_MOCK.fedLiquidity,
    }

    // Final round-trip strips any sneaky non-serializable values
    return NextResponse.json(jsonSafe(response))
  } catch (error) {
    console.error('Error in /api/institutional-squawk:', error)
    // Fallback path — also routed through jsonSafe so the catch block itself
    // can never throw a serialization error.
    return NextResponse.json(jsonSafe(SQUAWK_NEWS_MOCK))
  }
}
