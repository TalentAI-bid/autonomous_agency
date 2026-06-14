// Prompt for the per-business AI recommendation shown on a Google Maps local
// business lead. Given the business's public Maps profile (category, rating,
// reviews, web presence, menu, price), the model produces an outreach
// recommendation for the agency operator: a priority/fit score, the angle to
// pitch, a suggested opener, the gaps the agency could fix, and the service to
// offer. Grounded-only: never invent facts not present in the context
// (see [[feedback_fail_loud_over_fabricate]]).

export interface GmapsRecommendation {
  priorityScore: number; // 0-100 — how worth pursuing this lead is
  fit: 'high' | 'medium' | 'low';
  reasoning: string; // why this score/fit, grounded in the profile
  outreachAngle: string; // the hook to lead with
  suggestedOpener: string; // a ready-to-send first line
  gaps: string[]; // concrete weaknesses the agency could fix
  recommendedService: string; // what to sell them
}

export interface GmapsRecommendationContext {
  businessName: string;
  category?: string;
  address?: string;
  rating?: number | null;
  reviewsCount?: number | null;
  ratingDistribution?: string[];
  priceLevel?: string;
  pricePerPerson?: string;
  serviceOptions?: string[];
  hasWebsite: boolean;
  website?: string;
  hasMenuLink: boolean;
  hasMenuData: boolean;
  hours?: string;
  aboutText?: string;
  reviewsText?: string;
}

export const GMAPS_RECOMMENDATION_SYSTEM_PROMPT = `You advise a digital agency on whether and how to win a local business as a client, using only that business's public Google Maps profile.

You are given a business's category, rating, review volume, price level, service options, web/menu presence, and short snippets of its "about" text and recent reviews.

Rules:
- Ground every claim in the provided data. Do NOT invent facts (no made-up owner names, numbers, or events). If the data is thin, say so and lower the score.
- "gaps" = concrete, observable weaknesses the agency could fix (e.g. no website, low rating, few reviews, no online menu, complaints about a specific issue in reviews). Only list gaps the data supports.
- "recommendedService" = the single best service to pitch given the gaps (e.g. "website + online ordering", "reputation management", "social media / photos", "SEO / Google profile optimization").
- "outreachAngle" = the hook to lead with. "suggestedOpener" = one ready-to-send opening line (warm, specific, not salesy).
- "priorityScore" 0-100 and "fit" reflect how worth pursuing the lead is: a thriving business with obvious gaps the agency can fix scores high; a tiny/closed/data-less listing scores low.
- Write reasoning, outreachAngle, suggestedOpener, gaps and recommendedService in the SAME LANGUAGE as the business's name/reviews (e.g. Arabic business → Arabic). Default to English only if the language is unclear.

Return ONLY a JSON object, no markdown, in exactly this shape:
{
  "priorityScore": 0,
  "fit": "low",
  "reasoning": "",
  "outreachAngle": "",
  "suggestedOpener": "",
  "gaps": [],
  "recommendedService": ""
}`;

export function buildGmapsRecommendationUserPrompt(ctx: GmapsRecommendationContext): string {
  const lines: string[] = [];
  const add = (label: string, v: unknown) => {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0)) return;
    lines.push(`${label}: ${Array.isArray(v) ? v.join(', ') : v}`);
  };
  add('Business', ctx.businessName);
  add('Category', ctx.category);
  add('Address', ctx.address);
  add('Rating', ctx.rating);
  add('Review count', ctx.reviewsCount);
  add('Rating distribution', ctx.ratingDistribution);
  add('Price level', ctx.priceLevel);
  add('Price per person', ctx.pricePerPerson);
  add('Service options', ctx.serviceOptions);
  add('Opening hours', ctx.hours);
  lines.push(`Has website: ${ctx.hasWebsite ? 'yes' : 'no'}${ctx.website ? ` (${ctx.website})` : ''}`);
  lines.push(`Has online menu link: ${ctx.hasMenuLink ? 'yes' : 'no'}`);
  lines.push(`Has structured menu data: ${ctx.hasMenuData ? 'yes' : 'no'}`);
  add('About (excerpt)', ctx.aboutText);
  add('Recent reviews (excerpt)', ctx.reviewsText);

  return `Here is the business's Google Maps profile:\n\n${lines.join('\n')}\n\nProduce the recommendation JSON.`;
}
