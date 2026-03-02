/**
 * Pipeline Integration Test — 6-Step Job→Candidate→Outreach Flow
 *
 * Tests the full agent pipeline:
 *   1. SearXNG job search
 *   2. Crawl4ai job scrape + Together AI requirements extraction
 *   3. SearXNG candidate search (from extracted requirements)
 *   4. Crawl4ai candidate scrape + Together AI data extraction
 *   5. Together AI candidate scoring (against job requirements)
 *   6. Outreach email generation (Claude primary, Together AI fallback — dry-run)
 *
 * Usage:  cd agentcore && npx tsx scripts/test-scraping-pipeline.ts
 * Output: agentcore/scripts/pipeline-test-results.json
 */

import { readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

/** Load .env file into process.env (only sets vars that are not already set). */
function loadEnv(): void {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  // Try .env next to the scripts/ dir (i.e. agentcore/.env)
  const envPath = join(scriptDir, '..', '.env');

  let raw: string;
  try {
    raw = readFileSync(envPath, 'utf-8');
  } catch {
    // .env file not found — silently continue (env vars may be set externally)
    return;
  }

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    // Skip blank lines and comments
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;

    const key = trimmed.slice(0, eqIndex).trim();
    let value = trimmed.slice(eqIndex + 1).trim();

    // Strip surrounding quotes (single or double)
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Only set if not already present in the environment
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadEnv();

const SEARXNG_URL = process.env.SEARXNG_URL ?? 'http://localhost:8080';
const CRAWL4AI_URL = process.env.CRAWL4AI_URL ?? 'http://localhost:11235';
const TOGETHER_API_URL = process.env.TOGETHER_API_URL ?? 'https://api.together.xyz/v1';
const TOGETHER_API_KEY = process.env.TOGETHER_API_KEY ?? '';
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY ?? '';

// Early-exit guard
if (!TOGETHER_API_KEY) {
  console.error(
    `[pipeline-test] ERROR: TOGETHER_API_KEY is not set.\n` +
    `\n` +
    `  This script loads agentcore/.env automatically.\n` +
    `  Make sure .env exists and contains TOGETHER_API_KEY, then run:\n` +
    `\n` +
    `    cd agentcore && npx tsx scripts/test-scraping-pipeline.ts\n`,
  );
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_PATH = join(__dirname, 'pipeline-test-results.json');

interface StepResult {
  step: string;
  status: 'pass' | 'fail';
  durationMs: number;
  data?: unknown;
  error?: string;
}

const results: StepResult[] = [];

function log(msg: string) {
  console.log(`[pipeline-test] ${msg}`);
}

/** Strip JSON code-fence wrappers from LLM responses */
function stripJsonFence(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

// ── Shared types ────────────────────────────────────────────────────────

interface JobRequirements {
  title: string;
  company: string;
  location: string;
  requiredSkills: string[];
  experienceYears: number;
  description: string;
}

interface CandidateData {
  firstName: string;
  lastName: string;
  title: string;
  company: string;
  location: string;
  skills: string[];
  experience: Array<{ company: string; title: string; duration: string }>;
  email: string;
  linkedinUrl: string;
}

interface ScoringResult {
  overall: number;
  breakdown: Record<string, number>;
  reasoning: string;
}

// ── Reusable helper: Crawl4ai scrape with polling ───────────────────────

async function scrapeUrl(url: string): Promise<string | null> {
  const res = await fetch(`${CRAWL4AI_URL}/crawl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      urls: [url],
      word_count_threshold: 10,
      extraction_strategy: 'NoExtractionStrategy',
      chunking_strategy: 'RegexChunking',
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`Crawl4ai returned ${res.status}`);

  const data = (await res.json()) as {
    status?: string;
    task_id?: string;
    results?: Array<{
      markdown?: string | { raw_markdown?: string };
      extracted_content?: string;
      content?: string;
    }>;
  };

  // Handle async task polling
  let resultData = data;
  if (!data.results?.length && data.task_id) {
    log(`  Async task ${data.task_id}, polling...`);
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const pollRes = await fetch(`${CRAWL4AI_URL}/task/${data.task_id}`);
      if (!pollRes.ok) continue;
      const pollData = (await pollRes.json()) as typeof data;
      if (pollData.status === 'completed' && pollData.results?.length) {
        resultData = pollData;
        break;
      }
    }
  }

  // Extract text using the FIXED parsing logic
  const md = resultData.results?.[0]?.markdown;
  const text = typeof md === 'string' ? md : (md?.raw_markdown ?? resultData.results?.[0]?.extracted_content ?? '');

  // Critical check: detect the old bug
  const isBroken = text === '[object Object]' || text.includes('[object Object]');
  const isEmpty = text.trim().length === 0;

  if (isBroken) throw new Error('markdown is "[object Object]" — parsing bug');
  if (isEmpty) throw new Error('scraped text is empty');

  return text;
}

/** Call Together AI chat completions and return the raw content string */
async function callTogetherAI(messages: Array<{ role: string; content: string }>, maxTokens = 2048): Promise<string> {
  const res = await fetch(`${TOGETHER_API_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOGETHER_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-ai/DeepSeek-V3',
      messages,
      temperature: 0.3,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`Together AI returned ${res.status}`);

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content ?? '';
}

// ── Step 1: Job Search (SearXNG) ────────────────────────────────────────

async function step1_jobSearch(): Promise<string | null> {
  const query = 'rust blockchain developer remote';
  log(`Step 1 — Job Search (SearXNG): "${query}"`);
  const start = Date.now();

  try {
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);

    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const hits = data.results ?? [];

    const step: StepResult = {
      step: '1_job_search',
      status: hits.length > 0 ? 'pass' : 'fail',
      durationMs: Date.now() - start,
      data: { query, totalResults: hits.length, top3: hits.slice(0, 3) },
    };
    results.push(step);

    if (hits.length === 0) {
      log('  FAIL — no search results returned');
      return null;
    }

    // Prefer a specific job page URL (not a listing index)
    const jobUrl = hits[0]?.url ?? null;
    log(`  PASS — ${hits.length} results. Top: ${jobUrl}`);
    return jobUrl;
  } catch (err) {
    results.push({ step: '1_job_search', status: 'fail', durationMs: Date.now() - start, error: String(err) });
    log(`  FAIL — ${err}`);
    return null;
  }
}

// ── Step 2: Job Scrape & Requirements Extraction ────────────────────────

const FALLBACK_JOB_REQUIREMENTS: JobRequirements = {
  title: 'Senior Rust/Blockchain Developer',
  company: 'Web3 Startup',
  location: 'Remote',
  requiredSkills: ['Rust', 'Solana', 'Blockchain', 'Smart Contracts', 'TypeScript'],
  experienceYears: 3,
  description: 'Looking for an experienced Rust developer with blockchain/web3 experience to build decentralized applications.',
};

async function step2_jobScrapeAndExtract(jobUrl: string): Promise<{ jobText: string; jobRequirements: JobRequirements }> {
  log(`Step 2 — Job Scrape & Requirements Extraction: ${jobUrl}`);
  const start = Date.now();

  try {
    // Scrape the job page
    const jobText = await scrapeUrl(jobUrl);
    if (!jobText) throw new Error('scrapeUrl returned null');

    log(`  Scraped ${jobText.length} chars. Extracting requirements via Together AI...`);

    // Extract structured requirements via Together AI
    const messages = [
      {
        role: 'system',
        content: `You are a data extraction assistant. Extract structured job requirements from the provided text.
The page may list multiple jobs — if so, extract details from the FIRST or most prominent job listing.
Return ONLY a JSON object with these fields:
{
  "title": "",
  "company": "",
  "location": "",
  "requiredSkills": [],
  "experienceYears": 0,
  "description": ""
}
If a field is not found, make your best guess from context. For requiredSkills, include any programming languages, frameworks, or technologies mentioned. Return ONLY the JSON.`,
      },
      {
        role: 'user',
        content: `Extract structured job requirements from the following job posting text:\n\n${jobText.slice(0, 6000)}`,
      },
    ];

    const content = await callTogetherAI(messages);
    const extracted = JSON.parse(stripJsonFence(content)) as JobRequirements;

    const hasData = !!(extracted.title || (extracted.requiredSkills && extracted.requiredSkills.length > 0));

    const step: StepResult = {
      step: '2_job_scrape_extract',
      status: hasData ? 'pass' : 'fail',
      durationMs: Date.now() - start,
      data: { url: jobUrl, textLength: jobText.length, extracted },
    };
    results.push(step);

    if (hasData) {
      log(`  PASS — Title: "${extracted.title}", Skills: [${extracted.requiredSkills?.join(', ')}]`);
      return { jobText, jobRequirements: extracted };
    } else {
      log('  FAIL — extraction returned empty fields, using fallback requirements');
      return { jobText, jobRequirements: FALLBACK_JOB_REQUIREMENTS };
    }
  } catch (err) {
    results.push({ step: '2_job_scrape_extract', status: 'fail', durationMs: Date.now() - start, error: String(err) });
    log(`  FAIL — ${err}`);
    log('  Using fallback job requirements for subsequent steps');
    return { jobText: '', jobRequirements: FALLBACK_JOB_REQUIREMENTS };
  }
}

// ── Step 3: Candidate Search (SearXNG) ──────────────────────────────────

interface SearchHit {
  url: string;
  title: string;
  content: string;
}

const FALLBACK_CANDIDATE_URL = 'https://github.com/nickel-org/nickel.rs';

async function step3_candidateSearch(jobRequirements: JobRequirements): Promise<SearchHit> {
  const skills = jobRequirements.requiredSkills?.slice(0, 3).join(' ') || 'Rust blockchain';
  const query = `${skills} developer site:linkedin.com/in/`;
  log(`Step 3 — Candidate Search (SearXNG): "${query}"`);
  const start = Date.now();

  const fallbackHit: SearchHit = { url: FALLBACK_CANDIDATE_URL, title: '', content: '' };

  try {
    const url = `${SEARXNG_URL}/search?q=${encodeURIComponent(query)}&format=json`;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`SearXNG returned ${res.status}`);

    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    const hits = data.results ?? [];

    // Filter to linkedin.com/in/ profile URLs only (no /jobs/, /company/, etc.)
    const profileHits = hits.filter((h) => {
      const u = h.url ?? '';
      return u.includes('linkedin.com/in/') && !u.includes('/jobs/') && !u.includes('/company/');
    });

    const topHit = profileHits[0];

    const step: StepResult = {
      step: '3_candidate_search',
      status: profileHits.length > 0 ? 'pass' : 'fail',
      durationMs: Date.now() - start,
      data: {
        query,
        totalResults: hits.length,
        profileResults: profileHits.length,
        top3Profiles: profileHits.slice(0, 3),
      },
    };
    results.push(step);

    if (topHit?.url) {
      log(`  PASS — ${profileHits.length} profile(s) found. Top: ${topHit.url}`);
      return { url: topHit.url, title: topHit.title ?? '', content: topHit.content ?? '' };
    } else {
      log(`  FAIL — no linkedin.com/in/ profiles found (${hits.length} total results). Using fallback.`);
      return fallbackHit;
    }
  } catch (err) {
    results.push({ step: '3_candidate_search', status: 'fail', durationMs: Date.now() - start, error: String(err) });
    log(`  FAIL — ${err}`);
    log(`  Using fallback candidate URL: ${FALLBACK_CANDIDATE_URL}`);
    return fallbackHit;
  }
}

// ── Step 4: Candidate Scrape & Data Extraction ──────────────────────────

async function step4_candidateScrapeAndExtract(searchHit: SearchHit): Promise<{ candidateText: string; candidateData: CandidateData } | null> {
  const candidateUrl = searchHit.url;
  log(`Step 4 — Candidate Scrape & Data Extraction: ${candidateUrl}`);
  const start = Date.now();

  try {
    let candidateText: string;
    try {
      candidateText = (await scrapeUrl(candidateUrl)) ?? '';
    } catch {
      log('  Scrape failed, will rely on search snippet data');
      candidateText = '';
    }

    // Combine scraped text with search snippet for better extraction
    const searchContext = [searchHit.title, searchHit.content].filter(Boolean).join('\n');
    const combinedText = [candidateText, searchContext ? `\n\n--- Search snippet ---\n${searchContext}` : ''].join('');

    if (!combinedText.trim()) throw new Error('no text available (scrape failed and no search snippet)');

    log(`  Text available: ${candidateText.length} chars scraped + ${searchContext.length} chars from search snippet. Extracting via Together AI...`);

    const messages = [
      {
        role: 'system',
        content: `You are a data extraction assistant. Extract structured profile data from the provided text.
The text may include a scraped page and/or a search snippet. Use ALL available information to fill in fields.
If you can infer a person's name from the title or heading (e.g., "John Smith - Software Engineer | LinkedIn"), extract it.
Return ONLY a JSON object with these fields:
{
  "firstName": "",
  "lastName": "",
  "title": "",
  "company": "",
  "location": "",
  "skills": [],
  "experience": [{ "company": "", "title": "", "duration": "" }],
  "email": "",
  "linkedinUrl": ""
}
If a field is not found, use an empty string, empty array, or null. Return ONLY the JSON.`,
      },
      {
        role: 'user',
        content: `Extract structured profile data from the following text:\n\n${combinedText.slice(0, 6000)}`,
      },
    ];

    const content = await callTogetherAI(messages);
    const extracted = JSON.parse(stripJsonFence(content)) as CandidateData;

    // Fill in the URL if not extracted
    if (!extracted.linkedinUrl && candidateUrl.includes('linkedin.com')) {
      extracted.linkedinUrl = candidateUrl;
    }

    const hasData = !!(extracted.firstName || extracted.title || (extracted.skills && extracted.skills.length > 0));

    const step: StepResult = {
      step: '4_candidate_scrape_extract',
      status: hasData ? 'pass' : 'fail',
      durationMs: Date.now() - start,
      data: { url: candidateUrl, scrapedLength: candidateText.length, snippetLength: searchContext.length, extracted },
    };
    results.push(step);

    if (hasData) {
      log(`  PASS — ${extracted.firstName ?? '?'} ${extracted.lastName ?? '?'}, ${extracted.title ?? 'no title'}, Skills: [${(extracted.skills ?? []).slice(0, 5).join(', ')}]`);
      return { candidateText: combinedText, candidateData: extracted };
    } else {
      log('  FAIL — extraction returned empty fields');
      return null;
    }
  } catch (err) {
    results.push({ step: '4_candidate_scrape_extract', status: 'fail', durationMs: Date.now() - start, error: String(err) });
    log(`  FAIL — ${err}`);
    return null;
  }
}

// ── Step 5: Candidate Scoring ───────────────────────────────────────────

async function step5_candidateScoring(candidateData: CandidateData, jobRequirements: JobRequirements): Promise<ScoringResult | null> {
  log('Step 5 — Candidate Scoring (Together AI)');
  const start = Date.now();

  try {
    const messages = [
      {
        role: 'system',
        content: `You are a candidate scoring assistant. Score how well a candidate matches the given job requirements.
Return ONLY a JSON object:
{
  "overall": <number 0-100>,
  "breakdown": {
    "skillMatch": <number 0-100>,
    "experienceMatch": <number 0-100>,
    "relevance": <number 0-100>
  },
  "reasoning": "<brief explanation>"
}
Return ONLY the JSON.`,
      },
      {
        role: 'user',
        content: `Score this candidate against the job requirements.

Job Requirements:
- Title: ${jobRequirements.title}
- Company: ${jobRequirements.company}
- Location: ${jobRequirements.location}
- Required Skills: ${jobRequirements.requiredSkills.join(', ')}
- Experience: ${jobRequirements.experienceYears}+ years
- Description: ${jobRequirements.description}

Candidate:
- Name: ${candidateData.firstName ?? '?'} ${candidateData.lastName ?? '?'}
- Title: ${candidateData.title ?? 'Unknown'}
- Company: ${candidateData.company ?? 'Unknown'}
- Skills: ${JSON.stringify(candidateData.skills ?? [])}
- Experience: ${JSON.stringify(candidateData.experience ?? [])}
- Location: ${candidateData.location ?? 'Unknown'}`,
      },
    ];

    const content = await callTogetherAI(messages, 1024);
    const scoring = JSON.parse(stripJsonFence(content)) as ScoringResult;

    const overall = Number(scoring.overall ?? -1);
    const passed = overall >= 0;

    const step: StepResult = {
      step: '5_candidate_scoring',
      status: passed ? 'pass' : 'fail',
      durationMs: Date.now() - start,
      data: { scoring, jobRequirements },
    };
    results.push(step);

    if (passed) {
      log(`  PASS — Score: ${overall}/100. ${scoring.reasoning ?? ''}`);
      return scoring;
    } else {
      log('  FAIL — scoring returned invalid data');
      return null;
    }
  } catch (err) {
    results.push({ step: '5_candidate_scoring', status: 'fail', durationMs: Date.now() - start, error: String(err) });
    log(`  FAIL — ${err}`);
    return null;
  }
}

// ── Step 6: Outreach Email Generation (dry-run) ─────────────────────────

async function step6_outreachEmail(
  candidateData: CandidateData,
  jobRequirements: JobRequirements,
  scoring: ScoringResult,
): Promise<void> {
  log('Step 6 — Outreach Email Generation (dry-run, NOT sending via SMTP)');
  const start = Date.now();

  const firstName = candidateData.firstName ?? 'there';
  const candidateTitle = candidateData.title ?? '';
  const candidateCompany = candidateData.company ?? '';
  const skills = candidateData.skills ?? [];
  const score = Number(scoring.overall ?? 0);

  const systemPrompt = `You are an expert recruiter writing a personalized outreach email.
Write a professional, warm, and concise email to a potential candidate.
Return ONLY a JSON object with "subject" and "body" fields.
The body should be plain text (not HTML).
Keep it under 200 words. Be specific about why they're a great fit based on the job and their background.`;

  const userPrompt = `Write a recruitment outreach email for:
- Candidate Name: ${firstName} ${candidateData.lastName ?? ''}
- Current Title: ${candidateTitle}
- Current Company: ${candidateCompany}
- Key Skills: ${skills.join(', ')}
- Fit Score: ${score}/100
- Scoring Reasoning: ${scoring.reasoning ?? 'N/A'}

Job Opportunity:
- Title: ${jobRequirements.title}
- Company: ${jobRequirements.company}
- Location: ${jobRequirements.location}
- Required Skills: ${jobRequirements.requiredSkills.join(', ')}
- Description: ${jobRequirements.description}

Explain why this candidate is a great fit for this specific role.
Tone: Professional but friendly.

Return JSON: { "subject": "...", "body": "..." }`;

  try {
    let content: string;

    if (CLAUDE_API_KEY) {
      // Use Claude (Anthropic API)
      log('  Using Claude API for email generation...');
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': CLAUDE_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5-20250929',
          max_tokens: 1024,
          system: systemPrompt,
          messages: [{ role: 'user', content: userPrompt }],
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!res.ok) throw new Error(`Claude API returned ${res.status}`);

      const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
      content = data.content?.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('') ?? '';
    } else {
      // Fallback to Together AI (DeepSeek-V3)
      log('  CLAUDE_API_KEY not set, using Together AI (DeepSeek-V3) fallback...');
      content = await callTogetherAI(
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        1024,
      );
    }

    // Parse email JSON
    const email = JSON.parse(stripJsonFence(content)) as { subject?: string; body?: string };
    const hasEmail = !!(email.subject && email.body);

    const step: StepResult = {
      step: '6_outreach_email_dryrun',
      status: hasEmail ? 'pass' : 'fail',
      durationMs: Date.now() - start,
      data: { email, dryRun: true, smtpSent: false },
    };
    results.push(step);

    if (hasEmail) {
      log(`  PASS — Generated email (NOT sent)`);
      log(`  Subject: ${email.subject}`);
      log(`  Body preview: ${email.body!.slice(0, 200)}...`);
    } else {
      log('  FAIL — email generation returned empty subject/body');
    }
  } catch (err) {
    results.push({ step: '6_outreach_email_dryrun', status: 'fail', durationMs: Date.now() - start, error: String(err) });
    log(`  FAIL — ${err}`);
  }
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  log('Starting pipeline integration test (6 steps)\n');

  // Step 1: Job Search
  const jobUrl = await step1_jobSearch();
  console.log();

  // Step 2: Job Scrape & Requirements Extraction
  const scrapeJobUrl = jobUrl ?? 'https://www.rust-lang.org/what/networking';
  if (!jobUrl) log(`Job search returned no results, using fallback URL: ${scrapeJobUrl}\n`);
  const { jobText, jobRequirements } = await step2_jobScrapeAndExtract(scrapeJobUrl);
  console.log();

  // Step 3: Candidate Search (using extracted requirements)
  const candidateSearchHit = await step3_candidateSearch(jobRequirements);
  console.log();

  // Step 4: Candidate Scrape & Data Extraction
  const candidateResult = await step4_candidateScrapeAndExtract(candidateSearchHit);
  console.log();

  // Fallback candidate data if scrape/extraction failed
  const candidateData: CandidateData = candidateResult?.candidateData ?? {
    firstName: 'Unknown',
    lastName: 'Candidate',
    title: 'Software Developer',
    company: '',
    location: 'Remote',
    skills: jobRequirements.requiredSkills?.slice(0, 3) ?? ['Rust'],
    experience: [],
    email: '',
    linkedinUrl: candidateSearchHit.url,
  };

  // Step 5: Candidate Scoring (always runs, uses fallback data if needed)
  const scoring = await step5_candidateScoring(candidateData, jobRequirements);
  console.log();

  // Fallback scoring if scoring failed
  const scoringData: ScoringResult = scoring ?? {
    overall: 50,
    breakdown: { skillMatch: 50, experienceMatch: 50, relevance: 50 },
    reasoning: 'Unable to score — using default mid-range score',
  };

  // Step 6: Outreach Email (dry-run)
  await step6_outreachEmail(candidateData, jobRequirements, scoringData);
  console.log();

  // Summary
  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail').length;

  log(`\n${'='.repeat(50)}`);
  log(`Results: ${passed} passed, ${failed} failed out of ${results.length} steps`);
  for (const r of results) {
    log(`  ${r.status === 'pass' ? 'PASS' : 'FAIL'} ${r.step} (${r.durationMs}ms)`);
  }
  log(`${'='.repeat(50)}\n`);

  // Write results
  await writeFile(RESULTS_PATH, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));
  log(`Results written to ${RESULTS_PATH}`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
