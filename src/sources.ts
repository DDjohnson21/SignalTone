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
  source: "hackernews" | "github_trending";
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

// ─── Scoring ─────────────────────────────────────────────────────────────────

/** Exponential recency decay with a 12-hour half-life, as per Section 6.2. */
function recencyScore(publishedAt: Date): number {
  const ageMs = Date.now() - publishedAt.getTime();
  const halfLifeMs = 12 * 60 * 60 * 1000;
  return Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
}

function rank(items: SourceItem[]): SourceItem[] {
  return [...items].sort((a, b) => recencyScore(b.publishedAt) - recencyScore(a.publishedAt));
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
 * Topic filtering is applied post-cache so the fetch is not per-user.
 */
export async function getTopItems(
  topicFilter?: string,
  limit = 8
): Promise<SourceItem[]> {
  const cacheKey = "raw";
  const cached = cache.get(cacheKey);

  let allItems: SourceItem[];

  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    allItems = cached.items;
  } else {
    const [hn, gh] = await Promise.all([
      fetchHackerNews().catch((e) => {
        console.warn("HN fetch failed:", e);
        return [] as SourceItem[];
      }),
      fetchGitHubTrending().catch((e) => {
        console.warn("GitHub fetch failed:", e);
        return [] as SourceItem[];
      }),
    ]);

    allItems = rank([...hn, ...gh]);
    cache.set(cacheKey, { items: allItems, fetchedAt: Date.now() });
    console.log(`Source cache refreshed: ${hn.length} HN + ${gh.length} GH items`);
  }

  if (topicFilter) {
    const filtered = allItems.filter((item) => matchesTopic(item, topicFilter));
    // If nothing matched the topic, fall back to top items so we never return empty
    return (filtered.length > 0 ? filtered : allItems).slice(0, limit);
  }

  return allItems.slice(0, limit);
}

/** Manually expire the cache (useful for testing). */
export function clearSourceCache(): void {
  cache.clear();
}
