// ── PipelineContext — single source of truth passed through all agents ────────

export interface PipelineContext {
  useCase: 'sales' | 'recruitment';
  masterAgentId: string;
  tenantId: string;
  campaignId?: string;
  missionText?: string;

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
    products?: Array<{
      name: string;
      description?: string | null;
      targetAudience?: string | null;
      painPointsSolved?: string[] | null;
      keyFeatures?: string[] | null;
      differentiators?: string[] | null;
      pricingModel?: string | null;
    }>;
    elevatorPitch?: string;
    socialProof?: string;
    targetMarketDescription?: string;
    painPointsAddressed?: string[];
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
  reasoning?: string;
  userRole?: 'vendor' | 'buyer';
  targetIndustries?: string[];
  painPointsAddressed?: string[];
  bdStrategy?: 'hiring_signal' | 'industry_target' | 'hybrid';
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
  dataSourceStrategy?: {
    primaryRegion: string;
    availableSources: string[];
    expectedQuality: 'excellent' | 'good' | 'medium' | 'limited';
    needsChromeExtension: boolean;
    userNotes: string;
  };
  pipelineSteps?: Array<{
    id: string;
    tool: 'LINKEDIN_EXTENSION' | 'CRAWL4AI' | 'LLM_ANALYSIS' | 'REACHER' | 'EMAIL_PATTERN' | 'SCORING';
    action: string;
    dependsOn: string[];
    params?: Record<string, unknown>;
  }>;
  hiringKeywords?: string[];
  targetTech?: string[];
}
