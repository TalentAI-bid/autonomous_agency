import { eq, and, ilike } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { createRedisConnection, pubRedis } from '../queues/setup.js';
import { dispatchJob, type JobOptions } from '../services/queue.service.js';
import { withTenant } from '../config/database.js';
import { contacts, companies, agentTasks, agentActivityLog, masterAgents, agentMessages } from '../db/schema/index.js';
import type { Contact, NewContact, Company, NewCompany, AgentTask } from '../db/schema/index.js';
import type { AgentType } from '../queues/queues.js';
import { complete as togetherComplete, extractJSON as togetherExtractJSON, type ChatMessage } from '../tools/together-ai.tool.js';
import { complete as claudeComplete } from '../tools/claude.tool.js';
import { search as searxSearch, type SearchResult } from '../tools/searxng.tool.js';
import { scrape as crawlScrape } from '../tools/crawl4ai.tool.js';
import type { PipelineContext } from '../types/pipeline-context.js';
import logger from '../utils/logger.js';

/** Shared Redis connection for all agent instances (avoids per-instance connection leak) */
const sharedAgentRedis: Redis = createRedisConnection();
sharedAgentRedis.on('error', (err: Error) => {
  const code = (err as any).code;
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED') return;
  console.error('[Redis:agent] error:', err.message);
});

export abstract class BaseAgent {
  protected tenantId: string;
  protected masterAgentId: string;
  protected agentType: AgentType;
  protected redis: Redis;
  private _masterAgentIdValid: boolean | undefined;

  constructor(opts: { tenantId: string; masterAgentId: string; agentType: AgentType }) {
    this.tenantId = opts.tenantId;
    this.masterAgentId = opts.masterAgentId;
    this.agentType = opts.agentType;
    this.redis = sharedAgentRedis;
  }

  // ── LLM ──────────────────────────────────────────────────────────────────

  protected async callTogether(messages: ChatMessage[], opts?: { temperature?: number; max_tokens?: number; model?: string }): Promise<string> {
    return togetherComplete(this.tenantId, messages, opts);
  }

  protected async callClaude(system: string, user: string): Promise<string> {
    return claudeComplete(this.tenantId, system, user);
  }

  protected async extractJSON<T>(
    messages: ChatMessage[],
    retries?: number,
    opts?: { temperature?: number; model?: string },
  ): Promise<T> {
    return togetherExtractJSON<T>(this.tenantId, messages, retries, opts);
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
    data: Partial<NewContact> & { linkedinUrl?: string; id?: string },
  ): Promise<Contact> {
    return withTenant(this.tenantId, async (tx) => {
      // Update by ID if provided (e.g. document agent updating existing contact)
      if (data.id) {
        const { id, ...updateData } = data;
        const [updated] = await tx
          .update(contacts)
          .set({ ...updateData, updatedAt: new Date() })
          .where(and(eq(contacts.id, id), eq(contacts.tenantId, this.tenantId)))
          .returning();
        if (updated) return updated;
      }

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

      // Dedup by email — prevents duplicate contacts when LinkedIn URL is missing
      if (data.email) {
        const byEmail = await tx
          .select()
          .from(contacts)
          .where(and(eq(contacts.tenantId, this.tenantId), eq(contacts.email, data.email)))
          .limit(1);
        if (byEmail.length > 0) {
          const [updated] = await tx
            .update(contacts)
            .set({ ...data, updatedAt: new Date() })
            .where(eq(contacts.id, byEmail[0]!.id))
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

  protected async getValidMasterAgentId(): Promise<string | undefined> {
    if (!this.masterAgentId) return undefined;
    if (this._masterAgentIdValid === true) return this.masterAgentId;
    if (this._masterAgentIdValid === false) return undefined;

    try {
      const [row] = await withTenant(this.tenantId, async (tx) => {
        return tx.select({ id: masterAgents.id }).from(masterAgents)
          .where(and(eq(masterAgents.id, this.masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
          .limit(1);
      });
      this._masterAgentIdValid = !!row;
    } catch {
      this._masterAgentIdValid = false;
    }
    return this._masterAgentIdValid ? this.masterAgentId : undefined;
  }

  private isValidCompanyName(name: string): boolean {
    if (!name || name.length < 2 || name.length > 80) return false;
    if (name === 'Unknown') return false;
    // Reject question-like strings (StackOverflow titles, etc.)
    if (/\?\s*(\[.*\])?\s*$/.test(name)) return false;
    // Reject strings with too many special chars (URLs, code snippets)
    const specialRatio = (name.match(/[^a-zA-Z0-9\s.,&'"-]/g) || []).length / name.length;
    if (specialRatio > 0.3) return false;
    // Reject obvious non-company patterns
    if (/^(how|what|why|when|where|which|can|does|should|is)\s/i.test(name)) return false;
    // Reject article titles / news headlines containing ellipsis
    if (name.includes('…') || name.includes('...')) return false;
    // Reject sentence-like strings (> 8 words = not a company name)
    if (name.split(/\s+/).length > 8) return false;
    // Reject strings starting with a quote
    if (/^["'"']/.test(name)) return false;
    // Reject strings that look like headlines (contain common headline verbs)
    if (/\b(named|establishes|announces|launches|raises|hits|embracing|transforming|advancing)\b/i.test(name)) return false;
    // Reject single generic words (not a company name)
    if (name.split(/\s+/).length === 1 && /^[a-z]/i.test(name) && name.length < 15) {
      const genericWords = new Set(['leadership', 'management', 'technology', 'solutions', 'services', 'software', 'design', 'marketing', 'consulting', 'analytics', 'resources', 'development', 'engineering', 'security', 'compliance', 'performance', 'innovation', 'integration', 'automation', 'intelligence', 'payments', 'careers', 'jobs', 'hiring', 'team', 'people', 'about', 'blog', 'news', 'home']);
      if (genericWords.has(name.toLowerCase())) return false;
    }
    // Reject article-like prefixes
    if (/^(meet\s+(the|our)|top\s+\d+|best\s+\d+|the\s+top|a\s+guide|how\s+to|list\s+of|review\s+of|guide\s+to)\s/i.test(name)) return false;
    // Reject "X for Y" patterns (product descriptions, not company names)
    if (/^\w+\s+for\s+\w+/i.test(name) && name.split(/\s+/).length >= 4) return false;
    // Reject strings starting with common article words
    if (/^(stealth|new|breaking|exclusive|updated|introducing)\s/i.test(name) && name.split(/\s+/).length >= 3) return false;
    return true;
  }

  protected async saveOrUpdateCompany(
    data: Partial<NewCompany> & { name: string; domain?: string; id?: string },
  ): Promise<Company> {
    // Type guard: LLM sometimes returns nested object for name
    if (typeof data.name === 'object' && data.name !== null) {
      data.name = (data.name as any).name || JSON.stringify(data.name);
    }
    data.name = String(data.name).trim();

    // Reject garbage company names
    if (!this.isValidCompanyName(data.name)) {
      throw new Error(`Invalid company name rejected: "${data.name.slice(0, 80)}"`);
    }
    const validMasterAgentId = await this.getValidMasterAgentId();
    return withTenant(this.tenantId, async (tx) => {
      // ID-pinned update: caller knows the exact row to update (preserves
      // discovery signals that would otherwise be lost on name-mismatch).
      if (data.id) {
        const { id, ...updateData } = data;
        const existing = await tx
          .select()
          .from(companies)
          .where(and(eq(companies.id, id), eq(companies.tenantId, this.tenantId)))
          .limit(1);
        if (existing.length > 0) {
          const [updated] = await tx
            .update(companies)
            .set({
              ...updateData,
              masterAgentId: validMasterAgentId,
              rawData: {
                ...(existing[0]!.rawData as Record<string, unknown> ?? {}),
                ...(updateData.rawData as Record<string, unknown> ?? {}),
              },
              updatedAt: new Date(),
            })
            .where(eq(companies.id, existing[0]!.id))
            .returning();
          return updated!;
        }
        // ID provided but row not found — fall through to fuzzy match
      }

      // Try to find by domain first (most reliable match)
      if (data.domain) {
        const existing = await tx
          .select()
          .from(companies)
          .where(
            and(
              eq(companies.tenantId, this.tenantId),
              ilike(companies.domain, data.domain),
            ),
          )
          .limit(1);

        if (existing.length > 0) {
          const [updated] = await tx
            .update(companies)
            .set({
              ...data,
              masterAgentId: validMasterAgentId,
              rawData: {
                ...(existing[0]!.rawData as Record<string, unknown> ?? {}),
                ...(data.rawData as Record<string, unknown> ?? {}),
              },
              updatedAt: new Date(),
            })
            .where(eq(companies.id, existing[0]!.id))
            .returning();
          return updated!;
        }
      }

      // Try to find by name (case-insensitive)
      const byName = await tx
        .select()
        .from(companies)
        .where(
          and(
            eq(companies.tenantId, this.tenantId),
            ilike(companies.name, data.name),
          ),
        )
        .limit(1);

      if (byName.length > 0) {
        const [updated] = await tx
          .update(companies)
          .set({
            ...data,
            masterAgentId: validMasterAgentId,
            rawData: {
              ...(byName[0]!.rawData as Record<string, unknown> ?? {}),
              ...(data.rawData as Record<string, unknown> ?? {}),
            },
            updatedAt: new Date(),
          })
          .where(eq(companies.id, byName[0]!.id))
          .returning();
        return updated!;
      }

      // Create new company
      const [created] = await tx
        .insert(companies)
        .values({
          tenantId: this.tenantId,
          masterAgentId: validMasterAgentId,
          ...data,
          rawData: {
            ...(data.rawData as Record<string, unknown> ?? {}),
          },
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

  // ── Agent Messaging ─────────────────────────────────────────────────────

  protected sendMessage(
    toAgent: string | null,
    messageType: string,
    content: Record<string, unknown>,
    metadata?: Record<string, unknown>,
  ): void {
    // Fire-and-forget — never blocks the agent
    withTenant(this.tenantId, async (tx) => {
      const [msg] = await tx.insert(agentMessages).values({
        tenantId: this.tenantId,
        masterAgentId: this.masterAgentId || undefined,
        fromAgent: this.agentType,
        toAgent: toAgent ?? undefined,
        messageType,
        content,
        metadata,
      }).returning();
      return msg;
    }).then((msg) => {
      this.emitEvent('agent:message', {
        id: msg?.id,
        masterAgentId: this.masterAgentId,
        fromAgent: this.agentType,
        toAgent: toAgent ?? undefined,
        messageType,
        content,
        metadata,
      }).catch(() => {});
    }).catch((err) => {
      logger.debug({ err, messageType }, 'Failed to save agent message (non-blocking)');
    });
  }

  protected async checkHumanInstructions(): Promise<string | null> {
    try {
      const key = `tenant:${this.tenantId}:human-instruction:${this.masterAgentId}:${this.agentType}`;
      const instruction = await this.redis.get(key);
      if (instruction) {
        await this.redis.del(key);
        this.sendMessage(null, 'agent_response', {
          respondingTo: 'human_instruction',
          instruction,
          action: 'acknowledged',
        });
      }
      return instruction;
    } catch (err) {
      logger.debug({ err }, 'Failed to check human instructions (non-blocking)');
      return null;
    }
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

  // ── PipelineContext ──────────────────────────────────────────────────────

  protected getPipelineContext(input: Record<string, unknown>): PipelineContext | undefined {
    return input.pipelineContext as PipelineContext | undefined;
  }

  // ── Activity Logging ─────────────────────────────────────────────────────

  protected logActivity(
    action: string,
    status: 'started' | 'completed' | 'failed' | 'skipped',
    options?: { inputSummary?: string; outputSummary?: string; details?: Record<string, unknown>; durationMs?: number; error?: string },
  ): void {
    // Fire-and-forget — never blocks the agent
    withTenant(this.tenantId, async (tx) => {
      await tx.insert(agentActivityLog).values({
        tenantId: this.tenantId,
        masterAgentId: this.masterAgentId || undefined,
        agentType: this.agentType,
        action,
        status,
        inputSummary: options?.inputSummary ?? undefined,
        outputSummary: options?.outputSummary ?? undefined,
        details: options?.details ?? undefined,
        durationMs: options?.durationMs ?? undefined,
        error: options?.error ?? undefined,
      });
    }).then(() => {
      this.emitEvent('agent:activity', {
        agentType: this.agentType,
        action,
        status,
        masterAgentId: this.masterAgentId,
        ...(options?.durationMs != null ? { durationMs: options.durationMs } : {}),
        ...(options?.error ? { error: options.error } : {}),
      }).catch(() => {});
    }).catch((err) => {
      logger.debug({ err, action, status }, 'Failed to log activity (non-blocking)');
    });
  }

  protected async trackAction<T>(
    action: string,
    inputSummary: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const start = Date.now();
    this.logActivity(action, 'started', { inputSummary });
    try {
      const result = await fn();
      const durationMs = Date.now() - start;
      const outputSummary = typeof result === 'object' && result !== null
        ? JSON.stringify(result).slice(0, 200)
        : String(result).slice(0, 200);
      this.logActivity(action, 'completed', { inputSummary, outputSummary, durationMs });
      return result;
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logActivity(action, 'failed', { inputSummary, durationMs, error: errorMsg });
      throw err;
    }
  }

  protected async setCurrentAction(action: string, description?: string): Promise<void> {
    try {
      const key = `agent-status:${this.masterAgentId}:${this.agentType}`;
      const value = JSON.stringify({
        action,
        description,
        startedAt: new Date().toISOString(),
        masterAgentId: this.masterAgentId,
      });
      await this.redis.setex(key, 300, value);
      await this.emitEvent('agent:status_change', {
        agentType: this.agentType,
        masterAgentId: this.masterAgentId,
        action,
        description,
        status: 'active',
      });
    } catch (err) {
      logger.debug({ err }, 'Failed to set current action (non-blocking)');
    }
  }

  protected async clearCurrentAction(): Promise<void> {
    try {
      const key = `agent-status:${this.masterAgentId}:${this.agentType}`;
      await this.redis.del(key);
      await this.emitEvent('agent:status_change', {
        agentType: this.agentType,
        masterAgentId: this.masterAgentId,
        status: 'idle',
      });
    } catch (err) {
      logger.debug({ err }, 'Failed to clear current action (non-blocking)');
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async close(): Promise<void> {
    // No-op: Redis connection is shared across all agent instances
  }

  abstract execute(input: Record<string, unknown>): Promise<Record<string, unknown>>;
}
