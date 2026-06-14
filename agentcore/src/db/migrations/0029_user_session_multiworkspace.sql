-- Multi-workspace extension sessions.
--
-- Bind extension sessions to a USER instead of a tenant. The dispatcher will
-- drain pending extension_tasks across every tenant the session's user is a
-- member of. Dashboard auth is unchanged; only the extension flow shifts.

-- 1) Mark default workspace per user.
ALTER TABLE user_tenants
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- At most one default per user.
CREATE UNIQUE INDEX IF NOT EXISTS user_tenants_one_default_per_user_idx
  ON user_tenants (user_id) WHERE is_default;

-- Backfill membership rows from users.tenant_id and mark them as the default.
INSERT INTO user_tenants (user_id, tenant_id, role, is_default)
  SELECT id, tenant_id, 'owner'::user_role, TRUE
    FROM users
   WHERE tenant_id IS NOT NULL
ON CONFLICT (user_id, tenant_id)
  DO UPDATE SET is_default = TRUE;

-- For users that already had multiple memberships but no default flagged,
-- pick the row whose tenant matches users.tenant_id (covered above), then
-- fall back to the oldest membership.
WITH no_default AS (
  SELECT user_id FROM user_tenants
  GROUP BY user_id
  HAVING COUNT(*) FILTER (WHERE is_default) = 0
), pick AS (
  SELECT DISTINCT ON (m.user_id) m.id
    FROM user_tenants m
    JOIN no_default n ON n.user_id = m.user_id
   ORDER BY m.user_id, m.joined_at ASC
)
UPDATE user_tenants SET is_default = TRUE WHERE id IN (SELECT id FROM pick);

-- 2) Allow tenant-less extension sessions. We do not drop tenant_id yet:
-- existing rows still carry it, and a follow-up migration will retire the
-- column once all callers stop reading it.
ALTER TABLE extension_sessions
  ALTER COLUMN tenant_id DROP NOT NULL;

-- Fast path for the new dispatcher: "find the live session for this user".
CREATE INDEX IF NOT EXISTS extension_sessions_user_active_idx
  ON extension_sessions (user_id) WHERE revoked_at IS NULL;
