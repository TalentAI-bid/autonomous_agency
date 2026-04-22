import { eq, and, desc, max } from 'drizzle-orm';
import { withTenant, db } from '../config/database.js';
import { conversations, conversationMessages, masterAgents, emailListenerConfigs, emailAccounts, tenants, products as productsTable } from '../db/schema/index.js';
import { complete, completeStream, extractJSON, SMART_MODEL } from '../tools/together-ai.tool.js';
import { parsePDF } from '../tools/pdf-parser.tool.js';
import { parseDOCX } from '../tools/docx-parser.tool.js';
import { buildChatSystemPrompt, type InferredIntent } from '../prompts/chat-agent.prompt.js';
import { applySearchChoice, type SearchChoicePayload } from './search-negotiation.service.js';
import { registerTenantWorkers, scheduleAgentJobs } from '../queues/workers.js';
import { MasterAgent } from '../agents/master-agent.js';
import { flushEmailQueue } from '../tools/email-queue.tool.js';
import { drainAllPipelineQueues } from './queue.service.js';
import { resetSearchRateLimits } from '../tools/searxng.tool.js';
import { NotFoundError, ValidationError, ConflictError } from '../utils/errors.js';
import type { ChatMessage } from '../tools/together-ai.tool.js';
import logger from '../utils/logger.js';

interface Attachment {
  fileName: string;
  mimeType: string;
  buffer: Buffer;
}

// Helper: load company profile + active products for prompt context
async function loadCompanyContext(tenantId: string) {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  const settings = (tenant?.settings as Record<string, unknown>) ?? {};
  const companyProfile = settings.companyProfile as Record<string, unknown> | undefined;

  const activeProducts = await withTenant(tenantId, async (tx) => {
    return tx.select({
      name: productsTable.name,
      description: productsTable.description,
      category: productsTable.category,
      targetAudience: productsTable.targetAudience,
      painPointsSolved: productsTable.painPointsSolved,
      keyFeatures: productsTable.keyFeatures,
      differentiators: productsTable.differentiators,
      pricingModel: productsTable.pricingModel,
    }).from(productsTable)
      .where(and(eq(productsTable.tenantId, tenantId), eq(productsTable.isActive, true)));
  });

  return { companyProfile, products: activeProducts };
}

interface MissionIntent {
  bdStrategy: 'hiring_signal' | 'industry_target' | 'hybrid' | null;
  targetRoles: string[];
  locations: string[];
  industries: string[];
  targetTech: string[];
  userCompany: string | null;
  confidence: number;
  reasoning: string;
}

async function classifyMissionIntent(tenantId: string, userMessage: string): Promise<MissionIntent | null> {
  try {
    const systemPrompt = `You are a B2B sales/recruitment intent classifier. Read the user's mission message and extract structured intent.

Output STRICT JSON matching this shape (no markdown, no explanation):
{
  "bdStrategy": "hiring_signal" | "industry_target" | "hybrid" | null,
  "targetRoles": string[],
  "locations": string[],
  "industries": string[],
  "targetTech": string[],
  "userCompany": string | null,
  "confidence": number,
  "reasoning": string
}

Classification rules:
- "hiring_signal" when the user mentions hiring, jobs, recruitment, hires, team-growth, "companies hiring X", "who's hiring". The signal is that the user wants to find companies currently growing a specific role.
- "industry_target" when the user mentions an industry/vertical/ICP/customer profile without any hiring verbs (e.g. "fintech startups", "SaaS companies in Berlin", "e-commerce SMBs").
- "hybrid" when BOTH hiring verbs AND a clear industry are present.
- null when the mission is too vague to pick one (e.g. "help me find leads").

Confidence is a float 0..1. If confidence < 0.7, set bdStrategy=null. Values ≥ 0.9 indicate the strategy is stated explicitly or implied unambiguously.

Extract:
- targetRoles: technical/business roles being hired for OR targeted (e.g. "Hedera developer", "Head of HR").
- locations: normalized country/region/city names (e.g. "United Kingdom", "Berlin").
- industries: industries/verticals/segments mentioned (e.g. "blockchain", "fintech").
- targetTech: specific technologies mentioned (e.g. "Hedera", "Solidity", "React").
- userCompany: if the user names their own company, capture it; otherwise null.
- reasoning: one-sentence why.`;

    const result = await extractJSON<MissionIntent>(
      tenantId,
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      2,
      { model: SMART_MODEL, temperature: 0.2, max_tokens: 800 },
    );

    if (!result || typeof result.confidence !== 'number') return null;

    // Hard-enforce the <0.7 rule in case the LLM ignored it.
    if (result.confidence < 0.7) result.bdStrategy = null;

    return result;
  } catch (err) {
    logger.warn({ err, tenantId }, 'classifyMissionIntent failed');
    return null;
  }
}

/** Heuristic: decide whether a user's free-text reply should be treated as a
 * broaden-manual search term when pendingSearchChoice is active. Affirmative
 * short phrases ("yes, continue", "sounds good") should NOT trigger broaden. */
function looksLikeBroadenTerm(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const wordCount = trimmed.split(/\s+/).length;
  const lower = trimmed.toLowerCase();
  const affirmativeTokens = ['yes', 'continue', 'keep', 'sounds good', 'looks good', 'ok', 'okay', 'go ahead', 'proceed', 'sure'];
  const isShortAffirmative = wordCount < 4 && affirmativeTokens.some(t => lower.includes(t));
  if (isShortAffirmative) return false;

  // Don't treat clear conversational questions as search terms
  if (trimmed.endsWith('?') && wordCount > 4) return false;

  // Accept 1–6-word phrases as candidate search terms
  return wordCount >= 1 && wordCount <= 6;
}

export async function createConversation(tenantId: string, userId: string) {
  const [conversation] = await withTenant(tenantId, async (tx) => {
    return tx.insert(conversations).values({
      tenantId,
      userId,
      status: 'active',
    }).returning();
  });

  // Fetch active email listeners for context
  const listeners = await withTenant(tenantId, async (tx) => {
    return tx.select({ id: emailListenerConfigs.id, username: emailListenerConfigs.username, host: emailListenerConfigs.host })
      .from(emailListenerConfigs)
      .where(and(eq(emailListenerConfigs.tenantId, tenantId), eq(emailListenerConfigs.isActive, true)));
  });

  // Fetch active email sending accounts for context
  const accounts = await withTenant(tenantId, async (tx) => {
    return tx.select({ id: emailAccounts.id, name: emailAccounts.name, fromEmail: emailAccounts.fromEmail })
      .from(emailAccounts)
      .where(and(eq(emailAccounts.tenantId, tenantId), eq(emailAccounts.isActive, true)));
  });

  // Load company profile + products for context
  const { companyProfile, products: activeProducts } = await loadCompanyContext(tenantId);

  // Build messages for the greeting
  const systemPrompt = buildChatSystemPrompt({ emailListeners: listeners, emailAccounts: accounts, companyProfile, products: activeProducts });
  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: 'Start the conversation' },
  ];

  const greeting = await complete(tenantId, llmMessages);

  // Save the greeting as the first message
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

export async function sendMessage(
  tenantId: string,
  conversationId: string,
  content: string,
  attachments?: Attachment[],
) {
  // Verify conversation exists and belongs to tenant
  const [conversation] = await withTenant(tenantId, async (tx) => {
    return tx.select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
      .limit(1);
  });
  if (!conversation) throw new NotFoundError('Conversation', conversationId);
  if (conversation.status !== 'active') throw new ValidationError('Conversation is not active');

  // Get current max orderIndex
  const [maxResult] = await withTenant(tenantId, async (tx) => {
    return tx.select({ maxOrder: max(conversationMessages.orderIndex) })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId));
  });
  const maxOrder = maxResult?.maxOrder ?? -1;

  // Process attachments
  let fileMetadata: Array<{ fileName: string; mimeType: string; extractedText: string; pages?: number }> = [];
  if (attachments?.length) {
    for (const file of attachments) {
      const ext = file.fileName.toLowerCase().split('.').pop();
      let extractedText = '';
      let pages: number | undefined;

      if (ext === 'pdf') {
        const result = await parsePDF(file.buffer);
        extractedText = result.text;
        pages = result.pages;
      } else if (ext === 'docx') {
        const result = await parseDOCX(file.buffer);
        extractedText = result.text;
      } else {
        throw new ValidationError(`Unsupported file type: .${ext}. Only PDF and DOCX are supported.`);
      }

      fileMetadata.push({ fileName: file.fileName, mimeType: file.mimeType, extractedText, pages });
    }
  }

  // Save user message
  const userMsgMetadata = fileMetadata.length > 0 ? { files: fileMetadata } : undefined;
  const [userMsg] = await withTenant(tenantId, async (tx) => {
    return tx.insert(conversationMessages).values({
      conversationId,
      role: 'user',
      type: fileMetadata.length > 0 ? 'file_upload' : 'text',
      content,
      metadata: userMsgMetadata,
      orderIndex: maxOrder + 1,
    }).returning();
  });

  // Load messages, listeners, accounts, and company context in parallel
  const [allMessages, listeners, accounts, companyCtx] = await Promise.all([
    withTenant(tenantId, async (tx) => {
      return tx.select().from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId))
        .orderBy(conversationMessages.orderIndex);
    }),
    withTenant(tenantId, async (tx) => {
      return tx.select({ id: emailListenerConfigs.id, username: emailListenerConfigs.username, host: emailListenerConfigs.host })
        .from(emailListenerConfigs)
        .where(and(eq(emailListenerConfigs.tenantId, tenantId), eq(emailListenerConfigs.isActive, true)));
    }),
    withTenant(tenantId, async (tx) => {
      return tx.select({ id: emailAccounts.id, name: emailAccounts.name, fromEmail: emailAccounts.fromEmail })
        .from(emailAccounts)
        .where(and(eq(emailAccounts.tenantId, tenantId), eq(emailAccounts.isActive, true)));
    }),
    loadCompanyContext(tenantId),
  ]);

  // Load master-agent config (for intent classifier gate + pending search choice)
  let masterAgentConfig: Record<string, unknown> = {};
  if (conversation.masterAgentId) {
    const [masterRow] = await withTenant(tenantId, async (tx) => {
      return tx.select({ config: masterAgents.config }).from(masterAgents)
        .where(and(eq(masterAgents.id, conversation.masterAgentId as string), eq(masterAgents.tenantId, tenantId)))
        .limit(1);
    });
    masterAgentConfig = (masterRow?.config as Record<string, unknown>) ?? {};
  }

  const userMessageCountSoFar = allMessages.filter(m => m.role === 'user').length;
  const pendingSearchChoiceRaw = masterAgentConfig.pendingSearchChoice as
    | { jobTitle: string; totalFound?: number; locations?: string[] }
    | undefined;

  // Free-text broaden fallback: if a search negotiation is pending AND the
  // user's latest message looks like a new search term (not an affirmative),
  // route it through applySearchChoice before calling the chat LLM.
  let searchFallbackNote: string | null = null;
  if (
    conversation.masterAgentId &&
    pendingSearchChoiceRaw &&
    looksLikeBroadenTerm(content)
  ) {
    try {
      const outcome = await applySearchChoice(tenantId, conversation.masterAgentId, {
        choiceId: 'broaden_manual',
        userTerm: content.trim(),
      } satisfies SearchChoicePayload);
      searchFallbackNote = `[System] Free-text broaden triggered from chat — ran LinkedIn Jobs for "${outcome.appliedTerm}" across ${outcome.locationCount} location(s); found ${outcome.totalFound} companies.`;
      // Reload the (potentially cleared) config so the prompt reflects reality.
      if (conversation.masterAgentId) {
        const [fresh] = await withTenant(tenantId, async (tx) => {
          return tx.select({ config: masterAgents.config }).from(masterAgents)
            .where(and(eq(masterAgents.id, conversation.masterAgentId as string), eq(masterAgents.tenantId, tenantId)))
            .limit(1);
        });
        masterAgentConfig = (fresh?.config as Record<string, unknown>) ?? {};
      }
    } catch (err) {
      logger.warn({ err, tenantId, masterAgentId: conversation.masterAgentId }, 'Free-text broaden fallback failed');
    }
  }

  // Intent classifier gate: run only when bdStrategy is still null AND we are
  // within the first two user messages. Persist high-confidence extractions.
  let inferredIntent: InferredIntent | undefined;
  const userMessageCountAfter = userMessageCountSoFar + 1; // including the current message
  if (
    conversation.masterAgentId &&
    !masterAgentConfig.bdStrategy &&
    userMessageCountAfter <= 2
  ) {
    const mission = await classifyMissionIntent(tenantId, content);
    if (mission && mission.bdStrategy) {
      const conf: 'high' | 'medium' = mission.confidence >= 0.9 ? 'high' : 'medium';
      inferredIntent = {
        bdStrategy: mission.bdStrategy,
        confidence: conf,
        targetRoles: mission.targetRoles?.length ? mission.targetRoles : undefined,
        locations: mission.locations?.length ? mission.locations : undefined,
      };

      if (mission.confidence >= 0.9) {
        // Merge, preferring user-authored non-empty values in the existing config.
        const existing = masterAgentConfig;
        const merged: Record<string, unknown> = { ...existing };
        const setIfEmpty = (key: string, value: unknown) => {
          const cur = existing[key];
          const isEmpty = cur == null || (Array.isArray(cur) && cur.length === 0) || cur === '';
          if (isEmpty && value != null && !(Array.isArray(value) && value.length === 0) && value !== '') {
            merged[key] = value;
          }
        };
        setIfEmpty('bdStrategy', mission.bdStrategy);
        setIfEmpty('targetRoles', mission.targetRoles);
        setIfEmpty('locations', mission.locations);
        setIfEmpty('industries', mission.industries);
        setIfEmpty('targetTech', mission.targetTech);
        setIfEmpty('userCompany', mission.userCompany);

        try {
          await withTenant(tenantId, async (tx) => {
            await tx.update(masterAgents)
              .set({ config: merged, updatedAt: new Date() })
              .where(and(eq(masterAgents.id, conversation.masterAgentId as string), eq(masterAgents.tenantId, tenantId)));
          });
          masterAgentConfig = merged;
          logger.info(
            { tenantId, masterAgentId: conversation.masterAgentId, bdStrategy: mission.bdStrategy, confidence: mission.confidence },
            'classifyMissionIntent persisted to master_agents.config',
          );
        } catch (err) {
          logger.warn({ err, tenantId, masterAgentId: conversation.masterAgentId }, 'Failed to persist classifier output');
        }
      }
    }
  }

  const promptPendingChoice =
    pendingSearchChoiceRaw && masterAgentConfig.pendingSearchChoice
      ? { jobTitle: pendingSearchChoiceRaw.jobTitle, totalFound: pendingSearchChoiceRaw.totalFound ?? 0 }
      : null;

  // Build LLM message array
  const systemPrompt = buildChatSystemPrompt({
    emailListeners: listeners,
    emailAccounts: accounts,
    companyProfile: companyCtx.companyProfile,
    products: companyCtx.products,
    inferredIntent,
    pendingSearchChoice: promptPendingChoice,
  });

  // Build context block with extracted config and document texts
  const contextParts: string[] = [];
  if (searchFallbackNote) {
    contextParts.push(searchFallbackNote);
  }
  if (conversation.extractedConfig) {
    contextParts.push(`Current extracted configuration:\n${JSON.stringify(conversation.extractedConfig, null, 2)}`);
  }

  // Collect document texts from all messages with file metadata
  for (const msg of allMessages) {
    const meta = msg.metadata as Record<string, unknown> | null;
    if (meta?.files) {
      const files = meta.files as Array<{ fileName: string; extractedText: string }>;
      for (const f of files) {
        if (f.extractedText) {
          contextParts.push(`Document "${f.fileName}":\n${f.extractedText.slice(0, 8000)}`);
        }
      }
    }
  }

  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  if (contextParts.length > 0) {
    llmMessages.push({
      role: 'system',
      content: `## Context\n\n${contextParts.join('\n\n---\n\n')}`,
    });
  }

  // Add conversation history
  for (const msg of allMessages) {
    if (msg.role === 'system') continue;
    llmMessages.push({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    });
  }

  // Turn-count safeguard: force proposal after 3+ user messages with no proposal yet
  const userMessageCount = llmMessages.filter(m => m.role === 'user').length;
  const hasProposalAlready = allMessages.some(m => m.type === 'pipeline_proposal');
  if (userMessageCount >= 3 && !hasProposalAlready) {
    llmMessages.push({
      role: 'system',
      content: 'CRITICAL: You have been gathering information for several messages. You MUST output a <pipeline_proposal> now. Use sensible defaults for any missing information. If an email account or listener is needed and only one is available, auto-select it. Do not ask another question.',
    });
  }

  // Call LLM
  const response = await complete(tenantId, llmMessages, { max_tokens: 16384 });

  // Check for pipeline proposal
  const proposalMatch = response.match(/<pipeline_proposal>\s*([\s\S]*?)\s*<\/pipeline_proposal>/);
  let proposalData: Record<string, unknown> | undefined;
  let messageType: 'text' | 'pipeline_proposal' = 'text';

  if (proposalMatch) {
    try {
      const cleaned = proposalMatch[1]!.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      proposalData = JSON.parse(cleaned);
      messageType = 'pipeline_proposal';
    } catch (err) {
      logger.warn({ err }, 'Failed to parse pipeline proposal JSON from chat response');
    }
  }

  // Auto-enrich proposal with correct email config IDs (resilient to LLM mistakes)
  if (proposalData) {
    const config = (proposalData.config as Record<string, unknown>) ?? {};
    const pipelineSteps = (proposalData.pipeline as Array<{ agentType: string }>) ?? [];
    const hasOutreach = pipelineSteps.some(s => s.agentType === 'outreach');
    const hasEmailListen = pipelineSteps.some(s => s.agentType === 'email-listen');

    // Auto-fill emailAccountId if exactly one account exists and pipeline has outreach
    if (hasOutreach && !config.emailAccountId && accounts.length === 1) {
      config.emailAccountId = accounts[0].id;
    }

    // Auto-fill emailListenerConfigId if exactly one listener exists and pipeline has email-listen
    if (hasEmailListen && !config.emailListenerConfigId && listeners.length === 1) {
      config.emailListenerConfigId = listeners[0].id;
    }

    // Validate that IDs reference real accounts (not LLM hallucinations)
    if (config.emailAccountId && !accounts.some(a => a.id === config.emailAccountId)) {
      delete config.emailAccountId;
    }
    if (config.emailListenerConfigId && !listeners.some(l => l.id === config.emailListenerConfigId)) {
      delete config.emailListenerConfigId;
    }

    proposalData.config = config;
  }

  // Save assistant message
  const [assistantMsg] = await withTenant(tenantId, async (tx) => {
    return tx.insert(conversationMessages).values({
      conversationId,
      role: 'assistant',
      type: messageType,
      content: response,
      proposalData: proposalData,
      orderIndex: maxOrder + 2,
    }).returning();
  });

  // Update extractedConfig if proposal found
  if (proposalData) {
    await withTenant(tenantId, async (tx) => {
      return tx.update(conversations)
        .set({ extractedConfig: proposalData, updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
    });
  }

  return { message: assistantMsg };
}

export async function* sendMessageStream(
  tenantId: string,
  conversationId: string,
  content: string,
  attachments?: Attachment[],
): AsyncGenerator<string, void, unknown> {
  // Verify conversation exists and belongs to tenant
  const [conversation] = await withTenant(tenantId, async (tx) => {
    return tx.select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
      .limit(1);
  });
  if (!conversation) throw new NotFoundError('Conversation', conversationId);
  if (conversation.status !== 'active') throw new ValidationError('Conversation is not active');

  // Get current max orderIndex
  const [maxResult] = await withTenant(tenantId, async (tx) => {
    return tx.select({ maxOrder: max(conversationMessages.orderIndex) })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId));
  });
  const maxOrder = maxResult?.maxOrder ?? -1;

  // Process attachments
  let fileMetadata: Array<{ fileName: string; mimeType: string; extractedText: string; pages?: number }> = [];
  if (attachments?.length) {
    for (const file of attachments) {
      const ext = file.fileName.toLowerCase().split('.').pop();
      let extractedText = '';
      let pages: number | undefined;

      if (ext === 'pdf') {
        const result = await parsePDF(file.buffer);
        extractedText = result.text;
        pages = result.pages;
      } else if (ext === 'docx') {
        const result = await parseDOCX(file.buffer);
        extractedText = result.text;
      } else {
        throw new ValidationError(`Unsupported file type: .${ext}. Only PDF and DOCX are supported.`);
      }

      fileMetadata.push({ fileName: file.fileName, mimeType: file.mimeType, extractedText, pages });
    }
  }

  // Save user message
  const userMsgMetadata = fileMetadata.length > 0 ? { files: fileMetadata } : undefined;
  await withTenant(tenantId, async (tx) => {
    return tx.insert(conversationMessages).values({
      conversationId,
      role: 'user',
      type: fileMetadata.length > 0 ? 'file_upload' : 'text',
      content,
      metadata: userMsgMetadata,
      orderIndex: maxOrder + 1,
    }).returning();
  });

  // Load messages, listeners, accounts, and company context in parallel
  const [allMessages, listeners, accounts, companyCtx] = await Promise.all([
    withTenant(tenantId, async (tx) => {
      return tx.select().from(conversationMessages)
        .where(eq(conversationMessages.conversationId, conversationId))
        .orderBy(conversationMessages.orderIndex);
    }),
    withTenant(tenantId, async (tx) => {
      return tx.select({ id: emailListenerConfigs.id, username: emailListenerConfigs.username, host: emailListenerConfigs.host })
        .from(emailListenerConfigs)
        .where(and(eq(emailListenerConfigs.tenantId, tenantId), eq(emailListenerConfigs.isActive, true)));
    }),
    withTenant(tenantId, async (tx) => {
      return tx.select({ id: emailAccounts.id, name: emailAccounts.name, fromEmail: emailAccounts.fromEmail })
        .from(emailAccounts)
        .where(and(eq(emailAccounts.tenantId, tenantId), eq(emailAccounts.isActive, true)));
    }),
    loadCompanyContext(tenantId),
  ]);

  // Load master-agent config (for intent classifier gate + pending search choice)
  let masterAgentConfig: Record<string, unknown> = {};
  if (conversation.masterAgentId) {
    const [masterRow] = await withTenant(tenantId, async (tx) => {
      return tx.select({ config: masterAgents.config }).from(masterAgents)
        .where(and(eq(masterAgents.id, conversation.masterAgentId as string), eq(masterAgents.tenantId, tenantId)))
        .limit(1);
    });
    masterAgentConfig = (masterRow?.config as Record<string, unknown>) ?? {};
  }

  const userMessageCountSoFar = allMessages.filter(m => m.role === 'user').length;
  const pendingSearchChoiceRaw = masterAgentConfig.pendingSearchChoice as
    | { jobTitle: string; totalFound?: number; locations?: string[] }
    | undefined;

  let searchFallbackNote: string | null = null;
  if (
    conversation.masterAgentId &&
    pendingSearchChoiceRaw &&
    looksLikeBroadenTerm(content)
  ) {
    try {
      const outcome = await applySearchChoice(tenantId, conversation.masterAgentId, {
        choiceId: 'broaden_manual',
        userTerm: content.trim(),
      } satisfies SearchChoicePayload);
      searchFallbackNote = `[System] Free-text broaden triggered from chat — ran LinkedIn Jobs for "${outcome.appliedTerm}" across ${outcome.locationCount} location(s); found ${outcome.totalFound} companies.`;
      const [fresh] = await withTenant(tenantId, async (tx) => {
        return tx.select({ config: masterAgents.config }).from(masterAgents)
          .where(and(eq(masterAgents.id, conversation.masterAgentId as string), eq(masterAgents.tenantId, tenantId)))
          .limit(1);
      });
      masterAgentConfig = (fresh?.config as Record<string, unknown>) ?? {};
    } catch (err) {
      logger.warn({ err, tenantId, masterAgentId: conversation.masterAgentId }, 'Free-text broaden fallback failed');
    }
  }

  let inferredIntent: InferredIntent | undefined;
  const userMessageCountAfter = userMessageCountSoFar + 1;
  if (
    conversation.masterAgentId &&
    !masterAgentConfig.bdStrategy &&
    userMessageCountAfter <= 2
  ) {
    const mission = await classifyMissionIntent(tenantId, content);
    if (mission && mission.bdStrategy) {
      const conf: 'high' | 'medium' = mission.confidence >= 0.9 ? 'high' : 'medium';
      inferredIntent = {
        bdStrategy: mission.bdStrategy,
        confidence: conf,
        targetRoles: mission.targetRoles?.length ? mission.targetRoles : undefined,
        locations: mission.locations?.length ? mission.locations : undefined,
      };

      if (mission.confidence >= 0.9) {
        const existing = masterAgentConfig;
        const merged: Record<string, unknown> = { ...existing };
        const setIfEmpty = (key: string, value: unknown) => {
          const cur = existing[key];
          const isEmpty = cur == null || (Array.isArray(cur) && cur.length === 0) || cur === '';
          if (isEmpty && value != null && !(Array.isArray(value) && value.length === 0) && value !== '') {
            merged[key] = value;
          }
        };
        setIfEmpty('bdStrategy', mission.bdStrategy);
        setIfEmpty('targetRoles', mission.targetRoles);
        setIfEmpty('locations', mission.locations);
        setIfEmpty('industries', mission.industries);
        setIfEmpty('targetTech', mission.targetTech);
        setIfEmpty('userCompany', mission.userCompany);

        try {
          await withTenant(tenantId, async (tx) => {
            await tx.update(masterAgents)
              .set({ config: merged, updatedAt: new Date() })
              .where(and(eq(masterAgents.id, conversation.masterAgentId as string), eq(masterAgents.tenantId, tenantId)));
          });
          masterAgentConfig = merged;
          logger.info(
            { tenantId, masterAgentId: conversation.masterAgentId, bdStrategy: mission.bdStrategy, confidence: mission.confidence },
            'classifyMissionIntent persisted to master_agents.config (stream)',
          );
        } catch (err) {
          logger.warn({ err, tenantId, masterAgentId: conversation.masterAgentId }, 'Failed to persist classifier output (stream)');
        }
      }
    }
  }

  const promptPendingChoice =
    pendingSearchChoiceRaw && masterAgentConfig.pendingSearchChoice
      ? { jobTitle: pendingSearchChoiceRaw.jobTitle, totalFound: pendingSearchChoiceRaw.totalFound ?? 0 }
      : null;

  // Build LLM message array
  const systemPrompt = buildChatSystemPrompt({
    emailListeners: listeners,
    emailAccounts: accounts,
    companyProfile: companyCtx.companyProfile,
    products: companyCtx.products,
    inferredIntent,
    pendingSearchChoice: promptPendingChoice,
  });

  const contextParts: string[] = [];
  if (searchFallbackNote) {
    contextParts.push(searchFallbackNote);
  }
  if (conversation.extractedConfig) {
    contextParts.push(`Current extracted configuration:\n${JSON.stringify(conversation.extractedConfig, null, 2)}`);
  }

  for (const msg of allMessages) {
    const meta = msg.metadata as Record<string, unknown> | null;
    if (meta?.files) {
      const files = meta.files as Array<{ fileName: string; extractedText: string }>;
      for (const f of files) {
        if (f.extractedText) {
          contextParts.push(`Document "${f.fileName}":\n${f.extractedText.slice(0, 8000)}`);
        }
      }
    }
  }

  const llmMessages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
  ];

  if (contextParts.length > 0) {
    llmMessages.push({
      role: 'system',
      content: `## Context\n\n${contextParts.join('\n\n---\n\n')}`,
    });
  }

  for (const msg of allMessages) {
    if (msg.role === 'system') continue;
    llmMessages.push({
      role: msg.role as 'user' | 'assistant',
      content: msg.content,
    });
  }

  // Turn-count safeguard
  const userMessageCount = llmMessages.filter(m => m.role === 'user').length;
  const hasProposalAlready = allMessages.some(m => m.type === 'pipeline_proposal');
  if (userMessageCount >= 3 && !hasProposalAlready) {
    llmMessages.push({
      role: 'system',
      content: 'CRITICAL: You have been gathering information for several messages. You MUST output a <pipeline_proposal> now. Use sensible defaults for any missing information. If an email account or listener is needed and only one is available, auto-select it. Do not ask another question.',
    });
  }

  // Stream LLM response
  let fullResponse = '';
  const stream = completeStream(tenantId, llmMessages, { max_tokens: 16384 });
  for await (const chunk of stream) {
    fullResponse += chunk;
    yield `event: token\ndata: ${JSON.stringify({ text: chunk })}\n\n`;
  }

  // Parse proposal from full response
  const proposalMatch = fullResponse.match(/<pipeline_proposal>\s*([\s\S]*?)\s*<\/pipeline_proposal>/);
  let proposalData: Record<string, unknown> | undefined;
  let messageType: 'text' | 'pipeline_proposal' = 'text';

  if (proposalMatch) {
    try {
      const cleaned = proposalMatch[1]!.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      proposalData = JSON.parse(cleaned);
      messageType = 'pipeline_proposal';
    } catch (err) {
      logger.warn({ err }, 'Failed to parse pipeline proposal JSON from chat stream');
    }
  }

  // Auto-enrich proposal
  if (proposalData) {
    const config = (proposalData.config as Record<string, unknown>) ?? {};
    const pipelineSteps = (proposalData.pipeline as Array<{ agentType: string }>) ?? [];
    const hasOutreach = pipelineSteps.some(s => s.agentType === 'outreach');
    const hasEmailListen = pipelineSteps.some(s => s.agentType === 'email-listen');

    if (hasOutreach && !config.emailAccountId && accounts.length === 1) {
      config.emailAccountId = accounts[0].id;
    }
    if (hasEmailListen && !config.emailListenerConfigId && listeners.length === 1) {
      config.emailListenerConfigId = listeners[0].id;
    }
    if (config.emailAccountId && !accounts.some(a => a.id === config.emailAccountId)) {
      delete config.emailAccountId;
    }
    if (config.emailListenerConfigId && !listeners.some(l => l.id === config.emailListenerConfigId)) {
      delete config.emailListenerConfigId;
    }
    proposalData.config = config;
  }

  // Save assistant message
  const [assistantMsg] = await withTenant(tenantId, async (tx) => {
    return tx.insert(conversationMessages).values({
      conversationId,
      role: 'assistant',
      type: messageType,
      content: fullResponse,
      proposalData: proposalData,
      orderIndex: maxOrder + 2,
    }).returning();
  });

  // Update extractedConfig if proposal found
  if (proposalData) {
    await withTenant(tenantId, async (tx) => {
      return tx.update(conversations)
        .set({ extractedConfig: proposalData, updatedAt: new Date() })
        .where(eq(conversations.id, conversationId));
    });
  }

  // Emit final done event
  yield `event: done\ndata: ${JSON.stringify({ message: assistantMsg, proposalData: proposalData ?? null })}\n\n`;
}

export async function approveProposal(tenantId: string, conversationId: string, userId: string) {
  // Load conversation
  const [conversation] = await withTenant(tenantId, async (tx) => {
    return tx.select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
      .limit(1);
  });
  if (!conversation) throw new NotFoundError('Conversation', conversationId);
  if (conversation.status === 'completed') {
    throw new ConflictError('This conversation has already been approved.');
  }

  // Find latest pipeline proposal message
  const [proposalMsg] = await withTenant(tenantId, async (tx) => {
    return tx.select().from(conversationMessages)
      .where(and(
        eq(conversationMessages.conversationId, conversationId),
        eq(conversationMessages.type, 'pipeline_proposal'),
      ))
      .orderBy(desc(conversationMessages.orderIndex))
      .limit(1);
  });
  if (!proposalMsg?.proposalData) throw new NotFoundError('Pipeline proposal');

  const proposal = proposalMsg.proposalData as Record<string, unknown>;
  const config = (proposal.config as Record<string, unknown>) ?? {};
  const pipelineSteps = (proposal.pipeline as Array<{ agentType: string }>) ?? [];
  const hasOutreach = pipelineSteps.some(s => s.agentType === 'outreach');
  const hasEmailListen = pipelineSteps.some(s => s.agentType === 'email-listen');

  // Auto-fill email config IDs (same logic as chat flow)
  const [approvalListeners, approvalAccounts] = await Promise.all([
    withTenant(tenantId, async (tx) => {
      return tx.select({ id: emailListenerConfigs.id })
        .from(emailListenerConfigs)
        .where(and(eq(emailListenerConfigs.tenantId, tenantId), eq(emailListenerConfigs.isActive, true)));
    }),
    withTenant(tenantId, async (tx) => {
      return tx.select({ id: emailAccounts.id })
        .from(emailAccounts)
        .where(and(eq(emailAccounts.tenantId, tenantId), eq(emailAccounts.isActive, true)));
    }),
  ]);

  if (hasOutreach && !config.emailAccountId && approvalAccounts.length === 1) {
    config.emailAccountId = approvalAccounts[0].id;
  }
  if (hasEmailListen && !config.emailListenerConfigId && approvalListeners.length === 1) {
    config.emailListenerConfigId = approvalListeners[0].id;
  }

  // Validate email sending account (skip if user explicitly disabled outreach)
  if (hasOutreach && !config.emailAccountId && config.enableOutreach !== false) {
    throw new ValidationError(
      'This pipeline includes outreach but no email sending account is selected. Please configure one in Settings > Email, then ask the agent to update the proposal.'
    );
  }

  // Validate email listener config
  if (hasEmailListen && !config.emailListenerConfigId) {
    throw new ValidationError(
      'This pipeline includes email monitoring but no email listener is selected. Please configure one in Settings > Email, then ask the agent to update the proposal.'
    );
  }

  // Verify IDs exist in the database
  if (config.emailAccountId) {
    const [acct] = await withTenant(tenantId, async (tx) => {
      return tx.select({ id: emailAccounts.id }).from(emailAccounts)
        .where(and(eq(emailAccounts.id, config.emailAccountId as string), eq(emailAccounts.tenantId, tenantId)))
        .limit(1);
    });
    if (!acct) {
      throw new ValidationError('The selected email sending account no longer exists. Please update the proposal with a valid account.');
    }
  }

  if (config.emailListenerConfigId) {
    const [listener] = await withTenant(tenantId, async (tx) => {
      return tx.select({ id: emailListenerConfigs.id }).from(emailListenerConfigs)
        .where(and(eq(emailListenerConfigs.id, config.emailListenerConfigId as string), eq(emailListenerConfigs.tenantId, tenantId)))
        .limit(1);
    });
    if (!listener) {
      throw new ValidationError('The selected email listener no longer exists. Please update the proposal with a valid listener.');
    }
  }

  // Create master agent
  const [agent] = await withTenant(tenantId, async (tx) => {
    return tx.insert(masterAgents).values({
      tenantId,
      name: (proposal.name as string) || 'Chat-created Agent',
      description: (proposal.summary as string) || undefined,
      mission: (proposal.mission as string) || undefined,
      useCase: (proposal.useCase as 'recruitment' | 'sales' | 'custom') || 'custom',
      config: {
        ...((proposal.config as Record<string, unknown>) ?? {}),
        pipeline: proposal.pipeline,
        enabledAgents: (proposal.pipeline as Array<{ agentType: string }>)?.map(s => s.agentType) ?? [],
      } as Record<string, unknown>,
      createdBy: userId,
    }).returning();
  });

  // Update conversation
  await withTenant(tenantId, async (tx) => {
    return tx.update(conversations)
      .set({
        masterAgentId: agent.id,
        status: 'completed',
        updatedAt: new Date(),
      })
      .where(eq(conversations.id, conversationId));
  });

  // Get current max orderIndex for the approval message
  const [maxResult] = await withTenant(tenantId, async (tx) => {
    return tx.select({ maxOrder: max(conversationMessages.orderIndex) })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId));
  });

  // Save pipeline_approved message
  await withTenant(tenantId, async (tx) => {
    return tx.insert(conversationMessages).values({
      conversationId,
      role: 'assistant',
      type: 'pipeline_approved',
      content: `Pipeline "${agent.name}" has been approved and launched!`,
      orderIndex: (maxResult?.maxOrder ?? 0) + 1,
    });
  });

  // Start the agent
  await withTenant(tenantId, async (tx) => {
    return tx.update(masterAgents)
      .set({ status: 'running', updatedAt: new Date() })
      .where(eq(masterAgents.id, agent.id));
  });

  // Drain stale pipeline jobs + flush emails + reset search limits before starting fresh
  await drainAllPipelineQueues(tenantId);
  await flushEmailQueue(tenantId);
  await resetSearchRateLimits(tenantId);

  registerTenantWorkers(tenantId);

  // Fire-and-forget: run execute + schedule jobs in background
  void (async () => {
    const masterAgent = new MasterAgent({ tenantId, masterAgentId: agent.id });
    try {
      await masterAgent.execute({ masterAgentId: agent.id, mission: agent.mission });
      await masterAgent.close();

      // Re-fetch config from DB after execute() — it may have updated the config
      const [freshAgent] = await withTenant(tenantId, async (tx) => {
        return tx.select({ config: masterAgents.config }).from(masterAgents)
          .where(and(eq(masterAgents.id, agent.id), eq(masterAgents.tenantId, tenantId)))
          .limit(1);
      });
      const agentCfg = (freshAgent?.config as Record<string, unknown>) ?? {};
      logger.info({ tenantId, agentId: agent.id, configKeys: Object.keys(agentCfg) }, 'Scheduling agent jobs from approveProposal');
      await scheduleAgentJobs(tenantId, agent.id, agentCfg);
      logger.info({ tenantId, agentId: agent.id }, 'Agent jobs scheduled from approveProposal');
    } catch (err) {
      await masterAgent.close().catch(() => {});
      await withTenant(tenantId, async (tx) => {
        return tx.update(masterAgents)
          .set({ status: 'error', updatedAt: new Date() })
          .where(eq(masterAgents.id, agent.id));
      });
      logger.error({ err, tenantId, agentId: agent.id }, 'MasterAgent execute failed in approveProposal');
    }
  })();

  return { masterAgentId: agent.id };
}

export async function getConversation(tenantId: string, conversationId: string) {
  const [conversation] = await withTenant(tenantId, async (tx) => {
    return tx.select().from(conversations)
      .where(and(eq(conversations.id, conversationId), eq(conversations.tenantId, tenantId)))
      .limit(1);
  });
  if (!conversation) throw new NotFoundError('Conversation', conversationId);

  const messages = await withTenant(tenantId, async (tx) => {
    return tx.select().from(conversationMessages)
      .where(eq(conversationMessages.conversationId, conversationId))
      .orderBy(conversationMessages.orderIndex);
  });

  return { conversation, messages };
}
