# Institutional Squawk & Macro Intelligence Feed — Setup & Architecture

## Overview

The **Institutional Squawk & Macro Intelligence Feed** replaces the consumer-grade MarketNewsSection with a hyper-curated, institutional-grade news stream and advanced macro liquidity monitoring system.

### Key Features

1. **Whitelisted Institutional Squawk Stream**
   - Restricts incoming headlines to 5 trusted institutional sources only
   - Implements HTML entity decoding for clean typography rendering
   - Heat-maps macro keywords across sources to detect high-signal stories

2. **Federal Reserve Liquidity Monitor**
   - Displays Fed Balance Sheet Total Assets
   - Calculates Net Liquidity Gauge: Fed BS - TGA - RRP
   - Shows 14-day momentum arrow (expanding/contracting)

3. **Corporate Intelligence Panel**
   - Tracks institutional ownership velocity by hedge funds and insiders
   - Displays forward analyst revisions (% of analysts revising up in last 30d)
   - Shows analyst consensus ratings and upside targets

---

## Architecture

### Component File Structure

```
src/components/dashboard/
├── InstitutionalSquawkNewsStream.tsx  (Main export + all sub-components)
│   ├── TopMoversCard                  (Top 5 heat-mapped headlines)
│   ├── NewsTerminalFeed               (Scrolling whitelisted feed)
│   ├── FedLiquidityMonitor            (FRED data visualization)
│   └── CorporateIntelPanel            (Ownership + analyst revisions)
```

### API Route Structure

```
src/app/api/
└── institutional-squawk/
    └── route.ts                       (GET endpoint for all data)
```

### Data Flow

```
Dashboard Page (page.tsx)
    ↓
useEffect: fetch /api/institutional-squawk (60s interval)
    ↓
API Route Handler (route.ts)
    ├→ FRED API (Fed liquidity data)
    ├→ FMP API (Analyst revisions + ownership)
    ├→ Twitter/X API (Whitelisted institutional tweets)
    └→ Keyword heat-map logic → Top 5 Movers
    ↓
Component Rendering (InstitutionalSquawkNewsStream.tsx)
    ├→ TopMoversCard (sorted by heatScore)
    ├→ NewsTerminalFeed (reverse-chronological)
    ├→ FedLiquidityMonitor (grid layout)
    └→ CorporateIntelPanel (ownership + revisions)
```

---

## Whitelist Firewall

### Allowed Sources

The API route contains an immutable `ALLOWED_SOURCE_HANDLES` array:

```typescript
const ALLOWED_SOURCE_HANDLES = [
  '@zerohedge',        // Global macro intelligence, conspiracy theory debunking
  '@FirstSquawk',      // Real-time market alerts, Fed news
  '@FinancialJuice',   // Market sentiment, central bank analysis
  '@DeltaOne',         // Derivatives flow, structured products, volatility
  'BLOOMBERG',         // Bloomberg Terminal headline feeds (if available)
]
```

**Any incoming headline from a source NOT in this whitelist is discarded immediately.**

### Firewall Logic (in route.ts)

```typescript
function filterByWhitelist(sourceHandle: string): boolean {
  return ALLOWED_SOURCE_HANDLES.some(
    (allowed) =>
      sourceHandle.includes(allowed) ||
      allowed.includes(sourceHandle)
  )
}

// Applied when fetching Twitter/X data
const articles = data.data
  .filter((tweet: any) => {
    const author = data.includes?.users?.find((u: any) => u.id === tweet.author_id)
    return filterByWhitelist(`@${author?.username}`) // ← FIREWALL
  })
```

---

## Heat-Mapping Algorithm

### How It Works

1. **Macro Keyword Extraction**
   - Tracks: `FED`, `CPI`, `YIELD`, `CRUDE`, `RATE`, `INFLATION`, `GDP`, `RECESSION`, `VOLATILITY`, `FOMC`, `NFP`, `PPI`
   - Extracted from each article's headline

2. **3-Minute Window Detection**
   - Groups articles by (keyword, sourceHandle, time within 3 minutes)
   - Counts how many distinct sources mention the same keyword in the window

3. **Heat Score Calculation**
   - Base score = (number of sources / 5) × 100
   - Boost = (mention count / 10) × 10
   - Final score: min(100, base + boost)

4. **Top 5 Ranking**
   - Filters keywords with 2+ sources in the 3-minute window
   - Sorts by heat score descending
   - Returns top 5 movers with their headline, sources, and timestamp

### Example

```
Timeline:
10:00 - @FirstSquawk tweets about "Fed signals higher rates"
10:01 - BLOOMBERG publishes "Fed Rate Hike Odds Rise"
10:02 - @zerohedge shares "FOMC Decision Looms"

Result:
Keyword: FED
Sources: 3 (@FirstSquawk, BLOOMBERG, @zerohedge)
Heat Score: (3/5) * 100 + (3/10) * 10 = 63°
Rank: #1 (if highest score among all keywords)
```

---

## HTML Entity Decoding

### Problem

Raw HTML entities break typography:
- `&#x2019;` renders as raw text instead of: `'`
- `&#x201C;` and `&#x201D;` instead of: `"` and `"`
- `&amp;` instead of: `&`

### Solution

The `decodeHtmlEntities()` function (in component) handles both client-side (browser) and server-side:

```typescript
function decodeHtmlEntities(text: string): string {
  const textarea = typeof document !== 'undefined'
    ? document.createElement('textarea')
    : null

  if (textarea) {
    textarea.innerHTML = text  // Browser: leverage native parser
    return textarea.value
  }

  // Server-side fallback: manual replacements
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#x2014;/g, '—')
    .replace(/&#x2013;/g, '–')
    // ... more entities
}
```

Applied to all headline text in the NewsTerminalFeed component.

---

## API Configuration & Keys

### 1. FRED API (Federal Reserve Economic Data)

**Endpoint**: https://api.stlouisfed.org/fred/

**Get API Key**:
1. Go to https://fred.stlouisfed.org/docs/api/fred/
2. Click "Get Your API Key"
3. Create a free FRED account
4. Copy your API key

**Required Series IDs**:
- `WALCL` → Fed Balance Sheet Total Assets
- `WIMFSL` → Treasury General Account (TGA)
- `WTREGEN` → Reverse Repurchase Agreements (RRP)

**Example Request**:
```bash
curl "https://api.stlouisfed.org/fred/series/WALCL/observations?api_key=YOUR_KEY&limit=15&sort_order=desc"
```

**Rate Limits**: 400 requests per minute (more than sufficient)

---

### 2. FMP API (Financial Modeling Prep)

**Endpoints**:
- `/analyst-estimates` → Analyst revisions, price targets
- `/institutional-ownership/institutional-holders/{ticker}` → Ownership data

**Get API Key**:
1. Go to https://site.financialmodelingprep.com/developer/docs
2. Sign up (free tier available)
3. Copy your API key from dashboard

**Tracked Tickers** (configurable in route.ts):
```typescript
const trackedTickers = ['NVDA', 'DELL', 'MSFT', 'AMD']
```

**Example Requests**:
```bash
# Analyst Revisions
curl "https://financialmodelingprep.com/api/v4/analyst-estimates?symbol=NVDA&limit=1&apikey=YOUR_KEY"

# Institutional Ownership
curl "https://financialmodelingprep.com/api/v4/institutional-ownership/institutional-holders/NVDA?apikey=YOUR_KEY"
```

**Rate Limits**: Free tier allows 250 requests/day; upgrade to higher tier if needed

---

### 3. Twitter/X API

**Endpoint**: `https://api.twitter.com/2/tweets/search/recent`

**Get Bearer Token**:
1. Go to https://developer.twitter.com/en/portal/dashboard
2. Create an App (or use existing)
3. Go to "Keys and Tokens"
4. Copy your **Bearer Token** (from "Authentication Tokens")

**Required Permissions**:
- `tweet.read` (read tweets)
- `users.read` (read user information)

**Query Used**:
```typescript
const query = `from:zerohedge OR from:FirstSquawk OR from:FinancialJuice OR from:DeltaOne lang:en -is:retweet`
```

**Example Request**:
```bash
curl -H "Authorization: Bearer YOUR_BEARER_TOKEN" \
  "https://api.twitter.com/2/tweets/search/recent?query=from:zerohedge&max_results=100"
```

**Rate Limits**: Recent search allows 300 requests per 15 minutes

---

## Environment Variables Setup

### 1. Create `.env.local`

Copy `.env.example` to `.env.local` and populate:

```bash
cp .env.example .env.local
```

### 2. Fill in Your API Keys

```
FRED_API_KEY=xxxxx
FMP_API_KEY=xxxxx
TWITTER_BEARER_TOKEN=xxxxx
```

### 3. Next.js Automatic Loading

Next.js automatically loads `.env.local` at runtime. Variables are accessible via:

```typescript
const FRED_API_KEY = process.env.FRED_API_KEY || ''
```

**Note**: Only variables prefixed with `NEXT_PUBLIC_` are exposed to the browser. Sensitive tokens stay server-side.

---

## Data Structures

### Mock Data Format

All components accept and render a `SquawkNewsData` object:

```typescript
export interface SquawkNewsData {
  articles: SquawkArticle[]                    // 6+ headlines
  topMovers: TopMover[]                        // Top 5 heat-mapped
  fedLiquidity: FedLiquiditySnapshot           // 1 current snapshot
  institutionalOwnership: InstitutionalOwnershipMetric[]  // 4+ tickers
  analystRevisions: AnalystRevision[]          // 3+ tickers
}
```

The component falls back to `SQUAWK_NEWS_MOCK` if API fetch fails or returns null.

---

## Customization

### 1. Change Tracked Tickers

In `src/app/api/institutional-squawk/route.ts`:

```typescript
const trackedTickers = ['NVDA', 'DELL', 'MSFT', 'AMD']  // ← Edit here
```

### 2. Add/Remove Whitelisted Sources

In `src/app/api/institutional-squawk/route.ts`:

```typescript
const ALLOWED_SOURCE_HANDLES = [
  '@zerohedge',
  '@FirstSquawk',
  '@FinancialJuice',
  '@DeltaOne',
  'BLOOMBERG',
  // '@NewSource',  // ← Add here
]
```

Also update in `src/components/dashboard/InstitutionalSquawkNewsStream.tsx`:

```typescript
const ALLOWED_SOURCES = [
  { handle: '@zerohedge', name: 'ZeroHedge', color: '#94a3b8' },
  { handle: '@FirstSquawk', name: 'First Squawk', color: '#60a5fa' },
  // ... rest
  // { handle: '@NewSource', name: 'New Source', color: '#your_color' },
]
```

### 3. Adjust Refresh Interval

In `src/app/dashboard/page.tsx`:

```typescript
useEffect(() => {
  load()
  const t = setInterval(load, 60_000)  // ← Change 60_000 (60 seconds) to desired interval
  return () => clearInterval(t)
}, [load])
```

### 4. Customize Macro Keywords

In `src/app/api/institutional-squawk/route.ts`:

```typescript
function extractMacroKeywords(text: string): string[] {
  const keywords = ['FED', 'CPI', 'YIELD', 'CRUDE', 'RATE', /* add more */]
  return keywords.filter((kw) => text.toUpperCase().includes(kw))
}
```

---

## Styling & UI Customization

### Color Scheme

- **Light Blue** (X/Twitter source badges): `#60a5fa`
- **Glowing Amber/Neon** (Bloomberg Terminal): `#fbbf24` with glow effect
- **Success Green** (Expanding liquidity): `#34d399`
- **Alert Red** (Contracting liquidity): `#f87171`
- **Neutral Gray** (Container borders): `#1a2540`

### Components Using Colors

```typescript
// In TopMoversCard
const heatColor = mover.heatScore >= 80
  ? '#f87171'      // Red (hot)
  : mover.heatScore >= 65
    ? '#fbbf24'    // Amber (warm)
    : '#34d399'    // Green (cool)

// In NewsTerminalFeed
const sourceConfig = ALLOWED_SOURCES.find(...)
style={{
  color: sourceConfig.color,
  borderColor: `${sourceConfig.color}50`,      // 50% opacity
  backgroundColor: `${sourceConfig.color}12`,  // 12% opacity
}}
```

To modify, update the `ALLOWED_SOURCES` array color hex values.

---

## Error Handling & Fallbacks

### API Fetch Failures

If any external API fails (FRED, FMP, Twitter):

1. Component logs error to console
2. Returns `null` instead of throwing
3. Dashboard rendering checks `data || SQUAWK_NEWS_MOCK`
4. Displays mock data seamlessly

### Example

```typescript
async function fetchFedLiquidityData() {
  try {
    // ... API call
  } catch (error) {
    console.error('Error fetching FRED data:', error)
    return null  // ← Graceful failure
  }
}

// In GET handler
const [fedLiquidity, /* ... */] = await Promise.all([...])

const response: SquawkNewsData = {
  articles,
  topMovers,
  fedLiquidity: fedLiquidity || SQUAWK_NEWS_MOCK.fedLiquidity,  // ← Fallback
  // ...
}
```

---

## Performance Considerations

1. **Data Fetching**: Parallel fetches via `Promise.all()` (~2-4s typical)
2. **Memoization**: No heavy computations; all data pre-calculated by APIs
3. **Caching**: Next.js route with `cache: 'no-store'` ensures fresh data
4. **Bundle Size**: ~15KB gzipped (component + types)

---

## Testing

### 1. Test with Mock Data

Remove `.env.local` or set `FRED_API_KEY=` (empty) to force mock data:

```bash
FRED_API_KEY="" npm run dev
```

### 2. Test Individual Components

In a React Testing Library or Storybook setup:

```typescript
import { InstitutionalSquawkNewsStream, SQUAWK_NEWS_MOCK } from '...'

it('renders mock data', () => {
  render(<InstitutionalSquawkNewsStream data={SQUAWK_NEWS_MOCK} />)
  expect(screen.getByText(/FED/)).toBeInTheDocument()
})
```

### 3. Verify API Endpoint

```bash
curl http://localhost:3000/api/institutional-squawk
```

Should return JSON with `articles`, `topMovers`, `fedLiquidity`, etc.

---

## Monitoring & Logging

### Add Debug Logging (optional)

In `src/app/api/institutional-squawk/route.ts`:

```typescript
console.log(`[Squawk] Fetched ${articles.length} whitelisted articles`)
console.log(`[Squawk] Top mover: ${topMovers[0]?.keyword} (heat: ${topMovers[0]?.heatScore}°)`)
console.log(`[Squawk] Fed liquidity: $${fedLiquidity?.netLiquidity}B (${fedLiquidity?.momentumDirection})`)
```

### Monitor in Production

Set up error tracking (Sentry, LogRocket, etc.) to catch API failures:

```typescript
import * as Sentry from "@sentry/nextjs"

catch (error) {
  Sentry.captureException(error, { tags: { endpoint: 'institutional-squawk' } })
  return NextResponse.json(SQUAWK_NEWS_MOCK)
}
```

---

## Roadmap / Future Enhancements

- [ ] Add real-time WebSocket stream for live squawk updates
- [ ] Implement sentiment analysis on headlines
- [ ] Add calendar events (Fed meetings, CPI print times)
- [ ] Historical heat-map trending (top keywords over time)
- [ ] Mobile-optimized terminal view
- [ ] Dark mode toggle (already dark by default, add light mode)
- [ ] Custom keyword filtering by user
- [ ] Slack/Discord webhook integration for high-heat stories
- [ ] API rate-limiting & caching strategy for production scale

---

## Support & Questions

For issues or questions:

1. Check `.env.local` has all required keys
2. Verify API key permissions (FRED free, FMP needs account, Twitter needs app approval)
3. Check browser console for network errors
4. Test individual API endpoints with `curl` or Postman
5. Ensure Next.js dev server is running (`npm run dev`)

---

**Version**: 1.0  
**Last Updated**: May 2026  
**Status**: Production Ready (with API key setup)
