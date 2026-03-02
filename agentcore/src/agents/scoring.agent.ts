import { eq, and } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { contacts, companies, masterAgents } from '../db/schema/index.js';
import { logActivity } from '../services/crm-activity.service.js';
import { buildSystemPrompt, buildUserPrompt, type ScoringResult } from '../prompts/scoring.prompt.js';
import logger from '../utils/logger.js';

export class ScoringAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { contactId, masterAgentId, dryRun } = input as { contactId: string; masterAgentId: string; dryRun?: boolean };

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

    // 3. Extract rich data from rawData
    const raw = (contact.rawData as Record<string, unknown>) ?? {};
    const githubUrl = raw.githubUrl as string | undefined;
    const seniorityLevel = raw.seniorityLevel as string | undefined;
    const totalYearsExperience = raw.totalYearsExperience as number | undefined;
    const skillLevels = raw.skillLevels as Array<{ skill: string; level: string; evidence: string }> | undefined;
    const openSourceContributions = raw.openSourceContributions as Array<{ repo: string; description: string }> | undefined;
    const certifications = raw.certifications as string[] | undefined;
    const dataCompleteness = raw.dataCompleteness as number | undefined;

    // 4. Score with Together AI
    const useCase = agent?.useCase;
    const scoring = await this.extractJSON<ScoringResult>([
      { role: 'system', content: buildSystemPrompt(useCase) },
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
            seniorityLevel,
            githubUrl,
            totalYearsExperience,
            skillLevels,
            openSourceContributions,
            certifications,
            dataCompleteness,
          },
          requirements: {
            requiredSkills: (config.requiredSkills as string[]) ?? [],
            preferredSkills: (config.preferredSkills as string[]) ?? [],
            minExperience: (config.minExperience as number) ?? 0,
            locations: (config.locations as string[]) ?? [],
            experienceLevel: config.experienceLevel as string,
            scoringWeights: config.scoringWeights as Record<string, number>,
          },
          useCase,
        }),
      },
    ]);

    const score = Math.round(Math.min(100, Math.max(0, scoring.overall)));
    const passed = score >= threshold;
    const newStatus = passed ? 'scored' : 'rejected';

    // 5. Save score to contact
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

    // 6. Dispatch outreach if above threshold
    if (passed) {
      await this.dispatchNext('outreach', {
        contactId,
        masterAgentId,
        stepNumber: 1,
        dryRun,
      });
    }

    // Log CRM activity
    try {
      await logActivity({
        tenantId: this.tenantId,
        contactId,
        masterAgentId,
        type: 'score_updated',
        title: `Contact scored: ${score}/100 (${newStatus})`,
        metadata: {
          score,
          confidence: scoring.confidence,
          passed,
          threshold,
          breakdown: scoring.breakdown,
        },
      });
    } catch (err) {
      logger.warn({ err, contactId }, 'Failed to log CRM scoring activity');
    }

    await this.emitEvent('contact:scored', {
      contactId,
      score,
      confidence: scoring.confidence,
      status: newStatus,
      dataGaps: scoring.dataGaps,
    });

    logger.info({ tenantId: this.tenantId, contactId, score, confidence: scoring.confidence, passed }, 'ScoringAgent completed');

    return { score, confidence: scoring.confidence, breakdown: scoring.breakdown, dataGaps: scoring.dataGaps, status: newStatus };
  }
}
