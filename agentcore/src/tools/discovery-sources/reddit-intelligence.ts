import { createHash } from 'crypto';
import { Redis } from 'ioredis';
import pLimit from 'p-limit';
import { createRedisConnection } from '../../queues/setup.js';
import { searchDiscovery } from '../searxng.tool.js';
import { extractJSON } from '../together-ai.tool.js';
import logger from '../../utils/logger.js';
import type { DiscoveryParams, PeopleDiscoveryParams, RawCompanyResult, RawPersonResult } from './types.js';

// ── Types ───────────────────────────────────────────────────────────────────

interface RedditPost {
  id: string;
  title: string;
  selftext: string;
  subreddit: string;
  author: string;
  permalink: string;
  url: string;
  score: number;
  num_comments: number;
  created_utc: number;
  link_flair_text?: string;
}

interface IntentAnalysis {
  postId: string;
  intentScore: number;
  intentCategory: 'direct_hire' | 'project_need' | 'recommendation_request' | 'pain_point' | 'none';
  intentSignals: string[];
  extractedCompany?: string;
  extractedPerson?: string;
  extractedDomain?: string;
  extractedBudget?: string;
  extractedTechnologies?: string[];
  specificNeed?: string;
  urgency?: 'high' | 'medium' | 'low';
  recommendedAction: 'reach_out_directly' | 'enrich_and_email' | 'monitor' | 'skip';
}

interface AuthorProfile {
  username: string;
  karma: number;
  accountAge?: string;
  topSubreddits: string[];
  detectedProfession?: string;
  detectedCompany?: string;
  isActive: boolean;
}

interface RedditSearchResponse {
  data?: {
    children?: Array<{ data: RedditPost }>;
  };
}

interface RedditUserAbout {
  data?: {
    name?: string;
    total_karma?: number;
    link_karma?: number;
    comment_karma?: number;
    created_utc?: number;
  };
}

interface RedditUserPosts {
  data?: {
    children?: Array<{
      data: {
        subreddit?: string;
        title?: string;
        selftext?: string;
        author_flair_text?: string;
      };
    }>;
  };
}

// ── Module-level state ──────────────────────────────────────────────────────

const redis: Redis = createRedisConnection();
const redditApiLimit = pLimit(2);
const searxLimit = pLimit(5);
const llmLimit = pLimit(3);
const REDDIT_API_DELAY_MS = 2000;
const CACHE_TTL_6H = 6 * 3600;
const CACHE_TTL_24H = 24 * 3600;
const RATE_LIMIT_MAX = 200;
const RATE_LIMIT_WINDOW_SEC = 3600;
const USER_AGENT = 'agentcore:discovery:v1.0 (by /u/agentcore-bot)';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Subreddit configs ───────────────────────────────────────────────────────

const SUBREDDIT_CONFIGS: Record<string, { subreddits: string[]; keywords: string[] }> = {
  sales: {
    subreddits: [
      'SaaS', 'startups', 'Entrepreneur', 'smallbusiness', 'sales',
      'marketing', 'ecommerce', 'devops', 'sysadmin', 'forhire', 'hiring',
    ],
    keywords: [
      'looking for', 'recommend', 'alternative to', 'budget for',
      'need help with', 'anyone use', 'best tool for', 'switching from',
    ],
  },
  recruitment: {
    subreddits: [
      'cscareerquestions', 'experienceddevs', 'jobs', 'webdev',
      'programming', 'forhire', 'hiring',
    ],
    keywords: [
      '[hiring]', 'looking for a developer', 'need a contractor',
      'hiring remote', 'freelance wanted', 'looking to hire',
    ],
  },
};

// ── Rate limiting ───────────────────────────────────────────────────────────

export async function checkRateLimit(tenantId: string): Promise<boolean> {
  const rateLimitKey = `tenant:${tenantId}:ratelimit:reddit`;
  const currentCount = await redis.get(rateLimitKey);
  if (currentCount && parseInt(currentCount, 10) > RATE_LIMIT_MAX) {
    logger.warn({ tenantId, count: parseInt(currentCount, 10) }, 'Reddit rate limit exceeded');
    return false;
  }
  const count = await redis.incr(rateLimitKey);
  if (count === 1) {
    await redis.expire(rateLimitKey, RATE_LIMIT_WINDOW_SEC);
  }
  if (count > RATE_LIMIT_MAX) {
    logger.warn({ tenantId, count }, 'Reddit rate limit exceeded');
    return false;
  }
  return true;
}

// ── Reddit JSON API ─────────────────────────────────────────────────────────

export async function searchRedditJSON(
  query: string,
  tenantId: string,
  subreddit?: string,
  sort: 'relevance' | 'new' | 'hot' | 'top' = 'relevance',
): Promise<RedditPost[]> {
  if (!(await checkRateLimit(tenantId))) return [];

  const cacheKey = `tenant:${tenantId}:cache:reddit:${createHash('md5').update(`${query}:${subreddit ?? 'all'}:${sort}`).digest('hex')}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as RedditPost[];
  } catch { /* continue */ }

  try {
    await sleep(REDDIT_API_DELAY_MS);

    const baseUrl = subreddit
      ? `https://www.reddit.com/r/${subreddit}/search.json`
      : `https://www.reddit.com/search.json`;

    const params = new URLSearchParams({
      q: query,
      sort,
      limit: '25',
      t: 'month',
      restrict_sr: subreddit ? 'true' : 'false',
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`${baseUrl}?${params.toString()}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.debug({ status: response.status, query, subreddit }, 'Reddit API returned non-OK');
      return [];
    }

    const data = await response.json() as RedditSearchResponse;
    const posts: RedditPost[] = (data.data?.children ?? []).map((child) => child.data);

    await redis.setex(cacheKey, CACHE_TTL_6H, JSON.stringify(posts)).catch(() => {});
    return posts;
  } catch (err) {
    logger.debug({ err, query, subreddit }, 'Reddit JSON search error');
    return [];
  }
}

// ── SearXNG broader search ──────────────────────────────────────────────────

export async function searchRedditViaSearXNG(
  query: string,
  tenantId: string,
): Promise<RedditPost[]> {
  try {
    const results = await searchDiscovery(tenantId, `${query} reddit.com`, 10);
    return results
      .filter((r) => r.url.includes('reddit.com/r/'))
      .map((r) => {
        // Extract subreddit from URL
        const subredditMatch = r.url.match(/reddit\.com\/r\/([^/]+)/);
        // Extract post ID from URL
        const postIdMatch = r.url.match(/comments\/([a-z0-9]+)/);
        return {
          id: postIdMatch?.[1] ?? createHash('md5').update(r.url).digest('hex').slice(0, 10),
          title: r.title.replace(/ : \w+$/, '').replace(/ - Reddit$/, '').trim(),
          selftext: r.snippet,
          subreddit: subredditMatch?.[1] ?? 'unknown',
          author: 'unknown',
          permalink: r.url.replace('https://www.reddit.com', ''),
          url: r.url,
          score: 0,
          num_comments: 0,
          created_utc: Date.now() / 1000,
        };
      });
  } catch (err) {
    logger.debug({ err, query }, 'Reddit SearXNG search error');
    return [];
  }
}

// ── LLM intent scoring ─────────────────────────────────────────────────────

export async function scorePostsIntent(
  posts: RedditPost[],
  useCase: string,
  tenantId: string,
): Promise<IntentAnalysis[]> {
  if (posts.length === 0) return [];

  const batches: RedditPost[][] = [];
  for (let i = 0; i < posts.length; i += 10) {
    batches.push(posts.slice(i, i + 10));
  }

  const allResults: IntentAnalysis[] = [];

  for (const batch of batches) {
    try {
      const postsData = batch.map((p) => ({
        id: p.id,
        title: p.title,
        body: (p.selftext ?? '').slice(0, 500),
        subreddit: p.subreddit,
        author: p.author,
        score: p.score,
        comments: p.num_comments,
      }));

      const result = await llmLimit(() =>
        extractJSON<IntentAnalysis[]>(tenantId, [
          {
            role: 'system',
            content: `You are an expert at identifying buying intent and business opportunities from Reddit posts.
Analyze each post and score its intent for ${useCase === 'recruitment' ? 'hiring/recruiting needs' : 'B2B sales opportunities'}.

For each post, return:
- postId: the post ID
- intentScore: 0-100 (how likely this represents a real business opportunity)
- intentCategory: "direct_hire" | "project_need" | "recommendation_request" | "pain_point" | "none"
- intentSignals: array of specific phrases/signals that indicate intent
- extractedCompany: company name if mentioned
- extractedPerson: person name if mentioned
- extractedDomain: website/domain if mentioned
- extractedBudget: budget info if mentioned
- extractedTechnologies: technologies mentioned
- specificNeed: what exactly they need
- urgency: "high" | "medium" | "low"
- recommendedAction: "reach_out_directly" | "enrich_and_email" | "monitor" | "skip"

Return a JSON array of analysis objects.`,
          },
          {
            role: 'user',
            content: `Analyze these Reddit posts for ${useCase} intent:\n\n${JSON.stringify(postsData, null, 2)}`,
          },
        ]),
      );

      if (Array.isArray(result)) {
        allResults.push(...result);
      }
    } catch (err) {
      logger.debug({ err, batchSize: batch.length }, 'LLM intent scoring failed for batch');
    }
  }

  return allResults;
}

// ── Author research ─────────────────────────────────────────────────────────

export async function researchAuthorProfile(
  username: string,
  tenantId: string,
): Promise<AuthorProfile | null> {
  if (!username || username === '[deleted]' || username === 'unknown') return null;
  if (!(await checkRateLimit(tenantId))) return null;

  const cacheKey = `tenant:${tenantId}:cache:reddit-author:${username}`;
  try {
    const cached = await redis.get(cacheKey);
    if (cached) return JSON.parse(cached) as AuthorProfile;
  } catch { /* continue */ }

  try {
    await sleep(REDDIT_API_DELAY_MS);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    // Fetch user about
    const aboutRes = await fetch(`https://www.reddit.com/user/${username}/about.json`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!aboutRes.ok) return null;
    const aboutData = await aboutRes.json() as RedditUserAbout;

    await sleep(REDDIT_API_DELAY_MS);

    // Fetch user posts
    const controller2 = new AbortController();
    const timeout2 = setTimeout(() => controller2.abort(), 10000);

    const postsRes = await fetch(`https://www.reddit.com/user/${username}/submitted.json?limit=25&sort=top&t=year`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller2.signal,
    });
    clearTimeout(timeout2);

    let topSubreddits: string[] = [];
    let detectedProfession: string | undefined;
    let detectedCompany: string | undefined;

    if (postsRes.ok) {
      const postsData = await postsRes.json() as RedditUserPosts;
      const posts = postsData.data?.children ?? [];

      // Count subreddit activity
      const subredditCounts = new Map<string, number>();
      for (const post of posts) {
        const sr = post.data.subreddit ?? 'unknown';
        subredditCounts.set(sr, (subredditCounts.get(sr) ?? 0) + 1);

        // Check flair for profession hints
        if (post.data.author_flair_text) {
          detectedProfession = post.data.author_flair_text;
        }
      }

      topSubreddits = Array.from(subredditCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([sr]) => sr);

      // Try to detect company from post content
      for (const post of posts.slice(0, 5)) {
        const text = `${post.data.title ?? ''} ${post.data.selftext ?? ''}`;
        const companyMatch = text.match(/(?:at|@|work(?:ing)? (?:for|at))\s+([A-Z][A-Za-z0-9.\s]{1,30})/);
        if (companyMatch) {
          detectedCompany = companyMatch[1]?.trim();
          break;
        }
      }
    }

    const accountCreated = aboutData.data?.created_utc;
    const accountAge = accountCreated
      ? `${Math.floor((Date.now() / 1000 - accountCreated) / (365.25 * 24 * 3600))} years`
      : undefined;

    const profile: AuthorProfile = {
      username,
      karma: aboutData.data?.total_karma ?? 0,
      accountAge,
      topSubreddits,
      detectedProfession,
      detectedCompany,
      isActive: topSubreddits.length > 0,
    };

    await redis.setex(cacheKey, CACHE_TTL_24H, JSON.stringify(profile)).catch(() => {});
    return profile;
  } catch (err) {
    logger.debug({ err, username }, 'Author profile research error');
    return null;
  }
}

// ── Comment mining ──────────────────────────────────────────────────────────

export async function fetchPostComments(
  permalink: string,
  tenantId: string,
): Promise<Array<{ author: string; body: string; score: number }>> {
  if (!(await checkRateLimit(tenantId))) return [];

  try {
    await sleep(REDDIT_API_DELAY_MS);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const url = `https://www.reddit.com${permalink}.json?limit=50`;
    const response = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return [];

    const data = await response.json() as Array<{
      data?: {
        children?: Array<{
          data?: { author?: string; body?: string; score?: number; replies?: unknown };
        }>;
      };
    }>;

    const comments: Array<{ author: string; body: string; score: number }> = [];

    function flattenComments(children: Array<{ data?: { author?: string; body?: string; score?: number; replies?: unknown } }>) {
      for (const child of children) {
        if (child.data?.author && child.data?.body) {
          comments.push({
            author: child.data.author,
            body: child.data.body,
            score: child.data.score ?? 0,
          });
        }
        // Flatten nested replies
        const replies = child.data?.replies as { data?: { children?: Array<{ data?: { author?: string; body?: string; score?: number; replies?: unknown } }> } } | undefined;
        if (replies?.data?.children) {
          flattenComments(replies.data.children);
        }
      }
    }

    if (data[1]?.data?.children) {
      flattenComments(data[1].data.children);
    }

    return comments;
  } catch (err) {
    logger.debug({ err, permalink }, 'Fetch post comments error');
    return [];
  }
}

// ── Public API: Company Discovery ───────────────────────────────────────────

export async function searchRedditIntelligence(
  params: DiscoveryParams,
  tenantId: string,
): Promise<RawCompanyResult[]> {
  const queryTerms: string[] = [];
  if (params.keywords?.length) queryTerms.push(...params.keywords.slice(0, 5));
  if (params.industry) queryTerms.push(params.industry);
  if (queryTerms.length === 0) return [];

  const useCase = params.useCase ?? 'sales';
  const config = SUBREDDIT_CONFIGS[useCase] ?? SUBREDDIT_CONFIGS.sales!;

  logger.info({ tenantId, queryTerms, useCase, subredditCount: config.subreddits.length }, 'Reddit intelligence starting company search');

  // Build queries
  const queries: string[] = [];
  for (const term of queryTerms) {
    queries.push(term);
    for (const keyword of config.keywords.slice(0, 3)) {
      queries.push(`${keyword} ${term}`);
    }
  }

  // Fire parallel searches: Reddit JSON API per subreddit + SearXNG
  const tasks: Array<Promise<RedditPost[]>> = [];

  // Reddit JSON API per subreddit for top queries
  for (const subreddit of config.subreddits.slice(0, 6)) {
    for (const query of queries.slice(0, 3)) {
      tasks.push(redditApiLimit(() => searchRedditJSON(query, tenantId, subreddit)));
    }
  }

  // SearXNG broader queries
  for (const query of queries.slice(0, 4)) {
    tasks.push(searxLimit(() => searchRedditViaSearXNG(query, tenantId)));
  }

  const settled = await Promise.allSettled(tasks);
  const allPosts: RedditPost[] = [];
  for (const result of settled) {
    if (result.status === 'fulfilled') {
      allPosts.push(...result.value);
    }
  }

  // Deduplicate by Reddit post ID
  const seen = new Set<string>();
  const uniquePosts: RedditPost[] = [];
  for (const post of allPosts) {
    if (!seen.has(post.id)) {
      seen.add(post.id);
      uniquePosts.push(post);
    }
  }

  // Score top 20 posts via LLM
  const postsToScore = uniquePosts.slice(0, 20);
  const analyses = await scorePostsIntent(postsToScore, useCase, tenantId);

  // Convert high-intent posts to RawCompanyResult
  const results: RawCompanyResult[] = [];

  for (const analysis of analyses) {
    if (analysis.intentScore < 50) continue;

    const post = postsToScore.find((p) => p.id === analysis.postId);
    if (!post) continue;

    const confidence = Math.min(analysis.intentScore * 0.8, 80);
    const name = analysis.extractedCompany || `Reddit Lead: ${post.title.slice(0, 60)}`;

    results.push({
      name,
      domain: analysis.extractedDomain,
      description: `${post.title}\n${(post.selftext ?? '').slice(0, 200)}`,
      source: 'reddit',
      confidence,
      rawData: {
        redditId: post.id,
        postUrl: `https://www.reddit.com${post.permalink}`,
        subreddit: post.subreddit,
        authorUsername: post.author,
        intentScore: analysis.intentScore,
        intentCategory: analysis.intentCategory,
        intentSignals: analysis.intentSignals,
        recommendedAction: analysis.recommendedAction,
        extractedBudget: analysis.extractedBudget,
        extractedTechnologies: analysis.extractedTechnologies,
        specificNeed: analysis.specificNeed,
        urgency: analysis.urgency,
        postScore: post.score,
        numComments: post.num_comments,
      },
    });
  }

  logger.info(
    { tenantId, totalPosts: allPosts.length, uniquePosts: uniquePosts.length, scored: postsToScore.length, results: results.length },
    'Reddit intelligence company search completed',
  );

  return results;
}

// ── Public API: People Discovery ────────────────────────────────────────────

export async function searchRedditIntelligencePeople(
  params: PeopleDiscoveryParams,
  tenantId: string,
): Promise<RawPersonResult[]> {
  if (!params.companyName) return [];

  const results: RawPersonResult[] = [];

  // Search Reddit for company mentions
  const posts = await redditApiLimit(() =>
    searchRedditJSON(params.companyName!, tenantId, undefined, 'relevance'),
  );

  // Research high-karma authors who mention the company
  const authorsSeen = new Set<string>();
  for (const post of posts.slice(0, 10)) {
    if (!post.author || post.author === '[deleted]' || authorsSeen.has(post.author)) continue;
    authorsSeen.add(post.author);

    if (post.score < 5) continue; // Skip low-engagement posts

    const profile = await redditApiLimit(() =>
      researchAuthorProfile(post.author, tenantId),
    );
    if (!profile || !profile.isActive) continue;

    results.push({
      fullName: profile.username,
      title: profile.detectedProfession ?? undefined,
      companyName: profile.detectedCompany ?? params.companyName,
      source: 'reddit',
      confidence: 40,
      rawData: {
        redditUsername: profile.username,
        karma: profile.karma,
        accountAge: profile.accountAge,
        topSubreddits: profile.topSubreddits,
        postTitle: post.title,
        postUrl: `https://www.reddit.com${post.permalink}`,
      },
    });
  }

  return results;
}
