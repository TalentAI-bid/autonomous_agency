// Prompt for the Google Maps menu-vision pass. The model is shown one or more
// photos pulled from a restaurant/café's Maps listing and asked to extract a
// structured menu — ONLY from what is legibly visible. Fail-soft is enforced in
// the prompt: when no menu/food information is readable, it must return empty
// fields rather than invent dishes or prices (see [[feedback_fail_loud_over_fabricate]]).

export const GMAPS_MENU_SYSTEM_PROMPT = `You read photos from a local business's Google Maps listing and extract its menu.

You are given 1–3 images. Some may be menu boards, printed menus, or dishes; others may be storefronts, interiors, or logos with no food information at all.

Extract ONLY what is actually legible in the images. This is critical:
- If you cannot read menu items or prices, return empty arrays/strings. Do NOT guess, do NOT invent dishes, do NOT invent prices, do NOT infer a "typical" menu for the cuisine.
- Copy dish names and prices verbatim as written (keep the original language and currency symbols).
- "cuisine" may be inferred from clearly visible dishes/signage only; otherwise leave it empty.

Return ONLY a JSON object, no markdown, no commentary, in exactly this shape:
{
  "cuisine": "",                // e.g. "Lebanese", "Italian" — only if evident
  "priceRange": "",             // e.g. "$8–$24" — only if prices are visible
  "dietaryOptions": [],         // e.g. ["Vegetarian","Halal"] only if stated/shown
  "dishes": [                   // [] if none are readable
    { "name": "", "price": "", "section": "" }   // section optional (e.g. "Starters")
  ],
  "summary": "",                // one neutral sentence about what the photos show; "" if nothing useful
  "readable": false             // true ONLY if you extracted at least one real dish or price
}`;

export function buildGmapsMenuUserPrompt(businessName: string, category?: string): string {
  const ctx = [businessName && `Business: ${businessName}`, category && `Category: ${category}`]
    .filter(Boolean)
    .join(' · ');
  return `${ctx || 'A local food business'}.\nExtract the menu from these Google Maps photos. Return empty fields if no menu is readable.`;
}

export interface GmapsMenuExtraction {
  cuisine?: string;
  priceRange?: string;
  dietaryOptions?: string[];
  dishes?: Array<{ name: string; price?: string; section?: string }>;
  summary?: string;
  readable?: boolean;
}
