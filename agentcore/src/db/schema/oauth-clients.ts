import { pgTable, varchar, jsonb, timestamp } from 'drizzle-orm/pg-core';

// App-wide OAuth clients registered via Dynamic Client Registration (RFC 7591).
// Public clients (PKCE, no secret). See migrations/0037_oauth_clients.sql.
export const oauthClients = pgTable('oauth_clients', {
  clientId: varchar('client_id', { length: 128 }).primaryKey(),
  clientName: varchar('client_name', { length: 255 }),
  redirectUris: jsonb('redirect_uris').notNull(),
  grantTypes: jsonb('grant_types').notNull(),
  tokenEndpointAuthMethod: varchar('token_endpoint_auth_method', { length: 32 }).notNull().default('none'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
