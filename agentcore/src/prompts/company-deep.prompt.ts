export interface DeepCompanyProfile {
  name: string;
  domain: string;
  industry: string;
  size: string;
  techStack: string[];
  funding: string;
  description: string;
  linkedinUrl: string;
  products: string[];
  foundedYear: string;
  headquarters: string;
  cultureValues: string[];
  recentNews: Array<{ headline: string; date: string }>;
  openPositions: Array<{
    title: string;
    location: string;
    requiredSkills: string[];
    salary: string;
    description: string;
    url: string;
  }>;
  keyPeople: Array<{ name: string; title: string; department: string; linkedinUrl: string; email: string }>;
  competitors: string[];
  contactEmail: string;
  hiringContactEmails: string[];
  glassdoorRating: string;
  employeeCount: string;
  recentFunding: string;
  teamPageUrl: string;
}

export function buildSystemPrompt(): string {
  return `You are a company research analyst specializing in deep company intelligence. Your job is to extract comprehensive company data from multiple web sources (company website, about page, careers page, team page, LinkedIn, Crunchbase, news, Glassdoor, search results).

Rules:
- Extract all available information; use empty strings for unknown text, empty arrays for unknown lists.
- For techStack, infer from job postings, careers page, and product descriptions.
- For size, use ranges: "1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000", "5000+".
- For employeeCount, extract the most precise number available (e.g. "~350", "1200+"). Use "" if unknown.
- For funding, use: "Pre-seed", "Seed", "Series A/B/C/D+", "Public", "Bootstrapped", "Unknown".
- For recentFunding, extract the latest funding round details (e.g. "Series B - $50M led by Acme Ventures, Jan 2026"). Use "" if unknown.
- For glassdoorRating, extract the overall rating (e.g. "4.2/5"). Use "" if not found.
- keyPeople extraction — STRICT RULES:
  - ONLY extract people found on the company's OWN DOMAIN pages (homepage, about page, team page, leadership page). The company domain is provided in the COMPANY header above.
  - COMPLETELY IGNORE people mentioned in: news articles, Crunchbase, external directories, press releases, partner pages, or any page NOT on the company's own domain.
  - ONLY include CURRENT employees. Do NOT include: former employees, board advisors, investors, clients, partners, or contractors.
  - Extract a MAXIMUM of 5 people. No more.
  - Priority order (extract in this order until you have 5): CEO, CTO, VP Engineering, Head of HR, Hiring Manager, COO, CFO, Head of Sales, Head of Marketing.
  - If fewer than 5 people are found on the company's own domain, return only those found. Do NOT pad with people from other sources.
  - For each person: name, title, department (e.g. "Engineering", "Sales", "Executive"), linkedinUrl (if visible on team page), email (if visible on team/contact page).
  - Use empty strings for unknown fields.
- Extract teamPageUrl: the URL of the team/leadership page if found. Use "" if not found.
- Extract open positions from careers page if available. For each position extract: title, location, requiredSkills (array), salary (string, use "" if not found), description (brief), and url (if available).
- Extract culture values from about page or careers page.
- Extract contactEmail (general company contact email) and hiringContactEmails (HR/recruiting emails found on careers pages, job posts, or contact pages). Use empty string / empty array if not found.
- For competitors, infer from industry and product descriptions.

Always respond with valid JSON.`;
}

export function buildUserPrompt(data: {
  companyName: string;
  domain?: string;
  homepageContent?: string;
  aboutPageContent?: string;
  careersPageContent?: string;
  teamPageContent?: string;
  linkedinCompanyContent?: string;
  crunchbaseContent?: string;
  newsContent?: string;
  glassdoorContent?: string;
  searchResults?: string;
}): string {
  const sections: string[] = [];

  sections.push(`COMPANY: ${data.companyName}${data.domain ? ` (${data.domain})` : ''}`);

  if (data.homepageContent) {
    sections.push(`HOMEPAGE CONTENT:\n${data.homepageContent.slice(0, 2500)}`);
  }

  if (data.aboutPageContent) {
    sections.push(`ABOUT PAGE CONTENT:\n${data.aboutPageContent.slice(0, 2000)}`);
  }

  if (data.careersPageContent) {
    sections.push(`CAREERS PAGE CONTENT:\n${data.careersPageContent.slice(0, 1500)}`);
  }

  if (data.teamPageContent) {
    sections.push(`TEAM/LEADERSHIP PAGE CONTENT:\n${data.teamPageContent.slice(0, 2500)}`);
  }

  if (data.linkedinCompanyContent) {
    sections.push(`LINKEDIN COMPANY PAGE CONTENT:\n${data.linkedinCompanyContent.slice(0, 1500)}`);
  }

  if (data.crunchbaseContent) {
    sections.push(`CRUNCHBASE / FUNDING CONTENT:\n${data.crunchbaseContent.slice(0, 1000)}`);
  }

  if (data.newsContent) {
    sections.push(`RECENT NEWS:\n${data.newsContent.slice(0, 1000)}`);
  }

  if (data.glassdoorContent) {
    sections.push(`GLASSDOOR REVIEWS:\n${data.glassdoorContent.slice(0, 500)}`);
  }

  if (data.searchResults) {
    sections.push(`SEARCH RESULTS:\n${data.searchResults.slice(0, 1000)}`);
  }

  return `Extract comprehensive company information from the sources below into a DeepCompanyProfile JSON object.

${sections.join('\n\n---\n\n')}

Return a single JSON object with all DeepCompanyProfile fields.`;
}
