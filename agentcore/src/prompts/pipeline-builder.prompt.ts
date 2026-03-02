export interface PipelineStep {
  agentType: string;
  order: number;
  description: string;
  config: Record<string, unknown>;
}

export interface PipelineProposal {
  pipeline: PipelineStep[];
  missingCapabilities: string[];
  summary: string;
  estimatedDuration: string;
  warnings: string[];
}

export interface PipelineBuilderInput {
  useCase: 'recruitment' | 'sales' | 'custom';
  targetRole?: string;
  requiredSkills?: string[];
  experienceLevel?: string;
  locations?: string[];
  targetIndustry?: string;
  companySize?: string;
  additionalContext?: string;
  scoringThreshold: number;
  emailTone: string;
  enableOutreach: boolean;
}

const AGENT_CAPABILITY_MANIFEST = {
  discovery: {
    name: 'Discovery Agent',
    description: 'Searches the web via SearxNG to find people matching search queries. Discovers contacts from LinkedIn, job boards, and other professional sources.',
    inputs: ['searchQueries: string[]', 'maxResults: number'],
    outputs: ['contacts with name, URL, source'],
    triggersNext: ['document (for LinkedIn profiles)', 'enrichment (for other web results)'],
    requiredFor: ['Finding new candidates or leads from the web'],
  },
  document: {
    name: 'Document Agent',
    description: 'Extracts structured data from documents — LinkedIn profiles, CVs, PDFs, and job specs. Parses skills, experience, education, and contact information.',
    inputs: ['url or document buffer', 'document type (cv, linkedin_profile, job_spec)'],
    outputs: ['structured contact data (skills, experience, education, location)'],
    triggersNext: ['enrichment'],
    requiredFor: ['Processing LinkedIn profiles', 'Parsing CVs and resumes'],
  },
  enrichment: {
    name: 'Enrichment Agent',
    description: 'Enriches contact data by finding company information via web search, discovering email addresses, and verifying email deliverability.',
    inputs: ['contactId'],
    outputs: ['email address', 'email verification status', 'company data'],
    triggersNext: ['scoring'],
    requiredFor: ['Finding contact email addresses', 'Getting company information'],
  },
  scoring: {
    name: 'Scoring Agent',
    description: 'Evaluates contacts against job requirements using LLM analysis. Scores on skills match, experience level, location fit, education, and company background. Score range: 0-100.',
    inputs: ['contactId', 'job requirements from master agent config'],
    outputs: ['score (0-100)', 'detailed breakdown', 'pass/fail status'],
    triggersNext: ['outreach (if score >= threshold)'],
    requiredFor: ['Evaluating candidate/lead quality', 'Filtering contacts by fit'],
  },
  outreach: {
    name: 'Outreach Agent',
    description: 'Generates personalized emails using Claude AI and sends them via SMTP. Supports multi-step campaigns with configurable follow-up intervals.',
    inputs: ['contactId', 'campaignId', 'stepNumber'],
    outputs: ['sent email with messageId', 'scheduled follow-ups'],
    triggersNext: ['outreach (follow-up steps)'],
    requiredFor: ['Sending personalized emails', 'Running email campaigns'],
  },
  reply: {
    name: 'Reply Agent',
    description: 'Classifies incoming email replies (interested, objection, not_now, out_of_office, unsubscribe, bounce) and takes appropriate automated action.',
    inputs: ['replyId'],
    outputs: ['classification', 'sentiment score', 'action taken'],
    triggersNext: ['action (if interested)', 'outreach (if not_now/out_of_office)', 'enrichment (if bounce)'],
    requiredFor: ['Handling email responses automatically'],
  },
  action: {
    name: 'Action Agent',
    description: 'Generates comprehensive candidate/lead reports and schedules interviews. Sends calendar invites and detailed reports to the account owner.',
    inputs: ['contactId', 'action type'],
    outputs: ['interview record', 'report sent status', 'calendar invite status'],
    triggersNext: [],
    requiredFor: ['Scheduling interviews', 'Generating candidate reports'],
  },
  'email-listen': {
    name: 'Email Listener Agent',
    description: 'Monitors an IMAP/POP3 mailbox for inbound emails.',
    inputs: ['configId (email listener configuration)'],
    outputs: ['reply records', 'contact creation for new senders'],
    triggersNext: ['reply (for classification)', 'mailbox (for threading)'],
    requiredFor: ['Monitoring email inbox for replies and new messages'],
  },
  mailbox: {
    name: 'Mailbox Agent',
    description: 'Manages email threads and CRM activity.',
    inputs: ['emailId', 'type (inbound/outbound)'],
    outputs: ['thread grouping', 'CRM activity logs'],
    triggersNext: [],
    requiredFor: ['Organizing emails into threads', 'CRM tracking'],
  },
};

export function buildSystemPrompt(): string {
  return `You are an AI pipeline architect for an autonomous agent platform. Your job is to analyze a user's requirements and design the optimal agent pipeline to achieve their goal.

## Available Agents

${JSON.stringify(AGENT_CAPABILITY_MANIFEST, null, 2)}

## Pipeline Rules

1. **Valid execution order for web-search pipelines:** discovery → document → enrichment → scoring → outreach → reply → action
2. **Dependencies must be respected:** Each agent can only run after its upstream agents complete. You cannot skip required intermediate steps.
3. **Discovery is first for web-search pipelines:** If the goal involves finding new contacts from the web, discovery is the first step. For email-only pipelines (monitoring inbox), discovery is NOT needed.
4. **Document follows discovery:** LinkedIn profiles need document processing before enrichment.
5. **Enrichment requires contacts:** Cannot enrich without discovered contacts.
6. **Scoring requires enrichment:** Scoring needs enriched contact data (skills, experience, email).
7. **Outreach requires scoring:** Only contacts that pass scoring should receive outreach.
8. **Reply and action are optional:** Only include if outreach is enabled.
9. **If outreach is disabled:** Exclude outreach, reply, and action agents from the pipeline.
10. **Flag missing capabilities:** If the user requests something no agent can do, add it to missingCapabilities.
11. **Email-only pipelines:** If the user only wants to monitor inbound emails, the pipeline should be: email-listen → reply → mailbox. No discovery, document, enrichment, scoring, or outreach.

## Response Format

Respond with ONLY a valid JSON object matching this schema:
{
  "pipeline": [
    { "agentType": "string", "order": 1, "description": "string", "config": {} }
  ],
  "missingCapabilities": ["string"],
  "summary": "string",
  "estimatedDuration": "string",
  "warnings": ["string"]
}`;
}

export function buildUserPrompt(data: PipelineBuilderInput): string {
  const sections: string[] = [`USE CASE: ${data.useCase}`];

  if (data.useCase === 'recruitment') {
    if (data.targetRole) sections.push(`TARGET ROLE: ${data.targetRole}`);
    if (data.requiredSkills?.length) sections.push(`REQUIRED SKILLS: ${data.requiredSkills.join(', ')}`);
    if (data.experienceLevel) sections.push(`EXPERIENCE LEVEL: ${data.experienceLevel}`);
    if (data.locations?.length) sections.push(`LOCATIONS: ${data.locations.join(', ')}`);
  } else if (data.useCase === 'sales') {
    if (data.targetIndustry) sections.push(`TARGET INDUSTRY: ${data.targetIndustry}`);
    if (data.companySize) sections.push(`COMPANY SIZE: ${data.companySize}`);
  }

  if (data.additionalContext) sections.push(`ADDITIONAL CONTEXT: ${data.additionalContext}`);
  sections.push(`SCORING THRESHOLD: ${data.scoringThreshold}/100`);
  sections.push(`EMAIL TONE: ${data.emailTone}`);
  sections.push(`OUTREACH ENABLED: ${data.enableOutreach}`);

  return `Design the optimal agent pipeline for this request:

${sections.join('\n')}

Analyze the requirements against available agent capabilities. Return the pipeline as JSON with:
- The ordered list of pipeline steps with descriptions tailored to this specific use case
- Any capabilities the user needs that our agents cannot provide (missingCapabilities)
- A brief summary of what the pipeline will do
- Estimated duration (e.g. "2-4 hours" for typical pipelines)
- Any warnings about potential issues

Remember: respond with ONLY valid JSON, no markdown or explanation.`;
}
