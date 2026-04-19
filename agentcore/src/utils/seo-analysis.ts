export function calculateSeoScore(html: string): number {
  let score = 100;
  if (!/<title[^>]*>[^<]{5,}<\/title>/i.test(html)) score -= 20;
  if (!/<meta[^>]*name=["']description["'][^>]*content=["'][^"']+["']/i.test(html)) score -= 15;
  if (!/<meta[^>]*property=["']og:/i.test(html)) score -= 10;
  if (!/<h1/i.test(html)) score -= 10;
  const wordCount = html.replace(/<[^>]+>/g, ' ').split(/\s+/).length;
  if (wordCount < 200) score -= 20;
  if (!/application\/ld\+json/i.test(html)) score -= 10;
  if (!/alt=["'][^"']+["']/i.test(html)) score -= 10;
  return Math.max(score, 0);
}

export function detectSeoIssues(html: string): string[] {
  const issues: string[] = [];
  if (!/<title/i.test(html)) issues.push('Missing title tag');
  if (!/meta.*description/i.test(html)) issues.push('Missing meta description');
  if (!/og:/i.test(html)) issues.push('Missing Open Graph tags');
  if (!/application\/ld\+json/i.test(html)) issues.push('Missing structured data');
  return issues;
}
