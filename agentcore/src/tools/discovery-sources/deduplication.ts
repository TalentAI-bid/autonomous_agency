import type {
  RawCompanyResult,
  RawPersonResult,
  MergedCompanyResult,
  MergedPersonResult,
} from './types.js';

// ── Normalization helpers ───────────────────────────────────────────────────

const COMPANY_SUFFIXES = /\b(inc|ltd|llc|gmbh|corp|co|plc|sa|ag|pty|pvt|limited|incorporated|corporation)\b\.?/gi;

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(COMPANY_SUFFIXES, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '').trim();
}

// ── Company deduplication ───────────────────────────────────────────────────

const COMPANY_FIELDS: (keyof RawCompanyResult)[] = [
  'name', 'domain', 'industry', 'size', 'techStack', 'funding',
  'linkedinUrl', 'description', 'foundedYear', 'headquarters',
];

function companyGroupKey(c: RawCompanyResult): string {
  if (c.domain) return `domain:${normalizeDomain(c.domain)}`;
  return `name:${normalizeName(c.name)}`;
}

function countNonEmpty(obj: RawCompanyResult): number {
  let count = 0;
  for (const key of COMPANY_FIELDS) {
    const val = obj[key];
    if (val !== undefined && val !== null && val !== '') {
      if (Array.isArray(val) && val.length === 0) continue;
      count++;
    }
  }
  return count;
}

export function deduplicateCompanies(raw: RawCompanyResult[]): MergedCompanyResult[] {
  const groups = new Map<string, RawCompanyResult[]>();

  for (const item of raw) {
    const key = companyGroupKey(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  const results: MergedCompanyResult[] = [];

  for (const group of groups.values()) {
    // Sort by confidence descending so highest-confidence values win
    group.sort((a, b) => b.confidence - a.confidence);

    const merged: MergedCompanyResult = {
      name: '',
      source: group[0]!.source,
      confidence: 0,
      sources: [],
      dataCompleteness: 0,
    };

    const seenSources = new Set<string>();
    const techStackSet = new Set<string>();
    let maxConfidence = 0;

    for (const item of group) {
      // First non-empty value wins for scalars
      if (!merged.name && item.name) merged.name = item.name;
      if (!merged.domain && item.domain) merged.domain = item.domain;
      if (!merged.industry && item.industry) merged.industry = item.industry;
      if (!merged.size && item.size) merged.size = item.size;
      if (!merged.funding && item.funding) merged.funding = item.funding;
      if (!merged.linkedinUrl && item.linkedinUrl) merged.linkedinUrl = item.linkedinUrl;
      if (!merged.description && item.description) merged.description = item.description;
      if (!merged.foundedYear && item.foundedYear) merged.foundedYear = item.foundedYear;
      if (!merged.headquarters && item.headquarters) merged.headquarters = item.headquarters;

      // Union arrays
      if (item.techStack) {
        for (const t of item.techStack) techStackSet.add(t);
      }

      // Merge rawData
      if (item.rawData) {
        merged.rawData = Object.assign(merged.rawData ?? {}, item.rawData);
      }

      // Track sources
      if (!seenSources.has(item.source)) {
        seenSources.add(item.source);
        merged.sources.push(item.source);
      }

      if (item.confidence > maxConfidence) maxConfidence = item.confidence;
    }

    if (techStackSet.size > 0) merged.techStack = [...techStackSet];

    // Confidence boost for multi-source corroboration
    merged.confidence = Math.min(100, maxConfidence + (merged.sources.length - 1) * 5);

    // Data completeness
    merged.dataCompleteness = Math.round((countNonEmpty(merged) / COMPANY_FIELDS.length) * 100);

    results.push(merged);
  }

  // Sort by confidence desc, then data completeness desc
  results.sort((a, b) => b.confidence - a.confidence || b.dataCompleteness - a.dataCompleteness);

  return results;
}

// ── People deduplication ────────────────────────────────────────────────────

function personGroupKey(p: RawPersonResult): string {
  if (p.linkedinUrl) return `linkedin:${p.linkedinUrl.toLowerCase().replace(/\/$/, '')}`;
  if (p.email) return `email:${p.email.toLowerCase()}`;
  const name = (p.fullName ?? `${p.firstName ?? ''} ${p.lastName ?? ''}`).toLowerCase().trim();
  const company = (p.companyName ?? '').toLowerCase().trim();
  return `name:${name}:${company}`;
}

export function deduplicatePeople(raw: RawPersonResult[]): MergedPersonResult[] {
  const groups = new Map<string, RawPersonResult[]>();

  for (const item of raw) {
    const key = personGroupKey(item);
    const group = groups.get(key);
    if (group) {
      group.push(item);
    } else {
      groups.set(key, [item]);
    }
  }

  const results: MergedPersonResult[] = [];

  for (const group of groups.values()) {
    group.sort((a, b) => b.confidence - a.confidence);

    const merged: MergedPersonResult = {
      source: group[0]!.source,
      confidence: 0,
      sources: [],
    };

    const seenSources = new Set<string>();
    const skillsSet = new Set<string>();
    let maxConfidence = 0;

    for (const item of group) {
      if (!merged.firstName && item.firstName) merged.firstName = item.firstName;
      if (!merged.lastName && item.lastName) merged.lastName = item.lastName;
      if (!merged.fullName && item.fullName) merged.fullName = item.fullName;
      if (!merged.title && item.title) merged.title = item.title;
      if (!merged.companyName && item.companyName) merged.companyName = item.companyName;
      if (!merged.email && item.email) merged.email = item.email;
      if (!merged.linkedinUrl && item.linkedinUrl) merged.linkedinUrl = item.linkedinUrl;
      if (!merged.githubUrl && item.githubUrl) merged.githubUrl = item.githubUrl;
      if (!merged.twitterUrl && item.twitterUrl) merged.twitterUrl = item.twitterUrl;
      if (!merged.location && item.location) merged.location = item.location;

      if (item.skills) {
        for (const s of item.skills) skillsSet.add(s);
      }

      if (item.rawData) {
        merged.rawData = Object.assign(merged.rawData ?? {}, item.rawData);
      }

      if (!seenSources.has(item.source)) {
        seenSources.add(item.source);
        merged.sources.push(item.source);
      }

      if (item.confidence > maxConfidence) maxConfidence = item.confidence;
    }

    if (skillsSet.size > 0) merged.skills = [...skillsSet];
    merged.confidence = Math.min(100, maxConfidence + (merged.sources.length - 1) * 5);

    // Derive fullName if missing
    if (!merged.fullName && (merged.firstName || merged.lastName)) {
      merged.fullName = [merged.firstName, merged.lastName].filter(Boolean).join(' ');
    }

    results.push(merged);
  }

  results.sort((a, b) => b.confidence - a.confidence);

  return results;
}
