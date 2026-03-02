export interface ClassifiedResult {
  index: number;
  classification: string;
  confidence: number;
  extractedName?: string;
  extractedTitle?: string;
  extractedCompany?: string;
  extractedJobTitle?: string;
  extractedRequiredSkills?: string[];
  reasoning: string;
}

export function buildSystemPrompt(useCase?: string): string {
  if (useCase === 'sales') {
    return `You are a search result classifier for a B2B sales lead generation pipeline. Your job is to classify each search result into one of four categories:

1. **decision_maker** — A LinkedIn profile or bio page of a person with an authority title (C-suite, VP, Director, Head of, Manager). Must reference a real person's name and title.
2. **company_page** — A company website, LinkedIn company page, Crunchbase page, or company about page.
3. **team_page** — A company /team, /about, /leadership, or /people page listing multiple team members.
4. **irrelevant** — Everything else: job postings, news articles, blog posts, tutorials, forums, product pages, etc.

URL pattern hints:
- linkedin.com/in/ → likely decision_maker (check title for authority)
- linkedin.com/company/ → likely company_page
- URLs with /team, /about-us, /leadership, /people → likely team_page
- URLs with /jobs/, /careers/, /hiring/ → irrelevant (job postings)

For decision_maker results, extract the person's name (extractedName), title (extractedTitle), and company (extractedCompany) if visible.
For company_page results, extract the company name (extractedCompany).
For team_page results, extract the company name (extractedCompany).

Always respond with valid JSON — an array of ClassifiedResult objects.`;
  }

  return `You are a search result classifier for a talent sourcing pipeline. Your job is to classify each search result into one of four categories:

1. **candidate_profile** — A page about a specific individual person (LinkedIn profile, personal website, portfolio, bio page). Must reference a real person's name.
2. **company_page** — A page about a company/organization (company website, LinkedIn company page, Crunchbase, about page).
3. **job_listing** — A job posting, job board page, job aggregator page, or careers listing. Indicators:
   - Titles containing "Jobs", "Careers", "Hiring", "Open Positions", "Job Openings"
   - Titles with "Page X:", "X+ jobs", pagination markers
   - URLs from indeed.com, glassdoor.com, ziprecruiter.com, monster.com, angel.co/jobs
   - Date-stamped aggregator pages ("Best X Jobs in 2025/2026")
4. **irrelevant** — Anything else: news articles, blog posts, tutorials, forums, product pages, etc.

URL pattern hints:
- linkedin.com/in/ → likely candidate_profile
- linkedin.com/company/ → likely company_page
- github.com/{username} (no sub-paths like /repos or just github.com) → likely candidate_profile
- URLs with /jobs/, /careers/, /hiring/ → likely job_listing

For candidate_profile results, extract the person's name, title, and company if visible.
For company_page results, extract the company name.
For job_listing results, extract the company name (extractedCompany), job title (extractedJobTitle), and key required skills mentioned (extractedRequiredSkills array).

Always respond with valid JSON — an array of ClassifiedResult objects.`;
}

export function buildUserPrompt(results: Array<{ index: number; url: string; title: string; snippet: string }>, useCase?: string): string {
  const formatted = results.map((r) =>
    `[${r.index}] URL: ${r.url}\n    Title: ${r.title}\n    Snippet: ${r.snippet}`,
  ).join('\n\n');

  if (useCase === 'sales') {
    return `Classify each search result below. Return a JSON array with one object per result.

SEARCH RESULTS:
${formatted}

Return JSON array:
[
  {
    "index": 0,
    "classification": "decision_maker",
    "confidence": 0.95,
    "extractedName": "Jane Smith",
    "extractedTitle": "VP Engineering",
    "extractedCompany": "Acme Corp",
    "reasoning": "LinkedIn profile with VP-level authority title"
  }
]`;
  }

  return `Classify each search result below. Return a JSON array with one object per result.

SEARCH RESULTS:
${formatted}

Return JSON array:
[
  {
    "index": 0,
    "classification": "candidate_profile",
    "confidence": 0.95,
    "extractedName": "John Doe",
    "extractedTitle": "Senior Software Engineer",
    "extractedCompany": "Google",
    "reasoning": "LinkedIn profile URL with clear person name and title"
  }
]`;
}
