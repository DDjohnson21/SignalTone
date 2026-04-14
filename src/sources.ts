// Source engine: Hacker News + GitHub Trending with 30-min in-memory cache.
//
// GitHub note: there is no official GitHub Trending API. We proxy it using
// the GitHub Search API (repos created in the past 7 days, sorted by stars).
// This is a reasonable approximation of "trending" and requires no auth,
// though an optional GITHUB_TOKEN raises the rate limit from 60 → 5000 req/hr.

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SourceItem {
  title: string;
  url: string;
  score: number;
  source: "hackernews" | "github_trending" | "arxiv" | "rss" | "producthunt";
  topic?: string;
  publishedAt: Date;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  items: SourceItem[];
  fetchedAt: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes
const cache = new Map<string, CacheEntry>();

// ─── Hacker News ─────────────────────────────────────────────────────────────

const HN_MIN_SCORE = 50;  // filter low-signal stories
const HN_FETCH_COUNT = 30; // fetch extra to account for dead links

// ─── URL validation ───────────────────────────────────────────────────────────

/** HEAD → GET fallback. Returns false on timeout, network error, or 4xx/5xx. */
async function validateUrl(url: string): Promise<boolean> {
  for (const method of ["HEAD", "GET"] as const) {
    try {
      const res = await fetch(url, {
        method,
        signal: AbortSignal.timeout(5000),
        redirect: "follow",
      });
      if (res.status !== 405) return res.status < 400;
    } catch {
      return false;
    }
  }
  return false;
}

interface HNItem {
  id: number;
  title: string;
  url?: string;
  score: number;
  time: number;
  type: string;
}

async function fetchHackerNews(): Promise<SourceItem[]> {
  const topRes = await fetch(
    "https://hacker-news.firebaseio.com/v0/topstories.json"
  );
  if (!topRes.ok) throw new Error(`HN topstories: ${topRes.status}`);

  const ids = (await topRes.json()) as number[];
  const top = ids.slice(0, HN_FETCH_COUNT);

  const stories = await Promise.all(
    top.map(async (id) => {
      try {
        const res = await fetch(
          `https://hacker-news.firebaseio.com/v0/item/${id}.json`
        );
        return res.ok ? ((await res.json()) as HNItem) : null;
      } catch {
        return null;
      }
    })
  );

  const valid = stories.filter(
    (s): s is HNItem =>
      s !== null &&
      s.type === "story" &&
      s.score >= HN_MIN_SCORE &&
      Boolean(s.url || s.id)
  );

  // Validate external URLs in parallel; fall back to HN comments page for dead links
  return Promise.all(
    valid.map(async (s) => {
      const hnFallback = `https://news.ycombinator.com/item?id=${s.id}`;
      let url = hnFallback;

      if (s.url) {
        const ok = await validateUrl(s.url);
        url = ok ? s.url : hnFallback;
        if (!ok) console.log(`[Sources] Dead link replaced with HN fallback: ${s.url}`);
      }

      return {
        title: s.title,
        url,
        score: s.score,
        source: "hackernews" as const,
        publishedAt: new Date(s.time * 1000),
      };
    })
  );
}

// ─── GitHub Trending (via Search API) ────────────────────────────────────────

interface GHRepo {
  full_name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  language: string | null;
  created_at: string;
  topics: string[];
}

async function fetchGitHubTrending(): Promise<SourceItem[]> {
  // Repos created in the past 7 days sorted by stars ≈ trending
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const dateStr = since.toISOString().split("T")[0];

  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": "SignalTone-Agent/1.0",
  };

  const token = process.env.GITHUB_TOKEN;
  if (token) headers["Authorization"] = `Bearer ${token}`;

  const res = await fetch(
    `https://api.github.com/search/repositories?q=created:>${dateStr}&sort=stars&order=desc&per_page=10`,
    { headers }
  );

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.warn(`GitHub trending fetch failed (${res.status}): ${body.slice(0, 200)}`);
    return [];
  }

  const data = (await res.json()) as { items: GHRepo[] };

  return data.items.map((repo) => ({
    title: `${repo.full_name}${repo.description ? ` — ${repo.description}` : ""}`,
    url: repo.html_url,
    score: repo.stargazers_count,
    source: "github_trending" as const,
    topic: repo.language ?? undefined,
    publishedAt: new Date(repo.created_at),
  }));
}

// ─── ArXiv ───────────────────────────────────────────────────────────────────

async function fetchArxiv(): Promise<SourceItem[]> {
  try {
    const res = await fetch(
      "https://export.arxiv.org/api/query?search_query=cat:cs.AI+OR+cat:cs.CL+OR+cat:cs.SE&sortBy=submittedDate&sortOrder=descending&max_results=8",
      { signal: AbortSignal.timeout(10000) }
    );
    if (!res.ok) return [];
    const xml = await res.text();

    const entries: SourceItem[] = [];
    const entryPattern = /<entry>([\s\S]*?)<\/entry>/g;
    let match: RegExpExecArray | null;

    while ((match = entryPattern.exec(xml)) !== null) {
      const block = match[1];

      const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(block);
      const idMatch = /<id>([\s\S]*?)<\/id>/.exec(block);
      const publishedMatch = /<published>([\s\S]*?)<\/published>/.exec(block);

      const title = titleMatch ? titleMatch[1].trim() : null;
      const url = idMatch ? idMatch[1].trim() : null;
      const published = publishedMatch ? publishedMatch[1].trim() : null;

      if (!title || !url) continue;

      entries.push({
        title,
        url,
        score: 120,
        source: "arxiv",
        topic: "ai",
        publishedAt: published ? new Date(published) : new Date(),
      });
    }

    return entries;
  } catch {
    return [];
  }
}

// ─── RSS ─────────────────────────────────────────────────────────────────────

const RSS_FEEDS: Array<{ url: string; topic?: string }> = [
  { url: "https://simonwillison.net/atom/everything/", topic: "ai" },
  { url: "https://techcrunch.com/feed/", topic: undefined },
  { url: "https://www.theverge.com/rss/index.xml", topic: undefined },
];

async function fetchRSS(feedUrl: string, topic?: string): Promise<SourceItem[]> {
  try {
    const res = await fetch(feedUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return [];
    const xml = await res.text();

    const items: SourceItem[] = [];

    // Match <item> or <entry> blocks
    const blockPattern = /<(?:item|entry)>([\s\S]*?)<\/(?:item|entry)>/g;
    let match: RegExpExecArray | null;

    while ((match = blockPattern.exec(xml)) !== null && items.length < 5) {
      const block = match[1];

      // Extract title — handle CDATA
      const titleMatch = /<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/.exec(block);
      const title = titleMatch ? titleMatch[1].trim() : null;

      // Extract link — handle plain <link> or atom <link href="..."/>
      let url: string | null = null;
      const hrefMatch = /<link[^>]+href="([^"]+)"/.exec(block);
      if (hrefMatch) {
        url = hrefMatch[1].trim();
      } else {
        const linkMatch = /<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/.exec(block);
        if (linkMatch) url = linkMatch[1].trim();
      }

      // Extract pubDate or published
      const dateMatch = /<(?:pubDate|published)>([\s\S]*?)<\/(?:pubDate|published)>/.exec(block);
      const published = dateMatch ? dateMatch[1].trim() : null;

      if (!title || !url) continue;

      items.push({
        title,
        url,
        score: 70,
        source: "rss",
        topic,
        publishedAt: published ? new Date(published) : new Date(),
      });
    }

    return items;
  } catch {
    return [];
  }
}

// ─── Product Hunt ───────────────────────────────────────────────────────────

interface PHPost {
  name: string;
  tagline: string | null;
  url: string;
  votesCount: number;
  created_at: string;
  topics: Array<{ slug: string; name: string }>;
}

/**
 * Product Hunt API fetcher.
 * Note: Product Hunt requires OAuth authentication. This implementation
 * uses a public proxy approach — for production, set up PH OAuth and
 * use the PH API directly with a valid access token.
 *
 * Alternative: Use RSS feed at https://www.producthunt.com/feed/rss
 */
async function fetchProductHunt(): Promise<SourceItem[]> {
  try {
    // Product Hunt RSS feed (no auth required, limited to ~20 items)
    const res = await fetch("https://www.producthunt.com/feed/rss", {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];

    const xml = await res.text();
    const items: SourceItem[] = [];

    const itemPattern = /<item>([\s\S]*?)<\/item>/g;
    let match: RegExpExecArray | null;

    while ((match = itemPattern.exec(xml)) !== null && items.length < 8) {
      const block = match[1];

      const titleMatch = /<title>([\s\S]*?)<\/title>/.exec(block);
      const linkMatch = /<link>([\s\S]*?)<\/link>/.exec(block);
      const pubDateMatch = /<pubDate>([\s\S]*?)<\/pubDate>/.exec(block);
      const descMatch = /<description>([\s\S]*?)<\/description>/.exec(block);

      const title = titleMatch ? titleMatch[1].trim() : null;
      const url = linkMatch ? linkMatch[1].trim() : null;
      const pubDate = pubDateMatch ? pubDateMatch[1].trim() : null;
      const desc = descMatch ? descMatch[1].trim() : null;

      if (!title || !url) continue;

      // Extract vote count from description if available
      const votesMatch = /(\d+)\s*votes?/i.exec(desc ?? "");
      const votes = votesMatch ? parseInt(votesMatch[1], 10) : 50;

      items.push({
        title,
        url,
        score: votes,
        source: "producthunt",
        topic: "devtools", // PH is mostly dev tools and consumer apps
        publishedAt: pubDate ? new Date(pubDate) : new Date(),
      });
    }

    return items;
  } catch {
    return [];
  }
}

// ─── Scoring ─────────────────────────────────────────────────────────────────

/** Exponential recency decay with a 12-hour half-life, as per Section 6.2. */
function recencyScore(publishedAt: Date): number {
  const ageMs = Date.now() - publishedAt.getTime();
  const halfLifeMs = 12 * 60 * 60 * 1000;
  return Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
}

/** Novelty penalty: reduces score for topics the user has seen recently.
 * Each recent topic occurrence reduces the score by 15% (up to 80% max penalty). */
function noveltyPenalty(item: SourceItem, recentTopics: Map<string, number>): number {
  if (!item.topic || recentTopics.size === 0) return 1;

  const key = item.topic.toLowerCase();
  const count = recentTopics.get(key) ?? 0;
  if (count === 0) return 1;

  const penaltyPerOccurrence = 0.15;
  const maxPenalty = 0.8;
  const totalPenalty = Math.min(count * penaltyPerOccurrence, maxPenalty);

  return 1 - totalPenalty;
}

function rank(items: SourceItem[], recentTopics?: Map<string, number>): SourceItem[] {
  return [...items].sort((a, b) => {
    const aRecency = recencyScore(a.publishedAt);
    const bRecency = recencyScore(b.publishedAt);
    const aNovelty = noveltyPenalty(a, recentTopics ?? new Map());
    const bNovelty = noveltyPenalty(b, recentTopics ?? new Map());

    const aScore = aRecency * aNovelty;
    const bScore = bRecency * bNovelty;

    return bScore - aScore;
  });
}

// ─── Topic filtering ─────────────────────────────────────────────────────────

const TOPIC_KEYWORDS: Record<string, string[]> = {
  ai: ["ai", "llm", "gpt", "machine learning", "neural", "openai", "anthropic", "gemini", "claude", "ml"],
  crypto: ["crypto", "blockchain", "bitcoin", "ethereum", "web3", "defi", "nft", "solana"],
  devtools: ["devtools", "developer tools", "ide", "editor", "cli", "sdk", "api", "tooling"],
  cybersecurity: ["security", "vulnerability", "hack", "exploit", "cve", "malware", "breach"],
  mobile: ["ios", "android", "swift", "kotlin", "flutter", "react native", "mobile"],
  cloud: ["cloud", "aws", "gcp", "azure", "kubernetes", "docker", "serverless", "infra"],
};

function matchesTopic(item: SourceItem, topic: string): boolean {
  const needle = topic.toLowerCase();
  const haystack = `${item.title} ${item.topic ?? ""}`.toLowerCase();

  // Direct substring match
  if (haystack.includes(needle)) return true;

  // Alias expansion
  const aliases = TOPIC_KEYWORDS[needle] ?? [];
  return aliases.some((kw) => haystack.includes(kw));
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns up to `limit` ranked source items.
 * Raw fetch results are cached per TTL and shared across all callers.
 * Topic filtering and seenUrls dedup are applied post-cache so the fetch is not per-user.
 */
export async function getTopItems(
  topicFilter?: string,
  limit = 8,
  seenUrls?: Set<string>,
  recentTopics?: Map<string, number>
): Promise<SourceItem[]> {
  const cacheKey = "raw";
  const cached = cache.get(cacheKey);

  let allItems: SourceItem[];

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    allItems = cached.items;
  } else {
    const [hn, gh, arxiv, ph, ...rssResults] = await Promise.all([
      fetchHackerNews().catch((e) => {
        console.warn("HN fetch failed:", e);
        return [] as SourceItem[];
      }),
      fetchGitHubTrending().catch((e) => {
        console.warn("GitHub fetch failed:", e);
        return [] as SourceItem[];
      }),
      fetchArxiv().catch((e) => {
        console.warn("ArXiv fetch failed:", e);
        return [] as SourceItem[];
      }),
      fetchProductHunt().catch((e) => {
        console.warn("Product Hunt fetch failed:", e);
        return [] as SourceItem[];
      }),
      ...RSS_FEEDS.map((f) =>
        fetchRSS(f.url, f.topic).catch((e) => {
          console.warn(`RSS fetch failed (${f.url}):`, e);
          return [] as SourceItem[];
        })
      ),
    ]);

    const rssItems = rssResults.flat();
    allItems = rank([...hn, ...gh, ...arxiv, ...ph, ...rssItems], recentTopics);
    cache.set(cacheKey, { items: allItems, fetchedAt: Date.now() });
    console.log(
      `Source cache refreshed: ${hn.length} HN + ${gh.length} GH + ${arxiv.length} ArXiv + ${ph.length} PH + ${rssItems.length} RSS items`
    );
  }

  let filtered = allItems;

  if (topicFilter) {
    const topicFiltered = allItems.filter((item) => matchesTopic(item, topicFilter));
    // If nothing matched the topic, fall back to top items so we never return empty
    filtered = topicFiltered.length > 0 ? topicFiltered : allItems;
  }

  if (seenUrls && seenUrls.size > 0) {
    filtered = filtered.filter((item) => !seenUrls.has(item.url));
  }

  // Apply topic novelty re-ranking if recent topics are provided
  // This is done post-cache so it's user-specific
  if (recentTopics && recentTopics.size > 0) {
    filtered = rank(filtered, recentTopics);
    const penalizedTopics = [...recentTopics.entries()]
      .filter(([_, count]) => count > 0)
      .slice(0, 3)
      .map(([t, c]) => `${t}(${c})`)
      .join(", ");
    console.log(`[Sources] Topic novelty applied: ${penalizedTopics}`);
  }

  return filtered.slice(0, limit);
}

/** Manually expire the cache (useful for testing). */
export function clearSourceCache(): void {
  cache.clear();
}
