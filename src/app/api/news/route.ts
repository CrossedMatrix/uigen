/**
 * /api/news — Market Intelligence Aggregator
 *
 * Pulls from public RSS feeds (Bloomberg, Reuters, CNBC, MarketWatch, Yahoo Finance, WSJ)
 * and key financial X accounts via Nitter RSS, filters to the last 12 hours, then
 * uses Claude to categorize and summarize into four market-moving themes:
 *   GEOPOLITICS · MACRO · EARNINGS · SENTIMENT
 *
 * Result is cached 5 minutes in-process so the component can poll without
 * hammering upstream sources.
 *
 * Env vars (optional — graceful degradation without them):
 *   ANTHROPIC_API_KEY  — enables AI summarization (falls back to keyword categorization)
 */

import { type NextRequest, NextResponse } from 'next/server'
import { z }                              from 'zod'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ─── Public Types ─────────────────────────────────────────────────────────────

export type ArticleCategory = 'geopolitics' | 'macro' | 'earnings' | 'sentiment' | 'other'
export type MarketImpact    = 'bullish' | 'bearish' | 'neutral'
export type MarketSentiment = 'RISK-ON' | 'RISK-OFF' | 'NEUTRAL'

export interface NewsArticle {
  id:           string
  title:        string
  summary:      string        // first ~120 chars of description, HTML stripped
  url:          string
  source:       string        // display name e.g. "Bloomberg"
  sourceType:   'rss' | 'x'
  handle?:      string        // X handle e.g. "@firstsquawk"
  publishedAt:  number        // Unix ms
  category:     ArticleCategory
  marketImpact: MarketImpact
}

export interface CategorySummary {
  aiSummary: string           // 2-sentence AI-generated summary
  keyEvent:  string           // single most important headline
  count:     number
}

export interface NewsResponse {
  articles:        NewsArticle[]
  topMovers:       NewsArticle[]        // top 5 most market-impactful articles
  categories: {
    geopolitics: CategorySummary
    macro:       CategorySummary
    earnings:    CategorySummary
    sentiment:   CategorySummary
  }
  masterSummary:   string
  marketSentiment: MarketSentiment
  totalSources:    number
  totalArticles:   number
  lastUpdated:     number
  aiEnhanced:      boolean
  fromCache:       boolean
}

// ─── RSS Source Definitions ───────────────────────────────────────────────────

interface RSSSource {
  url:    string
  name:   string
  weight: number   // higher = more trustworthy / prioritized
}

const RSS_SOURCES: RSSSource[] = [
  { url: 'https://feeds.bloomberg.com/markets/news.rss',                       name: 'Bloomberg',   weight: 10 },
  { url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',         name: 'MarketWatch', weight: 8  },
  { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html',               name: 'CNBC',        weight: 8  },
  { url: 'https://feeds.a.dj.com/rss/WSJcomUSBusiness.xml',                    name: 'WSJ',         weight: 9  },
  { url: 'https://finance.yahoo.com/rss/topfinstories',                         name: 'Yahoo Finance', weight: 6 },
  { url: 'https://feeds.reuters.com/reuters/businessNews',                      name: 'Reuters',     weight: 9  },
  { url: 'https://feeds.marketwatch.com/marketwatch/marketpulse/',              name: 'MW Pulse',    weight: 7  },
  { url: 'https://feeds.bloomberg.com/politics/news.rss',                       name: 'Bloomberg Politics', weight: 8 },
]

// Key financial X accounts to fetch via Nitter RSS
const X_ACCOUNTS: Array<{ handle: string; name: string; weight: number }> = [
  { handle: 'firstsquawk',   name: 'First Squawk',   weight: 9 },
  { handle: 'LiveSquawk',    name: 'Live Squawk',    weight: 8 },
  { handle: 'DeItaone',      name: 'Walter Bloomberg', weight: 9 },
  { handle: 'unusual_whales', name: 'Unusual Whales', weight: 7 },
  { handle: 'zerohedge',     name: 'ZeroHedge',      weight: 6 },
  { handle: 'markets',       name: 'Bloomberg Mkts', weight: 8 },
]

// Nitter instances to try in order (fall through on failure)
const NITTER_INSTANCES = [
  'https://nitter.privacydev.net',
  'https://nitter.net',
  'https://nitter.nl',
  'https://nitter.cz',
]

const WINDOW_MS      = 12 * 60 * 60 * 1_000   // 12-hour article window
const FETCH_TIMEOUT  = 6_000                    // 6 s per feed
const MAX_AI_ARTICLES = 30                      // cap sent to AI to control token cost
const CACHE_TTL_MS   = 5 * 60 * 1_000          // 5-minute in-process cache

// ─── XML / HTML Helpers ───────────────────────────────────────────────────────

function decodeHTMLEntities(str: string): string {
  return str
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#\d+;/g, '')
}

function extractXMLTag(xml: string, tag: string): string {
  const cdata = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, 'i')
  const plain = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i')
  const cm = cdata.exec(xml)
  if (cm) return cm[1].trim()
  const pm = plain.exec(xml)
  if (pm) return decodeHTMLEntities(pm[1].replace(/<[^>]+>/g, '').trim())
  return ''
}

function stripHTML(str: string): string {
  return str.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
}

function truncate(str: string, len: number): string {
  const s = stripHTML(str)
  return s.length > len ? s.slice(0, len).trimEnd() + '…' : s
}

function parseRSSDate(dateStr: string): number {
  if (!dateStr) return 0
  const ts = Date.parse(dateStr)
  return isNaN(ts) ? 0 : ts
}

function makeId(source: string, title: string): string {
  // Simple deterministic ID from source + title
  let h = 5381
  const s = source + title
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i)
  return Math.abs(h).toString(36)
}

// ─── RSS Parsing ──────────────────────────────────────────────────────────────

interface RawArticle {
  id:          string
  title:       string
  summary:     string
  url:         string
  source:      string
  sourceType:  'rss' | 'x'
  handle?:     string
  publishedAt: number
}

function parseRSSXML(xml: string, sourceName: string): RawArticle[] {
  const items: RawArticle[] = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi
  let match: RegExpExecArray | null

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1]
    const title      = extractXMLTag(block, 'title')
    const link       = extractXMLTag(block, 'link')
                    || extractXMLTag(block, 'guid')
    const pubDate    = extractXMLTag(block, 'pubDate')
                    || extractXMLTag(block, 'dc:date')
                    || extractXMLTag(block, 'updated')
    const desc       = extractXMLTag(block, 'description')
                    || extractXMLTag(block, 'summary')
                    || extractXMLTag(block, 'content:encoded')

    if (!title || !pubDate) continue
    const publishedAt = parseRSSDate(pubDate)
    if (!publishedAt) continue

    items.push({
      id:          makeId(sourceName, title),
      title:       truncate(title, 140),
      summary:     truncate(desc,   160),
      url:         link,
      source:      sourceName,
      sourceType:  'rss',
      publishedAt,
    })
  }

  return items
}

function parseNitterXML(xml: string, handle: string, displayName: string): RawArticle[] {
  const items: RawArticle[] = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi
  let match: RegExpExecArray | null

  while ((match = itemRegex.exec(xml)) !== null) {
    const block  = match[1]
    const rawTitle = extractXMLTag(block, 'title')
    const link     = extractXMLTag(block, 'link')
    const pubDate  = extractXMLTag(block, 'pubDate')

    if (!rawTitle || !pubDate) continue
    const publishedAt = parseRSSDate(pubDate)
    if (!publishedAt) continue

    // Nitter prepends "R to @X: " for retweets — skip retweets
    if (/^R to @/i.test(rawTitle)) continue

    // Strip the "@handle: " prefix nitter adds
    const title = rawTitle.replace(/^@\w+:\s*/i, '').trim()

    items.push({
      id:          makeId(`x/${handle}`, title),
      title:       truncate(title, 140),
      summary:     '',
      url:         link,
      source:      `X · ${displayName}`,
      sourceType:  'x',
      handle:      `@${handle}`,
      publishedAt,
    })
  }

  return items
}

// ─── Feed Fetching ────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, ms = FETCH_TIMEOUT): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MarketBot/1.0; +https://localhost)',
        'Accept':     'application/rss+xml, application/xml, text/xml, */*',
      },
      cache: 'no-store',
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

async function fetchRSSSource(src: RSSSource): Promise<RawArticle[]> {
  try {
    const xml = await fetchWithTimeout(src.url)
    return parseRSSXML(xml, src.name)
  } catch {
    return []
  }
}

async function fetchNitterAccount(
  handle:   string,
  name:     string,
): Promise<RawArticle[]> {
  for (const base of NITTER_INSTANCES) {
    try {
      const xml = await fetchWithTimeout(`${base}/${handle}/rss`, 5_000)
      const items = parseNitterXML(xml, handle, name)
      if (items.length > 0) return items
    } catch {
      // try next instance
    }
  }
  return []
}

// ─── Keyword Categorization (fallback when AI is unavailable) ─────────────────

const CATEGORY_KEYWORDS: Record<ArticleCategory, string[]> = {
  geopolitics: [
    'war', 'sanction', 'tariff', 'trade war', 'nato', 'opec', 'china', 'russia',
    'iran', 'israel', 'ukraine', 'election', 'military', 'conflict', 'diplomatic',
    'geopolit', 'treaty', 'export ban', 'embargo', 'rare earth', 'taiwan',
    'pentagon', 'whitehouse', 'congress', 'senate', 'middle east', 'oil supply',
  ],
  macro: [
    'fed', 'federal reserve', 'ecb', 'boj', 'bank of england', 'cpi', 'pce',
    'ppi', 'gdp', 'inflation', 'unemployment', 'interest rate', 'treasury',
    'yield', 'ism', 'pmi', 'nfp', 'fomc', 'powell', 'recession', 'rate cut',
    'rate hike', 'central bank', 'basis point', 'bps', 'quantitative', 'jobs report',
    'payroll', 'consumer price', 'producer price', 'balance of trade', 'defict',
  ],
  earnings: [
    'eps', 'earnings', 'revenue', 'quarterly', 'beats', 'misses', 'q1', 'q2',
    'q3', 'q4', 'fiscal', 'guidance', 'profit', 'results', 'annual report',
    'outlook', 'estimate', 'consensus', 'adjusted earnings', 'net income',
    'operating income', 'margin', 'year-over-year', 'yoy', 'quarter',
  ],
  sentiment: [
    'vix', 'rally', 'selloff', 'correction', 'volatility', 'bullish', 'bearish',
    'short', 'put', 'call', 'options', 'sentiment', 'fear', 'greed', 'positioning',
    'upgrade', 'downgrade', 'target price', 'overweight', 'underweight', 'buy rating',
    'sell rating', 'momentum', 'oversold', 'overbought', 'squeeze', 'unusual activity',
    'flow', 'positioning', 'hedge fund', 'institution',
  ],
  other: [],
}

function classifyByKeyword(text: string): ArticleCategory {
  const lower = text.toLowerCase()
  let best: ArticleCategory = 'other'
  let bestScore = 0

  for (const [cat, keywords] of Object.entries(CATEGORY_KEYWORDS) as [ArticleCategory, string[]][]) {
    if (cat === 'other') continue
    const score = keywords.filter(kw => lower.includes(kw)).length
    if (score > bestScore) { bestScore = score; best = cat }
  }

  return best
}

function classifyImpactByKeyword(text: string): MarketImpact {
  const lower = text.toLowerCase()
  const bull = ['beats', 'surge', 'rally', 'record', 'strong', 'rises', 'jumps', 'gains', 'breaks out', 'upgrade', 'buy', 'overweight', 'above estimate']
  const bear = ['misses', 'drops', 'falls', 'selloff', 'fear', 'risk', 'warning', 'concern', 'threat', 'cut', 'downgrade', 'sell', 'below estimate', 'collapse', 'crash', 'tumbles']
  const bullHits = bull.filter(w => lower.includes(w)).length
  const bearHits = bear.filter(w => lower.includes(w)).length
  if (bullHits > bearHits) return 'bullish'
  if (bearHits > bullHits) return 'bearish'
  return 'neutral'
}

// ─── AI Analysis (Zod-validated JSON via Vercel AI SDK) ───────────────────────

const AIAnalysisSchema = z.object({
  masterSummary:   z.string().describe('3-sentence overview of most important market-moving events in last 12 hours'),
  marketSentiment: z.enum(['RISK-ON', 'RISK-OFF', 'NEUTRAL']),
  categories: z.object({
    geopolitics: z.object({
      summary:  z.string().describe('2-sentence summary of geopolitical developments affecting markets'),
      keyEvent: z.string().describe('Single most important geopolitical headline, ≤80 chars'),
    }),
    macro: z.object({
      summary:  z.string().describe('2-sentence summary of macroeconomic developments'),
      keyEvent: z.string().describe('Single most important macro event, ≤80 chars'),
    }),
    earnings: z.object({
      summary:  z.string().describe('2-sentence summary of earnings news'),
      keyEvent: z.string().describe('Single most impactful earnings headline, ≤80 chars'),
    }),
    sentiment: z.object({
      summary:  z.string().describe('2-sentence summary of market sentiment and positioning'),
      keyEvent: z.string().describe('Single most notable sentiment/positioning event, ≤80 chars'),
    }),
  }),
  articleAnalysis: z.array(z.object({
    index:        z.number(),
    category:     z.enum(['geopolitics', 'macro', 'earnings', 'sentiment', 'other']),
    marketImpact: z.enum(['bullish', 'bearish', 'neutral']),
  })).describe('Category and market impact for each article, by its index in the input list'),
})

async function runAIAnalysis(
  articles: RawArticle[],
): Promise<z.infer<typeof AIAnalysisSchema> | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null

  const articlesForAI = articles.slice(0, MAX_AI_ARTICLES)

  const articleList = articlesForAI
    .map((a, i) =>
      `[${i}] ${a.source.toUpperCase()} — ${a.title}${a.summary ? ` | ${a.summary}` : ''}`,
    )
    .join('\n')

  const prompt = `You are a senior market analyst at a major investment bank. Analyze the following financial news headlines from the last 12 hours and return ONLY a valid JSON object — no markdown, no explanation, no code fences.

JSON SCHEMA:
{
  "masterSummary": "<2-3 sentences: dominant market narrative and most important cross-asset themes>",
  "marketSentiment": "RISK-ON" | "RISK-OFF" | "NEUTRAL",
  "categories": {
    "geopolitics": {
      "summary": "<2 sentences: most important geopolitical developments affecting markets>",
      "keyEvent": "<single most market-moving geopolitical headline, ≤80 chars>"
    },
    "macro": {
      "summary": "<2 sentences: most important macroeconomic developments>",
      "keyEvent": "<single most important macro event, ≤80 chars>"
    },
    "earnings": {
      "summary": "<2 sentences: most impactful earnings news>",
      "keyEvent": "<most impactful earnings headline, ≤80 chars>"
    },
    "sentiment": {
      "summary": "<2 sentences: market sentiment and positioning shifts>",
      "keyEvent": "<most notable sentiment/positioning event, ≤80 chars>"
    }
  },
  "articleAnalysis": [
    { "index": 0, "category": "geopolitics"|"macro"|"earnings"|"sentiment"|"other", "marketImpact": "bullish"|"bearish"|"neutral" }
  ]
}
Include one articleAnalysis entry for every article index [0]–[${articlesForAI.length - 1}].

ARTICLES:
${articleList}`

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body: JSON.stringify({
        model:      'claude-3-5-haiku-20241022',
        max_tokens: 1_500,
        messages:   [{ role: 'user', content: prompt }],
      }),
    })

    if (!res.ok) {
      console.error('[news/route] Anthropic API error:', res.status)
      return null
    }

    const json = await res.json() as { content?: Array<{ type: string; text: string }> }
    const text = json.content?.find(c => c.type === 'text')?.text ?? ''

    // Strip potential markdown fences before parsing
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim()
    const jsonMatch = /\{[\s\S]*\}/.exec(cleaned)
    if (!jsonMatch) return null

    return AIAnalysisSchema.parse(JSON.parse(jsonMatch[0]))
  } catch (err) {
    console.error('[news/route] AI analysis failed:', err)
    return null
  }
}

// ─── Keyword-Based Fallback Summaries ────────────────────────────────────────

function buildFallbackSummaries(
  articles: NewsArticle[],
): NewsResponse['categories'] & { masterSummary: string; marketSentiment: MarketSentiment } {
  const byCategory = (cat: ArticleCategory) =>
    articles.filter(a => a.category === cat)

  const topOf = (cat: ArticleCategory) =>
    byCategory(cat)[0]?.title ?? 'No significant events in this window.'

  const summarize = (cat: ArticleCategory) => {
    const items = byCategory(cat)
    if (items.length === 0) return `No notable ${cat} events in the last 12 hours.`
    return `${items.length} ${cat} developments tracked. Leading story: ${items[0].title.slice(0, 100)}.`
  }

  const bearCount = articles.filter(a => a.marketImpact === 'bearish').length
  const bullCount = articles.filter(a => a.marketImpact === 'bullish').length
  const marketSentiment: MarketSentiment =
    bearCount > bullCount * 1.4 ? 'RISK-OFF' :
    bullCount > bearCount * 1.4 ? 'RISK-ON' : 'NEUTRAL'

  return {
    geopolitics: { aiSummary: summarize('geopolitics'), keyEvent: topOf('geopolitics'), count: byCategory('geopolitics').length },
    macro:       { aiSummary: summarize('macro'),       keyEvent: topOf('macro'),       count: byCategory('macro').length       },
    earnings:    { aiSummary: summarize('earnings'),    keyEvent: topOf('earnings'),    count: byCategory('earnings').length    },
    sentiment:   { aiSummary: summarize('sentiment'),   keyEvent: topOf('sentiment'),   count: byCategory('sentiment').length   },
    masterSummary:   `${articles.length} market events tracked in the last 12 hours across ${[...new Set(articles.map(a => a.source))].length} sources. Market signal is ${marketSentiment}.`,
    marketSentiment,
  }
}

// ─── Mock Data (used when all feeds fail) ────────────────────────────────────

function buildMockResponse(): NewsResponse {
  const now = Date.now()
  const ago = (min: number) => now - min * 60_000

  const mock: NewsArticle[] = [
    // Geopolitics
    { id: 'm1',  title: "US, EU impose coordinated sanctions on Russian energy entities; Urals spread widens to record",           summary: "New measures target Gazprom subsidiaries and shipping intermediaries.", url: '#', source: 'Reuters',     sourceType: 'rss', publishedAt: ago(20),  category: 'geopolitics', marketImpact: 'bearish' },
    { id: 'm2',  title: "OPEC+ defers production decision; Saudi sources say cuts maintained through Q3",                          summary: "Meeting postponed amid disagreement over Iraq quota compliance.",    url: '#', source: 'Bloomberg',   sourceType: 'rss', publishedAt: ago(55),  category: 'geopolitics', marketImpact: 'bullish' },
    { id: 'm3',  title: "China retaliates with rare earth export curbs following US advanced chip restrictions",                    summary: "Yttrium, dysprosium, and terbium added to restricted export list.",  url: '#', source: 'Bloomberg Politics', sourceType: 'rss', publishedAt: ago(110), category: 'geopolitics', marketImpact: 'bearish' },
    { id: 'm4',  title: "NATO allies pledge $40B Ukraine defense package; US contributes $18B in air defense systems",             summary: "Package includes Patriot batteries and ATACMS munitions.",           url: '#', source: 'Reuters',     sourceType: 'rss', publishedAt: ago(195), category: 'geopolitics', marketImpact: 'neutral' },
    { id: 'm5',  title: 'BREAKING: Iranian proxy forces attack US outpost in eastern Syria; CENTCOM confirms no casualties',       summary: '',                                                                  url: '#', source: 'X · First Squawk', sourceType: 'x', handle: '@firstsquawk', publishedAt: ago(310), category: 'geopolitics', marketImpact: 'bearish' },
    // Macro
    { id: 'm6',  title: "Fed's Powell: 'Not yet confident inflation is sustainably moving toward 2% target'",                     summary: "Remarks at Chicago Fed conference signal continued patience on cuts.", url: '#', source: 'Bloomberg',   sourceType: 'rss', publishedAt: ago(35),  category: 'macro', marketImpact: 'bearish' },
    { id: 'm7',  title: "US ISM Services PMI 49.4 vs 51.0 est — first contraction in 14 months; dollar index falls 0.3%",         summary: "New orders sub-index collapsed to 46.2, weakest read since 2020.",  url: '#', source: 'MarketWatch', sourceType: 'rss', publishedAt: ago(88),  category: 'macro', marketImpact: 'bearish' },
    { id: 'm8',  title: "US 10Y Treasury yield climbs to 4.68% as strong ADP payrolls reduce Q3 cut expectations",                summary: "Markets now pricing 1.1 cuts for 2025, down from 1.8 last week.",    url: '#', source: 'Reuters',     sourceType: 'rss', publishedAt: ago(145), category: 'macro', marketImpact: 'neutral' },
    { id: 'm9',  title: "ECB's Lagarde: Rate path 'fully data-dependent'; June cut on table if April CPI confirms",               summary: "Board divided between one and two cuts in H1 2025.",                url: '#', source: 'Bloomberg',   sourceType: 'rss', publishedAt: ago(210), category: 'macro', marketImpact: 'bullish' },
    { id: 'm10', title: 'ECB: Lagarde reiterates no pre-commitment on rate cuts — "we are not done with vigilance"',              summary: '',                                                                  url: '#', source: 'X · Live Squawk', sourceType: 'x', handle: '@LiveSquawk', publishedAt: ago(270), category: 'macro', marketImpact: 'bearish' },
    { id: 'm11', title: "China Q1 GDP beats at 5.3% YoY vs 4.9% est; retail sales miss, industrial output strong",               summary: "Beat driven by manufacturing exports; domestic consumption weak.",   url: '#', source: 'Reuters',     sourceType: 'rss', publishedAt: ago(390), category: 'macro', marketImpact: 'neutral' },
    { id: 'm12', title: "Germany factory orders -3.2% MoM, seventh consecutive monthly decline; DAX sheds 0.8%",                  summary: "Automotive and machinery sectors lead decline.",                     url: '#', source: 'MarketWatch', sourceType: 'rss', publishedAt: ago(480), category: 'macro', marketImpact: 'bearish' },
    // Earnings
    { id: 'm13', title: "Microsoft Q3: EPS $3.46 beats $3.22 est; Azure +21% YoY, above 19% guide; raises FY outlook",           summary: "Cloud segment margin expanded 220bps; Copilot seats doubled QoQ.",   url: '#', source: 'Bloomberg',   sourceType: 'rss', publishedAt: ago(42),  category: 'earnings', marketImpact: 'bullish' },
    { id: 'm14', title: "Alphabet Q1: Search +14% YoY; YouTube beats $8.1B vs $7.7B est; Cloud margin 9.4% vs 8.9% est",         summary: "AI Overview traffic monetization ramping faster than expected.",     url: '#', source: 'CNBC',        sourceType: 'rss', publishedAt: ago(65),  category: 'earnings', marketImpact: 'bullish' },
    { id: 'm15', title: "META Q1: Revenue $36.5B misses $37.1B est; Q2 guide midpoint below consensus; capex raised to $40B",     summary: "Reality Labs burn widened to $5.1B; stock -8% after hours.",         url: '#', source: 'WSJ',         sourceType: 'rss', publishedAt: ago(120), category: 'earnings', marketImpact: 'bearish' },
    { id: 'm16', title: "AMD Q1: Data center GPU revenue $2.3B vs $2.1B est; guide $7.7B vs $7.5B est",                           summary: "MI300X demand tracking ahead of internal targets per CEO Su.",       url: '#', source: 'MarketWatch', sourceType: 'rss', publishedAt: ago(230), category: 'earnings', marketImpact: 'bullish' },
    { id: 'm17', title: 'MASSIVE call sweep AMD: 10k contracts at $200 strike, Jun expiry — $4.2M premium, buyer-side',           summary: '',                                                                  url: '#', source: 'X · Unusual Whales', sourceType: 'x', handle: '@unusual_whales', publishedAt: ago(155), category: 'earnings', marketImpact: 'bullish' },
    // Sentiment
    { id: 'm18', title: "VIX spikes 11.4% to 19.8; put-call ratio hits 1.18, highest level since October 2024 lows",             summary: "Largest single-session options hedging surge in six months.",        url: '#', source: 'Bloomberg',   sourceType: 'rss', publishedAt: ago(18),  category: 'sentiment', marketImpact: 'bearish' },
    { id: 'm19', title: "Goldman Sachs cuts S&P 500 year-end target to 5,100 from 5,600 on valuation and rate concerns",          summary: "GS cites tighter financial conditions and earnings risk.",            url: '#', source: 'Reuters',     sourceType: 'rss', publishedAt: ago(72),  category: 'sentiment', marketImpact: 'bearish' },
    { id: 'm20', title: "CFTC: Leveraged funds cut net S&P 500 long by 48k contracts — third consecutive week of reduction",      summary: "Largest 3-week reduction in spec longs since March 2023.",          url: '#', source: 'MarketWatch', sourceType: 'rss', publishedAt: ago(185), category: 'sentiment', marketImpact: 'bearish' },
    { id: 'm21', title: "JPMorgan upgrades Energy sector to Overweight; raises XLE target to $112 on supply discipline thesis",   summary: '',                                                                  url: '#', source: 'X · Walter Bloomberg', sourceType: 'x', handle: '@DeItaone', publishedAt: ago(305), category: 'sentiment', marketImpact: 'bullish' },
    { id: 'm22', title: "Retail investors reduce tech exposure at fastest pace in 18 months — Vanda Research positioning data",    summary: "NVDA, MSFT, AAPL net selling from individual investor cohort.",      url: '#', source: 'Bloomberg',   sourceType: 'rss', publishedAt: ago(430), category: 'sentiment', marketImpact: 'bearish' },
  ]

  const categoryCount = (cat: ArticleCategory) => mock.filter(a => a.category === cat).length
  const topMovers = extractTopMovers(mock, 5)

  return {
    articles:        mock,
    topMovers,
    categories: {
      geopolitics: {
        aiSummary: 'Coordinated US-EU sanctions on Russian energy entities are tightening Urals discount. Chinese rare earth export restrictions escalate tech supply chain tensions.',
        keyEvent:  'US/EU sanction Russian energy; China restricts rare earth exports',
        count:     categoryCount('geopolitics'),
      },
      macro: {
        aiSummary: "Fed's Powell reiterated patience on rate cuts as ISM Services contracted for the first time in 14 months. Markets are now pricing fewer than two cuts for 2025.",
        keyEvent:  "Fed Powell: 'not yet confident' inflation sustainably returning to 2%",
        count:     categoryCount('macro'),
      },
      earnings: {
        aiSummary: 'Microsoft and Alphabet reported strong Q1/Q3 results, with cloud and AI revenue both beating. META missed on revenue and raised capex, weighing on mega-cap sentiment.',
        keyEvent:  'MSFT Azure +21% YoY beats guide; META misses Q1 revenue, guides light',
        count:     categoryCount('earnings'),
      },
      sentiment: {
        aiSummary: 'VIX jumped above 19.8 as leveraged funds cut S&P longs for a third straight week. Goldman Sachs cut its year-end target to 5,100, reinforcing caution.',
        keyEvent:  'VIX +11.4% to 19.8; Goldman cuts SPX target to 5,100',
        count:     categoryCount('sentiment'),
      },
    },
    masterSummary:   "Risk appetite is under pressure as Fed hawkishness intersects with geopolitical supply shocks and mixed mega-cap earnings. VIX pierced 19.8 on elevated put buying while leveraged funds reduced S&P exposure for a third straight week. Positive signals from Azure and Google Cloud provided a partial offset, but the weight of macro data argues for continued caution.",
    marketSentiment: 'RISK-OFF',
    totalSources:    8,
    totalArticles:   mock.length,
    lastUpdated:     Date.now(),
    aiEnhanced:      false,
    fromCache:       false,
  }
}

// ─── Market Impact Scoring ────────────────────────────────────────────────────
//
// Articles are scored by their potential to move markets, considering:
//   1. Category (macro 2.0x, earnings 1.5x, sentiment 1.5x, geo 1.0x)
//   2. Market impact (bullish +2, neutral 0, bearish -2)
//   3. Recency (last 3h +1.0, last 6h +0.5)
//   4. Keywords (Fed, CPI, earnings, geopolitical crisis, VIX surge)

const MARKET_MOVER_KEYWORDS = [
  // Fed / Central bank (highest impact)
  'fed', 'federal reserve', 'powell', 'fomc', 'rate cut', 'rate hike', 'boe', 'ecb', 'lagarde',
  // Macro data (high impact)
  'cpi', 'inflation', 'pce', 'ppi', 'jobs report', 'unemployment', 'payroll', 'nfp', 'gdp',
  // Earnings (triggers rotation)
  'earnings beat', 'earnings miss', 'revenue beat', 'beats estimate', 'misses estimate', 'guidance raised', 'guidance lowered',
  // Geopolitical escalation (risk-off)
  'war', 'sanction', 'conflict', 'missile', 'attack', 'nuclear', 'iran', 'russia', 'china', 'taiwan',
  // Sentiment shifts (market structure)
  'vix spike', 'vix surge', 'vix jump', 'put buying', 'fund positioning', 'short covering', 'squeeze',
  // Market structure
  'yield curve', 'inversion', 'breadth', 'momentum', 'correction', 'bull market', 'bear market',
]

function scoreArticleForMarketImpact(
  article: NewsArticle,
  now: number,
): number {
  let score = 0

  // ── 1. Category weighting ──────────────────────────────────────────────────
  const categoryWeights: Record<ArticleCategory, number> = {
    macro:       2.0,    // interest rates, inflation, jobs — move everything
    earnings:    1.5,    // can trigger sector/mega-cap rotations
    sentiment:   1.5,    // VIX, positioning, flow — market structure
    geopolitics: 1.0,    // supply shocks, but less consistent impact
    other:       0.5,
  }
  score += categoryWeights[article.category] ?? 0.5

  // ── 2. Market impact (direction + magnitude) ───────────────────────────────
  if (article.marketImpact === 'bullish')  score += 2.0
  if (article.marketImpact === 'bearish') score += 2.5   // downside moves faster
  // neutral adds 0

  // ── 3. Recency bonus (last 3h most critical) ────────────────────────────────
  const ageMs = now - article.publishedAt
  const ageHours = ageMs / 3_600_000
  if (ageHours <= 3)      score += 1.0
  else if (ageHours <= 6) score += 0.5
  else if (ageHours <= 12) score += 0.2

  // ── 4. Keyword matching (known market-moving topics) ──────────────────────
  const fullText = `${article.title} ${article.summary}`.toLowerCase()
  const matches = MARKET_MOVER_KEYWORDS.filter(kw => fullText.includes(kw.toLowerCase())).length
  score += Math.min(matches * 0.3, 1.5)   // cap at +1.5

  // ── 5. X posts get slight boost (often have breaking news/flows) ───────────
  if (article.sourceType === 'x') score += 0.3

  return score
}

function extractTopMovers(articles: NewsArticle[], count = 5): NewsArticle[] {
  const now = Date.now()
  const scored = articles.map(a => ({
    article: a,
    score:   scoreArticleForMarketImpact(a, now),
  }))
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(s => s.article)
}

// ─── In-Process Cache ─────────────────────────────────────────────────────────

let cachedPayload:  NewsResponse | null = null
let cacheExpiresAt: number = 0

// ─── Route Handler ────────────────────────────────────────────────────────────

export async function GET(_req: NextRequest): Promise<NextResponse<NewsResponse>> {
  // Serve from cache if fresh
  if (cachedPayload && Date.now() < cacheExpiresAt) {
    return NextResponse.json({ ...cachedPayload, fromCache: true })
  }

  const windowStart = Date.now() - WINDOW_MS

  // ── 1. Fetch all feeds in parallel ──────────────────────────────────────────
  const rssFetches   = RSS_SOURCES.map(src => fetchRSSSource(src))
  const nitterFetches = X_ACCOUNTS.map(acc => fetchNitterAccount(acc.handle, acc.name))

  const [rssResults, nitterResults] = await Promise.all([
    Promise.allSettled(rssFetches),
    Promise.allSettled(nitterFetches),
  ])

  const rssArticles     = rssResults.flatMap(r => r.status === 'fulfilled' ? r.value : [])
  const nitterArticles  = nitterResults.flatMap(r => r.status === 'fulfilled' ? r.value : [])
  const allRaw: RawArticle[] = [...rssArticles, ...nitterArticles]

  // ── 2. Filter to last 12 hours + deduplicate by title hash ──────────────────
  const seen  = new Set<string>()
  const fresh = allRaw
    .filter(a => a.publishedAt >= windowStart)
    .filter(a => { if (seen.has(a.id)) return false; seen.add(a.id); return true })
    .sort((a, b) => b.publishedAt - a.publishedAt)

  // Use mock data when feeds are completely dry (network issue, dev environment, etc.)
  if (fresh.length === 0) {
    const mock = buildMockResponse()
    cachedPayload  = mock
    cacheExpiresAt = Date.now() + CACHE_TTL_MS
    return NextResponse.json(mock)
  }

  // ── 3. Keyword pre-classify all articles ────────────────────────────────────
  const preClassified: NewsArticle[] = fresh.map(a => ({
    ...a,
    category:     classifyByKeyword(`${a.title} ${a.summary}`),
    marketImpact: classifyImpactByKeyword(`${a.title} ${a.summary}`),
  }))

  // ── 4. AI analysis (overwrites keyword classification when available) ────────
  const aiResult = await runAIAnalysis(fresh)
  let articles = preClassified
  let aiEnhanced = false

  if (aiResult) {
    aiEnhanced = true
    // Merge AI classifications for articles that were sent to AI
    const analysisMap = new Map(aiResult.articleAnalysis.map(a => [a.index, a]))
    articles = preClassified.map((art, i) => {
      const ai = analysisMap.get(i)
      if (!ai) return art
      return { ...art, category: ai.category, marketImpact: ai.marketImpact }
    })
  }

  // ── 5. Build response ────────────────────────────────────────────────────────
  const countBy = (cat: ArticleCategory) => articles.filter(a => a.category === cat).length
  const topOf   = (cat: ArticleCategory) => articles.find(a => a.category === cat)?.title ?? '—'

  let categories: NewsResponse['categories']
  let masterSummary: string
  let marketSentiment: MarketSentiment

  if (aiResult) {
    categories = {
      geopolitics: { aiSummary: aiResult.categories.geopolitics.summary, keyEvent: aiResult.categories.geopolitics.keyEvent, count: countBy('geopolitics') },
      macro:       { aiSummary: aiResult.categories.macro.summary,       keyEvent: aiResult.categories.macro.keyEvent,       count: countBy('macro')       },
      earnings:    { aiSummary: aiResult.categories.earnings.summary,     keyEvent: aiResult.categories.earnings.keyEvent,    count: countBy('earnings')    },
      sentiment:   { aiSummary: aiResult.categories.sentiment.summary,    keyEvent: aiResult.categories.sentiment.keyEvent,   count: countBy('sentiment')   },
    }
    masterSummary   = aiResult.masterSummary
    marketSentiment = aiResult.marketSentiment
  } else {
    const fallback  = buildFallbackSummaries(articles)
    categories      = fallback
    masterSummary   = fallback.masterSummary
    marketSentiment = fallback.marketSentiment
  }

  const topMovers = extractTopMovers(articles, 5)

  const response: NewsResponse = {
    articles,
    topMovers,
    categories,
    masterSummary,
    marketSentiment,
    totalSources:  [...new Set(articles.map(a => a.source))].length,
    totalArticles: articles.length,
    lastUpdated:   Date.now(),
    aiEnhanced,
    fromCache:     false,
  }

  cachedPayload  = response
  cacheExpiresAt = Date.now() + CACHE_TTL_MS

  return NextResponse.json(response)
}
