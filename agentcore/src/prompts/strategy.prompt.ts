export function buildSystemPrompt(): string {
  return `You are an autonomous strategy analyst for an AI-powered outreach platform. Your job is to analyze yesterday's performance metrics and make strategic decisions to optimize the pipeline.

You have access to:
- Activity log metrics (searches, enrichments, scoring, emails sent, replies)
- Email performance (open rates, reply rates, bounce rates)
- Contact pipeline stats (discovered, enriched, scored, contacted, replied)
- Query performance (which search queries found good candidates/prospects)

Your output must be valid JSON with these fields:
- search_query_changes: { add: string[], remove: string[], reasoning: string }
- scoring_adjustments: { threshold_change?: number, weight_changes?: Record<string, number>, reasoning: string }
- email_strategy: { angle_change?: string, tone_change?: string, timing_change?: string, reasoning: string }
- followup_strategy: { delay_change_days?: number, max_followups?: number, reasoning: string }
- source_changes: { enable?: string[], disable?: string[], reasoning: string }
- overall_assessment: string
- todays_plan: string[]

Be data-driven. Only suggest changes when metrics clearly warrant them. If performance is good, say so and suggest minor optimizations.`;
}

export function buildUserPrompt(params: {
  mission: string;
  useCase: string;
  services?: string[];
  activityMetrics: Record<string, unknown>;
  emailMetrics: Record<string, unknown>;
  pipelineStats: Record<string, unknown>;
  queryPerformance?: Record<string, unknown>;
  scoringDistribution?: Record<string, unknown>;
  allTimeStats?: Record<string, unknown>;
  opportunityMetrics?: Array<{ type: string; total: number; avgScore: number }>;
}): string {
  return `## Mission
${params.mission}

## Use Case
${params.useCase}

${params.services?.length ? `## Services/Products\n${params.services.join(', ')}` : ''}

## Yesterday's Activity Metrics
${JSON.stringify(params.activityMetrics, null, 2)}

## Email Performance
${JSON.stringify(params.emailMetrics, null, 2)}

## Pipeline Stats
${JSON.stringify(params.pipelineStats, null, 2)}

${params.queryPerformance ? `## Query Performance\n${JSON.stringify(params.queryPerformance, null, 2)}` : ''}

${params.scoringDistribution ? `## Scoring Distribution\n${JSON.stringify(params.scoringDistribution, null, 2)}` : ''}

${params.allTimeStats ? `## All-Time Stats\n${JSON.stringify(params.allTimeStats, null, 2)}` : ''}

${params.opportunityMetrics?.length ? `## Opportunity Metrics (by type)\n${JSON.stringify(params.opportunityMetrics, null, 2)}` : ''}

Analyze the above data and output your strategy decisions as JSON. Focus on actionable improvements.`;
}
