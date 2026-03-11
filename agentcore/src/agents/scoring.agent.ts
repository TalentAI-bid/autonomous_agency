import { eq, and, or, desc } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { contacts, companies, masterAgents, opportunities } from '../db/schema/index.js';
import { logActivity } from '../services/crm-activity.service.js';
import { buildSystemPrompt, buildUserPrompt, type ScoringResult } from '../prompts/scoring.prompt.js';
import logger from '../utils/logger.js';

export class ScoringAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { contactId, masterAgentId, dryRun } = input as { contactId: string; masterAgentId: string; dryRun?: boolean };

    const ctx = this.getPipelineContext(input);

    logger.info({ tenantId: this.tenantId, contactId }, 'ScoringAgent starting');
    await this.setCurrentAction('scoring', `Scoring contact ${contactId.slice(0, 8)}`);

    // 1. Load contact + company
    const [contact] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, this.tenantId)))
        .limit(1);
    });
    if (!contact) throw new Error(`Contact ${contactId} not found`);

    let companyName = contact.companyName ?? '';
    let companyRecord: typeof companies.$inferSelect | null = null;
    if (contact.companyId) {
      const [company] = await withTenant(this.tenantId, async (tx) => {
        return tx.select().from(companies)
          .where(eq(companies.id, contact.companyId!))
          .limit(1);
      });
      if (company) {
        companyRecord = company;
        companyName = company.name ?? companyName;
      }
    }

    // 1b. Load linked opportunity for sales scoring
    let opportunityData: typeof opportunities.$inferSelect | null = null;
    if (ctx?.useCase === 'sales') {
      const oppConditions = [eq(opportunities.masterAgentId, masterAgentId)];
      if (contact.companyId) {
        oppConditions.push(or(eq(opportunities.contactId, contactId), eq(opportunities.companyId, contact.companyId))!);
      } else {
        oppConditions.push(eq(opportunities.contactId, contactId));
      }
      const [opp] = await withTenant(this.tenantId, async (tx) => {
        return tx.select().from(opportunities)
          .where(and(...oppConditions))
          .orderBy(desc(opportunities.buyingIntentScore))
          .limit(1);
      });
      opportunityData = opp ?? null;
    }

    // 2. Load masterAgent.config for requirements + scoring weights
    const [agent] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(masterAgents)
        .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
        .limit(1);
    });
    const config = (agent?.config as Record<string, unknown>) ?? {};
    const useCaseDefault = ctx?.useCase === 'recruitment' ? 70 : 50;
    const threshold = ctx?.scoringThreshold ?? (config.scoringThreshold as number) ?? useCaseDefault;

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
    const useCase = ctx?.useCase ?? agent?.useCase;
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
            targetRoles: ctx?.targetRoles ?? (config.targetRoles as string[]) ?? [],
            minExperience: (config.minExperience as number) ?? 0,
            locations: (config.locations as string[]) ?? [],
            experienceLevel: config.experienceLevel as string,
            scoringWeights: ctx?.scoringWeights ?? (config.scoringWeights as Record<string, number>),
          },
          useCase,
          opportunity: opportunityData ? {
            type: opportunityData.opportunityType,
            title: opportunityData.title,
            buyingIntentScore: opportunityData.buyingIntentScore,
            technologies: opportunityData.technologies as string[] | undefined,
            description: opportunityData.description ?? undefined,
          } : undefined,
          companyEnrichment: companyRecord ? {
            techStack: (companyRecord.techStack as string[]) ?? undefined,
            funding: companyRecord.funding ?? undefined,
            size: companyRecord.size ?? undefined,
            recentNews: ((companyRecord.rawData as Record<string, unknown>)?.recentNews as string[]) ?? undefined,
            products: ((companyRecord.rawData as Record<string, unknown>)?.products as string[]) ?? undefined,
            description: companyRecord.description ?? undefined,
          } : undefined,
        }),
      },
    ]);

    let rawScore = scoring.overall;

    // Opportunity scoring bonus: +10 for contacts linked to high buying-intent opportunities
    if (opportunityData && opportunityData.buyingIntentScore >= 70) {
      rawScore += 10;
      logger.debug({ contactId, opportunityId: opportunityData.id, bonus: 10 }, 'Applied opportunity scoring bonus');
    }

    const score = Math.round(Math.min(100, Math.max(0, rawScore)));
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

    // 5b. Save score to company (keep max across contacts)
    if (companyRecord) {
      const companyFitKey = useCase === 'sales' ? 'companyFit' : 'companyBackground';
      const companyScore = typeof scoring.breakdown[companyFitKey] === 'number'
        ? Math.round(scoring.breakdown[companyFitKey])
        : score;
      if (!companyRecord.score || companyScore > companyRecord.score) {
        await withTenant(this.tenantId, async (tx) => {
          await tx.update(companies)
            .set({
              score: companyScore,
              scoreDetails: {
                sourceContactId: contactId,
                breakdown: scoring.breakdown,
                overall: score,
                confidence: scoring.confidence,
              },
              updatedAt: new Date(),
            })
            .where(eq(companies.id, companyRecord!.id));
        });
      }
    }

    // 6. Dispatch outreach if above threshold
    if (passed) {
      await this.dispatchNext('outreach', {
        contactId,
        masterAgentId,
        stepNumber: 1,
        pipelineContext: ctx,
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

    const contactName = `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim();
    this.sendMessage(null, 'reasoning', {
      contactName,
      score,
      breakdown: scoring.breakdown,
      confidence: scoring.confidence,
      decision: passed ? 'pass' : 'reject',
      threshold,
    });

    await this.emitEvent('contact:scored', {
      contactId,
      score,
      confidence: scoring.confidence,
      status: newStatus,
      dataGaps: scoring.dataGaps,
    });

    this.logActivity(passed ? 'score_above_threshold' : 'score_below_threshold', 'completed', {
      inputSummary: `${contact.firstName ?? ''} ${contact.lastName ?? ''}`.trim(),
      details: { contactId, score, confidence: scoring.confidence, threshold, passed, status: newStatus },
    });
    await this.clearCurrentAction();

    logger.info({ tenantId: this.tenantId, contactId, score, confidence: scoring.confidence, passed }, 'ScoringAgent completed');

    return { score, confidence: scoring.confidence, breakdown: scoring.breakdown, dataGaps: scoring.dataGaps, status: newStatus };
  }
}
