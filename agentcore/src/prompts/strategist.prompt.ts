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
- opportunitySearchQueries: [{ type: string, query: string, rationale: string }] — exact search queries to find targets. Types: linkedin_jobs, indeed_jobs, career_pages
- companyQualificationCriteria: { sizeRange: { min: number, max: number }, industries: string[], signals: string[], redFlags: string[] }
- decisionMakerTargeting: { titlePatterns: string[], seniorityLevels: string[], departmentFocus: string[] }
- emailStrategy: { angles: [{ name: string, description: string, bestFor: string }], subjectPatterns: string[], tone: string, rulesOfEngagement: string[] }
- successMetrics: { targetOpenRate: number, targetReplyRate: number, targetConversionRate: number }

CRITICAL QUERY RULES — YOU MUST FOLLOW ALL OF THESE:

1. EVERY query MUST contain the EXACT country or city from the mission's target locations. If the mission says "Ireland", every single query must contain "Ireland". No exceptions.
2. EVERY query MUST contain at least one specific role keyword (e.g. "DevOps engineer", "CTO", "VP Engineering") OR a specific skill/service keyword from the mission (e.g. "DevOps", "Kubernetes", "cloud migration").
3. NO generic queries without a role or skill keyword. A query like "companies in Ireland" is FORBIDDEN — it must be "DevOps companies Ireland" or "hiring DevOps engineer Ireland".
4. Use AT MOST 2 quoted phrases per query. Too many quoted terms returns zero results.
5. When targeting non-English countries, include queries in BOTH the local language AND English.

Generate EXACTLY 15 queries in 3 groups of 5:

GROUP 1 — LinkedIn Jobs (type: "linkedin_jobs"):
Generate 5 queries using site:linkedin.com/jobs/
Example: site:linkedin.com/jobs/ "DevOps engineer" Ireland

GROUP 2 — Indeed Jobs (type: "indeed_jobs"):
Generate 5 queries using site:indeed.com OR site:indeed.co.uk (match country domain)
Example: site:indeed.com "DevOps" Ireland

GROUP 3 — Company Career Pages (type: "career_pages"):
Generate 5 queries targeting company career pages, job boards, or hiring signals
Example: "hiring DevOps engineer" Ireland site:lever.co OR site:greenhouse.io
Example: "DevOps team" careers Ireland 2025

BAD query examples (NEVER generate these):
- "companies in Ireland" (no role/skill keyword)
- "hiring engineer" (no location)
- "DevOps" "cloud" "engineer" "Ireland" "startup" (too many quoted phrases)
- site:linkedin.com/company/ "technology" (no location, no specific role)

GOOD query examples:
- site:linkedin.com/jobs/ "DevOps engineer" Ireland
- site:indeed.com "cloud infrastructure" Ireland
- "hiring DevOps" Ireland site:lever.co
- "looking for DevOps partner" Ireland 2025
- "DevOps services" OR "cloud migration" Ireland careers

IMPORTANT: Output ONLY the JSON object. Do NOT include any reasoning, explanation, or <think> tags. Just the raw JSON.`;
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
