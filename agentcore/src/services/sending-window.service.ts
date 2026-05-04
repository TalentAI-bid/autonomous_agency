import { eq } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { contacts, companies } from '../db/schema/index.js';
import logger from '../utils/logger.js';

// ─── Sending window ─────────────────────────────────────────────────────────
// Default: Tue/Wed/Thu, 09:00–16:00 in the recipient's local time. Mon mornings
// are buried under weekend backlog; Fri afternoons are dead. T-W-Th 9-4 is the
// industry-standard cold-B2B window.
//
// Override via masterAgent.config.sendingWindow:
//   { days: [2,3,4], startHour: 9, endHour: 16 }   // 0=Sun ... 6=Sat
// Hours are inclusive of start, exclusive of end (so endHour=16 means last
// send slot is 15:59 local).

export interface SendingWindowConfig {
  days: number[];
  startHour: number;
  endHour: number;
}

export const DEFAULT_SENDING_WINDOW: SendingWindowConfig = {
  days: [2, 3, 4], // Tue, Wed, Thu
  startHour: 9,
  endHour: 16,
};

// Static city/country → IANA timezone map. Built-in Intl APIs handle the
// actual offset math; this is just a coarse classifier for company HQs.
const TZ_MAP: Record<string, string> = {
  // United Kingdom / Ireland
  'london': 'Europe/London', 'manchester': 'Europe/London', 'edinburgh': 'Europe/London',
  'glasgow': 'Europe/London', 'leeds': 'Europe/London', 'birmingham': 'Europe/London',
  'bristol': 'Europe/London', 'united kingdom': 'Europe/London', 'uk': 'Europe/London',
  'gb': 'Europe/London', 'england': 'Europe/London', 'scotland': 'Europe/London',
  'dublin': 'Europe/Dublin', 'ireland': 'Europe/Dublin', 'cork': 'Europe/Dublin',
  // France / Belgium / Netherlands / Lux
  'paris': 'Europe/Paris', 'lyon': 'Europe/Paris', 'marseille': 'Europe/Paris',
  'toulouse': 'Europe/Paris', 'france': 'Europe/Paris',
  'brussels': 'Europe/Brussels', 'antwerp': 'Europe/Brussels', 'belgium': 'Europe/Brussels',
  'amsterdam': 'Europe/Amsterdam', 'rotterdam': 'Europe/Amsterdam',
  'the hague': 'Europe/Amsterdam', 'netherlands': 'Europe/Amsterdam',
  'luxembourg': 'Europe/Luxembourg',
  // Germany / Austria / Switzerland
  'berlin': 'Europe/Berlin', 'munich': 'Europe/Berlin', 'hamburg': 'Europe/Berlin',
  'frankfurt': 'Europe/Berlin', 'cologne': 'Europe/Berlin', 'stuttgart': 'Europe/Berlin',
  'germany': 'Europe/Berlin', 'de': 'Europe/Berlin',
  'vienna': 'Europe/Vienna', 'austria': 'Europe/Vienna',
  'zurich': 'Europe/Zurich', 'geneva': 'Europe/Zurich', 'bern': 'Europe/Zurich',
  'switzerland': 'Europe/Zurich',
  // Iberia / Italy
  'madrid': 'Europe/Madrid', 'barcelona': 'Europe/Madrid', 'valencia': 'Europe/Madrid',
  'spain': 'Europe/Madrid',
  'lisbon': 'Europe/Lisbon', 'porto': 'Europe/Lisbon', 'portugal': 'Europe/Lisbon',
  'rome': 'Europe/Rome', 'milan': 'Europe/Rome', 'turin': 'Europe/Rome',
  'italy': 'Europe/Rome',
  // Nordics
  'stockholm': 'Europe/Stockholm', 'sweden': 'Europe/Stockholm',
  'copenhagen': 'Europe/Copenhagen', 'denmark': 'Europe/Copenhagen',
  'oslo': 'Europe/Oslo', 'norway': 'Europe/Oslo',
  'helsinki': 'Europe/Helsinki', 'finland': 'Europe/Helsinki',
  // Baltics / Eastern Europe
  'tallinn': 'Europe/Tallinn', 'estonia': 'Europe/Tallinn',
  'vilnius': 'Europe/Vilnius', 'lithuania': 'Europe/Vilnius',
  'riga': 'Europe/Riga', 'latvia': 'Europe/Riga',
  'warsaw': 'Europe/Warsaw', 'poland': 'Europe/Warsaw',
  'prague': 'Europe/Prague', 'czech': 'Europe/Prague', 'czech republic': 'Europe/Prague',
  // US (cover the four major zones)
  'new york': 'America/New_York', 'nyc': 'America/New_York', 'boston': 'America/New_York',
  'washington': 'America/New_York', 'atlanta': 'America/New_York', 'miami': 'America/New_York',
  'chicago': 'America/Chicago', 'austin': 'America/Chicago', 'dallas': 'America/Chicago',
  'houston': 'America/Chicago', 'denver': 'America/Denver', 'phoenix': 'America/Phoenix',
  'san francisco': 'America/Los_Angeles', 'sf': 'America/Los_Angeles',
  'los angeles': 'America/Los_Angeles', 'la': 'America/Los_Angeles',
  'seattle': 'America/Los_Angeles', 'portland': 'America/Los_Angeles',
  'us': 'America/New_York', 'usa': 'America/New_York', 'united states': 'America/New_York',
  // Canada
  'toronto': 'America/Toronto', 'montreal': 'America/Toronto', 'ottawa': 'America/Toronto',
  'vancouver': 'America/Vancouver', 'canada': 'America/Toronto',
  // APAC (lighter coverage — most missions are EU/UK/US-focused)
  'singapore': 'Asia/Singapore',
  'tokyo': 'Asia/Tokyo', 'japan': 'Asia/Tokyo',
  'sydney': 'Australia/Sydney', 'melbourne': 'Australia/Sydney', 'australia': 'Australia/Sydney',
};

/**
 * Best-effort city/country → IANA timezone. Returns null when no part of the
 * input matches the static map; the caller falls back to UTC.
 */
function lookupTimezone(input: string | null | undefined): string | null {
  if (!input) return null;
  const text = input.toLowerCase();
  for (const key of Object.keys(TZ_MAP)) {
    // Word-boundary-ish match: check the key surrounded by non-word chars
    // or string boundaries to avoid 'us' matching 'austria'.
    const pattern = new RegExp(`(^|[^a-z])${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`);
    if (pattern.test(text)) return TZ_MAP[key]!;
  }
  return null;
}

/**
 * Resolve a contact's timezone in this order:
 *   1. contact.timezone if already set
 *   2. derive from company.headquarters via TZ_MAP
 *   3. UTC fallback
 *
 * Caches a derived value back onto contact.timezone so subsequent calls
 * skip the lookup. Always returns a valid IANA string.
 */
export async function resolveContactTimezone(
  tenantId: string,
  contactId: string,
): Promise<string> {
  const result = await withTenant(tenantId, async (tx) => {
    const [contact] = await tx
      .select({
        id: contacts.id,
        timezone: contacts.timezone,
        location: contacts.location,
        companyId: contacts.companyId,
      })
      .from(contacts)
      .where(eq(contacts.id, contactId))
      .limit(1);
    if (!contact) return 'UTC';
    if (contact.timezone) return contact.timezone;

    // Try contact.location first
    let tz = lookupTimezone(contact.location);

    // Fall back to company headquarters
    if (!tz && contact.companyId) {
      const [company] = await tx
        .select({ rawData: companies.rawData })
        .from(companies)
        .where(eq(companies.id, contact.companyId))
        .limit(1);
      const raw = (company?.rawData ?? {}) as Record<string, unknown>;
      const hq = raw.headquarters;
      const hqStr = typeof hq === 'string'
        ? hq
        : (hq && typeof hq === 'object'
          ? Object.values(hq as Record<string, unknown>).filter(Boolean).join(' ')
          : '');
      tz = lookupTimezone(hqStr);
    }

    const finalTz = tz ?? 'UTC';
    // Cache the derived value so we don't re-lookup on every send.
    if (finalTz !== 'UTC' || !contact.timezone) {
      await tx.update(contacts)
        .set({ timezone: finalTz, updatedAt: new Date() })
        .where(eq(contacts.id, contactId));
    }
    return finalTz;
  });

  return result;
}

/**
 * Read local-time hour/weekday for the given UTC instant in the given IANA tz.
 * Uses Intl.DateTimeFormat — no third-party dep.
 */
function localHourAndDay(now: Date, tz: string): { hour: number; weekday: number } {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
      weekday: 'short',
    });
    const parts = fmt.formatToParts(now);
    const hourPart = parts.find((p) => p.type === 'hour')?.value ?? '0';
    const weekdayPart = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
    const hour = Number(hourPart) % 24; // 'en-US' may return 24 instead of 0 at midnight
    const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const weekday = weekdayMap[weekdayPart] ?? 1;
    return { hour, weekday };
  } catch (err) {
    logger.warn({ err, tz }, 'localHourAndDay: Intl failure, defaulting to UTC');
    return { hour: now.getUTCHours(), weekday: now.getUTCDay() };
  }
}

export function isWithinSendingWindow(
  now: Date,
  tz: string,
  config: SendingWindowConfig = DEFAULT_SENDING_WINDOW,
): boolean {
  const { hour, weekday } = localHourAndDay(now, tz);
  if (!config.days.includes(weekday)) return false;
  return hour >= config.startHour && hour < config.endHour;
}

/**
 * Next UTC instant when the recipient enters the sending window. If `now` is
 * already inside the window, returns `now`. Otherwise advances day-by-day in
 * the local tz to the next allowed day, snapping the time to startHour:00
 * local. Always returns a Date in the future (or equal to now).
 */
export function computeNextSendingSlot(
  now: Date,
  tz: string,
  config: SendingWindowConfig = DEFAULT_SENDING_WINDOW,
): Date {
  if (isWithinSendingWindow(now, tz, config)) return now;

  // Walk hour-by-hour up to 8 days ahead; the window opens within a week.
  // We use 1-hour granularity so the snap respects DST transitions.
  const ONE_HOUR = 60 * 60 * 1000;
  for (let h = 1; h <= 24 * 8; h++) {
    const candidate = new Date(now.getTime() + h * ONE_HOUR);
    const { hour, weekday } = localHourAndDay(candidate, tz);
    if (config.days.includes(weekday) && hour === config.startHour) {
      return candidate;
    }
  }

  // Fallback — should not happen with sane config.
  logger.warn({ tz, config }, 'computeNextSendingSlot: no slot found in 8 days');
  return new Date(now.getTime() + 24 * ONE_HOUR);
}

/**
 * Read the per-agent override of the sending window from
 * masterAgent.config.sendingWindow, falling back to the default.
 */
export function resolveSendingWindow(
  masterAgentConfig: Record<string, unknown> | null | undefined,
): SendingWindowConfig {
  const cfg = masterAgentConfig?.sendingWindow as Partial<SendingWindowConfig> | undefined;
  if (
    cfg &&
    Array.isArray(cfg.days) && cfg.days.every((d) => typeof d === 'number') &&
    typeof cfg.startHour === 'number' &&
    typeof cfg.endHour === 'number'
  ) {
    return { days: cfg.days, startHour: cfg.startHour, endHour: cfg.endHour };
  }
  return DEFAULT_SENDING_WINDOW;
}
