export interface MasterAgentRequirements {
  useCase: string;
  targetRoles: string[];
  requiredSkills: string[];
  preferredSkills: string[];
  minExperience: number;
  locations: string[];
  scoringWeights: Record<string, number>;
  scoringThreshold: number;
  emailTone: string;
  valueProposition: string;
  searchCriteria: Record<string, unknown>;
  // Sales-specific fields
  targetCompanyAttributes?: string[];
  idealCustomerProfile?: {
    industries?: string[];
    companySizes?: string[];
    techStack?: string[];
  };
  // Sender business context
  senderCompanyName?: string;
  senderCompanyDescription?: string;
  services?: string[];
  caseStudies?: Array<{ title: string; result: string }>;
  differentiators?: string[];
  callToAction?: string;
  calendlyUrl?: string;
  senderWebsite?: string;
  senderFirstName?: string;
  senderTitle?: string;
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

  if (data.useCase === 'sales') {
    return `Analyze this mission and extract structured requirements for finding and reaching the right contacts at target organizations.

IMPORTANT: The mission could target ANY type of organization — companies, universities, government agencies, nonprofits, consulting firms, etc. Adapt ALL fields to match the actual mission. Do NOT default to tech/SaaS terminology unless the mission is explicitly about tech.

MISSION: ${data.mission}

DOCUMENTS:
${docsText || 'No documents provided.'}

Extract and return a JSON object with this exact structure:
{
  "useCase": "sales",
  "targetRoles": ["contact titles to find — adapt to mission, e.g. CTO, Dean of Research, VP Marketing, Program Director, Partnership Manager"],
  "requiredSkills": ["target organization attributes — adapt to mission, e.g. industry focus, size, type, programs, certifications"],
  "preferredSkills": ["nice-to-have organization/prospect attributes"],
  "minExperience": 0,
  "locations": ["target cities or regions, use 'Remote' if applicable"],
  "targetCompanyAttributes": ["organization descriptors: industry, size, type, focus areas"],
  "idealCustomerProfile": {
    "industries": ["target industries or sectors"],
    "companySizes": ["e.g. 50-200, 200-1000, startup, enterprise, large university, small agency"],
    "techStack": ["relevant signals: technologies, programs, certifications, partnerships, initiatives"]
  },
  "scoringWeights": {
    "authority": 30,
    "companyFit": 25,
    "relevance": 20,
    "accessibility": 15,
    "engagement": 10
  },
  "scoringThreshold": 60,
  "emailTone": "professional|casual|formal|friendly",
  "valueProposition": "one sentence about what your product solves for these companies",
  "searchCriteria": {
    "industries": [],
    "companySizes": [],
    "excludeCompanies": [],
    "keywords": ["product/solution keywords relevant to the sales campaign"]
  },
  "senderCompanyName": "name of your company (extract from mission/docs)",
  "senderCompanyDescription": "1-2 sentence description of what your company does",
  "services": ["specific services/products you offer"],
  "caseStudies": [{"title": "brief case study title", "result": "quantified outcome"}],
  "differentiators": ["what makes you different from competitors"],
  "callToAction": "desired action (e.g., 'Book a 15-min discovery call')",
  "calendlyUrl": "scheduling link if mentioned",
  "senderWebsite": "company website if mentioned",
  "senderFirstName": "first name of the email sender",
  "senderTitle": "sender's job title"
}`;
  }

  // Default: recruitment
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
  "scoringThreshold": 50,
  "emailTone": "professional|casual|formal|friendly",
  "valueProposition": "one sentence about what makes this opportunity compelling",
  "searchCriteria": {
    "industries": [],
    "companySizes": [],
    "excludeCompanies": [],
    "keywords": []
  },
  "senderCompanyName": "name of the hiring company (extract from mission/docs)",
  "senderCompanyDescription": "1-2 sentence description of the hiring company",
  "services": ["what the company builds/offers"],
  "differentiators": ["what makes this company a great place to work"],
  "callToAction": "desired action (e.g., 'Would you be open to a quick chat?')",
  "calendlyUrl": "scheduling link if mentioned",
  "senderWebsite": "company careers page or website if mentioned",
  "senderFirstName": "first name of the recruiter/sender",
  "senderTitle": "sender's job title"
}`;
}
