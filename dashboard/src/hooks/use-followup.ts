'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost } from '@/lib/api';

export interface FollowupSequenceCampaign {
  id: string;
  name: string;
  status: string;
  masterAgentId?: string | null;
}

export interface FollowupSequenceCc {
  id: string;
  campaignId: string;
  contactId: string;
  currentStep: number;
  status: string;
  lastActionAt: string | null;
  nextScheduledAt: string | null;
  stoppedReason: string | null;
  stoppedAt: string | null;
  sequenceState: { touch1Angle?: string; anglesUsed?: string[] } | null;
  createdAt: string;
}

export interface FollowupSequenceStep {
  id: string;
  stepNumber: number;
  delayDays: number;
  stepType: string;
  active: boolean;
  subject: string | null;
}

export interface FollowupSequenceSend {
  id: string;
  subject: string | null;
  sentAt: string | null;
  touchNumber: number | null;
  messageId: string | null;
}

export interface FollowupSequenceData {
  contact: { id: string; firstName?: string | null; lastName?: string | null; email?: string | null; unsubscribed?: boolean; timezone?: string | null };
  sequences: Array<{
    campaign: FollowupSequenceCampaign;
    campaignContact: FollowupSequenceCc;
    steps: FollowupSequenceStep[];
    sends: FollowupSequenceSend[];
  }>;
}

export function useContactSequence(contactId: string) {
  return useQuery({
    queryKey: ['followup', 'sequence', contactId],
    queryFn: () => apiGet<FollowupSequenceData>(`/followup/contacts/${contactId}/sequence`),
    enabled: !!contactId,
    staleTime: 15000,
  });
}

export function useStopSequence(contactId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { reason?: string } = {}) =>
      apiPost<{ stopped: number; cancelled: number; contactId: string }>(
        `/followup/contacts/${contactId}/stop`,
        { reason: params.reason ?? 'manual' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['followup', 'sequence', contactId] });
      queryClient.invalidateQueries({ queryKey: ['contacts', contactId] });
    },
  });
}

export function useUnsubscribeContact(contactId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (params: { reason?: string } = {}) =>
      apiPost<{ stopped: number; cancelled: number; contactId: string; unsubscribed: boolean }>(
        `/followup/contacts/${contactId}/unsubscribe`,
        { reason: params.reason ?? 'unsubscribed' },
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['followup', 'sequence', contactId] });
      queryClient.invalidateQueries({ queryKey: ['contacts', contactId] });
    },
  });
}
