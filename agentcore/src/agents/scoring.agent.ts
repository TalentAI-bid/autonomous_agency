import { eq, and } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { contacts, companies, masterAgents } from '../db/schema/index.js';
import { buildSystemPrompt, buildUserPrompt, type ScoringResult } from '../prompts/scoring.prompt.js';
import logger from '../utils/logger.js';

export class ScoringAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { contactId, masterAgentId } = input as { contactId: string; masterAgentId: string };

    logger.info({ tenantId: this.tenantId, contactId }, 'ScoringAgent starting');

    // 1. Load contact + company
    const [contact] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, this.tenantId)))
        .limit(1);
    });
    if (!contact) throw new Error(`Contact ${contactId} not found`);

    let companyName = contact.companyName ?? '';
    if (contact.companyId) {
      const [company] = await withTenant(this.tenantId, async (tx) => {
        return tx.select().from(companies)
          .where(eq(companies.id, contact.companyId!))
          .limit(1);
      });
      companyName = company?.name ?? companyName;
    }

    // 2. Load masterAgent.config for requirements + scoring weights
    const [agent] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(masterAgents)
        .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
        .limit(1);
    });
    const config = (agent?.config as Record<string, unknown>) ?? {};
    const threshold = (config.scoringThreshold as number) ?? 70;

    // 3. Score with Together AI
    const scoring = await this.extractJSON<ScoringResult>([
      { role: 'system', content: buildSystemPrompt() },
      {
        role: 'user',
        content: buildUserPrompt({
          contact: {
            name: `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim(),
            title: contact.title ?? '',
            skills: (contact.skills as string[]) ?? [],
            experience: (contact.experience as Array<{ company: string; title: string; startDate: string; endDate: string }>) ?? [],
            education: (contact.education as Array<{ institution: string; degree: string; field: string }>) ?? [],
            location: contact.location ?? '',
            companyName,
          },
          requirements: {
            requiredSkills: (config.requiredSkills as string[]) ?? [],
            preferredSkills: (config.preferredSkills as string[]) ?? [],
            minExperience: (config.minExperience as number) ?? 0,
            locations: (config.locations as string[]) ?? [],
            experienceLevel: config.experienceLevel as string,
            scoringWeights: config.scoringWeights as Record<string, number>,
          },
        }),
      },
    ]);

    const score = Math.round(Math.min(100, Math.max(0, scoring.overall)));
    const passed = score >= threshold;
    const newStatus = passed ? 'scored' : 'rejected';

    // 4. Save score to contact
    await withTenant(this.tenantId, async (tx) => {
      await tx.update(contacts)
        .set({
          score,
          scoreDetails: scoring as unknown as Record<string, unknown>,
          status: newStatus,
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, contactId));
    });

    // 5. Dispatch outreach if above threshold
    if (passed) {
      await this.dispatchNext('outreach', {
        contactId,
        masterAgentId,
        stepNumber: 1,
      });
    }

    await this.emitEvent('contact:scored', { contactId, score, status: newStatus });

    logger.info({ tenantId: this.tenantId, contactId, score, passed }, 'ScoringAgent completed');

    return { score, breakdown: scoring.breakdown, status: newStatus };
  }
}
