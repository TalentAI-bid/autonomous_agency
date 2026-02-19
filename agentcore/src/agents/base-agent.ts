import { eq, and } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createRedisConnection, pubRedis } from '../queues/setup.js';
import { dispatchJob, type JobOptions } from '../services/queue.service.js';
import { withTenant } from '../config/database.js';
import { contacts, agentTasks } from '../db/schema/index.js';
import type { Contact, NewContact, AgentTask } from '../db/schema/index.js';
import type { AgentType } from '../queues/queues.js';
import { complete as togetherComplete, extractJSON as togetherExtractJSON, type ChatMessage } from '../tools/together-ai.tool.js';
import { complete as claudeComplete } from '../tools/claude.tool.js';
import { search as searxSearch, type SearchResult } from '../tools/searxng.tool.js';
import { scrape as crawlScrape } from '../tools/crawl4ai.tool.js';
import logger from '../utils/logger.js';

export abstract class BaseAgent {
  protected tenantId: string;
  protected masterAgentId: string;
  protected agentType: AgentType;
  protected redis: Redis;

  constructor(opts: { tenantId: string; masterAgentId: string; agentType: AgentType }) {
    this.tenantId = opts.tenantId;
    this.masterAgentId = opts.masterAgentId;
    this.agentType = opts.agentType;
    this.redis = createRedisConnection();
  }

  // ── LLM ──────────────────────────────────────────────────────────────────

  protected async callTogether(messages: ChatMessage[]): Promise<string> {
    return togetherComplete(this.tenantId, messages);
  }

  protected async callClaude(system: string, user: string): Promise<string> {
    return claudeComplete(this.tenantId, system, user);
  }

  protected async extractJSON<T>(messages: ChatMessage[], retries?: number): Promise<T> {
    return togetherExtractJSON<T>(this.tenantId, messages, retries);
  }

  // ── Web ───────────────────────────────────────────────────────────────────

  protected async searchWeb(query: string, maxResults?: number): Promise<SearchResult[]> {
    return searxSearch(this.tenantId, query, maxResults);
  }

  protected async scrapeUrl(url: string, instruction?: string): Promise<string> {
    return crawlScrape(this.tenantId, url, instruction);
  }

  // ── DB helpers ────────────────────────────────────────────────────────────

  protected async saveOrUpdateContact(
    data: Partial<NewContact> & { linkedinUrl?: string },
  ): Promise<Contact> {
    return withTenant(this.tenantId, async (tx) => {
      if (data.linkedinUrl) {
        const existing = await tx
          .select()
          .from(contacts)
          .where(
            and(
              eq(contacts.tenantId, this.tenantId),
              eq(contacts.linkedinUrl, data.linkedinUrl),
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          const [updated] = await tx
            .update(contacts)
            .set({ ...data, updatedAt: new Date() })
            .where(eq(contacts.id, existing[0]!.id))
            .returning();
          return updated!;
        }
      }

      const [created] = await tx
        .insert(contacts)
        .values({
          tenantId: this.tenantId,
          masterAgentId: this.masterAgentId,
          status: 'discovered',
          ...data,
        })
        .returning();
      return created!;
    });
  }

  protected async updateTask(
    taskId: string,
    status: AgentTask['status'],
    output?: Record<string, unknown>,
    error?: string,
  ): Promise<void> {
    await withTenant(this.tenantId, async (tx) => {
      await tx
        .update(agentTasks)
        .set({
          status,
          output: output ?? undefined,
          error: error ?? undefined,
          completedAt: status === 'completed' || status === 'failed' ? new Date() : undefined,
        })
        .where(and(eq(agentTasks.id, taskId), eq(agentTasks.tenantId, this.tenantId)));
    });
  }

  // ── Events ────────────────────────────────────────────────────────────────

  protected async emitEvent(event: string, data: Record<string, unknown>): Promise<void> {
    try {
      await pubRedis.publish(
        `agent-events:${this.tenantId}`,
        JSON.stringify({ event, data, agentType: this.agentType, timestamp: new Date().toISOString() }),
      );
    } catch (err) {
      logger.error({ err, event, tenantId: this.tenantId }, 'Failed to emit event');
    }
  }

  // ── Memory (Redis) ────────────────────────────────────────────────────────

  protected async getMemory(key: string): Promise<unknown> {
    const raw = await this.redis.get(`tenant:${this.tenantId}:memory:${key}`);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  protected async setMemory(key: string, value: unknown, ttlSeconds = 86400): Promise<void> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    await this.redis.setex(`tenant:${this.tenantId}:memory:${key}`, ttlSeconds, serialized);
  }

  // ── Queue dispatch ────────────────────────────────────────────────────────

  protected async dispatchNext(
    type: AgentType,
    data: Record<string, unknown>,
    opts?: JobOptions,
  ): Promise<string> {
    return dispatchJob(this.tenantId, type, { ...data, masterAgentId: this.masterAgentId }, opts);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    await this.redis.quit();
  }

  abstract execute(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}
