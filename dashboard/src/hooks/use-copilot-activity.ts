'use client';

import { useMutation } from '@tanstack/react-query';
import { apiPost } from '@/lib/api';

export type CopilotActivityType =
  | 'note_added'
  | 'call_logged'
  | 'meeting_scheduled'
  | 'manual_email_sent'
  | 'manual_email_received'
  | 'linkedin_connection_sent'
  | 'linkedin_connection_accepted'
  | 'linkedin_message_sent'
  | 'linkedin_message_received'
  | 'linkedin_followup_sent';

export interface CopilotActivityDraft {
  contactName: string | null;
  contactEmail: string | null;
  type: CopilotActivityType;
  title: string;
  description: string;
  suggestedStageSlug: string | null;
}

export interface CopilotContactCandidate {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  companyName: string | null;
  masterAgentId: string | null;
  matchType: 'email' | 'name';
  score: number;
}

export interface CopilotParseResult {
  draft: CopilotActivityDraft;
  candidates: CopilotContactCandidate[];
}

/**
 * Sends free text + OCR'd image text to the backend; the LLM returns a
 * structured activity draft + matched contact candidates.
 */
export function useParseActivity() {
  return useMutation({
    mutationFn: (input: { text?: string; ocrText?: string }) =>
      apiPost<CopilotParseResult>('/crm/copilot/parse-activity', input),
  });
}
