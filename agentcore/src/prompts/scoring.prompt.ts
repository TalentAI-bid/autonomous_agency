export interface ScoringResult {
  overall: number;
  breakdown: {
    skills: number;
    experience: number;
    location: number;
    education: number;
    companyBackground: number;
  };
  reasoning: string;
  strengths: string[];
  concerns: string[];
}

export function buildSystemPrompt(): string {
  return `You are a talent assessment specialist. Score candidates against job requirements objectively and consistently.

Scoring rules:
- All scores 0-100
- Skills: match percentage of required skills + bonus for preferred skills
- Experience: years relevant experience vs requirement, seniority match
- Location: exact match = 100, same country = 70, remote-friendly = 60, mismatch = 20
- Education: relevant degree = 80+, prestigious = 100, no degree = 40
- Company background: tier 1 companies = 90+, relevant industry = 70, startup experience = 60

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
  };
  requirements: {
    requiredSkills: string[];
    preferredSkills?: string[];
    minExperience: number;
    locations: string[];
    experienceLevel?: string;
    scoringWeights?: Record<string, number>;
  };
}): string {
  const yearsExp = data.contact.experience.reduce((total, exp) => {
    const start = new Date(exp.startDate + '-01');
    const end = exp.endDate === 'present' ? new Date() : new Date(exp.endDate + '-01');
    return total + (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 365);
  }, 0);

  return `Score this candidate against the job requirements.

CANDIDATE:
- Name: ${data.contact.name}
- Current Title: ${data.contact.title}
- Location: ${data.contact.location}
- Current Company: ${data.contact.companyName}
- Skills: ${data.contact.skills.join(', ')}
- Total Experience: ~${Math.round(yearsExp)} years
- Experience history: ${data.contact.experience.map((e) => `${e.title} at ${e.company}`).join('; ')}
- Education: ${data.contact.education.map((e) => `${e.degree} in ${e.field} from ${e.institution}`).join('; ')}

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
  "breakdown": {
    "skills": 80,
    "experience": 70,
    "location": 90,
    "education": 65,
    "companyBackground": 75
  },
  "reasoning": "One paragraph explaining the overall score",
  "strengths": ["Strong match on required skills", "Right seniority level"],
  "concerns": ["Location mismatch", "Missing X skill"]
}`;
}
