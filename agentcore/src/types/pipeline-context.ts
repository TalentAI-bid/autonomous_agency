// ── PipelineContext — single source of truth passed through all agents ────────

export interface PipelineContext {
  useCase: 'sales' | 'recruitment';
  masterAgentId: string;
  tenantId: string;
  campaignId?: string;

  // Shared targeting
  targetRoles: string[];
  locations: string[];

  // Sales-specific ICP + strategy
  sales?: {
    industries?: string[];
    companySizes?: string[];
    techStack?: string[];
    services?: string[];
    caseStudies?: Array<{ title: string; result: string }>;
    differentiators?: string[];
    valueProposition?: string;
    callToAction?: string;
    calendlyUrl?: string;
    salesStrategy?: SalesStrategy;
  };

  // Recruitment-specific
  recruitment?: {
    requiredSkills?: string[];
    preferredSkills?: string[];
    minExperience?: number;
    experienceLevel?: string;
    companyContext?: string;
  };

  // Scoring
  scoringWeights?: Record<string, number>;
  scoringThreshold: number;

  // Email
  emailTone?: string;
  emailRules?: string[];
  senderCompanyName?: string;
  senderFirstName?: string;
  senderTitle?: string;
}

export interface SalesStrategy {
  marketAnalysis?: {
    customerPersonas?: Array<{
      title?: string;
      painPoints?: string[];
      buyingTriggers?: string[];
      objections?: string[];
    }>;
    competitiveLandscape?: string;
  };
  opportunitySearchQueries?: Array<{ type: string; query: string; rationale: string }>;
  companyQualificationCriteria?: {
    sizeRange?: { min?: number; max?: number };
    industries?: string[];
    techSignals?: string[];
    redFlags?: string[];
    fundingStages?: string[];
  };
  decisionMakerTargeting?: {
    titlePatterns?: string[];
    seniorityLevels?: string[];
    departmentFocus?: string[];
  };
  emailStrategy?: {
    angles?: Array<{ name: string; description: string; bestFor?: string }>;
    subjectPatterns?: string[];
    tone?: string;
    rulesOfEngagement?: string[];
  };
  successMetrics?: {
    targetOpenRate?: number;
    targetReplyRate?: number;
    targetConversionRate?: number;
  };
}
