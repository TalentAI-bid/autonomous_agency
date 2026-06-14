'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPut } from '@/lib/api';

export type StudioChannel =
  | 'email_cold'
  | 'linkedin_dm'
  | 'linkedin_connection_request'
  | 'twitter_dm'
  | 'whatsapp'
  | 'telegram';

export type StudioTrack = 'sales' | 'partnership' | 'collaboration';

export type MessageType =
  | 'first_message'
  | 'first_followup'
  | 'second_followup'
  | 'breakup'
  | 'reactivation'
  | 'post_meeting'
  | 'post_no_show';

export interface MessagingConfig {
  sender_name?: string;
  sender_title?: string;
  sender_location?: string;
  sender_company?: string;
  value_prop?: string;
  target_icp?: string;
  differentiator?: string;
  pricing_summary?: string;
  brand_voice_notes?: string;
}

export interface StudioComposition {
  id: string;
  channel: StudioChannel;
  track: StudioTrack;
  subject?: string;
  body: string;
  classification?: string;
  characterCount: number;
  createdAt: string;
}

export interface GenerateInput {
  channel: StudioChannel;
  track: StudioTrack;
  messageType?: MessageType;
  recipient: {
    name: string;
    company?: string;
    title?: string;
    location?: string;
    linkedinUrl?: string;
  };
  customContext?: string;
}

export function useGenerateStudioMessage() {
  return useMutation({
    mutationFn: (input: GenerateInput) =>
      apiPost<{ success: boolean; composition: StudioComposition }>('/studio/generate', input),
  });
}

export function useMessagingConfig() {
  return useQuery({
    queryKey: ['studio', 'config'],
    queryFn: () => apiGet<{ data: MessagingConfig }>('/studio/config'),
    staleTime: 30_000,
  });
}

export function useSaveMessagingConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (config: MessagingConfig) =>
      apiPut<{ data: MessagingConfig }>('/studio/config', config),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['studio', 'config'] }),
  });
}
