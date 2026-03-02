export interface CandidateProfile {
  firstName: string;
  lastName: string;
  title: string;
  company: string;
  location: string;
  email: string;
  linkedinUrl: string;
  githubUrl: string;
  personalWebsite: string;
  twitterUrl: string;
  stackOverflowUrl: string;
  mediumUrl: string;
  blogPosts: Array<{ title: string; url: string }>;
  summary: string;
  skills: string[];
  skillLevels: Array<{ skill: string; level: 'beginner' | 'intermediate' | 'advanced' | 'expert'; evidence: string }>;
  experience: Array<{
    company: string;
    title: string;
    startDate: string;
    endDate: string;
    description: string;
    technologies: string[];
  }>;
  education: Array<{ institution: string; degree: string; field: string; year: string }>;
  openSourceContributions: Array<{ repo: string; description: string }>;
  certifications: string[];
  languages: string[];
  totalYearsExperience: number;
  seniorityLevel: 'junior' | 'mid' | 'senior' | 'staff' | 'principal';
  githubStats: {
    totalRepos: number;
    totalStars: number;
    topLanguages: string[];
    topRepos: Array<{ name: string; stars: number; language: string; description: string }>;
    contributionLevel: 'inactive' | 'occasional' | 'active' | 'prolific';
  };
  dataCompleteness: number; // 0-100
}

export function buildSystemPrompt(useCase?: string): string {
  if (useCase === 'sales') {
    return `You are a sales intelligence analyst. Your job is to synthesize data from multiple sources (LinkedIn, company websites, Twitter/X, news, search results) into a comprehensive prospect profile. Prioritize: authority level, department, buying signals, company tech stack, and decision-making power.

Rules:
- Merge and reconcile data across sources. If sources conflict, prefer LinkedIn > company website > Twitter > search snippets.
- Focus on title, seniority, and department to assess authority level.
- Extract company information: industry, size, tech stack, recent funding.
- Calculate totalYearsExperience from experience entries (sum of durations, use "present" for current roles).
- Determine seniorityLevel based on: years of experience, title keywords (junior/mid/senior/staff/principal/lead/director/VP/C-suite), and responsibility scope.
- Extract social profile URLs (twitterUrl, linkedinUrl, etc.).
- Calculate dataCompleteness (0-100) based on how many fields have meaningful data:
  - Name (10), Title (10), Company (5), Location (5), Email (10)
  - Skills with 3+ items (10), Experience with 1+ entries (15), Education (5)
  - GitHub/Portfolio (5), Summary (5), Certifications/Languages (5), Skill levels (10)
  - Social profiles (5 total)
- Use empty strings for unknown text fields, empty arrays for unknown lists, 0 for unknown numbers.
- For dates, use "YYYY-MM" format. Use "present" for current positions.

Always respond with valid JSON.`;
  }

  return `You are a talent intelligence analyst. Your job is to synthesize data from multiple sources (LinkedIn, GitHub, Twitter/X, Stack Overflow, Medium/dev.to, personal websites, search results) into a comprehensive candidate profile.

Rules:
- Merge and reconcile data across sources. If sources conflict, prefer LinkedIn > personal site > GitHub > Twitter > Stack Overflow > search snippets.
- Infer skills from project descriptions, technologies mentioned in experience, GitHub repos, Stack Overflow answers, and blog posts.
- Calculate totalYearsExperience from experience entries (sum of durations, use "present" for current roles).
- Determine seniorityLevel based on: years of experience, title keywords (junior/mid/senior/staff/principal/lead/director), and responsibility scope.
- Extract social profile URLs:
  - twitterUrl: Twitter/X profile URL if found in any source.
  - stackOverflowUrl: Stack Overflow profile URL if found.
  - mediumUrl: Medium or dev.to profile URL if found.
- Extract blogPosts: up to 5 recent blog posts (title + url) from Medium, dev.to, or personal blog.
- Analyze GitHub repos data (if provided) to populate githubStats:
  - Count totalRepos and totalStars from the repos list.
  - Identify topLanguages from repo language fields (most frequent first).
  - Pick up to 5 topRepos sorted by stars descending (name, stars, language, description).
  - Determine contributionLevel: "inactive" (0-2 repos, <5 stars), "occasional" (3-10 repos), "active" (11-30 repos or 50+ stars), "prolific" (30+ repos or 200+ stars).
  - If no GitHub data available, use: { totalRepos: 0, totalStars: 0, topLanguages: [], topRepos: [], contributionLevel: "inactive" }.
- Calculate dataCompleteness (0-100) based on how many fields have meaningful data:
  - Name (10), Title (10), Company (5), Location (5), Email (10)
  - Skills with 3+ items (10), Experience with 1+ entries (15), Education (5)
  - GitHub/Portfolio (5), Summary (5), Certifications/Languages (5), Skill levels (10)
  - Social profiles — Twitter, Stack Overflow, Medium (5 total: any found counts)
- Use empty strings for unknown text fields, empty arrays for unknown lists, 0 for unknown numbers.
- For dates, use "YYYY-MM" format. Use "present" for current positions.

Always respond with valid JSON.`;
}

export function buildUserPrompt(data: {
  existingContact: {
    firstName?: string;
    lastName?: string;
    title?: string;
    companyName?: string;
    location?: string;
    email?: string;
    linkedinUrl?: string;
    skills?: string[];
    experience?: Record<string, unknown>[];
    education?: Record<string, unknown>[];
  };
  linkedinContent?: string;
  linkedinSearchContent?: string;
  githubContent?: string;
  githubReposContent?: string;
  personalSiteContent?: string;
  twitterContent?: string;
  stackOverflowContent?: string;
  devCommunityContent?: string;
  searchSnippets?: string;
}): string {
  const sections: string[] = [];

  sections.push(`EXISTING CONTACT DATA:
- Name: ${data.existingContact.firstName ?? ''} ${data.existingContact.lastName ?? ''}
- Title: ${data.existingContact.title ?? ''}
- Company: ${data.existingContact.companyName ?? ''}
- Location: ${data.existingContact.location ?? ''}
- Email: ${data.existingContact.email ?? ''}
- LinkedIn: ${data.existingContact.linkedinUrl ?? ''}
- Skills: ${(data.existingContact.skills ?? []).join(', ') || 'None'}
- Experience: ${JSON.stringify(data.existingContact.experience ?? []).slice(0, 1000)}
- Education: ${JSON.stringify(data.existingContact.education ?? []).slice(0, 500)}`);

  if (data.linkedinContent) {
    sections.push(`LINKEDIN PROFILE CONTENT:\n${data.linkedinContent.slice(0, 4000)}`);
  }

  if (data.linkedinSearchContent) {
    sections.push(`LINKEDIN SEARCH RESULT:\n${data.linkedinSearchContent.slice(0, 3000)}`);
  }

  if (data.githubContent) {
    sections.push(`GITHUB PROFILE CONTENT:\n${data.githubContent.slice(0, 3000)}`);
  }

  if (data.githubReposContent) {
    sections.push(`GITHUB REPOSITORIES (sorted by stars):\n${data.githubReposContent.slice(0, 3000)}`);
  }

  if (data.personalSiteContent) {
    sections.push(`PERSONAL WEBSITE CONTENT:\n${data.personalSiteContent.slice(0, 3000)}`);
  }

  if (data.twitterContent) {
    sections.push(`TWITTER/X PROFILE CONTENT:\n${data.twitterContent.slice(0, 2000)}`);
  }

  if (data.stackOverflowContent) {
    sections.push(`STACK OVERFLOW PROFILE CONTENT:\n${data.stackOverflowContent.slice(0, 2000)}`);
  }

  if (data.devCommunityContent) {
    sections.push(`DEV COMMUNITY (Medium/dev.to) CONTENT:\n${data.devCommunityContent.slice(0, 2000)}`);
  }

  if (data.searchSnippets) {
    sections.push(`SEARCH SNIPPETS:\n${data.searchSnippets.slice(0, 2000)}`);
  }

  return `Synthesize all the data sources below into a comprehensive CandidateProfile JSON object.

${sections.join('\n\n---\n\n')}

Return a single JSON object with all CandidateProfile fields.`;
}
