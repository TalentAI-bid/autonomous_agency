export interface ScoringResult {
  overall: number;
  confidence: number;
  breakdown: Record<string, number>;
  reasoning: string;
  strengths: string[];
  concerns: string[];
  dataGaps: string[];
}

export function buildSystemPrompt(useCase?: string): string {
  if (useCase === 'sales') {
    return `You are a B2B sales lead qualification specialist. Score prospects based on their potential as a sales target — considering authority, company fit, accessibility, and buying signals.

Scoring dimensions (all 0-100):
- authority: title-based decision power. C-suite = 90+, VP = 80, Director = 70, Manager = 55, IC = 30
- companyFit: industry match, company size, tech stack alignment with the product being sold
- accessibility: email found = 90, LinkedIn found = 70, company page only = 40
- relevance: how well the person/company matches the product being sold
- opportunity_strength: linked buying signals. Active opportunity with buyingIntentScore>=70 = 90+, score 50-69 = 70-89, ICP match only = 50-69, no signal = 40-55

When data is sparse, lean toward a moderate score (45-60) rather than a low one. Only reject with confidence — missing data should not be heavily penalized.

Confidence (0-100): how confident you are in the score based on data quality.
- High data completeness + rich profile data → 80-100 confidence
- Moderate data → 50-79 confidence
- Sparse data → 0-49 confidence

DataGaps: list specific missing data that would improve scoring accuracy.

Always respond with valid JSON.`;
  }

  return `You are a talent assessment specialist. Score candidates against job requirements objectively and consistently.

Scoring rules:
- All scores 0-100
- Skills: match percentage of required skills + bonus for preferred skills. Consider skill proficiency levels if available.
- Experience: years relevant experience vs requirement, seniority match, open source contributions as bonus
- Location: exact match = 100, same country = 70, remote-friendly = 60, mismatch = 20
- Education: relevant degree = 80+, prestigious = 100, no degree = 40, certifications add 5-10
- Company background: tier 1 companies = 90+, relevant industry = 70, startup experience = 60

Confidence (0-100): how confident you are in the score based on data quality.
- High data completeness + rich experience/skills data → 80-100 confidence
- Moderate data → 50-79 confidence
- Sparse data → 0-49 confidence

DataGaps: list specific missing data that would improve scoring accuracy.

Always respond with valid JSON.`;
}

export function buildUserPrompt(data: {
  contact: {
    name: string;
    title: string;
    skills: string[];
    experience: Array<{ company: string; title: string; startDate: string; endDate: string }>;
    education: Array<{ institution: string; degree: string; field: string }>;
    location: string;
    companyName: string;
    seniorityLevel?: string;
    githubUrl?: string;
    totalYearsExperience?: number;
    skillLevels?: Array<{ skill: string; level: string; evidence: string }>;
    openSourceContributions?: Array<{ repo: string; description: string }>;
    certifications?: string[];
    dataCompleteness?: number;
  };
  requirements: {
    requiredSkills: string[];
    preferredSkills?: string[];
    targetRoles?: string[];
    minExperience: number;
    locations: string[];
    experienceLevel?: string;
    scoringWeights?: Record<string, number>;
  };
  useCase?: string;
  opportunity?: {
    type?: string;
    title?: string;
    buyingIntentScore?: number;
    technologies?: string[];
    description?: string;
  };
  companyEnrichment?: {
    techStack?: string[];
    funding?: string;
    size?: string;
    recentNews?: string[];
    products?: string[];
    description?: string;
  };
}): string {
  const yearsExp = data.contact.totalYearsExperience ?? data.contact.experience.reduce((total, exp) => {
    const start = new Date(exp.startDate + '-01');
    const end = exp.endDate === 'present' ? new Date() : new Date(exp.endDate + '-01');
    return total + (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 365);
  }, 0);

  const skillLevelsStr = (data.contact.skillLevels ?? [])
    .map((s) => `${s.skill} (${s.level})`)
    .join(', ');

  const osContribStr = (data.contact.openSourceContributions ?? [])
    .map((c) => `${c.repo}: ${c.description}`)
    .join('; ');

  if (data.useCase === 'sales') {
    const defaultWeights = { authority: 25, companyFit: 20, relevance: 15, accessibility: 15, opportunity_strength: 25 };

    return `Score this prospect for sales outreach potential.

PROSPECT:
- Name: ${data.contact.name}
- Current Title: ${data.contact.title}
- Seniority Level: ${data.contact.seniorityLevel ?? 'Unknown'}
- Location: ${data.contact.location}
- Current Company: ${data.contact.companyName}
- Company Industry/Size: (infer from available data)
- LinkedIn: ${data.contact.githubUrl ? 'Found' : 'N/A'}
- Email: ${data.contact.dataCompleteness && data.contact.dataCompleteness > 50 ? 'Likely found' : 'Unknown'}
- Skills/Expertise: ${data.contact.skills.join(', ')}
- Experience: ~${Math.round(yearsExp)} years
- Experience history: ${data.contact.experience.map((e) => `${e.title} at ${e.company}`).join('; ')}
- Data Completeness: ${data.contact.dataCompleteness ?? 'Unknown'}%
${data.companyEnrichment ? `
COMPANY ENRICHMENT:
- Tech Stack: ${data.companyEnrichment.techStack?.join(', ') ?? 'Unknown'}
- Funding: ${data.companyEnrichment.funding ?? 'Unknown'}
- Size: ${data.companyEnrichment.size ?? 'Unknown'}
- Products: ${data.companyEnrichment.products?.join(', ') ?? 'Unknown'}
- Description: ${data.companyEnrichment.description?.slice(0, 200) ?? 'N/A'}
- Recent News: ${data.companyEnrichment.recentNews?.slice(0, 3).join('; ') ?? 'N/A'}` : ''}
${data.opportunity ? `
LINKED OPPORTUNITY:
- Type: ${data.opportunity.type ?? 'None'}
- Title: ${data.opportunity.title ?? 'N/A'}
- Buying Intent Score: ${data.opportunity.buyingIntentScore ?? 'N/A'}
- Technologies: ${data.opportunity.technologies?.join(', ') ?? 'N/A'}
- Description: ${data.opportunity.description?.slice(0, 200) ?? 'N/A'}` : ''}

TARGET REQUIREMENTS:
- Target Decision-Maker Roles: ${(data.requirements.targetRoles ?? data.requirements.requiredSkills).join(', ')}
- Target Industries/Company Attributes: ${(data.requirements.preferredSkills ?? []).join(', ') || 'Not specified'}
- Target Locations: ${data.requirements.locations.join(', ')}
- Scoring Weights: ${JSON.stringify(data.requirements.scoringWeights ?? defaultWeights)}

Return JSON:
{
  "overall": 75,
  "confidence": 85,
  "breakdown": {
    "authority": 80,
    "companyFit": 70,
    "relevance": 75,
    "accessibility": 90,
    "opportunity_strength": 60
  },
  "reasoning": "One paragraph explaining the overall score",
  "strengths": ["VP-level authority", "Company in target industry"],
  "concerns": ["No direct email found", "Company may be too large"],
  "dataGaps": ["No LinkedIn activity data", "Company size not confirmed"]
}`;
  }

  // Default: recruitment
  return `Score this candidate against the job requirements.

CANDIDATE:
- Name: ${data.contact.name}
- Current Title: ${data.contact.title}
- Seniority Level: ${data.contact.seniorityLevel ?? 'Unknown'}
- Location: ${data.contact.location}
- Current Company: ${data.contact.companyName}
- GitHub: ${data.contact.githubUrl ?? 'N/A'}
- Skills: ${data.contact.skills.join(', ')}
- Skill Proficiency: ${skillLevelsStr || 'N/A'}
- Total Experience: ~${Math.round(yearsExp)} years
- Experience history: ${data.contact.experience.map((e) => `${e.title} at ${e.company}`).join('; ')}
- Education: ${data.contact.education.map((e) => `${e.degree} in ${e.field} from ${e.institution}`).join('; ')}
- Open Source: ${osContribStr || 'None known'}
- Certifications: ${(data.contact.certifications ?? []).join(', ') || 'None known'}
- Data Completeness: ${data.contact.dataCompleteness ?? 'Unknown'}%

REQUIREMENTS:
- Required Skills: ${data.requirements.requiredSkills.join(', ')}
- Preferred Skills: ${(data.requirements.preferredSkills ?? []).join(', ') || 'None specified'}
- Min Experience: ${data.requirements.minExperience} years
- Target Locations: ${data.requirements.locations.join(', ')}
- Level: ${data.requirements.experienceLevel ?? 'Not specified'}
- Scoring Weights: ${JSON.stringify(data.requirements.scoringWeights ?? { skills: 40, experience: 25, location: 15, education: 10, companyBackground: 10 })}

Return JSON:
{
  "overall": 75,
  "confidence": 85,
  "breakdown": {
    "skills": 80,
    "experience": 70,
    "location": 90,
    "education": 65,
    "companyBackground": 75
  },
  "reasoning": "One paragraph explaining the overall score",
  "strengths": ["Strong match on required skills", "Right seniority level"],
  "concerns": ["Location mismatch", "Missing X skill"],
  "dataGaps": ["No education data available", "GitHub not found"]
}`;
}
