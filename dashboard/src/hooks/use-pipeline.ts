'use client';

import { useMutation } from '@tanstack/react-query';
import { apiPost } from '@/lib/api';
import type { PipelineProposal, PipelineFormData } from '@/types/pipeline';

export function useAnalyzePipeline() {
  return useMutation({
    mutationFn: (formData: PipelineFormData) => {
      const payload = {
        useCase: formData.useCase,
        targetRole: formData.targetRole || undefined,
        requiredSkills: formData.requiredSkills
          ? formData.requiredSkills.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
        experienceLevel: formData.experienceLevel || undefined,
        locations: formData.locations
          ? formData.locations.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
        targetIndustry: formData.targetIndustry || undefined,
        companySize: formData.companySize || undefined,
        additionalContext: formData.additionalContext || undefined,
        scoringThreshold: formData.scoringThreshold,
        emailTone: formData.emailTone,
        enableOutreach: formData.enableOutreach,
      };
      return apiPost<PipelineProposal>('/master-agents/analyze-pipeline', payload);
    },
  });
}
