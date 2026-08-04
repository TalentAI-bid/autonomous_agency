-- OAuth 2.1 Dynamic Client Registration store for the MCP server.
--
-- Clients are app-wide (not tenant-scoped): each Claude install registers once
-- via POST /register and stores its client_id. Public clients (PKCE, no secret),
-- token_endpoint_auth_method='none'. Authorization codes, access tokens, and
-- refresh tokens live in Redis (short-lived / revocable), not here.
--
-- Additive + idempotent; safe to re-run. Apply with psql (journal-less, same as 0033-0036).

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id varchar(128) PRIMARY KEY,
  client_name varchar(255),
  redirect_uris jsonb NOT NULL,
  grant_types jsonb NOT NULL DEFAULT '["authorization_code","refresh_token"]'::jsonb,
  token_endpoint_auth_method varchar(32) NOT NULL DEFAULT 'none',
  created_at timestamptz NOT NULL DEFAULT now()
);
