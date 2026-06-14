// Resolve the sender's first name for any outreach draft / signature.
//
// Source of truth: `users.name` of the tenant's primary user (default
// workspace, most recently joined as tiebreak). The first whitespace-
// separated token is used as the first name.
//
// Failure mode: throws AppError 'MISSING_SENDER_NAME'. We never fall back
// to a placeholder or invented name — the user has explicitly asked that
// drafts fail loud when the account holder's name is missing rather than
// be signed by something synthetic.

import { eq, desc } from 'drizzle-orm';
import { db } from '../config/database.js';
import { users, userTenants } from '../db/schema/index.js';
import { AppError } from '../utils/errors.js';

/**
 * Returns the account holder's first name for the given tenant.
 * Throws AppError('MISSING_SENDER_NAME') if no user is found or the user's
 * name is null/empty.
 */
export async function resolveSenderFirstName(tenantId: string): Promise<string> {
  const [row] = await db
    .select({ name: users.name })
    .from(userTenants)
    .innerJoin(users, eq(users.id, userTenants.userId))
    .where(eq(userTenants.tenantId, tenantId))
    .orderBy(desc(userTenants.isDefault), desc(userTenants.joinedAt))
    .limit(1);

  const first = row?.name?.trim().split(/\s+/)[0];
  if (!first) {
    throw new AppError(
      "Set your name in Settings — drafts can't sign off without it.",
      400,
      'MISSING_SENDER_NAME',
    );
  }
  return first;
}
