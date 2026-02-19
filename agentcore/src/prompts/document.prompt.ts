export interface CVExtracted {
  name: string;
  firstName: string;
  lastName: string;
  title: string;
  company: string;
  location: string;
  email: string;
  linkedinUrl: string;
  summary: string;
  skills: string[];
  experience: Array<{
    company: string;
    title: string;
    startDate: string;
    endDate: string;
    description: string;
  }>;
  education: Array<{
    institution: string;
    degree: string;
    field: string;
    year: string;
  }>;
}

export interface JobSpecExtracted {
  title: string;
  company: string;
  location: string;
  remote: boolean;
  requiredSkills: string[];
  preferredSkills: string[];
  experienceLevel: string;
  minYearsExperience: number;
  salaryRange: string;
  responsibilities: string[];
  benefits: string[];
  description: string;
}

export function buildCVSystemPrompt(): string {
  return `You are a CV/resume parser. Extract structured information from CVs, resumes, and LinkedIn profiles. Be thorough and accurate. Infer missing fields where possible.

Always respond with valid JSON.`;
}

export function buildJobSpecSystemPrompt(): string {
  return `You are a job specification analyzer. Extract structured information from job descriptions, job specs, and role briefs.

Always respond with valid JSON.`;
}

export function buildUserPrompt(data: {
  type: 'cv' | 'linkedin_profile' | 'job_spec' | 'spec';
  rawText: string;
}): string {
  if (data.type === 'cv' || data.type === 'linkedin_profile') {
    return `Extract structured information from this ${data.type === 'cv' ? 'CV/resume' : 'LinkedIn profile'}:

${data.rawText.slice(0, 6000)}

Return JSON:
{
  "name": "Full Name",
  "firstName": "First",
  "lastName": "Last",
  "title": "Current job title",
  "company": "Current company",
  "location": "City, Country",
  "email": "email@example.com or empty string",
  "linkedinUrl": "https://linkedin.com/in/... or empty string",
  "summary": "Professional summary in 2-3 sentences",
  "skills": ["skill1", "skill2"],
  "experience": [
    {
      "company": "Company Name",
      "title": "Job Title",
      "startDate": "YYYY-MM",
      "endDate": "YYYY-MM or present",
      "description": "Key responsibilities"
    }
  ],
  "education": [
    {
      "institution": "University Name",
      "degree": "BSc/MSc/PhD",
      "field": "Computer Science",
      "year": "YYYY"
    }
  ]
}`;
  }

  return `Extract structured information from this job specification:

${data.rawText.slice(0, 6000)}

Return JSON:
{
  "title": "Job title",
  "company": "Company name or empty string",
  "location": "Location or empty string",
  "remote": false,
  "requiredSkills": ["must-have skill 1", "skill 2"],
  "preferredSkills": ["nice-to-have skill 1"],
  "experienceLevel": "junior|mid|senior|lead|principal",
  "minYearsExperience": 0,
  "salaryRange": "£60k-£80k or empty string",
  "responsibilities": ["key responsibility 1"],
  "benefits": ["benefit 1"],
  "description": "One paragraph summary"
}`;
}
