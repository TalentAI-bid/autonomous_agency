'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost } from '@/lib/api';

export interface GmapsRecommendation {
  priorityScore: number;
  fit: 'high' | 'medium' | 'low';
  reasoning: string;
  outreachAngle: string;
  suggestedOpener: string;
  gaps: string[];
  recommendedService: string;
  generatedAt?: string;
}

// Generates (and persists) the AI outreach recommendation for a gmaps_business
// contact. Invalidates the contact/prospect detail queries so the stored
// recommendation re-renders from sourceMetadata.aiRecommendation.
export function useGenerateGmapsRecommendation(contactId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<{ data: GmapsRecommendation }>(`/contacts/${contactId}/ai-recommendation`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prospect', contactId] });
      qc.invalidateQueries({ queryKey: ['contacts', contactId] });
    },
  });
}
