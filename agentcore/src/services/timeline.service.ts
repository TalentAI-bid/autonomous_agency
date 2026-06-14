import { eq, and, desc, lt, or } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { crmActivities } from '../db/schema/index.js';
import type {
  CrmActivity,
  NewCrmActivity,
  CrmEventCategory,
  CrmActorType,
} from '../db/schema/index.js';
import { pubRedis } from '../queues/setup.js';
import logger from '../utils/logger.js';

/**
 * Single source of truth for contact timeline events. Backed by the existing
 * crm_activities table (extended with event_category + actor_type by
 * migration 0034) so we don't fork the audit log into two parallel stores.
 *
 * logEvent() is the modern API: explicit eventCategory + actorType.
 * The legacy logActivity() in crm-activity.service.ts wraps this and
 * infers reasonable defaults so older call sites keep working unchanged.
 *
 * Call this from any code that mutates contact state. Failures bubble up
 * — wrap call sites in try/catch where logging shouldn't fail the parent
 * mutation (most call sites). This service does NOT swallow tx-mismatch
 * or constraint errors, which always indicate a real bug.
 */

export interface LogEventInput {
  tenantId: string;
  contactId: string;
  type: NewCrmActivity['type'];
  eventCategory: CrmEventCategory;
  actorType: CrmActorType;
  /** When actorType === 'user', the user_id that performed the action. */
  actorUserId?: string | null;
  title?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  occurredAt?: Date;
  dealId?: string;
  masterAgentId?: string;
}

export async function logEvent(input: LogEventInput): Promise<{ id: string }> {
  const title = input.title ?? defaultTitleFor(input.type);

  const [row] = await withTenant(input.tenantId, async (tx) => {
    return tx
      .insert(crmActivities)
      .values({
        tenantId: input.tenantId,
        contactId: input.contactId,
        dealId: input.dealId,
        userId: input.actorType === 'user' ? input.actorUserId ?? undefined : undefined,
        masterAgentId: input.masterAgentId,
        type: input.type,
        eventCategory: input.eventCategory,
        actorType: input.actorType,
        title,
        description: input.description,
        metadata: input.metadata,
        occurredAt: input.occurredAt ?? new Date(),
      })
      .returning({ id: crmActivities.id });
  });

  // Emit a real-time event so the dashboard timeline updates without polling.
  try {
    await pubRedis.publish(
      `tenant:${input.tenantId}`,
      JSON.stringify({
        event: 'timeline:event',
        data: {
          eventId: row!.id,
          contactId: input.contactId,
          type: input.type,
          eventCategory: input.eventCategory,
          actorType: input.actorType,
          title,
        },
        timestamp: new Date().toISOString(),
      }),
    );
  } catch (err) {
    logger.warn({ err, contactId: input.contactId }, 'Failed to publish timeline event');
  }

  return { id: row!.id };
}

export interface GetTimelineOpts {
  tenantId: string;
  contactId: string;
  /** Opaque cursor returned from a previous page. */
  cursor?: string | null;
  limit?: number;
  category?: CrmEventCategory;
}

export interface TimelinePage {
  events: CrmActivity[];
  nextCursor: string | null;
  hasMore: boolean;
}

export async function getContactTimeline(opts: GetTimelineOpts): Promise<TimelinePage> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);

  const events = await withTenant(opts.tenantId, async (tx) => {
    const conditions = [
      eq(crmActivities.tenantId, opts.tenantId),
      eq(crmActivities.contactId, opts.contactId),
    ];
    if (opts.category) conditions.push(eq(crmActivities.eventCategory, opts.category));

    if (opts.cursor) {
      // Cursor encodes (occurredAt, id) so identical timestamps don't
      // produce a stable-cursor bug. Sort by occurredAt DESC, id DESC so
      // (occurredAt, id) < cursor means "older than the cursor".
      const decoded = decodeCursor(opts.cursor);
      if (decoded) {
        conditions.push(
          or(
            lt(crmActivities.occurredAt, decoded.occurredAt),
            and(
              eq(crmActivities.occurredAt, decoded.occurredAt),
              lt(crmActivities.id, decoded.id),
            ),
          )!,
        );
      }
    }

    return tx
      .select()
      .from(crmActivities)
      .where(and(...conditions))
      .orderBy(desc(crmActivities.occurredAt), desc(crmActivities.id))
      .limit(limit + 1);
  });

  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(0, limit) : events;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor(last.occurredAt, last.id)
    : null;

  return { events: page, nextCursor, hasMore };
}

function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ occurredAt: occurredAt.toISOString(), id })).toString('base64');
}

function decodeCursor(cursor: string): { occurredAt: Date; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString());
    const occurredAt = new Date(parsed.occurredAt);
    if (Number.isNaN(occurredAt.getTime()) || typeof parsed.id !== 'string') return null;
    return { occurredAt, id: parsed.id };
  } catch {
    return null;
  }
}

/**
 * Inferred default title per event type. Used when the caller doesn't
 * supply one. Keep these short — the dashboard renders them as a one-line
 * summary in the event feed.
 */
function defaultTitleFor(type: NewCrmActivity['type']): string {
  switch (type) {
    case 'contact_added': return 'Contact added';
    case 'contact_tagged': return 'Tags updated';
    case 'contact_untagged': return 'Tags removed';
    case 'contact_marked_dnc': return 'Marked do-not-contact';
    case 'contact_reassigned': return 'Contact reassigned';
    case 'duplicate_capture_attempted': return 'Duplicate capture attempted';
    case 'note_added': return 'Note added';
    case 'email_sent': return 'Email sent';
    case 'email_opened': return 'Email opened';
    case 'email_replied': return 'Email replied';
    case 'linkedin_message_sent': return 'LinkedIn message sent';
    case 'linkedin_message_received': return 'LinkedIn message received';
    case 'linkedin_connection_sent': return 'LinkedIn connect sent';
    case 'linkedin_connection_accepted': return 'LinkedIn connect accepted';
    case 'stage_change': return 'Stage changed';
    case 'status_change': return 'Status changed';
    case 'meeting_scheduled': return 'Meeting scheduled';
    default: return String(type).replace(/_/g, ' ');
  }
}

/**
 * Type-→-category fallback for legacy callers. Used by the wrapper in
 * crm-activity.service.ts so older call sites don't have to pass
 * eventCategory + actorType explicitly. Keep in sync with the SQL backfill
 * in migration 0034.
 */
export function inferEventCategory(type: NewCrmActivity['type']): CrmEventCategory {
  switch (type) {
    case 'email_sent':
    case 'linkedin_message_sent':
    case 'linkedin_connection_sent':
    case 'linkedin_followup_sent':
    case 'manual_email_sent':
    case 'call_logged':
      return 'outreach';
    case 'email_opened':
    case 'email_replied':
    case 'email_received':
    case 'email_bounced':
    case 'linkedin_message_received':
    case 'linkedin_connection_accepted':
    case 'manual_email_received':
      return 'response';
    case 'stage_change':
    case 'status_change':
    case 'score_updated':
      return 'status_change';
    case 'note_added':
      return 'manual_note';
    case 'meeting_scheduled':
      return 'meeting';
    case 'contact_added':
      return 'discovery';
    case 'contact_tagged':
    case 'contact_untagged':
    case 'contact_marked_dnc':
    case 'contact_reassigned':
    case 'duplicate_capture_attempted':
    case 'agent_action':
    default:
      return 'system_action';
  }
}

export function inferActorType(
  type: NewCrmActivity['type'],
  userId: string | undefined | null,
): CrmActorType {
  if (userId) return 'user';
  switch (type) {
    case 'email_opened':
    case 'email_replied':
    case 'email_received':
    case 'email_bounced':
    case 'linkedin_message_received':
    case 'linkedin_connection_accepted':
    case 'manual_email_received':
      return 'recipient';
    default:
      return 'system';
  }
}

