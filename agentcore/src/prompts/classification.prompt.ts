export interface ClassifiedResult {
  index: number;
  classification: string;
  confidence: number;
  extractedName?: string;
  extractedTitle?: string;
  extractedCompany?: string;
  extractedJobTitle?: string;
  extractedRequiredSkills?: string[];
  extractedCompanies?: string[];
  reasoning: string;
}

export function buildSystemPrompt(
  useCase?: string,
  salesContext?: { services?: string[]; industries?: string[] },
  icpExclusion?: { excludeCompanies?: string[]; companySizeRange?: string },
): string {
  if (useCase === 'sales') {
    let salesFocusLine = '';
    if (salesContext) {
      const parts: string[] = [];
      if (salesContext.services?.length) parts.push(`potential buyers of: ${salesContext.services.join(', ')}`);
      if (salesContext.industries?.length) parts.push(`target industries: ${salesContext.industries.join(', ')}`);
      if (parts.length) salesFocusLine = `\n\nFocus on companies that could be ${parts.join('. ')}.`;
    }

    let exclusionBlock = '\n\nIMPORTANT: SKIP mega-corporations (FAANG, Fortune 500). Focus on Series A-C startups and mid-market companies.';
    if (icpExclusion?.excludeCompanies?.length) {
      exclusionBlock += `\n\nEXCLUDE these companies and their subsidiaries: ${icpExclusion.excludeCompanies.join(', ')}`;
    }
    if (icpExclusion?.companySizeRange) {
      exclusionBlock += `\nTarget company size: ${icpExclusion.companySizeRange}. Companies with 10,000+ employees are NEVER relevant.`;
    } else {
      exclusionBlock += '\nTarget company size: 20-2000 employees. Companies with 10,000+ employees are NEVER relevant.';
    }

    return `You are a search result classifier for a B2B sales lead generation pipeline. Your job is to classify each search result into one of five categories:${salesFocusLine}

1. **decision_maker** — A LinkedIn profile or bio page of a person with an authority title (C-suite, VP, Director, Head of, Manager). Must reference a real person's name and title.
2. **company_page** — A company website, LinkedIn company page, Crunchbase page, or company about page.
3. **team_page** — A company /team, /about, /leadership, or /people page listing multiple team members.
4. **directory_page** — An article or page listing multiple companies (e.g., "10 Best Fintech Companies", "Top Blockchain Startups in London"). Do NOT use the article title as a company name.
5. **content_with_companies** — News articles, blog posts, or any content that mentions specific company names (e.g., "AI startups transforming healthcare", "Company X raises $10M"). Extract ALL company names found.
6. **irrelevant** — Content with NO company mentions: tutorials, generic forums, product docs, how-to guides, etc.
${exclusionBlock}

URL pattern hints:
- linkedin.com/in/ → likely decision_maker (check title for authority)
- linkedin.com/company/ → likely company_page
- URLs with /team, /about-us, /leadership, /people → likely team_page
- URLs with /jobs/, /careers/, /hiring/ → irrelevant (job postings)
- Titles with "Top X", "Best X", "X Companies" → likely directory_page
- News articles mentioning companies → likely content_with_companies

CRITICAL RULES FOR COMPANY NAME EXTRACTION:
- NEVER extract article titles, news headlines, or sentence fragments as company names.
- Company names are typically 1-5 words, proper nouns, capitalized (e.g., "Acme Corp", "DataBricks", "Stripe").
- If a result is a news article with no clear company mention in the snippet, classify as irrelevant.
- Strings containing "..." or "…", or that read like a sentence, are NOT company names.
- Headlines like "Doncaster firm named one of Europe's fastest growing" are NOT company names.

For decision_maker results, extract the person's name (extractedName), title (extractedTitle), and company (extractedCompany) if visible.
For company_page results, extract the company name (extractedCompany).
For team_page results, extract the company name (extractedCompany).
For directory_page results, extract company names in extractedCompanies array if visible in the snippet. The page will also be scraped separately.
For content_with_companies results, extract ALL company names mentioned in extractedCompanies array.

Always respond with valid JSON — an array of ClassifiedResult objects.`;
  }

  return `You are a search result classifier for a talent sourcing pipeline. Your job is to classify each search result into one of five categories:

1. **candidate_profile** — A page about a specific individual person (LinkedIn profile, personal website, portfolio, bio page). Must reference a real person's name.
2. **company_page** — A page about a company/organization (company website, LinkedIn company page, Crunchbase, about page).
3. **job_listing** — A job posting, job board page, job aggregator page, or careers listing. Indicators:
   - Titles containing "Jobs", "Careers", "Hiring", "Open Positions", "Job Openings"
   - Titles with "Page X:", "X+ jobs", pagination markers
   - URLs from indeed.com, glassdoor.com, ziprecruiter.com, monster.com, angel.co/jobs
   - Date-stamped aggregator pages ("Best X Jobs in 2025/2026")
4. **directory_page** — An article or page listing multiple companies (e.g., "10 Best Fintech Companies", "Top Blockchain Startups"). Do NOT use the article title as a company name.
5. **content_with_companies** — News articles, blog posts, or any content that mentions specific company names. Extract ALL company names found.
6. **irrelevant** — Content with NO company mentions: tutorials, generic forums, product docs, how-to guides, etc.

URL pattern hints:
- linkedin.com/in/ → likely candidate_profile
- linkedin.com/company/ → likely company_page
- github.com/{username} (no sub-paths like /repos or just github.com) → likely candidate_profile
- URLs with /jobs/, /careers/, /hiring/ → likely job_listing
- News articles mentioning companies → likely content_with_companies

CRITICAL RULES FOR COMPANY NAME EXTRACTION:
- NEVER extract article titles, news headlines, or sentence fragments as company names.
- Company names are typically 1-5 words, proper nouns, capitalized (e.g., "Acme Corp", "DataBricks", "Stripe").
- If a result is a news article with no clear company mention in the snippet, classify as irrelevant.
- Strings containing "..." or "…", or that read like a sentence, are NOT company names.
- Headlines like "Doncaster firm named one of Europe's fastest growing" are NOT company names.

For candidate_profile results, extract the person's name, title, and company if visible.
For company_page results, extract the company name.
For job_listing results, extract the company name (extractedCompany), job title (extractedJobTitle), and key required skills mentioned (extractedRequiredSkills array).
For directory_page results, extract company names in extractedCompanies array if visible in the snippet.
For content_with_companies results, extract ALL company names mentioned in extractedCompanies array.

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
