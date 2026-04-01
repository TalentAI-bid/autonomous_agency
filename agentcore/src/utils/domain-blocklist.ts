// ── FAANG / mega-corp blocklist ──────────────────────────────────────────────

export const MEGA_CORP_DOMAINS = new Set([
  'google.com', 'meta.com', 'facebook.com', 'apple.com', 'amazon.com',
  'aws.amazon.com', 'netflix.com', 'microsoft.com',
  'oracle.com', 'salesforce.com', 'ibm.com', 'intel.com',
  'cisco.com', 'adobe.com', 'uber.com', 'airbnb.com', 'stripe.com', 'spotify.com',
]);

export function isMegaCorp(domain: string): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase().replace('www.', '');
  return MEGA_CORP_DOMAINS.has(d);
}

// ── Low-value domains — never scrape, skip entirely ─────────────────────────

export const SKIP_DOMAINS = new Set([
  // Social media & forums
  'youtube.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com',
  'tiktok.com', 'pinterest.com', 'reddit.com', 'quora.com',
  'discord.com', 'app.slack.com', 'zoom.us', 'telegram.org',
  // Reference / encyclopedias
  'wikipedia.org', 'en.wikipedia.org', 'britannica.com', 'worldhistory.org',
  'merriam-webster.com', 'dictionary.com',
  // E-commerce / consumer
  'amazon.com', 'ebay.com', 'walmart.com', 'target.com', 'bestbuy.com',
  'aliexpress.com', 'wish.com', 'goodreads.com', 'carfax.com',
  // Q&A / developer forums
  'stackoverflow.com', 'stackexchange.com', 'serverfault.com',
  'superuser.com', 'askubuntu.com', 'stackinfra.com',
  // Developer tools / code hosting
  'github.com', 'gitlab.com', 'bitbucket.org',
  'npmjs.com', 'pypi.org', 'rubygems.org',
  // Tutorial / learning sites
  'cplusplus.com', 'geeksforgeeks.org', 'w3schools.com', 'tutorialspoint.com',
  'freecodecamp.org', 'codecademy.com', 'openstax.org',
  // Developer blogs / content
  'medium.com', 'dev.to', 'news.ycombinator.com', 'hackernews.com',
  // Academic / research
  'arxiv.org', 'researchgate.net', 'scholar.google.com',
  'collegeconfidential.com', 'talk.collegeconfidential.com',
  // Google services
  'docs.google.com', 'drive.google.com', 'sheets.google.com',
  // News / media
  'investopedia.com', 'hbr.org', 'store.hbr.org',
  'nytimes.com', 'wsj.com', 'bbc.com', 'cnn.com',
  'forbes.com', 'businessinsider.com', 'techcrunch.com',
  // Events / misc
  'eventbrite.com', 'meetup.com', 'gisgeography.com',
  'ficoforums.myfico.com',
  // Adult
  'pornhub.com', 'xvideos.com', 'onlyfans.com',
  // Job boards (not target companies)
  'indeed.com', 'glassdoor.com', 'monster.com', 'ziprecruiter.com',
  // Community sub-domains
  'community.shopify.com',
  // Misc non-companies from logs
  'scratch.mit.edu', 'names.org', 'planetkitesurfholidays.com',
]);

export function shouldSkipDomain(domain: string): boolean {
  const d = domain.toLowerCase().replace('www.', '');
  return SKIP_DOMAINS.has(d) || [...SKIP_DOMAINS].some(p => d.endsWith(`.${p}`));
}

/** Check if a URL belongs to a junk/non-company domain */
export function isJunkUrl(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.replace('www.', '');
    return shouldSkipDomain(hostname) || isMegaCorp(hostname);
  } catch {
    return false;
  }
}
