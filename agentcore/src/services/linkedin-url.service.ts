import logger from '../utils/logger.js';

// LinkedIn company search URL builder. Keywords match name/description/specialties;
// geography filters by HQ via companyHqGeo URN; size filters via companySize codes.
// Geography NEVER goes in keywords — that returns associations named after the
// region instead of companies based there.

interface BuildCompanySearchURLParams {
  searchKeywords: string[];
  geographyFilter?: { regions: string[] };
  sizeFilter?: { min: number; max: number };
  // Round 11 — LinkedIn industry classification facet. Each entry is the
  // industry's display name (e.g. "Financial Services", "Software Development").
  // Resolves to LinkedIn's numeric URN via INDUSTRY_URN_MAP. When set, LinkedIn
  // pre-filters by category, killing furniture / conference / agency leaks
  // that pure keyword search produces.
  industryFilter?: { industries: string[] };
}

export function buildLinkedInCompanySearchURL(params: BuildCompanySearchURLParams): string {
  const url = new URL('https://www.linkedin.com/search/results/companies/');

  if (params.searchKeywords?.length) {
    url.searchParams.set('keywords', params.searchKeywords.join(' '));
  }

  if (params.geographyFilter?.regions?.length) {
    for (const region of params.geographyFilter.regions) {
      if (UNVERIFIED_REGIONS.has(region.trim().toLowerCase())) {
        logger.warn(
          { region },
          'linkedin-url: region URN not yet verified — search will fall back to keyword-only filter for this region',
        );
      }
    }
    const urns = params.geographyFilter.regions
      .map((region) => resolveGeoUrn(region))
      .filter((u): u is string => Boolean(u));
    if (urns.length) {
      url.searchParams.set('companyHqGeo', JSON.stringify(urns));
    } else {
      logger.warn(
        { regions: params.geographyFilter.regions },
        'linkedin-url: no geo URNs resolved — search will be geographically unbounded',
      );
    }
  }

  if (params.sizeFilter) {
    const sizes = mapSizeToLinkedInRanges(params.sizeFilter.min, params.sizeFilter.max);
    if (sizes.length) {
      url.searchParams.set('companySize', JSON.stringify(sizes));
    }
  }

  // Industry-classification facet. JSON-stringified URN array, identical
  // shape to companyHqGeo. Resolved via INDUSTRY_URN_MAP — unresolved names
  // fall through with a warn and the URL just omits the facet.
  if (params.industryFilter?.industries?.length) {
    const urns = params.industryFilter.industries
      .map((i) => resolveIndustryUrn(i))
      .filter((u): u is string => Boolean(u));
    if (urns.length) {
      url.searchParams.set('industryCompanyVertical', JSON.stringify(urns));
    } else {
      logger.warn(
        { industries: params.industryFilter.industries },
        'linkedin-url: no industry URNs resolved — search will run without industry facet',
      );
    }
  }

  url.searchParams.set('origin', 'FACETED_SEARCH');
  return url.toString();
}

// Static map of major regions to LinkedIn geo URNs. Lowercase keys.
// Verified URNs spot-checked against public LinkedIn search URLs (BE/DE/FR/GB/NL).
// The "European Union / Europe" URN (91000000) is best-guess; verify before
// relying on it. Unresolved regions fall through silently — the URL is built
// without companyHqGeo (logged at warn).
const GEO_URN_MAP: Record<string, string> = {
  belgium: '100565514',
  netherlands: '102890719',
  france: '105015875',
  germany: '101282230',
  'united kingdom': '101165590',
  uk: '101165590',
  ireland: '104738515',
  spain: '105646813',
  italy: '103350119',
  poland: '105072130',
  lithuania: '101464403',
  sweden: '105117694',
  denmark: '104514075',
  norway: '103819153',
  finland: '100456013',
  portugal: '100364837',
  austria: '103883259',
  switzerland: '106693272',
  luxembourg: '104042105',
  'european union': '91000000',
  eu: '91000000',
  europe: '91000000',
  'united states': '103644278',
  usa: '103644278',
  us: '103644278',
  canada: '101174742',
  // MENA — verified URNs only. Jordan + Bahrain held in UNVERIFIED_REGIONS
  // until manually confirmed against LinkedIn search results.
  'united arab emirates': '104305776',
  uae: '104305776',
  'saudi arabia': '100459316',
  egypt: '106155005',
  qatar: '104170880',
  kuwait: '103317225',
  morocco: '102787409',
};

// Regions the strategist may emit that don't yet have a verified geo URN.
// resolveGeoUrn returns null for these; the URL builder logs a loud warn so
// production telemetry surfaces the gap until they're confirmed and added
// to GEO_URN_MAP above.
const UNVERIFIED_REGIONS = new Set<string>(['jordan', 'bahrain']);

export function resolveGeoUrn(region: string): string | null {
  return GEO_URN_MAP[region.trim().toLowerCase()] ?? null;
}

// LinkedIn industry-classification URNs (numeric strings). Map by the
// industry's display name, lowercased. Modern + legacy names both map
// (LinkedIn renamed several industries recently — "Computer Software" →
// "Software Development", "Internet" → "Technology, Information and Internet",
// etc.). Conservative coverage; expand iteratively as we hit unresolved
// warns in production.
const INDUSTRY_URN_MAP: Record<string, string> = {
  // Finance
  'financial services': '43',
  'banking': '41',
  'insurance': '42',
  'capital markets': '129',
  'investment management': '47',
  'investment banking': '45',
  'venture capital and private equity principals': '106',
  // Tech (modern + legacy aliases pointing to the same URN)
  'software development': '4',
  'computer software': '4',
  'it services and it consulting': '96',
  'information technology and services': '96',
  'technology, information and internet': '6',
  'internet': '6',
  'computer and network security': '118',
  'computer & network security': '118',
  'computer hardware': '3',
  'data infrastructure and analytics': '2458',
  // Healthcare
  'hospitals and health care': '14',
  'hospital & health care': '14',
  'health, wellness and fitness': '124',
  'wellness and fitness services': '124',
  'pharmaceuticals': '15',
  'biotechnology research': '12',
  'biotechnology': '12',
  'medical practices': '13',
  'medical equipment manufacturing': '17',
  // Adjacent (sometimes useful for B2B SaaS narrowed by function)
  'staffing and recruiting': '104',
  'human resources services': '137',
  'human resources': '137',
  'e-learning providers': '132',
  'e-learning': '132',
  'marketing and advertising': '80',
  'advertising services': '80',
};

export function resolveIndustryUrn(name: string): string | null {
  return INDUSTRY_URN_MAP[name.trim().toLowerCase()] ?? null;
}

// Region libraries — the strategist prompt teaches the LLM to emit the
// matching string array directly into geographyFilter.regions. We don't
// auto-resolve a library name server-side; explicit string arrays keep the
// JSON output traceable. Jordan + Bahrain (MENA) and Iceland (Nordics) /
// Austria + Switzerland (DACH) are deferred until URNs are verified.
export const REGION_LIBRARIES = {
  eu: [
    'United Kingdom', 'Germany', 'France', 'Netherlands', 'Sweden',
    'Ireland', 'Spain', 'Italy', 'Poland', 'Belgium',
  ],
  mena: [
    'United Arab Emirates', 'Saudi Arabia', 'Egypt', 'Qatar', 'Kuwait', 'Morocco',
  ],
  north_america: ['United States', 'Canada'],
  nordics: ['Sweden', 'Denmark', 'Norway', 'Finland'],
  dach: ['Germany'],
} as const;

export const GLOBAL_REGIONS: readonly string[] = [
  ...REGION_LIBRARIES.eu,
  ...REGION_LIBRARIES.mena,
  ...REGION_LIBRARIES.north_america,
];

// LinkedIn company size facet codes. The bucket overlaps the requested range
// when its [bucketMin, bucketMax] interval intersects [reqMin, reqMax].
export function mapSizeToLinkedInRanges(min: number, max: number): string[] {
  const buckets: Array<{ code: string; min: number; max: number }> = [
    { code: 'B', min: 2, max: 10 },
    { code: 'C', min: 11, max: 50 },
    { code: 'D', min: 51, max: 200 },
    { code: 'E', min: 201, max: 500 },
    { code: 'F', min: 501, max: 1000 },
    { code: 'G', min: 1001, max: 5000 },
    { code: 'H', min: 5001, max: 10000 },
    { code: 'I', min: 10001, max: Number.POSITIVE_INFINITY },
  ];
  return buckets.filter((b) => b.max >= min && b.min <= max).map((b) => b.code);
}
