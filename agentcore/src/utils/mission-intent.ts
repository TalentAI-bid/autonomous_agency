/**
 * Deterministic mission-text classifier used as a safety net for the strategist.
 *
 * The strategist LLM occasionally picks `bdStrategy='hiring_signal'` for missions
 * whose text mentions only industries/verticals (no hiring verbs) — typically
 * when regional data quality is "limited" and the LLM treats LinkedIn Jobs as a
 * proxy for company discovery. That decouples the *strategy* from the *mission*,
 * causing master-agent dispatch to take the wrong branch (master-agent.ts:443
 * instead of master-agent.ts:574). This module exposes a pure function that
 * surfaces the same heuristic the chat-service intent classifier uses, so
 * strategist.agent.ts can override an LLM mis-classification.
 *
 * Intentionally regex-based and zero-dependency: easy to unit test, no I/O, no LLM.
 */

const HIRING_VERB_PATTERNS = [
  /\bhir(?:e|ed|es|ing)\b/i,
  /\brecruit(?:s|ed|ing|ment|er|ers)?\b/i,
  /\bjobs?\b/i,
  /\bjob\s+post(?:s|ing|ings)?\b/i,
  /\bopen\s+roles?\b/i,
  /\bopen\s+positions?\b/i,
  /\bvacanc(?:y|ies)\b/i,
  /\bteam\s+(?:growth|growing|expansion|expanding)\b/i,
  /\bgrowing\s+(?:their|its|the)\s+team\b/i,
  /\bexpanding\s+(?:their|its|the)\s+team\b/i,
  /\bscaling\s+(?:their|its|the)\s+team\b/i,
  /\bactively\s+hiring\b/i,
  /\bnew\s+hires?\b/i,
];

const INDUSTRY_MARKER_PATTERNS = [
  /\bfirms?\b/i,
  /\bcompanies\s+in\b/i,
  /\bbusinesses?\s+in\b/i,
  /\bindustry\b/i,
  /\bindustries\b/i,
  /\bvertical(?:s)?\b/i,
  /\bsegments?\b/i,
  /\bsectors?\b/i,
  /\bICPs?\b/,                            // case-sensitive: avoid matching "icp" in random words
  /\bideal\s+customer\s+profile\b/i,
  /\bcustomer\s+profiles?\b/i,
  // Common B2B verticals that frequently appear in industry-target missions
  // (plurals included, since real missions say "fintechs", "SaaS firms", etc.):
  /\bsaas\b/i,
  /\bfintechs?\b/i,
  /\bhealthtechs?\b/i,
  /\binsurtechs?\b/i,
  /\bedtechs?\b/i,
  /\bregtechs?\b/i,
  /\bproptechs?\b/i,
  /\be-?commerce\b/i,
  /\bmid-?market\b/i,
  /\bSMBs?\b/,
  /\benterprise\s+(?:companies|firms|customers)\b/i,
];

// Local/consumer-facing place types that signal Google Maps discovery
// (bdStrategy 'local_business' / 'local_hybrid') rather than LinkedIn.
const LOCAL_BUSINESS_PATTERNS = [
  /\brestaurants?\b/i,
  /\bcaf[eé]s?\b/i,
  /\bcoffee\s+shops?\b/i,
  /\bsalons?\b/i,
  /\bbarbers?(?:\s*shops?)?\b/i,
  /\bshops?\b/i,
  /\bstores?\b/i,
  /\bclinics?\b/i,
  /\bdentists?\b/i,
  /\bgyms?\b/i,
  /\bhotels?\b/i,
  /\bbakeri(?:es|y)\b/i,
  /\blocal\s+business(?:es)?\b/i,
  /\bgoogle\s+maps\b/i,
  /\bnear\s+me\b/i,
];

export interface MissionIntentResult {
  hasHiringVerbs: boolean;
  hasIndustryMentions: boolean;
  hasLocalBusinessMentions: boolean;
  recommended: 'hiring_signal' | 'industry_target' | 'hybrid' | 'local_business' | 'local_hybrid' | null;
}

export function detectMissionStrategyFromText(missionText: string | null | undefined): MissionIntentResult {
  const text = (missionText ?? '').trim();
  if (text.length === 0) {
    return { hasHiringVerbs: false, hasIndustryMentions: false, hasLocalBusinessMentions: false, recommended: null };
  }

  const hasHiringVerbs = HIRING_VERB_PATTERNS.some((re) => re.test(text));
  const hasIndustryMentions = INDUSTRY_MARKER_PATTERNS.some((re) => re.test(text));
  const hasLocalBusinessMentions = LOCAL_BUSINESS_PATTERNS.some((re) => re.test(text));

  let recommended: MissionIntentResult['recommended'] = null;
  if (hasLocalBusinessMentions && hasIndustryMentions) recommended = 'local_hybrid';
  else if (hasLocalBusinessMentions) recommended = 'local_business';
  else if (hasHiringVerbs && hasIndustryMentions) recommended = 'hybrid';
  else if (hasHiringVerbs) recommended = 'hiring_signal';
  else if (hasIndustryMentions) recommended = 'industry_target';

  return { hasHiringVerbs, hasIndustryMentions, hasLocalBusinessMentions, recommended };
}
