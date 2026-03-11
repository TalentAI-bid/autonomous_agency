// ── Discovery Engine Types ──────────────────────────────────────────────────

export interface DiscoveryParams {
  industry?: string;
  location?: string;
  companySize?: string;
  techStack?: string[];
  keywords?: string[];
  targetRoles?: string[];
  useCase?: 'recruitment' | 'sales';
  maxResults?: number;
  targetCountries?: string[];
}

export interface PeopleDiscoveryParams {
  companyName?: string;
  companyDomain?: string;
  targetRoles?: string[];
  department?: string;
  maxResults?: number;
}

export interface RawCompanyResult {
  name: string;
  domain?: string;
  industry?: string;
  size?: string;
  techStack?: string[];
  funding?: string;
  linkedinUrl?: string;
  description?: string;
  foundedYear?: number;
  headquarters?: string;
  source: string;
  confidence: number;
  rawData?: Record<string, unknown>;
}

export interface RawPersonResult {
  firstName?: string;
  lastName?: string;
  fullName?: string;
  title?: string;
  companyName?: string;
  email?: string;
  linkedinUrl?: string;
  githubUrl?: string;
  twitterUrl?: string;
  location?: string;
  skills?: string[];
  source: string;
  confidence: number;
  rawData?: Record<string, unknown>;
}

export interface MergedCompanyResult extends RawCompanyResult {
  sources: string[];
  dataCompleteness: number;
}

export interface MergedPersonResult extends RawPersonResult {
  sources: string[];
}

export interface DiscoveryMetadata {
  totalSources: number;
  successfulSources: number;
  failedSources: string[];
  durationMs: number;
  fromCache: boolean;
}

export interface DiscoveryResult {
  companies: MergedCompanyResult[];
  people: MergedPersonResult[];
  metadata: DiscoveryMetadata;
}
