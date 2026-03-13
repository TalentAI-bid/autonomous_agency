// ── Enums ────────────────────────────────────────────────────────────────────

export type ContactStatus =
  | 'discovered' | 'enriched' | 'scored' | 'contacted' | 'replied'
  | 'qualified' | 'interview_scheduled' | 'rejected' | 'archived';

export type ContactSource =
  | 'linkedin_search' | 'linkedin_profile' | 'cv_upload' | 'manual' | 'web_search' | 'inbound';

export type AgentType =
  | 'discovery' | 'enrichment' | 'document' | 'scoring' | 'outreach' | 'reply' | 'action'
  | 'email-listen' | 'email-send' | 'mailbox' | 'reddit-monitor' | 'strategy' | 'strategist';

export type MasterAgentStatus = 'idle' | 'running' | 'paused' | 'error';
export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type DocType = 'job_spec' | 'cv' | 'whitepaper' | 'spec' | 'linkedin_profile' | 'other';
export type DocStatus = 'uploaded' | 'processing' | 'processed' | 'error';
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed';
export type ReplyClassification =
  | 'interested' | 'objection' | 'not_now' | 'out_of_office' | 'unsubscribe' | 'bounce' | 'other'
  | 'inquiry' | 'application' | 'partnership' | 'support_request' | 'spam' | 'introduction';
export type InterviewStatus = 'scheduled' | 'completed' | 'cancelled' | 'no_show';
export type UseCase = 'recruitment' | 'sales' | 'custom';

// ── Core Entities ─────────────────────────────────────────────────────────────

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  createdAt: string;
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  name: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  createdAt: string;
}

export interface MasterAgent {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  mission?: string;
  useCase: UseCase;
  status: MasterAgentStatus;
  config?: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentConfig {
  id: string;
  tenantId: string;
  masterAgentId: string;
  agentType: AgentType;
  systemPrompt?: string;
  tools?: string[];
  parameters?: Record<string, unknown>;
  isEnabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTask {
  id: string;
  tenantId: string;
  masterAgentId?: string;
  agentType: AgentType;
  status: TaskStatus;
  priority: number;
  input: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  retryCount: number;
  startedAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface Contact {
  id: string;
  tenantId: string;
  masterAgentId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  emailVerified: boolean;
  linkedinUrl?: string;
  title?: string;
  companyId?: string;
  companyName?: string;
  location?: string;
  skills?: string[];
  experience?: Record<string, unknown>[];
  education?: Record<string, unknown>[];
  score?: number;
  scoreDetails?: Record<string, unknown>;
  source?: ContactSource;
  status: ContactStatus;
  rawData?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Company {
  id: string;
  tenantId: string;
  masterAgentId?: string;
  name: string;
  domain?: string;
  industry?: string;
  size?: string;
  techStack?: string[];
  funding?: string;
  linkedinUrl?: string;
  description?: string;
  dataCompleteness?: number;
  rawData?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyDeepData {
  products?: string[];
  foundedYear?: string;
  headquarters?: string;
  cultureValues?: string[];
  recentNews?: Array<{ headline: string; date: string }>;
  openPositions?: Array<{
    title: string;
    location: string;
    requiredSkills?: string[];
    salary?: string;
    description?: string;
    url?: string;
  }>;
  keyPeople?: Array<{ name: string; title: string }>;
  competitors?: string[];
  masterAgentId?: string;
  contactEmail?: string;
  hiringContactEmails?: string[];
  jobListings?: Array<{
    title: string;
    skills: string[];
    url: string;
    snippet?: string;
    discoveryQuery?: string;
  }>;
}

export interface ContactDeepData {
  githubUrl?: string;
  personalWebsite?: string;
  summary?: string;
  skillLevels?: Array<{ skill: string; level: string; evidence: string }>;
  openSourceContributions?: Array<{ repo: string; description: string }>;
  certifications?: string[];
  languages?: string[];
  totalYearsExperience?: number;
  seniorityLevel?: string;
  dataCompleteness?: number;
  githubStats?: {
    totalRepos: number;
    totalStars: number;
    topLanguages: string[];
    topRepos: Array<{ name: string; stars: number; language: string; description: string }>;
    contributionLevel: string;
  };
  skipReason?: string;
}

export interface Document {
  id: string;
  tenantId: string;
  masterAgentId?: string;
  contactId?: string;
  type: DocType;
  fileName?: string;
  filePath?: string;
  mimeType?: string;
  extractedData?: Record<string, unknown>;
  rawText?: string;
  status: DocStatus;
  createdAt: string;
}

export interface Campaign {
  id: string;
  tenantId: string;
  masterAgentId?: string;
  name: string;
  description?: string;
  type: 'outbound_email' | 'linkedin' | 'multi_channel';
  status: CampaignStatus;
  settings?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CampaignStep {
  id: string;
  campaignId: string;
  stepNumber: number;
  subject?: string;
  template?: string;
  delayDays: number;
  channel: 'email' | 'linkedin';
  createdAt: string;
}

export interface CampaignContact {
  id: string;
  campaignId: string;
  contactId: string;
  currentStep: number;
  status: 'pending' | 'active' | 'replied' | 'bounced' | 'unsubscribed' | 'completed';
  lastActionAt?: string;
  createdAt: string;
}

export interface EmailSent {
  id: string;
  campaignContactId?: string;
  stepId?: string;
  fromEmail?: string;
  toEmail?: string;
  subject?: string;
  body?: string;
  sentAt?: string;
  openedAt?: string;
  clickedAt?: string;
  repliedAt?: string;
  bouncedAt?: string;
  messageId?: string;
}

export interface Reply {
  id: string;
  emailSentId?: string;
  contactId?: string;
  body?: string;
  classification?: ReplyClassification;
  sentiment?: number;
  autoResponse?: string;
  processedAt?: string;
  createdAt: string;
}

export interface Interview {
  id: string;
  tenantId: string;
  contactId: string;
  masterAgentId?: string;
  scheduledAt?: string;
  status: InterviewStatus;
  meetingUrl?: string;
  notes?: string;
  createdAt: string;
}

// ── API Types ─────────────────────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
}

export interface ApiError {
  error: { code: string; message: string };
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    total: number;
    cursor?: string;
    hasMore: boolean;
  };
}

export interface AuthResponse {
  data: {
    token: string;
    refreshToken?: string;
    user: User;
    tenant: Tenant;
  };
}

// ── Analytics Types ───────────────────────────────────────────────────────────

export interface AnalyticsOverview {
  contacts: {
    total: number;
    discovered: number;
    enriched: number;
    scored: number;
    contacted: number;
    replied: number;
    qualified: number;
    interview_scheduled: number;
  };
  emails: {
    sent: number;
    opened: number;
    replied: number;
    bounced: number;
    openRate: number;
    replyRate: number;
  };
  interviews: { scheduled: number; completed: number };
  agents: {
    active: number;
    tasksCompleted: number;
    tasksFailed: number;
  };
}

// ── WebSocket Event Types ─────────────────────────────────────────────────────

export interface AgentEvent {
  event: string;
  data: Record<string, unknown>;
  agentType?: AgentType;
  timestamp: string;
}

export interface AgentStatus {
  agentType: AgentType;
  status: 'idle' | 'running' | 'error';
  jobsCompleted: number;
  jobsFailed: number;
  lastActivity?: string;
}

// ── CRM & Email Types (re-exported) ──────────────────────────────────────────

export type { CrmStage, Deal, DealWithContact, CrmActivity, ActivityType, BoardColumn } from './crm';
export type { EmailAccount, EmailListenerConfig, QuotaStatus, EmailProvider, ListenerProtocol } from './email';

// ── Mailbox Types ─────────────────────────────────────────────────────────

export interface MailboxEmail {
  id: string;
  direction: 'sent' | 'received';
  fromEmail?: string;
  toEmail?: string;
  subject?: string;
  body?: string;
  sentAt?: string;
  createdAt?: string;
  classification?: ReplyClassification;
  sentiment?: number;
  contactName?: string;
  contactId?: string;
  threadId?: string;
  status?: string;
  isInbound?: boolean;
  openedAt?: string | null;
}

export interface MailboxStats {
  totalSent: number;
  totalReceived: number;
  todaySent: number;
  todayReceived: number;
  byClassification: Record<string, number>;
}

export type ThreadStatus = 'active' | 'archived' | 'needs_action' | 'waiting';
export type ThreadPriority = 'high' | 'medium' | 'low';

export interface MailboxThread {
  id: string;
  subject?: string;
  status: ThreadStatus;
  priority: ThreadPriority;
  messageCount: number;
  lastMessageAt?: string;
  summary?: string;
  nextAction?: string;
  dealId?: string;
  contactId?: string;
  contactName?: string;
  contactEmail?: string;
  deal?: {
    id: string;
    title?: string;
    value?: string;
    stage?: {
      id: string;
      name?: string;
      color?: string;
    };
  };
  createdAt: string;
  updatedAt: string;
}

export interface MailboxThreadDetail extends MailboxThread {
  messages: ThreadMessage[];
}

export interface ThreadMessage {
  id: string;
  direction: 'sent' | 'received';
  fromEmail?: string;
  toEmail?: string;
  subject?: string;
  body?: string;
  classification?: string;
  sentiment?: number;
  status?: string;
  date: string;
}

export interface MailboxDigest {
  needsAction: number;
  active: number;
  waiting: number;
  highPriority: number;
  totalThreads: number;
}

export interface ScheduledAction {
  id: string;
  type: 'email' | 'task';
  title: string;
  scheduledAt: string;
  status: string;
  metadata: Record<string, unknown>;
}

// ── Activity & Strategy Types ─────────────────────────────────────────────────

export interface ActivityLogEntry {
  id: string;
  tenantId: string;
  masterAgentId?: string;
  agentType: AgentType;
  action: string;
  status: 'started' | 'completed' | 'failed' | 'skipped';
  inputSummary?: string;
  outputSummary?: string;
  details?: Record<string, unknown>;
  durationMs?: number;
  error?: string;
  createdAt: string;
}

export interface ActivityStats {
  byAgentType: Array<{
    agentType: string;
    total: number;
    failed: number;
    avgDuration: number;
  }>;
  totalActions: number;
  recentErrors: ActivityLogEntry[];
}

export type StrategyExecutionStatus = 'pending' | 'analyzing' | 'executing' | 'completed' | 'failed';

export interface DailyStrategy {
  id: string;
  tenantId: string;
  masterAgentId: string;
  strategyDate: string;
  performanceAnalysis?: Record<string, unknown>;
  strategyDecisions?: Record<string, unknown>;
  actionPlan?: Record<string, unknown>;
  executionStatus: StrategyExecutionStatus;
  executedAt?: string;
  error?: string;
  createdAt: string;
}

// ── Opportunity Types ─────────────────────────────────────────────────────────

export type OpportunityType =
  | 'hiring_signal' | 'direct_request' | 'recommendation_ask' | 'project_announcement'
  | 'funding_signal' | 'technology_adoption' | 'tender_rfp' | 'conference_signal'
  | 'pain_point_expressed' | 'partnership_signal';

export type OpportunityUrgency = 'immediate' | 'soon' | 'exploring' | 'none';

export type OpportunityStatus = 'new' | 'researching' | 'qualified' | 'contacted' | 'converted' | 'skipped';

export interface Opportunity {
  id: string;
  tenantId: string;
  masterAgentId: string;
  title: string;
  description?: string;
  opportunityType: OpportunityType;
  source?: string;
  sourceUrl?: string;
  sourcePlatform?: string;
  companyName?: string;
  companyDomain?: string;
  personName?: string;
  personTitle?: string;
  technologies?: string[];
  budget?: string;
  timeline?: string;
  location?: string;
  rawContent?: string;
  buyingIntentScore: number;
  urgency: OpportunityUrgency;
  status: OpportunityStatus;
  companyId?: string;
  contactId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OpportunityStats {
  byType: Array<{ type: OpportunityType; total: number }>;
  byStatus: Array<{ status: OpportunityStatus; total: number }>;
  byUrgency: Array<{ urgency: OpportunityUrgency; total: number }>;
  total: number;
  avgBuyingIntentScore: number;
}

// ── Agent Message Types ───────────────────────────────────────────────────────

export interface AgentMessage {
  id: string;
  tenantId: string;
  masterAgentId: string;
  fromAgent: string;
  toAgent?: string;
  messageType: string;
  content: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type AgentMessageType =
  | 'task_assignment' | 'data_handoff' | 'reasoning' | 'status_update'
  | 'human_message' | 'agent_response';

// ── Filter Types ──────────────────────────────────────────────────────────────

export interface ContactFilters {
  search?: string;
  status?: ContactStatus;
  source?: ContactSource;
  masterAgentId?: string;
  minScore?: number;
  maxScore?: number;
  cursor?: string;
  limit?: number;
}

export interface CompanyFilters {
  search?: string;
  industry?: string;
  masterAgentId?: string;
  cursor?: string;
  limit?: number;
}
