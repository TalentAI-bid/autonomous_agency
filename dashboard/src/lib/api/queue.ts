import { apiGet, apiPost } from '@/lib/api';

export type ProspectActionPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type ProspectActionStatus = 'pending' | 'in_progress' | 'completed' | 'skipped' | 'expired' | 'superseded';

/** Shape stored in prospect_actions.target_alternatives. */
export interface TargetAlternative {
  contactId: string;
  name: string;
  title: string | null;
  channel: 'email' | 'linkedin_dm' | 'linkedin_connection_request';
}

export interface QueueAction {
  id: string;
  contactId: string | null;
  companyId: string;
  tenantId: string;
  userId: string;
  actionType: string;
  priority: ProspectActionPriority;
  priorityReason: string | null;
  whyNow: string | null;
  strategyNote: string | null;
  scheduledFor: string;
  expiresAt: string;
  draftSubject: string | null;
  draftBody: string | null;
  draftConfidence: number | null;
  channelTarget: string | null;
  contextSummary: string | null;
  targetAlternatives: TargetAlternative[];
  status: ProspectActionStatus;
  generatedAt: string;
  userOpenedAt: string | null;
  userCompletedAt: string | null;
  userSkippedAt: string | null;
  skipReason: string | null;
  triggeredByEventId: string | null;
}

export interface QueueContact {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  linkedinUrl: string | null;
  companyName: string | null;
  title: string | null;
  customTags: string[];
}

export interface QueueCompany {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  score: number | null;
  currentStage: string;
}

export interface QueueRow {
  action: QueueAction;
  company: QueueCompany;
  recommendedContact: QueueContact | null;
}

export interface QueueBucket {
  priority: ProspectActionPriority;
  count: number;
  actions: QueueRow[];
}

export interface RefreshQuota {
  remaining: number;
  limit: number;
  resetAt: string;
}

export interface QueueResponse {
  count: number;
  etaMinutes: number;
  refreshQuota: RefreshQuota;
  buckets: QueueBucket[];
}

export async function getQueue(opts: { masterAgentId?: string } = {}) {
  const path = opts.masterAgentId
    ? `/queue?masterAgentId=${encodeURIComponent(opts.masterAgentId)}`
    : '/queue';
  return apiGet<QueueResponse>(path);
}

export interface RefreshResult {
  queued: true;
  remaining: number;
  limit: number;
  resetAt: string;
}

export async function refreshQueue() {
  return apiPost<RefreshResult>('/queue/refresh');
}

export interface ExecuteResult {
  kind: 'email_confirm' | 'linkedin_clipboard' | 'manual' | 'research';
  contactId?: string;
  companyId?: string;
  subject?: string | null;
  body?: string | null;
  draftBody?: string | null;
  draftSubject?: string | null;
  targetUrl?: string | null;
  actionType?: string;
}

export async function executeAction(id: string) {
  return apiPost<ExecuteResult>(`/queue/actions/${id}/execute`);
}

export async function completeAction(
  id: string,
  body?: { sentAt?: string; notes?: string; channelData?: Record<string, unknown> },
) {
  return apiPost<{ ok: true }>(`/queue/actions/${id}/complete`, body ?? {});
}

export async function skipAction(id: string, reason: string, notes?: string) {
  return apiPost<{ ok: true }>(`/queue/actions/${id}/skip`, { reason, notes });
}

export async function editDraft(id: string, body: string, subject?: string) {
  return apiPost<{ ok: true }>(`/queue/actions/${id}/edit-draft`, { body, subject });
}

export interface RetargetResult {
  ok: true;
  draft: { subject: string | null; body: string | null; confidence: number | null };
}

export async function retargetAction(id: string, contactId: string) {
  return apiPost<RetargetResult>(`/queue/actions/${id}/retarget`, { contactId });
}
