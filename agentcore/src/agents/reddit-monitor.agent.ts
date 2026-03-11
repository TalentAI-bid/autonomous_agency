import { eq, and } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { masterAgents, agentConfigs, redditOpportunities } from '../db/schema/index.js';
import type { NewRedditOpportunity } from '../db/schema/index.js';
import {
  searchRedditJSON,
  scorePostsIntent,
  researchAuthorProfile,
} from '../tools/discovery-sources/reddit-intelligence.js';
import logger from '../utils/logger.js';

export class RedditMonitorAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { masterAgentId, tenantId } = input as {
      masterAgentId?: string;
      tenantId: string;
    };

    const agentId = masterAgentId ?? this.masterAgentId;
    logger.info({ tenantId: this.tenantId, agentId }, 'RedditMonitorAgent starting');
    await this.setCurrentAction('reddit_monitoring', 'Scanning Reddit for opportunities');

    // Load master agent config for subreddits/keywords/useCase
    let useCase = 'sales';
    let keywords: string[] = [];
    let subreddits: string[] = [];

    if (agentId) {
      try {
        const [agent] = await withTenant(this.tenantId, async (tx) => {
          return tx.select({
            useCase: masterAgents.useCase,
            config: masterAgents.config,
          }).from(masterAgents)
            .where(and(eq(masterAgents.id, agentId), eq(masterAgents.tenantId, this.tenantId)))
            .limit(1);
        });

        if (agent) {
          useCase = agent.useCase ?? 'sales';
          const config = agent.config as Record<string, unknown> | null;
          if (config?.redditKeywords && Array.isArray(config.redditKeywords)) {
            keywords = config.redditKeywords as string[];
          }
          if (config?.redditSubreddits && Array.isArray(config.redditSubreddits)) {
            subreddits = config.redditSubreddits as string[];
          }
          // Also pull keywords from discovery params
          if (!keywords.length && config?.discoveryParams) {
            const dp = config.discoveryParams as Record<string, unknown>;
            if (dp.keywords && Array.isArray(dp.keywords)) {
              keywords = dp.keywords as string[];
            }
          }
        }
      } catch (err) {
        logger.warn({ err, agentId }, 'Failed to load master agent config for reddit monitor');
      }
    }

    // Default subreddits if none configured
    if (!subreddits.length) {
      subreddits = useCase === 'recruitment'
        ? ['cscareerquestions', 'experienceddevs', 'forhire', 'hiring', 'webdev']
        : ['SaaS', 'startups', 'Entrepreneur', 'smallbusiness', 'forhire', 'hiring'];
    }

    // Default keywords
    if (!keywords.length) {
      keywords = useCase === 'recruitment'
        ? ['hiring developer', 'looking for engineer', 'need a contractor']
        : ['looking for', 'recommend', 'need help with', 'alternative to'];
    }

    // Get last checked timestamp from Redis
    const lastCheckedKey = `tenant:${this.tenantId}:reddit-monitor:lastChecked:${agentId ?? 'default'}`;
    let lastCheckedUtc = 0;
    try {
      const stored = await this.redis.get(lastCheckedKey);
      if (stored) lastCheckedUtc = parseInt(stored, 10);
    } catch { /* continue */ }

    let totalNewPosts = 0;
    let totalScored = 0;
    let totalOpportunities = 0;
    let totalHighIntent = 0;
    let totalContactsCreated = 0;

    for (const subreddit of subreddits) {
      for (const keyword of keywords.slice(0, 3)) {
        try {
          // Fetch new posts sorted by new
          const posts = await searchRedditJSON(keyword, this.tenantId, subreddit, 'new');

          // Filter to posts after lastCheckedUtc
          const newPosts = lastCheckedUtc > 0
            ? posts.filter((p) => p.created_utc > lastCheckedUtc)
            : posts;

          if (newPosts.length === 0) continue;
          totalNewPosts += newPosts.length;

          // Check each post against reddit_opportunities unique index — skip if exists
          const postsToProcess = [];
          for (const post of newPosts) {
            try {
              const existing = await withTenant(this.tenantId, async (tx) => {
                return tx.select({ id: redditOpportunities.id })
                  .from(redditOpportunities)
                  .where(
                    and(
                      eq(redditOpportunities.tenantId, this.tenantId),
                      eq(redditOpportunities.redditPostId, post.id),
                    ),
                  )
                  .limit(1);
              });
              if (existing.length === 0) {
                postsToProcess.push(post);
              }
            } catch { /* continue */ }
          }

          if (postsToProcess.length === 0) continue;

          // Score new posts via LLM intent analysis
          const analyses = await scorePostsIntent(postsToProcess, useCase, this.tenantId);
          totalScored += analyses.length;

          // Insert opportunities with intentScore >= 30
          for (const analysis of analyses) {
            if (analysis.intentScore < 30) continue;

            const post = postsToProcess.find((p) => p.id === analysis.postId);
            if (!post) continue;

            try {
              const opportunityData: NewRedditOpportunity = {
                tenantId: this.tenantId,
                masterAgentId: agentId || undefined,
                redditPostId: post.id,
                subreddit: post.subreddit,
                postTitle: post.title,
                postUrl: `https://www.reddit.com${post.permalink}`,
                authorUsername: post.author,
                buyingIntentScore: analysis.intentScore,
                opportunityType: analysis.intentCategory,
                recommendedAction: analysis.recommendedAction,
                extractedData: {
                  company_name: analysis.extractedCompany,
                  domain: analysis.extractedDomain,
                  person_name: analysis.extractedPerson,
                  budget: analysis.extractedBudget,
                  urgency: analysis.urgency,
                  technologies: analysis.extractedTechnologies,
                  specific_need: analysis.specificNeed,
                  intent_signals: analysis.intentSignals,
                },
                status: 'new',
              };

              await withTenant(this.tenantId, async (tx) => {
                await tx.insert(redditOpportunities)
                  .values(opportunityData)
                  .onConflictDoNothing();
              });
              totalOpportunities++;

              // For high-intent (>= 70): research author, create contact, dispatch enrichment
              if (analysis.intentScore >= 70 && post.author && post.author !== '[deleted]') {
                totalHighIntent++;

                const authorProfile = await researchAuthorProfile(post.author, this.tenantId);

                // Update opportunity with author profile
                if (authorProfile) {
                  await withTenant(this.tenantId, async (tx) => {
                    await tx.update(redditOpportunities)
                      .set({
                        authorProfileData: authorProfile as unknown as Record<string, unknown>,
                        status: 'processing',
                        updatedAt: new Date(),
                      })
                      .where(
                        and(
                          eq(redditOpportunities.tenantId, this.tenantId),
                          eq(redditOpportunities.redditPostId, post.id),
                        ),
                      );
                  });
                }

                // Create contact
                const contactName = analysis.extractedPerson ?? post.author;
                const nameParts = contactName.split(/\s+/);
                const firstName = nameParts[0] || post.author;
                const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;

                try {
                  const contact = await this.saveOrUpdateContact({
                    firstName,
                    lastName,
                    companyName: analysis.extractedCompany ?? authorProfile?.detectedCompany ?? undefined,
                    title: authorProfile?.detectedProfession ?? undefined,
                    source: 'reddit',
                    status: 'discovered',
                    rawData: {
                      redditUsername: post.author,
                      redditPostUrl: `https://www.reddit.com${post.permalink}`,
                      intentScore: analysis.intentScore,
                      intentCategory: analysis.intentCategory,
                      specificNeed: analysis.specificNeed,
                      subreddit: post.subreddit,
                      authorProfile: authorProfile ?? undefined,
                    },
                  });

                  // Update opportunity with contact ID
                  await withTenant(this.tenantId, async (tx) => {
                    await tx.update(redditOpportunities)
                      .set({ contactId: contact.id, updatedAt: new Date() })
                      .where(
                        and(
                          eq(redditOpportunities.tenantId, this.tenantId),
                          eq(redditOpportunities.redditPostId, post.id),
                        ),
                      );
                  });

                  // Dispatch to enrichment
                  await this.dispatchNext('enrichment', {
                    contactId: contact.id,
                    masterAgentId: agentId,
                  });

                  totalContactsCreated++;
                } catch (err) {
                  logger.warn({ err, author: post.author }, 'Failed to create contact from Reddit post');
                }
              }
            } catch (err) {
              logger.warn({ err, postId: post.id }, 'Failed to insert Reddit opportunity');
            }
          }
        } catch (err) {
          logger.warn({ err, subreddit, keyword }, 'Reddit monitor failed for subreddit/keyword');
        }
      }
    }

    // Update lastCheckedUtc in Redis
    const now = Math.floor(Date.now() / 1000);
    await this.redis.set(lastCheckedKey, now.toString()).catch(() => {});

    const stats = {
      totalNewPosts,
      totalScored,
      totalOpportunities,
      totalHighIntent,
      totalContactsCreated,
      subredditsMonitored: subreddits.length,
      keywordsUsed: keywords.length,
    };

    this.logActivity('reddit_scan_completed', 'completed', { details: stats });
    await this.clearCurrentAction();

    logger.info({ tenantId: this.tenantId, agentId, ...stats }, 'RedditMonitorAgent completed');

    await this.emitEvent('reddit-monitor:completed', stats);

    return stats;
  }
}
