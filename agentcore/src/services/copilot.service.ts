import { eq, and, max } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { conversations, conversationMessages, tenants, products } from '../db/schema/index.js';
import { complete, completeStream } from '../tools/together-ai.tool.js';
import { scrape } from '../tools/crawl4ai.tool.js';
import { buildCopilotSystemPrompt, buildProductSuggestPrompt } from '../prompts/copilot.prompt.js';
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

  // Parse products from response
  const productsMatch = fullResponse.match(/<products>\s*([\s\S]*?)\s*<\/products>/);
  let productsData: Array<Record<string, unknown>> | undefined;

  if (productsMatch) {
    try {
      const cleaned = productsMatch[1]!.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      productsData = JSON.parse(cleaned);
    } catch (err) {
      logger.warn({ err }, 'Failed to parse products JSON from copilot response');
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

  // Update extractedConfig — merge with existing to preserve products across refinements
  if (profileData || productsData) {
    const existingConfig = (conversation.extractedConfig as Record<string, unknown>) ?? {};
    const configUpdate: Record<string, unknown> = { ...existingConfig, type: 'copilot' };
    if (profileData) configUpdate.profile = profileData;
    if (productsData) configUpdate.products = productsData;
    await withTenant(tenantId, async (tx) => {
      return tx.update(conversations)
        .set({ extractedConfig: configUpdate, updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
    });
  }

  yield `event: done\ndata: ${JSON.stringify({ message: assistantMsg, profileData: profileData ?? null, productsData: productsData ?? null })}\n\n`;
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

  // Create products from extracted data
  const extractedProducts = config?.products as Array<Record<string, unknown>> | undefined;
  let createdProducts = 0;
  if (extractedProducts?.length) {
    // Get existing products to avoid duplicates
    const existingProducts = await withTenant(tenantId, async (tx) => {
      return tx.select({ name: products.name }).from(products)
        .where(eq(products.tenantId, tenantId));
    });
    const existingNames = new Set(existingProducts.map(p => p.name.toLowerCase()));

    const validPricingModels = ['subscription', 'per_seat', 'one_time', 'usage_based', 'freemium', 'custom'];

    for (const product of extractedProducts) {
      const name = product.name as string;
      if (!name || existingNames.has(name.toLowerCase())) continue;

      const pricingModel = validPricingModels.includes(product.pricingModel as string)
        ? product.pricingModel as string
        : null;

      await withTenant(tenantId, async (tx) => {
        return tx.insert(products).values({
          tenantId,
          name,
          description: (product.description as string) ?? null,
          category: (product.category as string) ?? null,
          targetAudience: (product.targetAudience as string) ?? null,
          painPointsSolved: (product.painPointsSolved as string[]) ?? null,
          keyFeatures: (product.keyFeatures as string[]) ?? null,
          differentiators: (product.differentiators as string[]) ?? null,
          pricingModel,
        });
      });
      createdProducts++;
      existingNames.add(name.toLowerCase());
    }
  }

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

  const approvalContent = createdProducts > 0
    ? `Company profile saved and ${createdProducts} product(s) created!`
    : 'Company profile has been saved!';

  await withTenant(tenantId, async (tx) => {
    return tx.insert(conversationMessages).values({
      conversationId,
      role: 'assistant',
      type: 'pipeline_approved',
      content: approvalContent,
      orderIndex: (maxResult?.maxOrder ?? 0) + 1,
    });
  });

  return { profile: profileData, productsCreated: createdProducts };
}

// ── Suggest Product ─────────────────────────────────────────────────────────

interface ProductSuggestion {
  description: string;
  category: string;
  targetAudience: string;
  painPointsSolved: string[];
  keyFeatures: string[];
  differentiators: string[];
  pricingModel: string | null;
  pricingDetails: string;
}

export async function suggestProduct(tenantId: string, productName: string): Promise<ProductSuggestion> {
  // Load company profile for context
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const settings = (tenant?.settings as Record<string, unknown>) ?? {};
  const companyProfile = settings.companyProfile as Record<string, unknown> | undefined;

  const prompt = buildProductSuggestPrompt(productName, companyProfile);
  const llmMessages: ChatMessage[] = [
    { role: 'system', content: prompt },
    { role: 'user', content: `Generate complete product details for: "${productName}"` },
  ];

  const response = await complete(tenantId, llmMessages);

  // Extract JSON from response
  const jsonMatch = response.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new ValidationError('Failed to generate product suggestion');
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as ProductSuggestion;
    // Validate pricingModel
    const validModels = ['subscription', 'per_seat', 'one_time', 'usage_based', 'freemium', 'custom'];
    if (parsed.pricingModel && !validModels.includes(parsed.pricingModel)) {
      parsed.pricingModel = null;
    }
    return parsed;
  } catch {
    throw new ValidationError('Failed to parse product suggestion');
  }
}
