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
    params?: PipelineStepParams;
  }>;
  hiringKeywords?: string[];
  targetTech?: string[];

  /**
   * Concrete shape of a "good lead" for this seller. Drives both the
   * strategist's downstream-step params (negativeKeywords, requiredAttributes)
   * and the company-triage seller profile.
   */
  idealCustomerShape?: {
    sizeRange: { min: number; max: number };
    preferredStages: string[];
    buyerSignals: string[];
    antiSignals: string[];
    geographicScope: string[];
    buyerFunctions: string[];
  };

  /**
   * If the mission combines multiple distinct ICPs, the strategist surfaces
   * the suggested split so the dashboard can prompt the user to spin up
   * additional agents. Empty when the mission is already a single ICP.
   */
  icpSegmentation?: Array<{
    name: string;
    rationale: string;
    suggestedSeparateAgent: boolean;
  }>;

  queryDesignNotes?: string;
}

/**
 * Per-step params shape. The dispatcher routes purely by `tool` + `action`,
 * so these are always optional — but for the discovery and analysis tools
 * they are MANDATORY at strategy validation time. See validateStrategistOutput.
 */
export interface PipelineStepParams {
  // Free-form params still allowed (industries, location, jobTitles, etc.)
  [key: string]: unknown;

  // Mandatory for LINKEDIN_EXTENSION + CRAWL4AI discovery steps
  negativeKeywords?: string[];
  requiredAttributes?: {
    minSize: number;
    maxSize: number;
    geographicScope: string[];
  };

  // Mandatory for LLM_ANALYSIS, SCORING, CRAWL4AI analysis steps
  groundingRequired?: boolean;
  outputContract?: {
    noFabrication: boolean;
    requireCitations: boolean;
    forbiddenPhrases: string[];
    allowEmptyOutput: boolean;
  };

  // Mandatory for LLM_ANALYSIS and SCORING
  instruction?: string;
}

/**
 * Documented top-level flags persisted on `master_agents.config` (JSONB).
 * Not enforced by the schema (config is untyped JSONB), but referenced by
 * master-agent.ts, strategist.agent.ts and chat.service.ts at runtime.
 */
export type BdStrategy = 'hiring_signal' | 'industry_target' | 'hybrid';

export interface MasterAgentConfigFlags {
  /**
   * The strategist's LLM-derived choice. Re-written every strategist run.
   * Used as a fallback when `userExplicitBdStrategy` is not set.
   */
  bdStrategy?: BdStrategy;

  /**
   * The user's explicit pick from the chat (replied "industry" / "hiring" /
   * "hybrid" or chip A/B/C to message 2). Once set, this is the single
   * source of truth — strategist + master-agent must respect it and never
   * overwrite it from LLM output.
   */
  userExplicitBdStrategy?: BdStrategy;
}
