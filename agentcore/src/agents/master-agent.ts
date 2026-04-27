import { eq, and, inArray, sql, count, lt, isNotNull } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { masterAgents, documents, agentConfigs, campaigns, campaignSteps, contacts, companies, agentTasks, products as productsTable } from '../db/schema/index.js';
import { getTenantById } from '../services/tenant.service.js';
import { AGENT_TYPES } from '../queues/queues.js';
import { getQueueStatus } from '../services/queue.service.js';
import { buildSystemPrompt as masterSystemPrompt, buildUserPrompt as masterUserPrompt } from '../prompts/master-agent.prompt.js';
import { buildSystemPrompt as discoverySystemPrompt, buildUserPrompt as discoveryUserPrompt } from '../prompts/discovery.prompt.js';
import { buildActionPlan, isActionPlanComplete } from '../prompts/action-plan.prompt.js';
import type { ActionPlan } from '../db/schema/master-agents.js';
import type { PipelineContext, SalesStrategy } from '../types/pipeline-context.js';
import { checkSearxngHealth } from '../tools/searxng.tool.js';
import { env } from '../config/env.js';
import * as agentSelectorPrompt from '../prompts/agent-selector.prompt.js';
import logger from '../utils/logger.js';
import { logPipelineError } from '../utils/pipeline-error.js';

export class MasterAgent extends BaseAgent {
  constructor(opts: { tenantId: string; masterAgentId: string }) {
    super({ ...opts, agentType: 'discovery' });
  }

  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { masterAgentId, mission, dryRun: inputDryRun } = input as { masterAgentId: string; mission?: string; dryRun?: boolean };

    logger.info({ tenantId: this.tenantId, masterAgentId }, 'MasterAgent starting');
    await this.setCurrentAction('master_orchestration', 'Parsing mission and generating queries');

    // 1. Load job spec / spec documents for this master agent
    const docs = await withTenant(this.tenantId, async (tx) => {
      return tx
        .select()
        .from(documents)
        .where(
          and(
            eq(documents.masterAgentId, masterAgentId),
            eq(documents.tenantId, this.tenantId),
            inArray(documents.type, ['job_spec', 'spec']),
          ),
        );
    });

    const docTexts = docs
      .filter((d) => d.rawText)
      .map((d) => ({ type: d.type, rawText: d.rawText! }));

    // 2. Load masterAgent record
    const [agent] = await withTenant(this.tenantId, async (tx) => {
      return tx
        .select()
        .from(masterAgents)
        .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
        .limit(1);
    });
    if (!agent) throw new Error(`MasterAgent ${masterAgentId} not found`);

    const agentConfig = (agent.config as Record<string, unknown>) ?? {};
    const dryRun = inputDryRun ?? (agentConfig.dryRun as boolean) ?? false;

    // Read enabled agents from config (null = all agents, for backwards compat)
    const enabledAgents = (agentConfig.enabledAgents as string[]) ?? null;
    const hasDiscovery = !enabledAgents || enabledAgents.includes('discovery');
    const enableOutreach = agentConfig.enableOutreach !== false; // default true for backward compat

    let requirements: Record<string, unknown> = {};
    let campaignId: string | undefined;
    let queries: string[] = [];
    const dispatchedJobIds: string[] = [];
    let pipelineContext: PipelineContext | undefined;
    let hiringSignalDispatched = false;

    if (hasDiscovery) {
      // 3. Parse requirements using Together AI
      const requirementsMessages = [
        { role: 'system' as const, content: masterSystemPrompt() },
        {
          role: 'user' as const,
          content: masterUserPrompt({
            mission: (mission as string) ?? agent.mission ?? '',
            documents: docTexts,
            useCase: agent.useCase,
          }),
        },
      ];

      requirements = await this.trackAction('requirements_parsed', agent.mission ?? 'mission', () =>
        this.extractJSON<Record<string, unknown>>(requirementsMessages),
      );

      this.sendMessage(null, 'task_assignment', {
        action: 'parsed_requirements',
        queries: (requirements.targetRoles as string[]) ?? [],
        targetRoles: (requirements.targetRoles as string[]) ?? [],
        requiredSkills: (requirements.requiredSkills as string[]) ?? [],
        locations: (requirements.locations as string[]) ?? [],
      });

      // 3b. Merge explicit config values (override LLM extraction)
      if (Array.isArray(agentConfig.locations) && (agentConfig.locations as string[]).length > 0) {
        requirements.locations = agentConfig.locations;
      }
      if (Array.isArray(agentConfig.requiredSkills) && (agentConfig.requiredSkills as string[]).length > 0) {
        requirements.requiredSkills = agentConfig.requiredSkills;
      }

      // 3c. Build PipelineContext from requirements + agent config
      const isSales = agent.useCase === 'sales';
      pipelineContext = {
        useCase: agent.useCase as 'sales' | 'recruitment',
        masterAgentId,
        tenantId: this.tenantId,
        missionText: (mission as string) ?? agent.mission ?? undefined,
        targetRoles: (requirements.targetRoles as string[]) ?? [],
        locations: (requirements.locations as string[]) ?? [],
        scoringThreshold: isSales ? 50 : 70,
        emailTone: (agentConfig.emailTone as string) ?? undefined,
        emailRules: (agentConfig.emailRules as string[]) ?? undefined,
        senderCompanyName: (agentConfig.senderCompanyName as string) ?? undefined,
        senderFirstName: (agentConfig.senderFirstName as string) ?? undefined,
        senderTitle: (agentConfig.senderTitle as string) ?? undefined,
        scoringWeights: (agentConfig.scoringWeights as Record<string, number>) ?? undefined,
        ...(isSales ? {
          sales: {
            industries: ((requirements.searchCriteria as Record<string, unknown>)?.industries as string[]) ?? [],
            companySizes: (agentConfig.companySizes as string[]) ?? undefined,
            techStack: (requirements.requiredSkills as string[]) ?? [],
            services: (agentConfig.services as string[]) ?? undefined,
            caseStudies: (agentConfig.caseStudies as Array<{ title: string; result: string }>) ?? undefined,
            differentiators: (agentConfig.differentiators as string[]) ?? undefined,
            valueProposition: (agentConfig.valueProposition as string) ?? undefined,
            callToAction: (agentConfig.callToAction as string) ?? undefined,
            calendlyUrl: (agentConfig.calendlyUrl as string) ?? undefined,
          },
        } : {
          recruitment: {
            requiredSkills: (requirements.requiredSkills as string[]) ?? [],
            preferredSkills: (requirements.preferredSkills as string[]) ?? [],
            minExperience: (requirements.minExperience as number) ?? 0,
            experienceLevel: (requirements.experienceLevel as string) ?? undefined,
            companyContext: (agentConfig.companyContext as string) ?? undefined,
          },
        }),
      };

      // 3c-ii. Enrich PipelineContext with company profile + selected products
      try {
        const tenant = await getTenantById(this.tenantId);
        const tenantSettings = (tenant.settings ?? {}) as Record<string, unknown>;
        const companyProfile = tenantSettings.companyProfile as Record<string, unknown> | undefined;

        if (companyProfile && isSales) {
          if (!pipelineContext.sales) pipelineContext.sales = {};
          // Company profile overrides agent-level config where present
          if (companyProfile.valueProposition) pipelineContext.sales.valueProposition ??= companyProfile.valueProposition as string;
          if (companyProfile.differentiators) pipelineContext.sales.differentiators ??= companyProfile.differentiators as string[];
          if (companyProfile.callToAction) pipelineContext.sales.callToAction ??= companyProfile.callToAction as string;
          if (companyProfile.calendlyUrl) pipelineContext.sales.calendlyUrl ??= companyProfile.calendlyUrl as string;
          if (companyProfile.companyName) pipelineContext.senderCompanyName ??= companyProfile.companyName as string;
          if (companyProfile.defaultSenderName) pipelineContext.senderFirstName ??= companyProfile.defaultSenderName as string;
          if (companyProfile.defaultSenderTitle) pipelineContext.senderTitle ??= companyProfile.defaultSenderTitle as string;

          // Additional profile fields
          if (companyProfile.elevatorPitch) pipelineContext.sales.elevatorPitch ??= companyProfile.elevatorPitch as string;
          if (companyProfile.socialProof) pipelineContext.sales.socialProof ??= companyProfile.socialProof as string;
          if (companyProfile.targetMarketDescription) pipelineContext.sales.targetMarketDescription ??= companyProfile.targetMarketDescription as string;

          // ICP fields
          const icp = companyProfile.icp as Record<string, unknown> | undefined;
          if (icp) {
            if (icp.targetIndustries && !pipelineContext.sales.industries?.length) {
              pipelineContext.sales.industries = icp.targetIndustries as string[];
            }
            if (icp.companySizes && !pipelineContext.sales.companySizes?.length) {
              pipelineContext.sales.companySizes = icp.companySizes as string[];
            }
            if (icp.painPointsAddressed) {
              pipelineContext.sales.painPointsAddressed ??= icp.painPointsAddressed as string[];
            }
            if (icp.decisionMakerRoles && !pipelineContext.targetRoles?.length) {
              pipelineContext.targetRoles = icp.decisionMakerRoles as string[];
            }
            if (icp.regions && !pipelineContext.locations?.length) {
              pipelineContext.locations = icp.regions as string[];
            }
          }
        }

        // Load products — use explicit productIds if set, otherwise load ALL active products
        if (isSales) {
          const productIds = (agentConfig.productIds as string[]) ?? [];
          const productColumns = {
            name: productsTable.name,
            description: productsTable.description,
            targetAudience: productsTable.targetAudience,
            painPointsSolved: productsTable.painPointsSolved,
            keyFeatures: productsTable.keyFeatures,
            differentiators: productsTable.differentiators,
            pricingModel: productsTable.pricingModel,
          };
          const selectedProducts = await withTenant(this.tenantId, async (tx) => {
            if (productIds.length > 0) {
              return tx.select(productColumns).from(productsTable)
                .where(and(inArray(productsTable.id, productIds), eq(productsTable.isActive, true)));
            }
            // No productIds configured → load ALL active products for this tenant
            return tx.select(productColumns).from(productsTable)
              .where(and(eq(productsTable.tenantId, this.tenantId), eq(productsTable.isActive, true)));
          });
          if (!pipelineContext.sales) pipelineContext.sales = {};
          if (selectedProducts.length > 0) {
            pipelineContext.sales.products = selectedProducts;
          }
        }
      } catch (err) {
        logger.warn({ err, masterAgentId }, 'Failed to load company profile / products');
      }

      // 3c-iii. Action plan — generate (if not yet present) and gate the rest
      // of the pipeline on user completion. Without this, outreach goes out
      // missing facts the agent can't infer (links, comp band, calendly, etc.).
      const existingPlan = (agent.actionPlan as ActionPlan | null) ?? null;
      let actionPlan: ActionPlan;
      if (!existingPlan) {
        const items = buildActionPlan(
          agent.useCase as 'sales' | 'recruitment' | 'custom',
          pipelineContext,
          agentConfig,
        );
        actionPlan = {
          status: isActionPlanComplete(items) ? 'completed' : 'pending',
          items,
          generatedAt: new Date().toISOString(),
        };
      } else {
        actionPlan = existingPlan;
      }

      const planNeedsAnswers = actionPlan.status === 'pending';
      if (planNeedsAnswers) {
        // Persist plan + flip status; user must answer before pipeline proceeds.
        await withTenant(this.tenantId, async (tx) => {
          await tx.update(masterAgents).set({
            actionPlan,
            status: 'awaiting_action_plan',
            config: { ...agentConfig, pipelineContext },
            updatedAt: new Date(),
          }).where(eq(masterAgents.id, masterAgentId));
        });
        const requiredOpen = actionPlan.items.filter(i => i.required && !i.answer).length;
        this.sendMessage(null, 'system_alert', {
          action: 'action_plan_required',
          severity: 'warning',
          requiredOpen,
          totalItems: actionPlan.items.length,
          message: `I need ${requiredOpen} answer${requiredOpen === 1 ? '' : 's'} from you before outreach can start. Please open the master agent and complete the Action Plan.`,
        });
        logger.info(
          { masterAgentId, requiredOpen, totalItems: actionPlan.items.length },
          'MasterAgent paused — action plan awaiting user answers',
        );
        return {
          masterAgentId,
          status: 'awaiting_action_plan',
          actionPlan,
          dispatched: 0,
        };
      }

      // Action plan exists and is complete (or had nothing required) — persist
      // it without altering status, then continue with strategist + dispatch.
      if (!existingPlan) {
        await withTenant(this.tenantId, async (tx) => {
          await tx.update(masterAgents).set({
            actionPlan,
            updatedAt: new Date(),
          }).where(eq(masterAgents.id, masterAgentId));
        });
      }

      // 3d. Run strategist INLINE so its search queries feed discovery
      {
        try {
          const { StrategistAgent } = await import('./strategist.agent.js');
          const strategist = new StrategistAgent({ tenantId: this.tenantId, masterAgentId });

          // Run with 60s timeout; fall back to fire-and-forget if it takes too long
          const strategyPromise = strategist.execute({ job: 'initialStrategy', masterAgentId, pipelineContext });
          const timeoutPromise = new Promise<null>((resolve) => setTimeout(() => resolve(null), 180000));
          const strategyResult = await Promise.race([strategyPromise, timeoutPromise]);

          await strategist.close();

          if (strategyResult && strategyResult.strategy) {
            const strategy = strategyResult.strategy as SalesStrategy;
            if (!pipelineContext.sales) pipelineContext.sales = {};
            pipelineContext.sales.salesStrategy = strategy;

            // Server-side dataSourceStrategy fallback — the LLM strategist does not reliably
            // emit this field. Without it, the downstream guards at lines ~162 and ~190 that
            // gate the user alert + Chrome-extension task enqueue both no-op silently. Compute
            // it deterministically from the mission locations so those guards always have
            // something to evaluate.
            if (!strategy.dataSourceStrategy) {
              const locs = (pipelineContext.locations ?? []).map((l) => String(l ?? '').toLowerCase()).join(' ');
              let ds: NonNullable<SalesStrategy['dataSourceStrategy']>;
              if (/\b(uk|united kingdom|england|scotland|wales|northern ireland|london|manchester|birmingham|edinburgh|glasgow)\b/.test(locs)) {
                ds = {
                  primaryRegion: 'gb',
                  availableSources: [],
                  expectedQuality: 'limited',
                  needsChromeExtension: true,
                  userNotes: 'UK mission — public job-board coverage is limited. The Chrome-extension LinkedIn scraper is required for viable signal.',
                };
              } else if (/\b(ireland|ie|dublin|cork|galway)\b/.test(locs)) {
                ds = {
                  primaryRegion: 'ie',
                  availableSources: ['irishjobs'],
                  expectedQuality: 'medium',
                  needsChromeExtension: false,
                  userNotes: 'Ireland mission — using IrishJobs as the primary public source.',
                };
              } else if (/\b(france|fr|paris|lyon|marseille|toulouse|bordeaux|nice|nantes)\b/.test(locs)) {
                ds = {
                  primaryRegion: 'fr',
                  availableSources: ['welcometothejungle', 'freework'],
                  expectedQuality: 'excellent',
                  needsChromeExtension: false,
                  userNotes: 'France mission — Welcome to the Jungle + Free-Work provide excellent coverage.',
                };
              } else if (/\b(germany|de|berlin|munich|hamburg|frankfurt|cologne|stuttgart|düsseldorf|dusseldorf)\b/.test(locs)) {
                ds = {
                  primaryRegion: 'de',
                  availableSources: ['stepstone', 'northdata'],
                  expectedQuality: 'good',
                  needsChromeExtension: false,
                  userNotes: 'Germany mission — StepStone + Northdata cover the market well.',
                };
              } else if (/\b(spain|es|madrid|barcelona|valencia|seville|sevilla|bilbao|málaga|malaga)\b/.test(locs)) {
                ds = {
                  primaryRegion: 'es',
                  availableSources: ['infojobs'],
                  expectedQuality: 'medium',
                  needsChromeExtension: false,
                  userNotes: 'Spain mission — InfoJobs is the primary public source.',
                };
              } else if (/\b(usa|us|united states|new york|san francisco|los angeles|boston|chicago|seattle|austin|denver|miami)\b/.test(locs)) {
                ds = {
                  primaryRegion: 'us',
                  availableSources: ['dice', 'glassdoor'],
                  expectedQuality: 'medium',
                  needsChromeExtension: false,
                  userNotes: 'US mission — Dice + Glassdoor provide coverage; LinkedIn remains the best signal but is not required.',
                };
              } else if (/\b(estonia|ee|tallinn|tartu)\b/.test(locs)) {
                ds = {
                  primaryRegion: 'ee',
                  availableSources: ['cvkeskus'],
                  expectedQuality: 'medium',
                  needsChromeExtension: false,
                  userNotes: 'Estonia mission — CV-Keskus is the primary public source.',
                };
              } else {
                ds = {
                  primaryRegion: 'unknown',
                  availableSources: [],
                  expectedQuality: 'limited',
                  needsChromeExtension: true,
                  userNotes: `Unknown region (${(pipelineContext.locations ?? []).join(', ') || 'no locations provided'}) — falling back to the Chrome-extension LinkedIn scraper.`,
                };
              }
              strategy.dataSourceStrategy = ds;
              logger.info(
                { masterAgentId, region: ds.primaryRegion, needsChromeExtension: ds.needsChromeExtension, availableSources: ds.availableSources },
                'Computed dataSourceStrategy from locations (LLM did not provide it)',
              );
            }

            logger.info({ masterAgentId, queryCount: strategy.opportunitySearchQueries?.length ?? 0 }, 'StrategistAgent initial strategy completed (inline)');

            // Always tell the user which data sources the strategist picked.
            // If the region requires the Chrome-extension LinkedIn scraper, flag it.
            if (strategy.dataSourceStrategy) {
              const ds = strategy.dataSourceStrategy;
              this.sendMessage(null, 'system_alert', {
                action: 'data_sources_selected',
                severity: ds.needsChromeExtension ? 'warning' : 'info',
                region: ds.primaryRegion,
                expectedQuality: ds.expectedQuality,
                availableSources: ds.availableSources,
                needsChromeExtension: ds.needsChromeExtension,
                message: ds.userNotes ||
                  `For the ${(ds.primaryRegion ?? '').toUpperCase()} mission I'll use: ${(ds.availableSources || []).join(', ') || '(no public sources available)'}` +
                  (ds.needsChromeExtension
                    ? ` — please activate the Chrome-extension LinkedIn scraper for viable coverage.`
                    : ''),
              });
              logger.info(
                {
                  masterAgentId,
                  region: ds.primaryRegion,
                  availableSources: ds.availableSources,
                  needsChromeExtension: ds.needsChromeExtension,
                },
                'Data-sources-selected notice sent to user',
              );
            }

            // Show proposed pipeline steps to the user
            if (strategy.pipelineSteps?.length) {
              this.sendMessage(null, 'system_alert', {
                action: 'pipeline_steps_proposed',
                severity: 'info',
                steps: strategy.pipelineSteps,
                message: `Pipeline: ${strategy.pipelineSteps.map(s => s.tool + ':' + s.action).join(' → ')}`,
              });
              logger.info(
                { masterAgentId, stepCount: strategy.pipelineSteps.length, steps: strategy.pipelineSteps.map(s => `${s.id}(${s.tool})`) },
                'Pipeline steps proposed by strategist',
              );
            }

            // Dispatch company discovery. Hiring-signal scraping is server-side
            // (public LinkedIn Jobs pages, no login) and must run regardless of
            // `needsChromeExtension`. Industry-target search DOES need the
            // extension (LinkedIn company search requires auth). Previously the
            // entire block was gated on `needsChromeExtension`, which silently
            // skipped hiring_signal alerts when the strategist set the flag to
            // false. Fix 3: split the gate — hiring_signal runs unconditionally.
            try {
              const bdStrategy = strategy.bdStrategy || 'hybrid';
              const userRole = strategy.userRole || 'vendor';
              const targetIndustries = strategy.targetIndustries ?? [];
              const services = (agentConfig.services as string[]) ?? [];
              const industries = pipelineContext.sales?.industries ?? [];
              const locs = pipelineContext.locations ?? [];

              let extensionTasksDispatched = 0;

              // ─── Hiring signal path: server-side LinkedIn Jobs scrape ──
              // LinkedIn Jobs search is PUBLIC (no login) — scrape via CRAWL4AI.
              // Runs independently of `needsChromeExtension`.
              if (bdStrategy === 'hiring_signal' || bdStrategy === 'hybrid') {
                hiringSignalDispatched = true;
                logger.info(
                  { bdStrategy, masterAgentId, hasPipelineSteps: !!strategy.pipelineSteps?.length, needsChromeExtension: !!strategy.dataSourceStrategy?.needsChromeExtension },
                  'Entering hiring_signal/hybrid dispatch block',
                );
                // Resolve jobTitles (hiring keywords — what companies are POSTING,
                // NOT decision-maker titles we email). Priority chain:
                //   1) strategy.pipelineSteps[*].params.jobTitles (array form)
                //   2) strategy.pipelineSteps[*].params.jobTitle (legacy singular)
                //   3) strategy.hiringKeywords (new top-level strategy field)
                //   4) agentConfig.hiringKeywords (persisted override)
                //   5) generic fallback — DO NOT fall back to targetRoles
                const resolveJobTitles = (): { value: string[]; source: string } => {
                  const stepJobTitles = strategy.pipelineSteps
                    ?.flatMap(s => (s.params?.jobTitles as string[] | undefined) ?? [])
                    .filter(Boolean) ?? [];
                  if (stepJobTitles.length) {
                    return { value: stepJobTitles, source: 'strategy.pipelineSteps.params.jobTitles' };
                  }
                  const stepJobTitleSingular = strategy.pipelineSteps
                    ?.flatMap(s => {
                      const jt = s.params?.jobTitle as string | undefined;
                      return jt ? [jt] : [];
                    }) ?? [];
                  if (stepJobTitleSingular.length) {
                    return { value: stepJobTitleSingular, source: 'strategy.pipelineSteps.params.jobTitle (legacy)' };
                  }
                  if (strategy.hiringKeywords?.length) {
                    return { value: strategy.hiringKeywords, source: 'strategy.hiringKeywords' };
                  }
                  const cfgHiring = (agentConfig as Record<string, unknown>).hiringKeywords as string[] | undefined;
                  if (cfgHiring?.length) {
                    return { value: cfgHiring, source: 'agentConfig.hiringKeywords' };
                  }
                  return { value: ['software engineer', 'developer'], source: 'fallback' };
                };
                const { value: jobTitles, source: jobTitleSource } = resolveJobTitles();
                logger.info(
                  { jobTitles, jobTitleSource, count: jobTitles.length, masterAgentId },
                  'Resolved jobTitles for LinkedIn Jobs search',
                );

                const LINKEDIN_SCRAPE_DELAY_MS = 3000;
                const { searchLinkedInJobs } = await import('../tools/linkedin-jobs.tool.js');
                let isFirstCall = true;
                let totalJobsFound = 0;
                const perLocation: Array<{ location: string; count: number }> = [];
                const cappedJobTitles = jobTitles.slice(0, 10);

                for (const loc of locs) {
                  let locCount = 0;
                  for (const jobTitle of cappedJobTitles) {
                    if (!isFirstCall) {
                      await new Promise(r => setTimeout(r, LINKEDIN_SCRAPE_DELAY_MS));
                    }
                    isFirstCall = false;
                    try {
                      const result = await searchLinkedInJobs(this.tenantId, jobTitle, loc, masterAgentId);
                      logger.info(
                        { masterAgentId, jobTitle, location: loc, companiesFound: result.companies.length },
                        'Server-side LinkedIn Jobs scrape completed (per-keyword)',
                      );
                      locCount += result.companies.length;
                    } catch (err) {
                      logger.warn({ err, masterAgentId, jobTitle, location: loc }, 'Server-side LinkedIn Jobs scrape failed');
                    }
                  }
                  perLocation.push({ location: loc, count: locCount });
                  totalJobsFound += locCount;
                }

                // Classify the aggregate outcome and, if weak, negotiate with
                // the user via a search_quality_low system_alert. Persist a
                // pendingSearchChoice so the route handler + chat fallback can
                // re-apply the user's decision later. Pipeline execution
                // continues — we don't block on user reply.
                const outcome: 'empty' | 'thin' | 'ok' =
                  totalJobsFound === 0 ? 'empty' : totalJobsFound < 10 ? 'thin' : 'ok';
                logger.info(
                  {
                    masterAgentId,
                    jobTitleCount: cappedJobTitles.length,
                    locationCount: locs.length,
                    totalJobsFound,
                    outcome,
                    perLocation,
                    fetchCompanyEnqueueExpected: totalJobsFound,
                  },
                  'LinkedIn Jobs dispatch aggregate',
                );

                if (outcome !== 'ok') {
                  try {
                    const jobTitleDisplay = cappedJobTitles.join(', ');
                    const pendingSearchChoice = {
                      jobTitle: jobTitleDisplay,
                      jobTitles: cappedJobTitles,
                      locations: [...locs],
                      perLocation,
                      firedAt: new Date().toISOString(),
                      totalFound: totalJobsFound,
                    };
                    await withTenant(this.tenantId, async (tx) => {
                      await tx.update(masterAgents)
                        .set({
                          config: { ...agentConfig, pendingSearchChoice },
                          updatedAt: new Date(),
                        })
                        .where(eq(masterAgents.id, masterAgentId));
                    });
                    (agentConfig as Record<string, unknown>).pendingSearchChoice = pendingSearchChoice;

                    this.sendMessage(null, 'system_alert', {
                      action: 'search_quality_low',
                      severity: 'warning',
                      outcome,
                      totalFound: totalJobsFound,
                      jobTitle: jobTitleDisplay,
                      jobTitles: cappedJobTitles,
                      perLocation,
                      message:
                        outcome === 'empty'
                          ? `I searched LinkedIn Jobs for "${jobTitleDisplay}" across ${locs.length} location(s) and found 0 companies. The keyword combo looks too narrow.`
                          : `I found only ${totalJobsFound} companies for "${jobTitleDisplay}". Quality might be thin — happy to broaden.`,
                      choices: [
                        { id: 'continue', label: 'Continue with what I have' },
                        { id: 'broaden_manual', label: 'Let me type a broader term' },
                        { id: 'broaden_auto', label: 'Broaden it for me' },
                      ],
                    });
                  } catch (persistErr) {
                    logger.warn({ err: persistErr, masterAgentId }, 'Failed to persist pendingSearchChoice');
                  }
                }
              }

              // ─── Industry target path: search_companies (requires extension)
              if (
                (bdStrategy === 'industry_target' || bdStrategy === 'hybrid') &&
                strategy.dataSourceStrategy?.needsChromeExtension
              ) {
                const { enqueueExtensionTask } = await import('../services/extension-dispatcher.js');
                let searchTerms: string[];
                if (userRole === 'vendor' && targetIndustries.length > 0) {
                  searchTerms = targetIndustries.slice(0, 5);
                } else if (targetIndustries.length > 0) {
                  searchTerms = targetIndustries.slice(0, 5);
                } else if (industries.length > 0) {
                  searchTerms = industries.slice(0, 5);
                } else if (services.length > 0) {
                  searchTerms = services.slice(0, 5);
                } else {
                  searchTerms = ['technology consulting'];
                }

                for (const term of searchTerms) {
                  for (const loc of locs) {
                    await enqueueExtensionTask({
                      tenantId: this.tenantId,
                      masterAgentId,
                      site: 'linkedin',
                      type: 'search_companies',
                      params: { industry: term, location: loc, limit: 20 },
                      priority: 7,
                    });
                    extensionTasksDispatched++;
                  }
                }

                logger.info({ masterAgentId, extensionTasksDispatched, bdStrategy, locs }, 'Chrome-extension LinkedIn tasks enqueued');
                if (extensionTasksDispatched > 0) {
                  this.sendMessage(null, 'system_alert', {
                    action: 'extension_tasks_enqueued',
                    severity: 'info',
                    count: extensionTasksDispatched,
                    message: `Queued ${extensionTasksDispatched} LinkedIn search${extensionTasksDispatched > 1 ? 'es' : ''} for the Chrome extension. They will run as soon as the extension connects.`,
                  });
                }
              }
            } catch (extErr) {
              logger.warn({ err: extErr, masterAgentId }, 'Failed to dispatch LinkedIn tasks');
            }

            // Always persist latest strategist output to config so subsequent runs
            // (resume, restart, re-dispatch) use the freshest bdStrategy / pipelineSteps /
            // dataSourceStrategy. Previously this was gated on `!agentConfig.bdStrategy`,
            // which meant stale values won after the first run — causing hiring_signal
            // missions to silently fall back to WTTJ-style discovery.
            if (strategy.bdStrategy) {
              try {
                const mergedConfig = {
                  ...agentConfig,
                  bdStrategy: strategy.bdStrategy,
                  dataSourceStrategy: strategy.dataSourceStrategy ?? agentConfig.dataSourceStrategy,
                  pipelineSteps: strategy.pipelineSteps ?? agentConfig.pipelineSteps,
                };
                await withTenant(this.tenantId, async (tx) => {
                  await tx.update(masterAgents)
                    .set({ config: mergedConfig, updatedAt: new Date() })
                    .where(eq(masterAgents.id, masterAgentId));
                });
                // Reflect the overwrite locally so the downstream dispatch decision
                // (dispatchBdStrategy ~L708) sees the fresh strategist value.
                agentConfig.bdStrategy = strategy.bdStrategy;
                if (strategy.dataSourceStrategy) agentConfig.dataSourceStrategy = strategy.dataSourceStrategy;
                if (strategy.pipelineSteps) agentConfig.pipelineSteps = strategy.pipelineSteps;
                logger.info(
                  { masterAgentId, bdStrategy: strategy.bdStrategy, pipelineStepsCount: strategy.pipelineSteps?.length ?? 0 },
                  'Strategist output saved to config (overwriting prior)',
                );
              } catch (saveErr) {
                logger.warn({ err: saveErr, masterAgentId }, 'Failed to save strategist BD strategy');
              }
            }
          } else {
            logger.warn({ masterAgentId }, 'Strategist timed out — falling back to fire-and-forget');
            await this.dispatchNext('strategist', {
              job: 'initialStrategy',
              masterAgentId,
              pipelineContext,
            });
          }
        } catch (err) {
          logger.warn({ err, masterAgentId }, 'Failed to run strategist inline, dispatching fire-and-forget');
          try {
            await this.dispatchNext('strategist', {
              job: 'initialStrategy',
              masterAgentId,
              pipelineContext,
            });
          } catch (dispatchErr) {
            logger.warn({ err: dispatchErr, masterAgentId }, 'Failed to dispatch strategist fallback');
          }
        }
      }

      // 4. Auto-create campaign (or reuse existing) + save all config in one write
      if (enableOutreach) {
        campaignId = await withTenant(this.tenantId, async (tx) => {
          // Check for existing active campaign
          const [existing] = await tx.select().from(campaigns)
            .where(and(
              eq(campaigns.masterAgentId, masterAgentId),
              eq(campaigns.tenantId, this.tenantId),
              eq(campaigns.status, 'active'),
            ))
            .limit(1);

          let cid: string;
          if (existing) {
            cid = existing.id;
            logger.info({ masterAgentId, campaignId: cid }, 'Reusing existing campaign');
          } else {
            const [newCampaign] = await tx.insert(campaigns).values({
              tenantId: this.tenantId,
              masterAgentId,
              name: `Auto: ${agent.name}`,
              type: 'email',
              status: 'active',
            }).returning();
            cid = newCampaign!.id;

            await tx.insert(campaignSteps).values([
              { campaignId: cid, stepNumber: 1, subject: 'Initial outreach', delayDays: 0, channel: 'email' as const },
              { campaignId: cid, stepNumber: 2, subject: 'Follow-up', delayDays: 3, channel: 'email' as const },
              { campaignId: cid, stepNumber: 3, subject: 'Final follow-up', delayDays: 7, channel: 'email' as const },
            ]);
          }

          // SINGLE combined config save — all data in one write
          await tx
            .update(masterAgents)
            .set({
              config: { ...agentConfig, ...requirements, campaignId: cid, pipelineContext },
              updatedAt: new Date(),
            })
            .where(eq(masterAgents.id, masterAgentId));

          return cid;
        });

        logger.info({ tenantId: this.tenantId, masterAgentId, campaignId }, 'MasterAgent auto-created campaign');

        // Update pipelineContext with campaignId
        if (pipelineContext) pipelineContext.campaignId = campaignId;
      } else {
        // Outreach disabled — just save config without campaign
        await withTenant(this.tenantId, async (tx) => {
          await tx
            .update(masterAgents)
            .set({
              config: { ...agentConfig, ...requirements, pipelineContext },
              updatedAt: new Date(),
            })
            .where(eq(masterAgents.id, masterAgentId));
        });
        logger.info({ tenantId: this.tenantId, masterAgentId }, 'MasterAgent: outreach disabled, skipping campaign creation');
      }

      // 5. Generate search queries — only needed for legacy SearXNG path.
      // When USE_COMPANY_FINDER=true, the company-finder agent runs its own
      // mission analysis against SITE_CONFIGS and does not consume `queries`.
      if (!env.USE_COMPANY_FINDER) {
        const queryMessages = [
          { role: 'system' as const, content: discoverySystemPrompt(agent.useCase) },
          {
            role: 'user' as const,
            content: discoveryUserPrompt({
              targetRoles: (requirements.targetRoles as string[]) ?? [],
              requiredSkills: (requirements.requiredSkills as string[]) ?? [],
              locations: (requirements.locations as string[]) ?? [],
              industries: ((requirements.searchCriteria as Record<string, unknown>)?.industries as string[]) ?? [],
              keywords: ((requirements.searchCriteria as Record<string, unknown>)?.keywords as string[]) ?? [],
              useCase: agent.useCase,
            }),
          },
        ];

        const queryResult = await this.trackAction('queries_generated', 'Generating search queries', () =>
          this.extractJSON<{ queries: string[] }>(queryMessages),
        );
        queries = queryResult.queries ?? [];
      }
    } else {
      logger.info({ tenantId: this.tenantId, masterAgentId, enabledAgents }, 'MasterAgent skipping discovery — not in pipeline');
    }

    // 6. Upsert agentConfigs — only for enabled agents (or all if no pipeline)
    const agentTypesToCreate = enabledAgents
      ? AGENT_TYPES.filter(t => enabledAgents.includes(t))
      : AGENT_TYPES;

    await withTenant(this.tenantId, async (tx) => {
      for (const agentType of agentTypesToCreate) {
        const existing = await tx
          .select()
          .from(agentConfigs)
          .where(
            and(
              eq(agentConfigs.masterAgentId, masterAgentId),
              eq(agentConfigs.agentType, agentType),
              eq(agentConfigs.tenantId, this.tenantId),
            ),
          )
          .limit(1);

        if (existing.length === 0) {
          await tx.insert(agentConfigs).values({
            tenantId: this.tenantId,
            masterAgentId,
            agentType,
            parameters: requirements as Record<string, unknown>,
            isEnabled: true,
          });
        } else {
          await tx
            .update(agentConfigs)
            .set({ parameters: requirements as Record<string, unknown>, updatedAt: new Date() })
            .where(eq(agentConfigs.id, existing[0]!.id));
        }
      }
    });

    // 6b. SearXNG health check — warn user if search is unavailable
    if (hasDiscovery) {
      const searxngStatus = await checkSearxngHealth();
      if (!searxngStatus.ok) {
        logger.error({ masterAgentId, url: searxngStatus.url, error: searxngStatus.error }, 'SearXNG unreachable — discovery will return empty results');
        this.sendMessage(null, 'system_alert', {
          action: 'service_unavailable',
          service: 'searxng',
          url: searxngStatus.url,
          error: searxngStatus.error,
          message: 'Web search (SearXNG) is not reachable. Discovery agents will not find new companies. Please check that SearXNG is running.',
        });
        await this.emitEvent('pipeline:service_down', { service: 'searxng', url: searxngStatus.url });
      }
    }

    logger.info(
      { masterAgentId, useCompanyFinder: env.USE_COMPANY_FINDER, hasDiscovery },
      'Master agent dispatch mode',
    );

    // 7. Dispatch discovery jobs — branches on USE_COMPANY_FINDER feature flag.
    //    When true: single company-finder job reads SITE_CONFIGS directly.
    //    When false: legacy SearXNG-based discovery batches (preserved for rollback).
    //    For bdStrategy='hiring_signal', LinkedIn Jobs scrape above already covered
    //    discovery — skip company-finder/crawler entirely to avoid polluting the
    //    pipeline with unrelated industry/SERP results.
    // Prefer the freshest strategist output (in-memory from this run) over the
    // persisted agentConfig — stale config historically caused hiring_signal agents
    // to fall back to hybrid/WTTJ discovery.
    // Trust ONLY the freshest strategist output. Persisted agentConfig.bdStrategy is
    // intentionally NOT consulted here — when the inline strategist times out or
    // throws, we must NOT silently inherit a stale `hiring_signal` decision from a
    // prior run, because the LinkedIn Jobs dispatch lives inside the strategist
    // success branch. Inheriting stale config would skip discovery and produce zero
    // results. The strategist itself is responsible for always returning a strategy
    // (retry + deterministic fallback live in StrategistAgent).
    const strategistBd = pipelineContext?.sales?.salesStrategy?.bdStrategy as string | undefined;
    const dispatchBdStrategy = strategistBd || 'hybrid';
    logger.info(
      {
        masterAgentId,
        dispatchBdStrategy,
        sources: {
          strategist: strategistBd ?? null,
          agentConfigIgnored: (agentConfig.bdStrategy as string) ?? null,
        },
      },
      'Computed dispatchBdStrategy for discovery gate',
    );
    const skipDiscoveryForHiringSignal = dispatchBdStrategy === 'hiring_signal';
    if (skipDiscoveryForHiringSignal) {
      logger.info(
        { masterAgentId, bdStrategy: dispatchBdStrategy },
        'Skipping company-finder/discovery — bdStrategy=hiring_signal uses LinkedIn Jobs as sole discovery source',
      );
    }
    if (hasDiscovery && !skipDiscoveryForHiringSignal) {
      // Extension-primary regions: the strategist already queued search_companies
      // tasks against the user's Chrome extension (see block around line 190).
      // If the extension is actually online, don't *also* fan out crawler-based
      // discovery — it would re-do the same work via SearxNG/Crawl4AI and pollute
      // the pipeline with low-signal rows. If the extension is flagged but
      // offline, fall through to the crawler path so missions don't silently stall.
      const { isExtensionConnected } = await import('../services/extension-dispatcher.js');

      // Pipeline steps can override the extension/crawler decision
      const pipelineSteps = pipelineContext?.sales?.salesStrategy?.pipelineSteps;
      let needsExtension =
        pipelineContext?.sales?.salesStrategy?.dataSourceStrategy?.needsChromeExtension === true;

      if (pipelineSteps?.length) {
        const rootSteps = pipelineSteps.filter(s => s.dependsOn.length === 0);
        const hasExtensionRoot = rootSteps.some(s => s.tool === 'LINKEDIN_EXTENSION');
        if (hasExtensionRoot && !needsExtension) {
          needsExtension = true;
          logger.info({ masterAgentId }, 'Pipeline steps override: LINKEDIN_EXTENSION in root → needsExtension=true');
        } else if (!hasExtensionRoot && needsExtension) {
          needsExtension = false;
          logger.info({ masterAgentId }, 'Pipeline steps override: no LINKEDIN_EXTENSION in root → needsExtension=false');
        }
      }

      const extensionOnline = needsExtension ? await isExtensionConnected(this.tenantId) : false;
      const skipCrawlerDiscovery = needsExtension && extensionOnline;

      if (skipCrawlerDiscovery) {
        logger.info(
          { masterAgentId, tenantId: this.tenantId },
          'Extension-primary region with live extension — skipping crawler discovery/company-finder dispatch',
        );
        this.sendMessage(null, 'system_alert', {
          action: 'crawler_discovery_skipped',
          severity: 'info',
          message:
            'Region is extension-primary and the Chrome extension is live. Discovery will run through the extension only.',
        });
      } else if (env.USE_COMPANY_FINDER) {
        // New path: LLM-based agent selector picks company-finder and/or candidate-finder.
        // Keyword hints pulled from requirements + any opportunity-focused strategy queries.
        const strategyQueries = pipelineContext?.sales?.salesStrategy?.opportunitySearchQueries ?? [];
        const strategyKeywords = strategyQueries
          .map((sq) => (typeof sq === 'string' ? sq : sq.query))
          .filter((s): s is string => Boolean(s));
        const baseKeywords = (requirements.requiredSkills as string[]) ?? [];
        const searchCriteriaKeywords =
          ((requirements.searchCriteria as Record<string, unknown>)?.keywords as string[]) ?? [];
        const mergedKeywords = Array.from(
          new Set([...baseKeywords, ...searchCriteriaKeywords, ...strategyKeywords]),
        ).filter((k) => k && k.trim().length > 0);

        const industries =
          ((requirements.idealCustomerProfile as Record<string, unknown>)?.industries as string[]) ??
          ((requirements.searchCriteria as Record<string, unknown>)?.industries as string[]) ??
          [];

        const sharedMissionContext = {
          mission: agent.mission ?? '',
          locations: (requirements.locations as string[]) ?? [],
          industries,
          targetRoles: (requirements.targetRoles as string[]) ?? [],
          requiredSkills: (requirements.requiredSkills as string[]) ?? [],
          experienceLevel: requirements.experienceLevel as string | undefined,
          keywords: mergedKeywords,
        };

        // Read BD strategy — re-read config in case strategist updated it
        let bdStrategy = (agentConfig.bdStrategy as string) || 'hybrid';
        if (!agentConfig.bdStrategy && pipelineContext?.sales?.salesStrategy?.bdStrategy) {
          bdStrategy = pipelineContext.sales.salesStrategy.bdStrategy;
        }
        logger.info({ masterAgentId, bdStrategy, useCase: agent.useCase }, 'Master agent: BD strategy');

        // LLM picks one or both finders.
        let selection: agentSelectorPrompt.AgentSelection;
        try {
          selection = await this.extractJSON<agentSelectorPrompt.AgentSelection>(
            [
              { role: 'system', content: agentSelectorPrompt.buildAgentSelectorSystemPrompt() },
              {
                role: 'user',
                content: agentSelectorPrompt.buildAgentSelectorUserPrompt({
                  mission: agent.mission ?? '',
                  useCase: agent.useCase ?? undefined,
                  targetRoles: sharedMissionContext.targetRoles,
                  industries: sharedMissionContext.industries,
                  locations: sharedMissionContext.locations,
                }),
              },
            ],
            1,
          );
        } catch (err) {
          logger.warn({ err, masterAgentId }, 'Agent selector failed — defaulting by useCase');
          selection = {
            selectedAgents: agent.useCase === 'recruitment' ? ['candidate-finder'] : ['company-finder'],
            reasoning: 'fallback (LLM error)',
          };
        }

        const valid = (Array.isArray(selection.selectedAgents) ? selection.selectedAgents : []).filter(
          (a): a is 'company-finder' | 'candidate-finder' | 'linkedin' =>
            a === 'company-finder' || a === 'candidate-finder' || a === 'linkedin',
        );
        if (valid.length === 0) {
          valid.push(agent.useCase === 'recruitment' ? 'candidate-finder' : 'company-finder');
        }

        logger.info(
          { masterAgentId, selectedAgents: valid, reasoning: selection.reasoning },
          'Agent selector decision',
        );

        for (const agentType of valid) {
          const jobId = await this.dispatchNext(agentType, {
            masterAgentId,
            missionContext: { ...sharedMissionContext, bdStrategy },
            pipelineContext,
            dryRun: dryRun || undefined,
          });
          dispatchedJobIds.push(jobId);
          logger.info({ masterAgentId, jobId, agentType }, 'Dispatched finder job');
        }
      } else {
        // Legacy path: SearXNG-based discovery batching (kept for rollback).
        let jobIndex = 0;

        // Helper: batch delay = batchIndex * 5 min + withinBatch * 2s
        const getBatchDelay = (i: number) => {
          const batchIndex = Math.floor(i / 5);
          const withinBatch = i % 5;
          return batchIndex * 300000 + withinBatch * 2000;
        };

        // 7a. For sales: dispatch opportunity-focused queries FIRST
        const strategyQueries = pipelineContext?.sales?.salesStrategy?.opportunitySearchQueries;
        if (strategyQueries && strategyQueries.length > 0) {
          for (const sq of strategyQueries) {
            const searchQuery = typeof sq === 'string' ? sq : sq.query;
            if (!searchQuery) continue;
            const jobId = await this.dispatchNext(
              'discovery',
              {
                searchQueries: [searchQuery],
                maxResults: 10,
                masterAgentId,
                opportunityFocused: true,
                pipelineContext,
                dryRun: dryRun || undefined,
              },
              { delay: getBatchDelay(jobIndex) },
            );
            dispatchedJobIds.push(jobId);
            jobIndex++;
          }
          logger.info({ masterAgentId, strategyQueryCount: strategyQueries.length }, 'Dispatched opportunity-focused discovery jobs (Phase 1)');
        }

        // 7b. Dispatch standard discovery queries in batches of 5
        for (const q of queries) {
          const jobId = await this.dispatchNext(
            'discovery',
            {
              searchQueries: [q!],
              maxResults: 10,
              masterAgentId,
              pipelineContext,
              dryRun: dryRun || undefined,
            },
            { delay: getBatchDelay(jobIndex) },
          );
          dispatchedJobIds.push(jobId);
          jobIndex++;
        }

        // 7c. Dispatch deep discovery job 15 minutes after start
        const deepJobId = await this.dispatchNext(
          'discovery',
          {
            deepDiscovery: true,
            discoveryParams: {
              keywords: queries.slice(0, 5),
              industry: ((requirements.searchCriteria as Record<string, unknown>)?.industries as string[])?.[0],
              location: (requirements.locations as string[])?.[0],
              techStack: requirements.requiredSkills as string[],
              targetRoles: requirements.targetRoles as string[],
              useCase: agent.useCase as 'recruitment' | 'sales',
              targetCountries: (agentConfig.targetCountries as string[]) ?? undefined,
            },
            masterAgentId,
            pipelineContext,
            dryRun: dryRun || undefined,
          },
          { delay: 900000 }, // 15 minutes
        );
        dispatchedJobIds.push(deepJobId);
      }
    }

    // Assertion: if we skipped the regular discovery gate because this is a
    // hiring_signal agent, the LinkedIn Jobs dispatch block MUST have run.
    // If it did not, the pipeline will produce zero discovery — surface it
    // as a structured error so the UI can tell the user what's wrong.
    if (skipDiscoveryForHiringSignal && !hiringSignalDispatched) {
      logger.error(
        { masterAgentId, dispatchBdStrategy, tenantId: this.tenantId },
        'CRITICAL: hiring_signal agent skipped discovery but LinkedIn Jobs dispatch never ran',
      );
      await logPipelineError({
        tenantId: this.tenantId,
        masterAgentId,
        step: 'dispatch',
        tool: 'MASTER',
        errorType: 'wrong_tool',
        severity: 'error',
        context: { dispatchBdStrategy, agentConfigBd: (agentConfig.bdStrategy as string) ?? null },
      });
    }

    const dispatchedToAgent = env.USE_COMPANY_FINDER ? 'finder' : 'discovery';

    this.sendMessage(null, 'task_assignment', {
      action: 'dispatched',
      toAgent: dispatchedToAgent,
      jobCount: dispatchedJobIds.length,
      queryCount: queries.length,
    });

    await this.emitEvent('master:started', {
      masterAgentId,
      queryCount: queries.length,
      jobIds: dispatchedJobIds,
      enabledAgents: enabledAgents ?? 'all',
    });

    this.logActivity('master_completed', 'completed', {
      details: { queryCount: queries.length, dispatchedJobs: dispatchedJobIds.length, enabledAgents: enabledAgents ?? 'all' },
    });
    await this.clearCurrentAction();

    logger.info(
      {
        tenantId: this.tenantId,
        masterAgentId,
        queryCount: queries.length,
        jobCount: dispatchedJobIds.length,
        mode: dispatchedToAgent,
        enabledAgents,
      },
      `MasterAgent dispatched ${dispatchedToAgent} jobs`,
    );

    return {
      parsedRequirements: requirements,
      queryCount: queries.length,
      dispatchedJobIds,
      enabledAgents: enabledAgents ?? 'all',
    };
  }

  /**
   * Orchestration loop — called periodically by a repeatable BullMQ job.
   * Collects pipeline metrics, makes decisions, and adjusts the pipeline.
   */
  async orchestrate(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { masterAgentId } = input as { masterAgentId: string };

    logger.info({ tenantId: this.tenantId, masterAgentId }, 'MasterAgent orchestration loop starting');

    // 0. Load pipelineContext from master agent config for enrichment dispatches
    let pipelineCtx: PipelineContext | undefined;
    try {
      const [agentRow] = await withTenant(this.tenantId, async (tx) => {
        return tx.select({ config: masterAgents.config, useCase: masterAgents.useCase })
          .from(masterAgents)
          .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
          .limit(1);
      });
      if (agentRow) {
        const cfg = (agentRow.config as Record<string, unknown>) ?? {};
        pipelineCtx = (cfg.pipelineContext as PipelineContext) ?? { useCase: agentRow.useCase ?? undefined } as PipelineContext;
      }
    } catch (err) {
      logger.warn({ err, masterAgentId }, 'Failed to load pipelineContext for orchestration');
    }

    // 1. Collect pipeline metrics
    const metrics = await withTenant(this.tenantId, async (tx) => {
      const statusCounts = await tx
        .select({
          status: contacts.status,
          count: count(),
        })
        .from(contacts)
        .where(and(eq(contacts.tenantId, this.tenantId), eq(contacts.masterAgentId, masterAgentId)))
        .groupBy(contacts.status);

      const byStatus: Record<string, number> = {};
      for (const row of statusCounts) {
        byStatus[row.status] = Number(row.count);
      }

      return {
        discovered: byStatus.discovered ?? 0,
        enriched: byStatus.enriched ?? 0,
        scored: byStatus.scored ?? 0,
        contacted: byStatus.contacted ?? 0,
        archived: byStatus.archived ?? 0,
        rejected: byStatus.rejected ?? 0,
        total: Object.values(byStatus).reduce((a, b) => a + b, 0),
      };
    });

    // 2. Compute rates
    const enrichmentRate = metrics.total > 0 ? ((metrics.enriched + metrics.scored + metrics.contacted) / metrics.total) * 100 : 0;
    const archiveRate = metrics.total > 0 ? (metrics.archived / metrics.total) * 100 : 0;
    const scoringAcceptRate = (metrics.enriched + metrics.scored + metrics.contacted) > 0
      ? ((metrics.scored + metrics.contacted) / (metrics.enriched + metrics.scored + metrics.contacted)) * 100 : 0;

    // 3. Make decisions and take action
    const decisions: string[] = [];
    const actions: string[] = [];

    // 3z. When metrics are all zero, check BullMQ queue status for diagnostics
    if (metrics.total === 0) {
      try {
        const [discoveryQ, enrichmentQ, scoringQ] = await Promise.all([
          getQueueStatus(this.tenantId, 'discovery'),
          getQueueStatus(this.tenantId, 'enrichment'),
          getQueueStatus(this.tenantId, 'scoring'),
        ]);

        const totalActive = discoveryQ.active + enrichmentQ.active + scoringQ.active;
        const totalWaiting = discoveryQ.waiting + enrichmentQ.waiting + scoringQ.waiting;
        const totalDelayed = discoveryQ.delayed + enrichmentQ.delayed + scoringQ.delayed;
        const totalFailed = discoveryQ.failed + enrichmentQ.failed + scoringQ.failed;

        if (totalActive > 0 || totalWaiting > 0 || totalDelayed > 0) {
          decisions.push(`Pipeline initializing — ${totalActive} active, ${totalWaiting} waiting, ${totalDelayed} delayed jobs across queues.`);
        } else if (totalFailed > 0) {
          decisions.push(`WARNING: ${totalFailed} failed jobs detected (discovery: ${discoveryQ.failed}, enrichment: ${enrichmentQ.failed}, scoring: ${scoringQ.failed}). Check worker logs for errors.`);
        } else {
          decisions.push('No contacts found yet — waiting for discovery to produce results.');
        }

        logger.info({
          masterAgentId,
          queueStatus: {
            discovery: discoveryQ,
            enrichment: enrichmentQ,
            scoring: scoringQ,
          },
        }, 'Orchestrator: metrics total=0, checked queue status');
      } catch (err) {
        logger.warn({ err, masterAgentId }, 'Failed to check queue status in orchestrator');
        decisions.push('No contacts found yet — queue status check failed.');
      }
    }

    // 3a. Check if strategist generated queries that weren't dispatched yet.
    //     This path dispatches LEGACY discovery jobs — only run when company-finder
    //     is disabled. With company-finder on, the strategist queries are already
    //     consumed via pipelineContext.sales.salesStrategy.opportunitySearchQueries
    //     inside CompanyFinderAgent.
    if (!env.USE_COMPANY_FINDER) {
      try {
        const [agentRow] = await withTenant(this.tenantId, async (tx) => {
          return tx.select({ config: masterAgents.config }).from(masterAgents)
            .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
            .limit(1);
        });
        const cfg = (agentRow?.config as Record<string, unknown>) ?? {};
        const salesStrategy = cfg.salesStrategy as SalesStrategy | undefined;
        const pendingQueries = salesStrategy?.opportunitySearchQueries;
        const alreadyDispatched = (cfg.dispatchedStrategyQueries as boolean) ?? false;

        if (pendingQueries?.length && !alreadyDispatched && metrics.discovered === 0) {
          let jobIdx = 0;
          for (const sq of pendingQueries) {
            const searchQuery = typeof sq === 'string' ? sq : (sq as Record<string, unknown>).query as string;
            if (!searchQuery) continue;
            await this.dispatchNext('discovery', {
              searchQueries: [searchQuery],
              maxResults: 10,
              masterAgentId,
              opportunityFocused: true,
            }, { delay: jobIdx * 5000 });
            jobIdx++;
          }
          // Mark as dispatched to avoid re-dispatching on next cycle
          await withTenant(this.tenantId, async (tx) => {
            await tx.update(masterAgents).set({
              config: { ...cfg, dispatchedStrategyQueries: true },
              updatedAt: new Date(),
            }).where(eq(masterAgents.id, masterAgentId));
          });
          if (jobIdx > 0) {
            actions.push(`Dispatched ${jobIdx} strategist queries as discovery jobs`);
            decisions.push('Found undispatched strategist queries — dispatching them now.');
            logger.info({ masterAgentId, queryCount: jobIdx }, 'Orchestrator dispatched undispatched strategist queries');
          }
        }
      } catch (err) {
        logger.warn({ err, masterAgentId }, 'Failed to check strategist queries in orchestration');
      }
    } else {
      logger.debug(
        { masterAgentId },
        'Orchestrator: skipping legacy strategist→discovery dispatch (USE_COMPANY_FINDER=true)',
      );
    }

    if (archiveRate > 60) {
      decisions.push('High archive rate detected — discovery may be producing low-quality results.');
      this.sendMessage(null, 'reasoning', {
        action: 'orchestration_warning',
        warning: 'high_archive_rate',
        archiveRate: Math.round(archiveRate),
        suggestion: 'Review search queries — too many low-quality results are being archived.',
      });
    }

    if (scoringAcceptRate < 30 && (metrics.enriched + metrics.scored) > 10) {
      decisions.push('Low scoring acceptance rate — threshold may be too strict or enrichment data insufficient.');
    }

    if (metrics.discovered > 0 && metrics.enriched < Math.max(metrics.discovered * 0.5, 5)) {
      // Check enrichment queue size before dispatching — prevent queue explosion
      let enrichmentQueueWaiting = 0;
      try {
        const enrichmentQStatus = await getQueueStatus(this.tenantId, 'enrichment');
        enrichmentQueueWaiting = enrichmentQStatus.waiting + enrichmentQStatus.active;
      } catch { /* continue */ }

      if (enrichmentQueueWaiting > 100) {
        decisions.push(`Enrichment queue already has ${enrichmentQueueWaiting} waiting+active — skipping additional dispatches.`);
      } else {
        decisions.push('Enrichment bottleneck detected — dispatching enrichment for unenriched companies and contacts.');

        let dispatched = 0;

        // ACTION 1: Find companies with low dataCompleteness and dispatch enrichment
        try {
          const unenrichedCompanies = await withTenant(this.tenantId, async (tx) => {
            return tx.select({ id: companies.id, name: companies.name, domain: companies.domain })
              .from(companies)
              .where(and(
                eq(companies.tenantId, this.tenantId),
                eq(companies.masterAgentId, masterAgentId),
                lt(companies.dataCompleteness, 70),
              ))
              .limit(5);
          });

          for (const comp of unenrichedCompanies) {
            try {
              await this.dispatchNext('enrichment', {
                companyId: comp.id,
                masterAgentId,
                pipelineContext: pipelineCtx,
              });
              dispatched++;
            } catch (err) {
              logger.warn({ err, companyId: comp.id }, 'Failed to dispatch company enrichment from orchestrator');
            }
          }
        } catch (err) {
          logger.warn({ err, masterAgentId }, 'Failed to query unenriched companies for orchestration');
        }

        // ACTION 2: Find contacts stuck in 'discovered' status and dispatch enrichment
        try {
          const unenrichedContacts = await withTenant(this.tenantId, async (tx) => {
            return tx.select({ id: contacts.id })
              .from(contacts)
              .where(and(
                eq(contacts.tenantId, this.tenantId),
                eq(contacts.masterAgentId, masterAgentId),
                eq(contacts.status, 'discovered'),
              ))
              .limit(5);
          });

          for (const c of unenrichedContacts) {
            try {
              await this.dispatchNext('enrichment', { contactId: c.id, masterAgentId, pipelineContext: pipelineCtx });
              dispatched++;
            } catch (err) {
              logger.warn({ err, contactId: c.id }, 'Failed to dispatch contact enrichment from orchestrator');
            }
          }
        } catch (err) {
          logger.warn({ err, masterAgentId }, 'Failed to query unenriched contacts for orchestration');
        }

        if (dispatched > 0) {
          actions.push(`Dispatched enrichment for ${dispatched} unenriched companies/contacts`);
          this.sendMessage('enrichment', 'task_assignment', {
            action: 'orchestrator_enrichment_dispatch',
            count: dispatched,
            reason: 'enrichment_bottleneck',
          });
        }
      }
    }

    // Service outage detection: check last 10 enrichment tasks
    try {
      const recentEnrichments = await withTenant(this.tenantId, async (tx) => {
        return tx.select({ output: agentTasks.output })
          .from(agentTasks)
          .where(and(
            eq(agentTasks.tenantId, this.tenantId),
            eq(agentTasks.masterAgentId, masterAgentId),
            eq(agentTasks.agentType, 'enrichment' as any),
            eq(agentTasks.status, 'completed'),
          ))
          .orderBy(sql`created_at DESC`)
          .limit(10);
      });

      if (recentEnrichments.length >= 10) {
        const allBelow20 = recentEnrichments.every(e => {
          const output = e.output as Record<string, unknown> | null;
          return (output?.dataCompleteness as number ?? 0) < 20;
        });
        if (allBelow20) {
          decisions.push('POSSIBLE SERVICE OUTAGE: last 10 enrichments all below 20% completeness');
          await this.emitEvent('pipeline:service_outage_suspected', { masterAgentId });
          logger.error({ masterAgentId }, 'Possible service outage — last 10 enrichments all below 20% completeness');
        }
      }
    } catch (err) {
      logger.warn({ err, masterAgentId }, 'Failed to check for service outage in orchestrator');
    }

    // Re-enrichment disabled — enrichment_retry_count column not migrated to production DB
    // TODO: Re-enable after running db:generate + applying migration

    if (metrics.scored > 20 && metrics.contacted < 5) {
      decisions.push('Outreach bottleneck detected — scored contacts are not being contacted.');
    }

    this.sendMessage(null, 'reasoning', {
      action: 'orchestration_analysis',
      metrics,
      rates: {
        enrichmentRate: Math.round(enrichmentRate),
        archiveRate: Math.round(archiveRate),
        scoringAcceptRate: Math.round(scoringAcceptRate),
      },
      decisions: decisions.length > 0 ? decisions : ['Pipeline running normally — no adjustments needed.'],
      actionsTaken: actions.length > 0 ? actions : undefined,
    });

    this.logActivity('orchestration_completed', 'completed', {
      details: { metrics, decisions, actions },
    });

    logger.info({ masterAgentId, metrics, decisions, actions }, 'MasterAgent orchestration loop completed');

    return { metrics, decisions, actions };
  }
}
