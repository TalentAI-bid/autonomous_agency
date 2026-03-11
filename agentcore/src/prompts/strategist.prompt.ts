import type { PipelineContext } from '../types/pipeline-context.js';

export function buildInitialStrategySystemPrompt(): string {
  return `You are an expert B2B sales strategist. Given a company's services, target market (ICP), and mission, you produce a comprehensive initial sales strategy document.

Your output must be valid JSON with these fields:
- marketAnalysis: { customerPersonas: [{ title, painPoints, buyingTriggers, objections }], competitiveLandscape: string }
- opportunitySearchQueries: [{ type: string, query: string, rationale: string }] — exact search queries to find buying signals per opportunity type (hiring_signal, direct_request, project_announcement, funding_signal, technology_adoption, tender_rfp, pain_point_expressed)
- companyQualificationCriteria: { sizeRange: { min: number, max: number }, industries: string[], techSignals: string[], redFlags: string[], fundingStages: string[] }
- decisionMakerTargeting: { titlePatterns: string[], seniorityLevels: string[], departmentFocus: string[] }
- emailStrategy: { angles: [{ name: string, description: string, bestFor: string }], subjectPatterns: string[], tone: string, rulesOfEngagement: string[] }
- successMetrics: { targetOpenRate: number, targetReplyRate: number, targetConversionRate: number }

Generate 15-25 search queries across different opportunity types. Be specific — include industry terms, technology names, and location modifiers from the ICP. For email angles, provide 3-4 distinct approaches to A/B test.

CRITICAL: Each query in opportunitySearchQueries must be an exact web search string ready for a search engine. Include:
- Quoted phrases for precision (e.g., "looking for CRM solution")
- Site operators for specific platforms (e.g., site:reddit.com, site:lever.co)
- Location/industry modifiers from the ICP
- Technology-specific terms

BAD examples (too generic, will return noise):
- "companies needing solutions"
- "businesses looking for help"

GOOD examples (specific, actionable):
- "hiring machine learning engineer" site:lever.co London
- "migrating from Salesforce" OR "replacing CRM" fintech
- "Series A" "healthcare SaaS" 2025
- site:reddit.com "looking for" "development agency"
- "Head of Engineering" "we're building" site:linkedin.com`;
}

export function buildInitialStrategyUserPrompt(ctx: PipelineContext, mission?: string): string {
  const sales = ctx.sales;
  const sections: string[] = [];

  if (mission) {
    sections.push(`## Mission\n${mission}`);
  }

  sections.push(`## Company Services\n${sales?.services?.join(', ') ?? 'Not specified'}`);
  sections.push(`## Value Proposition\n${sales?.valueProposition ?? 'Not specified'}`);
  sections.push(`## Differentiators\n${sales?.differentiators?.join(', ') ?? 'Not specified'}`);

  sections.push(`## Ideal Customer Profile (ICP)`);
  sections.push(`- Industries: ${sales?.industries?.join(', ') ?? 'Any'}`);
  sections.push(`- Company Sizes: ${sales?.companySizes?.join(', ') ?? 'Any'}`);
  sections.push(`- Tech Stack Signals: ${sales?.techStack?.join(', ') ?? 'Any'}`);
  sections.push(`- Target Roles: ${ctx.targetRoles?.join(', ') ?? 'Decision makers'}`);
  sections.push(`- Locations: ${ctx.locations?.join(', ') ?? 'Global'}`);

  if (sales?.caseStudies?.length) {
    sections.push(`## Case Studies`);
    for (const cs of sales.caseStudies) {
      sections.push(`- ${cs.title}: ${cs.result}`);
    }
  }

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
