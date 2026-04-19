import { eq, and, max } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { conversations, conversationMessages, tenants } from '../db/schema/index.js';
import { complete, completeStream } from '../tools/together-ai.tool.js';
import { scrape } from '../tools/crawl4ai.tool.js';
import { buildCopilotSystemPrompt } from '../prompts/copilot.prompt.js';
import { updateTenant } from './tenant.service.js';
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors.js';
import type { ChatMessage } from '../tools/together-ai.tool.js';
import { db } from '../config/database.js';
import logger from '../utils/logger.js';

// ── URL Detection ────────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s<>"']+/gi;

function extractUrls(text: string): string[] {
  return (text.match(URL_REGEX) ?? []).filter((url) => {
    try { new URL(url); return true; } catch { return false; }
  });
}

// ── Create Session ───────────────────────────────────────────────────────────

export async function createCopilotSession(tenantId: string, userId: string) {
  // Load existing company profile for context
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const settings = (tenant?.settings as Record<string, unknown>) ?? {};
  const existingProfile = settings.companyProfile as Record<string, unknown> | undefined;

  const [conversation] = await withTenant(tenantId, async (tx) => {
    return tx.insert(conversations).values({
      tenantId,
      userId,
      status: 'active',
      extractedConfig: { type: 'copilot' },
    }).returning();
  });

  // Generate greeting
  const systemPrompt = buildCopilotSystemPrompt(existingProfile);
  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Start the conversation' },
  ];

  const greeting = await complete(tenantId, llmMessages);

  const [greetingMsg] = await withTenant(tenantId, async (tx) => {
    return tx.insert(conversationMessages).values({
      conversationId: conversation.id,
      role: 'assistant',
      type: 'text',
      content: greeting,
      orderIndex: 0,
    }).returning();
  });

  return { conversation, messages: [greetingMsg] };
}

// ── Send Message (Streaming) ─────────────────────────────────────────────────

export async function* sendCopilotMessageStream(
  tenantId: string,
  conversationId: string,
  content: string,
): AsyncGenerator<string, void, unknown> {
  // Verify conversation
  const [conversation] = await withTenant(tenantId, async (tx) => {
    return tx.select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
      .limit(1);
  });
  if (!conversation) throw new NotFoundError('Session', conversationId);
  if (conversation.status !== 'active') throw new ValidationError('Session is not active');

  // Get max orderIndex
  const [maxResult] = await withTenant(tenantId, async (tx) => {
    return tx.select({ maxOrder: max(conversationMessages.orderIndex) })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId));
  });
  const maxOrder = maxResult?.maxOrder ?? -1;

  // Save user message
  await withTenant(tenantId, async (tx) => {
    return tx.insert(conversationMessages).values({
      conversationId,
      role: 'user',
      type: 'text',
      content,
      orderIndex: maxOrder + 1,
    }).returning();
  });

  // Detect URLs and crawl them
  const urls = extractUrls(content);
  let crawledContent = '';
  if (urls.length > 0) {
    yield `event: status\ndata: ${JSON.stringify({ text: 'Analyzing website...' })}\n\n`;
    for (const url of urls.slice(0, 2)) {
      try {
        const result = await scrape(tenantId, url);
        if (result) {
          crawledContent += `\n\n--- Website Content from ${url} ---\n${result.slice(0, 12000)}`;
        }
      } catch (err) {
        logger.warn({ err, url }, 'Copilot: failed to crawl URL');
      }
    }
  }

  // Load all messages
  const allMessages = await withTenant(tenantId, async (tx) => {
    return tx.select().from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(conversationMessages.orderIndex);
  });

  // Load existing profile for context
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const settings = (tenant?.settings as Record<string, unknown>) ?? {};
  const existingProfile = settings.companyProfile as Record<string, unknown> | undefined;

  // Build LLM messages
  const systemPrompt = buildCopilotSystemPrompt(existingProfile);
  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  // Add crawled content as context with generation instruction
  if (crawledContent) {
    llmMessages.push({
      role: 'system',
      content: `## Website Content (auto-crawled)\n${crawledContent}\n\n## INSTRUCTION\nYou now have the website content. Analyze it thoroughly and IMMEDIATELY generate a complete <company_profile> JSON in your response. Do NOT ask follow-up questions first. Use your sales expertise to infer everything you need from this content. Present your expert analysis and the complete profile.`,
    });
  }

  // Add previous crawled content from earlier messages
  for (const msg of allMessages) {
    const meta = msg.metadata as Record<string, unknown> | null;
    if (meta?.crawledContent) {
      llmMessages.push({
        role: 'system',
        content: `## Previously Crawled Content\n${(meta.crawledContent as string).slice(0, 8000)}`,
      });
    }
  }

  // Add conversation history
  for (const msg of allMessages) {
    if (msg.role === 'system') continue;
    llmMessages.push({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    });
  }

  // Turn-count safeguard: after 2+ user messages without a profile, force generation
  const userMessageCount = llmMessages.filter(m => m.role === 'user').length;
  const hasProfileAlready = allMessages.some(m => {
    const meta = m.metadata as Record<string, unknown> | null;
    return meta?.hasProfile === true;
  });
  if (userMessageCount >= 2 && !hasProfileAlready) {
    llmMessages.push({
      role: 'system',
      content: 'You have enough information now. You MUST output a <company_profile> JSON block in your response. Use your sales expertise to infer any missing fields — do NOT ask more questions. Present your expert analysis and the complete profile.',
    });
  }

  // Stream LLM response
  let fullResponse = '';
  const stream = completeStream(tenantId, llmMessages, { max_tokens: 8192 });
  for await (const chunk of stream) {
    fullResponse += chunk;
    yield `event: token\ndata: ${JSON.stringify({ text: chunk })}\n\n`;
  }

  // Parse company profile from response
  const profileMatch = fullResponse.match(/<company_profile>\s*([\s\S]*?)\s*<\/company_profile>/);
  let profileData: Record<string, unknown> | undefined;

  if (profileMatch) {
    try {
      const cleaned = profileMatch[1]!.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      profileData = JSON.parse(cleaned);
    } catch (err) {
      logger.warn({ err }, 'Failed to parse company profile JSON from copilot response');
    }
  }

  // Save assistant message
  const msgMetadata: Record<string, unknown> = {};
  if (crawledContent) msgMetadata.crawledContent = crawledContent;
  if (profileData) msgMetadata.hasProfile = true;

  const [assistantMsg] = await withTenant(tenantId, async (tx) => {
    return tx.insert(conversationMessages).values({
      conversationId,
      role: 'assistant',
      type: profileData ? 'pipeline_proposal' : 'text', // reuse pipeline_proposal type for profile proposals
      content: fullResponse,
      proposalData: profileData,
      metadata: Object.keys(msgMetadata).length > 0 ? msgMetadata : undefined,
      orderIndex: maxOrder + 2,
    }).returning();
  });

  // Update extractedConfig if profile found
  if (profileData) {
    await withTenant(tenantId, async (tx) => {
      return tx.update(conversations)
        .set({ extractedConfig: { type: 'copilot', profile: profileData }, updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
    });
  }

  yield `event: done\ndata: ${JSON.stringify({ message: assistantMsg, profileData: profileData ?? null })}\n\n`;
}

// ── Approve Profile ──────────────────────────────────────────────────────────

export async function approveCopilotProfile(tenantId: string, conversationId: string) {
  const [conversation] = await withTenant(tenantId, async (tx) => {
    return tx.select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
      .limit(1);
  });
  if (!conversation) throw new NotFoundError('Session', conversationId);
  if (conversation.status === 'completed') {
    throw new ConflictError('This session has already been completed.');
  }

  const config = conversation.extractedConfig as Record<string, unknown> | null;
  const profileData = config?.profile as Record<string, unknown> | undefined;
  if (!profileData) throw new ValidationError('No company profile has been generated yet');

  // Load current tenant settings and merge
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const currentSettings = (tenant?.settings as Record<string, unknown>) ?? {};

  await updateTenant(tenantId, {
    settings: { ...currentSettings, companyProfile: profileData },
  });

  // Mark conversation as completed
  await withTenant(tenantId, async (tx) => {
    return tx.update(conversations)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(eq(conversations.id, conversationId));
  });

  // Save approval message
  const [maxResult] = await withTenant(tenantId, async (tx) => {
    return tx.select({ maxOrder: max(conversationMessages.orderIndex) })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId));
  });

  await withTenant(tenantId, async (tx) => {
    return tx.insert(conversationMessages).values({
      conversationId,
      role: 'assistant',
      type: 'pipeline_approved',
      content: 'Company profile has been saved!',
      orderIndex: (maxResult?.maxOrder ?? 0) + 1,
    });
  });

  return { profile: profileData };
}
