export interface CompanyEnriched {
  name: string;
  domain: string;
  industry: string;
  size: string;
  techStack: string[];
  funding: string;
  description: string;
  linkedinUrl: string;
}

export function buildSystemPrompt(): string {
  return `You are a company research analyst. Extract and structure company information from web content, LinkedIn pages, and company websites.

Focus on: industry, company size, tech stack, funding stage, and key facts.

Always respond with valid JSON.`;
}

export function buildUserPrompt(data: {
  companyName: string;
  websiteContent?: string;
  searchResults?: string;
}): string {
  const context = [
    data.websiteContent ? `WEBSITE CONTENT:\n${data.websiteContent.slice(0, 3000)}` : '',
    data.searchResults ? `SEARCH RESULTS:\n${data.searchResults.slice(0, 2000)}` : '',
  ].filter(Boolean).join('\n\n');

  return `Research and extract structured information about this company: ${data.companyName}

${context || 'No additional context available.'}

Return JSON:
{
  "name": "${data.companyName}",
  "domain": "company.com",
  "industry": "Technology|Finance|Healthcare|etc",
  "size": "1-10|11-50|51-200|201-500|501-1000|1001-5000|5000+",
  "techStack": ["React", "Node.js", "AWS"],
  "funding": "Seed|Series A|Series B|Public|Bootstrapped|Unknown",
  "description": "One paragraph about the company",
  "linkedinUrl": "https://linkedin.com/company/... or empty string"
}`;
}
