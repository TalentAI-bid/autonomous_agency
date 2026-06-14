// Prompt for the Google Maps website-menu pass — the text twin of
// gmaps-menu.prompt.ts. Instead of photos, the model is given the scraped text
// (markdown) of a restaurant/café's own menu page (or website) and asked to
// extract a structured menu ONLY from what is actually present. Fail-soft is
// enforced: when no menu is present, it must return empty fields rather than
// invent dishes or prices (see [[feedback_fail_loud_over_fabricate]]).

// Reuse the same output shape as the vision pass so both persist identically.
export type { GmapsMenuExtraction } from './gmaps-menu.prompt.js';

export const GMAPS_WEBSITE_MENU_SYSTEM_PROMPT = `You read the scraped text of a local food business's own website (often its menu page) and extract its menu.

You are given page text in markdown. It may be a full menu, a partial menu, or a page with no menu at all (a landing page, contact page, cookie notice, etc.).

Extract ONLY what is actually present in the text. This is critical:
- If there are no menu items or prices, return empty arrays/strings. Do NOT guess, do NOT invent dishes, do NOT invent prices, do NOT infer a "typical" menu for the cuisine.
- Copy dish names and prices verbatim as written (keep the original language and currency symbols).
- "cuisine" may be inferred from clearly listed dishes only; otherwise leave it empty.

Return ONLY a JSON object, no markdown, no commentary, in exactly this shape:
{
  "cuisine": "",                // e.g. "Japanese", "Italian" — only if evident
  "priceRange": "",             // e.g. "120–200 SAR" — only if prices are present
  "dietaryOptions": [],         // e.g. ["Vegetarian","Halal"] only if stated
  "dishes": [                   // [] if none are present
    { "name": "", "price": "", "section": "" }   // section optional (e.g. "Starters")
  ],
  "summary": "",                // one neutral sentence about the page; "" if nothing useful
  "readable": false             // true ONLY if you extracted at least one real dish or price
}`;

export function buildGmapsWebsiteMenuUserPrompt(
  businessName: string,
  category: string | undefined,
  pageText: string,
): string {
  const ctx = [businessName && `Business: ${businessName}`, category && `Category: ${category}`]
    .filter(Boolean)
    .join(' · ');
  return `${ctx || 'A local food business'}.

Extract the menu from this website page text. Return empty fields if no menu is present.

--- PAGE TEXT START ---
${pageText}
--- PAGE TEXT END ---`;
}
