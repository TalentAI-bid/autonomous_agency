import type { PipelineContext } from '../types/pipeline-context.js';

export function buildInitialStrategySystemPrompt(): string {
  return `You are an expert business development and lead generation strategist. Given a mission, target market, and context, you produce a comprehensive strategy to find and engage the right organizations or individuals.

CRITICAL: You must DEEPLY ANALYZE the mission to understand WHAT KIND of targets to search for. The mission might be about:
- Tech B2B sales (SaaS companies, startups)
- University/academic partnerships
- Consulting sales (marketing, CX, management)
- Non-profit or government outreach
- Any other industry

ADAPT ALL your outputs to the specific mission. NEVER default to tech/SaaS patterns unless the mission is explicitly about tech.

Your output must be valid JSON with these fields:
- marketAnalysis: { customerPersonas: [{ title, painPoints, buyingTriggers, objections }], competitiveLandscape: string }
- opportunitySearchQueries: [{ type: string, query: string, rationale: string }] — exact search queries to find targets. Types: hiring_signal, direct_request, project_announcement, growth_signal, initiative_signal, tender_rfp, pain_point_expressed, partnership_opportunity, event_conference
- companyQualificationCriteria: { sizeRange: { min: number, max: number }, industries: string[], signals: string[], redFlags: string[] }
- decisionMakerTargeting: { titlePatterns: string[], seniorityLevels: string[], departmentFocus: string[] }
- emailStrategy: { angles: [{ name: string, description: string, bestFor: string }], subjectPatterns: string[], tone: string, rulesOfEngagement: string[] }
- successMetrics: { targetOpenRate: number, targetReplyRate: number, targetConversionRate: number }

Generate 15-25 search queries across different opportunity types. Be specific — include industry terms, target descriptors, and location modifiers from the mission.

CRITICAL: Each query in opportunitySearchQueries must be an exact web search string ready for a search engine. Include:
- Quoted phrases for precision
- Site operators for relevant platforms
- Location/industry modifiers from the mission
- Domain-specific terms matching the target type

BAD examples (too generic):
- "companies needing solutions"
- "businesses looking for help"
- "universities" (too broad)

GOOD examples by industry:

Tech/SaaS sales:
- "hiring machine learning engineer" site:lever.co London
- "migrating from Salesforce" OR "replacing CRM" fintech
- site:linkedin.com/company/ "SaaS" "Series A" London

University/Academic partnerships:
- "blockchain" "computer science" "research" site:.edu
- "distributed ledger" "curriculum" university Europe
- site:linkedin.com/company/ "university" "innovation" "blockchain"
- "academic partnership" "industry collaboration" "blockchain" 2025

Consulting/Services sales:
- "looking for marketing agency" OR "hiring consultancy" site:reddit.com
- "RFP" "marketing services" OR "consulting services" 2025
- "customer experience transformation" "looking for partner"
- site:linkedin.com/in/ "VP Marketing" "retail" London

Non-profit/Government:
- "sustainability initiative" "partnership" site:.org 2025
- "digital transformation" "public sector" "RFP" Europe
- site:linkedin.com/company/ "foundation" "grant" "technology"

For each opportunity type, generate at least 2-3 queries. Use diverse query patterns adapted to the mission:
- Organization discovery: "[target type] [descriptor] [location] [year]" (target type = companies/universities/agencies/organizations)
- LinkedIn discovery: site:linkedin.com/company/ "[industry]" "[location]"
- LinkedIn people: site:linkedin.com/in/ "[title]" "[industry]" "[location]"
- Academic: site:.edu OR site:.ac.uk OR site:.ac.fr "[topic]" "[department]"
- Government/NGO: site:.gov OR site:.org "[initiative]" "[topic]"
- Pain point/need: "[industry]" "looking for" OR "need" OR "seeking" "[service/partner type]"
- RFP/tender: "RFP" OR "request for proposal" "[service type]" [location] [year]
- Events: "[industry] conference" OR "[topic] summit" speakers [year] [location]
- News/announcements: "[organization type]" "launches" OR "announces" OR "partners with" "[topic]" [year]
- Reddit/forums: site:reddit.com "[topic]" "recommend" OR "looking for" OR "experience with"

The queries MUST be diverse — cover different angles, platforms, and signals. Do NOT generate similar queries with minor variations. MATCH the query style to the mission's industry.`;
}

export function buildInitialStrategyUserPrompt(ctx: PipelineContext, mission?: string): string {
  const sales = ctx.sales;
  const sections: string[] = [];

  if (mission) {
    sections.push(`## Mission\n${mission}`);
  }

  sections.push(`## Services / Offering\n${sales?.services?.join(', ') ?? 'Not specified'}`);
  sections.push(`## Value Proposition\n${sales?.valueProposition ?? 'Not specified'}`);
  sections.push(`## Differentiators\n${sales?.differentiators?.join(', ') ?? 'Not specified'}`);

  sections.push(`## Target Profile`);
  sections.push(`- Industries / Sectors: ${sales?.industries?.join(', ') ?? 'Any'}`);
  sections.push(`- Organization Sizes: ${sales?.companySizes?.join(', ') ?? 'Any'}`);
  sections.push(`- Key Signals: ${sales?.techStack?.join(', ') ?? 'Any'}`);
  sections.push(`- Target Roles / Contacts: ${ctx.targetRoles?.join(', ') ?? 'Decision makers'}`);
  sections.push(`- Locations: ${ctx.locations?.join(', ') ?? 'Global'}`);

  sections.push(`\nIMPORTANT: Analyze the mission carefully. Adapt ALL search queries, personas, and strategy to the SPECIFIC industry and target type described. If the mission is about universities, generate academic-focused queries. If about consulting, generate pain-point and RFP queries. Do NOT default to tech/SaaS patterns unless the mission is explicitly about tech products.`);

  if (sales?.caseStudies?.length) {
    sections.push(`## Case Studies`);
    for (const cs of sales.caseStudies) {
      sections.push(`- ${cs.title}: ${cs.result}`);
    }
  }

  sections.push(`\nIMPORTANT: Generate queries that will find SPECIFIC COMPANIES, not generic content. Each query should return company websites, LinkedIn company pages, news about specific companies, or directories listing companies. Avoid queries that return tutorials, generic articles, or product documentation.`);
  sections.push(`\nGenerate a comprehensive initial sales strategy as JSON.`);

  return sections.join('\n');
}

export function buildDailyReviewSystemPrompt(): string {
  return `You are an autonomous sales strategy analyst. You review yesterday's pipeline performance including opportunity discovery metrics, email performance, and contact pipeline stats.

Your output must be valid JSON with these fields:
- search_query_changes: { add: string[], remove: string[], reasoning: string }
- scoring_adjustments: { threshold_change?: number, weight_changes?: Record<string, number>, reasoning: string }
- email_strategy: { angle_change?: string, tone_change?: string, timing_change?: string, reasoning: string }
- followup_strategy: { delay_change_days?: number, max_followups?: number, reasoning: string }
- source_changes: { enable?: string[], disable?: string[], reasoning: string }
- opportunity_insights: { best_performing_types: string[], underperforming_types: string[], query_recommendations: string[], reasoning: string }
- overall_assessment: string
- todays_plan: string[]

Be data-driven. Only suggest changes when metrics clearly warrant them.`;
}

export function buildDailyReviewUserPrompt(params: {
  mission: string;
  useCase: string;
  services?: string[];
  activityMetrics: Record<string, unknown>;
  emailMetrics: Record<string, unknown>;
  pipelineStats: Record<string, unknown>;
  opportunityMetrics?: Array<{ type: string; total: number; avgScore: number }>;
}): string {
  const sections: string[] = [];

  sections.push(`## Mission\n${params.mission}`);
  sections.push(`## Use Case\n${params.useCase}`);
  if (params.services?.length) sections.push(`## Services\n${params.services.join(', ')}`);

  sections.push(`## Yesterday's Activity Metrics\n${JSON.stringify(params.activityMetrics, null, 2)}`);
  sections.push(`## Email Performance\n${JSON.stringify(params.emailMetrics, null, 2)}`);
  sections.push(`## Pipeline Stats\n${JSON.stringify(params.pipelineStats, null, 2)}`);

  if (params.opportunityMetrics?.length) {
    sections.push(`## Opportunity Metrics (by type)\n${JSON.stringify(params.opportunityMetrics, null, 2)}`);
  }

  sections.push(`\nAnalyze the above data and output your strategy decisions as JSON. Focus on actionable improvements.`);

  return sections.join('\n\n');
}
