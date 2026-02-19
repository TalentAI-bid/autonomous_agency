export interface MasterAgentRequirements {
  useCase: string;
  targetRoles: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  minExperience: number;
  locations: string[];
  scoringWeights: {
    skills: number;
    experience: number;
    location: number;
    education: number;
    companyBackground: number;
  };
  scoringThreshold: number;
  emailTone: string;
  valueProposition: string;
  searchCriteria: Record<string, unknown>;
}

export function buildSystemPrompt(): string {
  return `You are an AI recruitment/sales strategy analyst. Your job is to analyze job specifications and campaign briefs, then extract structured requirements for an autonomous agent pipeline.

Always respond with valid JSON matching the specified schema. Be precise and specific in extracting requirements. Infer reasonable defaults when information is missing.`;
}

export function buildUserPrompt(data: {
  mission: string;
  documents: Array<{ type: string; rawText: string }>;
  useCase: string;
}): string {
  const docsText = data.documents
    .map((d) => `[${d.type.toUpperCase()}]\n${d.rawText.slice(0, 3000)}`)
    .join('\n\n---\n\n');

  return `Analyze this recruitment/sales mission and extract structured requirements.

MISSION: ${data.mission}

DOCUMENTS:
${docsText || 'No documents provided.'}

Extract and return a JSON object with this exact structure:
{
  "useCase": "${data.useCase}",
  "targetRoles": ["array of specific job titles to search for"],
  "requiredSkills": ["must-have technical/professional skills"],
  "preferredSkills": ["nice-to-have skills"],
  "minExperience": 0,
  "locations": ["target cities or regions, use 'Remote' if applicable"],
  "scoringWeights": {
    "skills": 40,
    "experience": 25,
    "location": 15,
    "education": 10,
    "companyBackground": 10
  },
  "scoringThreshold": 70,
  "emailTone": "professional|casual|formal|friendly",
  "valueProposition": "one sentence about what makes this opportunity compelling",
  "searchCriteria": {
    "industries": [],
    "companySizes": [],
    "excludeCompanies": [],
    "keywords": []
  }
}`;
}
