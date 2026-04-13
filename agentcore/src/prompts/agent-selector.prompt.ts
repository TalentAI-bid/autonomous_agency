/**
 * Agent Selector Prompt — used by MasterAgent to decide which sourcing agent(s)
 * to dispatch for a given mission.
 *
 * Three options: company-finder (sources hiring companies), candidate-finder
 * (sources individual people), linkedin (LinkedIn headhunting).
 * The LLM may select one or more.
 */

export interface AgentSelection {
  selectedAgents: Array<'company-finder' | 'candidate-finder' | 'linkedin'>;
  reasoning: string;
}

export function buildAgentSelectorSystemPrompt(): string {
  return `You decide which sourcing agents to dispatch for a mission.

OPTIONS:
- "company-finder": sources HIRING COMPANIES from job boards / company databases. Use for B2B sales (find companies with budget + pain), startup sales, OR recruitment when the user wants to know WHICH COMPANIES are hiring.
- "candidate-finder": sources INDIVIDUAL PEOPLE from LinkedIn snippets / GitHub / Stack Overflow / Dev.to. Use for recruitment when the user wants to find specific candidates directly.
- "linkedin": searches LinkedIn directly via API for people matching criteria, fetches full profiles, finds emails. Use ONLY when the user explicitly asks for LinkedIn search, headhunting, LinkedIn sourcing, or mentions LinkedIn in their mission. This is a premium feature — do NOT select it unless the mission clearly requests it.

RETURN JSON: { "selectedAgents": ["company-finder" | "candidate-finder" | "linkedin", ...], "reasoning": string }

RULES:
- Pure B2B sales → ["company-finder"]
- Pure recruitment with named candidates as the goal → ["candidate-finder"]
- Recruitment that ALSO needs to know hiring companies → ["candidate-finder", "company-finder"]
- "Find React devs at hiring fintechs in London" → ["candidate-finder", "company-finder"]
- User says "headhunt", "linkedin search", "search linkedin", "find on linkedin", or explicitly mentions LinkedIn sourcing → include "linkedin"
- "Headhunt senior devops engineers in Paris via LinkedIn" → ["linkedin", "candidate-finder"]
- "Search LinkedIn for CTOs in fintech" → ["linkedin"]
- Do NOT add "linkedin" unless the user explicitly requests it
- If unsure → default to ["company-finder"]
- Output JSON only — no prose, no markdown fences.`;
}

export function buildAgentSelectorUserPrompt(mc: {
  mission: string;
  useCase?: string;
  targetRoles?: string[];
  industries?: string[];
  locations?: string[];
}): string {
  const lines: string[] = [];
  lines.push(`Mission: ${mc.mission}`);
  lines.push(`Use case: ${mc.useCase ?? 'unspecified'}`);
  lines.push(`Target roles: ${mc.targetRoles?.join(', ') ?? 'none'}`);
  lines.push(`Industries: ${mc.industries?.join(', ') ?? 'none'}`);
  lines.push(`Locations: ${mc.locations?.join(', ') ?? 'none'}`);
  lines.push('');
  lines.push('Which agent(s) should run? Return JSON only.');
  return lines.join('\n');
}
