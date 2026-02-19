// ── Enums ────────────────────────────────────────────────────────────────────

export type ContactStatus =
  | 'discovered' | 'enriched' | 'scored' | 'contacted' | 'replied'
  | 'qualified' | 'interview_scheduled' | 'rejected' | 'archived';

export type ContactSource =
  | 'linkedin_search' | 'linkedin_profile' | 'cv_upload' | 'manual' | 'web_search';

export type AgentType =
  | 'discovery' | 'enrichment' | 'document' | 'scoring' | 'outreach' | 'reply' | 'action';

export type MasterAgentStatus = 'idle' | 'running' | 'paused' | 'error';
export type TaskStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
export type DocType = 'job_spec' | 'cv' | 'whitepaper' | 'spec' | 'linkedin_profile' | 'other';
export type DocStatus = 'uploaded' | 'processing' | 'processed' | 'error';
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed';
export type ReplyClassification =
  | 'interested' | 'objection' | 'not_now' | 'out_of_office' | 'unsubscribe' | 'bounce' | 'other';
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
  name: string;
  domain?: string;
  industry?: string;
  size?: string;
  techStack?: string[];
  funding?: string;
  linkedinUrl?: string;
  description?: string;
  createdAt: string;
  updatedAt: string;
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
