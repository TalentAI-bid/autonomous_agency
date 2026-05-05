import logger from '../utils/logger.js';

// LinkedIn company search URL builder. Keywords match name/description/specialties;
// geography filters by HQ via companyHqGeo URN; size filters via companySize codes.
// Geography NEVER goes in keywords — that returns associations named after the
// region instead of companies based there.

interface BuildCompanySearchURLParams {
  searchKeywords: string[];
  geographyFilter?: { regions: string[] };
  sizeFilter?: { min: number; max: number };
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
