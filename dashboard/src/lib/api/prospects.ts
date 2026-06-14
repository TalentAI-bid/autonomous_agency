import { apiGet, apiGetPaginated, apiPost } from '@/lib/api';

/**
 * Typed wrapper around the /api/contacts/capture and /api/contacts/lookup
 * endpoints introduced for the Sales Operations Platform (Stage 1).
 * Keeps the request/response shapes here so the form component doesn't
 * have to know about axios or repeat the error-code strings.
 */

export interface CaptureInput {
  name?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  linkedinUrl?: string;
  company?: string;
  title?: string;
  location?: string;
  phone?: string;
  whatsapp?: string;
  headline?: string;
  about?: string;
  sourceType?: string;
  sourceMetadata?: Record<string, unknown>;
  tags?: string[];
  initialNote?: string;
}

export interface CaptureResult {
  contactId: string;
  isDuplicate: boolean;
  existingStage?: string | null;
}

export async function captureProspect(input: CaptureInput): Promise<CaptureResult> {
  return apiPost<CaptureResult>('/contacts/capture', input);
}

export interface LookupResult {
  exists: boolean;
  contactId?: string;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  currentStage?: string | null;
}

export async function lookupByLinkedinUrl(linkedinUrl: string): Promise<LookupResult> {
  return apiGet<LookupResult>('/contacts/lookup', { linkedinUrl });
}

// ─── Stage 2 — list / detail / timeline / management ──────────────

export interface ProspectListRow {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  companyName?: string | null;
  title?: string | null;
  location?: string | null;
  score?: number | null;
  status: string;
  source?: string | null;
  sourceType: string;
  customTags: string[];
  doNotContact: boolean;
  createdAt: string;
  currentStage: string | null;
  stageEnteredAt: string | null;
  lastTouchAt: string | null;
  lastResponseAt: string | null;
  totalTouches: number;
}

export interface ProspectListFilters {
  search?: string;
  status?: string;
  tag?: string;
  sourceType?: string;
  stage?: string;
  cursor?: string;
  limit?: number;
}

export async function listProspects(filters: ProspectListFilters = {}) {
  return apiGetPaginated<ProspectListRow>(
    '/contacts',
    filters as unknown as Record<string, unknown>,
  );
}

export interface TimelineEvent {
  id: string;
  type: string;
  eventCategory: string | null;
  actorType: string | null;
  userId: string | null;
  title: string | null;
  description: string | null;
  metadata: Record<string, unknown> | null;
  occurredAt: string;
}

export interface ProspectDetailResponse {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  companyName?: string | null;
  title?: string | null;
  location?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  twitterUrl?: string | null;
  headline?: string | null;
  about?: string | null;
  score?: number | null;
  intentScore: number;
  status: string;
  source?: string | null;
  sourceType: string;
  sourceMetadata: Record<string, unknown>;
  customTags: string[];
  doNotContact: boolean;
  doNotContactReason?: string | null;
  doNotContactAt?: string | null;
  createdAt: string;
  updatedAt: string;
  prospectStage: {
    currentStage: string;
    stageEnteredAt: string;
    lastTouchAt: string | null;
    lastResponseAt: string | null;
    totalTouches: number;
  } | null;
  recentEvents: TimelineEvent[];
}

export async function getProspect(id: string): Promise<ProspectDetailResponse> {
  return apiGet<ProspectDetailResponse>(`/contacts/${id}`);
}

export interface TimelinePage {
  events: TimelineEvent[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function getProspectTimeline(
  id: string,
  opts: { cursor?: string; limit?: number; category?: string } = {},
): Promise<TimelinePage> {
  return apiGet<TimelinePage>(`/contacts/${id}/timeline`, opts);
}

export async function addProspectNote(id: string, body: string) {
  return apiPost<{ eventId: string }>(`/contacts/${id}/notes`, { body });
}

export async function markProspectDnc(id: string, reason?: string) {
  return apiPost<{ ok: true }>(`/contacts/${id}/dnc`, { reason });
}

export async function updateProspectTags(id: string, add?: string[], remove?: string[]) {
  return apiPost<{ customTags: string[] }>(`/contacts/${id}/tags`, { add, remove });
}

export async function reassignProspect(id: string, userId: string) {
  return apiPost<{ ok: true }>(`/contacts/${id}/reassign`, { userId });
}
