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

export interface PipelineFormData {
  useCase: 'recruitment' | 'sales' | 'custom';
  targetRole: string;
  requiredSkills: string;
  experienceLevel: string;
  locations: string;
  targetIndustry: string;
  companySize: string;
  additionalContext: string;
  scoringThreshold: number;
  emailTone: string;
  enableOutreach: boolean;
}
