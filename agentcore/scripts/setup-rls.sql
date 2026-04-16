-- AgentCore Row-Level Security Setup
-- Run this after migrations: psql -d agentcore -f scripts/setup-rls.sql

-- Enable pg_trgm extension for GIN trigram indexes on email
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Function to get the current tenant ID from session variables
CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
BEGIN
  RETURN current_setting('app.current_tenant_id', true)::uuid;
EXCEPTION
  WHEN OTHERS THEN
    RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- Enable RLS on all tenant-scoped tables
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE master_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE companies ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE campaign_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE emails_sent ENABLE ROW LEVEL SECURITY;
ALTER TABLE replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE interviews ENABLE ROW LEVEL SECURITY;

-- Helper: create all 4 policies for a table with tenant_id column
-- Users
CREATE POLICY users_select ON users FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY users_update ON users FOR UPDATE USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY users_delete ON users FOR DELETE USING (tenant_id = current_tenant_id());

-- Master Agents
CREATE POLICY master_agents_select ON master_agents FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY master_agents_insert ON master_agents FOR INSERT WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY master_agents_update ON master_agents FOR UPDATE USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY master_agents_delete ON master_agents FOR DELETE USING (tenant_id = current_tenant_id());

-- Agent Configs
CREATE POLICY agent_configs_select ON agent_configs FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY agent_configs_insert ON agent_configs FOR INSERT WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY agent_configs_update ON agent_configs FOR UPDATE USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY agent_configs_delete ON agent_configs FOR DELETE USING (tenant_id = current_tenant_id());

-- Agent Tasks
CREATE POLICY agent_tasks_select ON agent_tasks FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY agent_tasks_insert ON agent_tasks FOR INSERT WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY agent_tasks_update ON agent_tasks FOR UPDATE USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY agent_tasks_delete ON agent_tasks FOR DELETE USING (tenant_id = current_tenant_id());

-- Agent Memory
CREATE POLICY agent_memory_select ON agent_memory FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY agent_memory_insert ON agent_memory FOR INSERT WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY agent_memory_update ON agent_memory FOR UPDATE USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY agent_memory_delete ON agent_memory FOR DELETE USING (tenant_id = current_tenant_id());

-- Contacts
CREATE POLICY contacts_select ON contacts FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY contacts_insert ON contacts FOR INSERT WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY contacts_update ON contacts FOR UPDATE USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY contacts_delete ON contacts FOR DELETE USING (tenant_id = current_tenant_id());

-- Companies
CREATE POLICY companies_select ON companies FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY companies_insert ON companies FOR INSERT WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY companies_update ON companies FOR UPDATE USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY companies_delete ON companies FOR DELETE USING (tenant_id = current_tenant_id());

-- Documents
CREATE POLICY documents_select ON documents FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY documents_insert ON documents FOR INSERT WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY documents_update ON documents FOR UPDATE USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY documents_delete ON documents FOR DELETE USING (tenant_id = current_tenant_id());

-- Campaigns
CREATE POLICY campaigns_select ON campaigns FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY campaigns_insert ON campaigns FOR INSERT WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY campaigns_update ON campaigns FOR UPDATE USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY campaigns_delete ON campaigns FOR DELETE USING (tenant_id = current_tenant_id());

-- Campaign Steps (no tenant_id directly, but access via campaign)
-- campaign_steps uses campaign_id, and campaigns have tenant_id.
-- For RLS on campaign_steps, we check via a subquery on campaigns.
CREATE POLICY campaign_steps_select ON campaign_steps FOR SELECT
  USING (EXISTS (SELECT 1 FROM campaigns WHERE campaigns.id = campaign_steps.campaign_id AND campaigns.tenant_id = current_tenant_id()));
CREATE POLICY campaign_steps_insert ON campaign_steps FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM campaigns WHERE campaigns.id = campaign_steps.campaign_id AND campaigns.tenant_id = current_tenant_id()));
CREATE POLICY campaign_steps_update ON campaign_steps FOR UPDATE
  USING (EXISTS (SELECT 1 FROM campaigns WHERE campaigns.id = campaign_steps.campaign_id AND campaigns.tenant_id = current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM campaigns WHERE campaigns.id = campaign_steps.campaign_id AND campaigns.tenant_id = current_tenant_id()));
CREATE POLICY campaign_steps_delete ON campaign_steps FOR DELETE
  USING (EXISTS (SELECT 1 FROM campaigns WHERE campaigns.id = campaign_steps.campaign_id AND campaigns.tenant_id = current_tenant_id()));

-- Campaign Contacts (no direct tenant_id, access via campaign)
CREATE POLICY campaign_contacts_select ON campaign_contacts FOR SELECT
  USING (EXISTS (SELECT 1 FROM campaigns WHERE campaigns.id = campaign_contacts.campaign_id AND campaigns.tenant_id = current_tenant_id()));
CREATE POLICY campaign_contacts_insert ON campaign_contacts FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM campaigns WHERE campaigns.id = campaign_contacts.campaign_id AND campaigns.tenant_id = current_tenant_id()));
CREATE POLICY campaign_contacts_update ON campaign_contacts FOR UPDATE
  USING (EXISTS (SELECT 1 FROM campaigns WHERE campaigns.id = campaign_contacts.campaign_id AND campaigns.tenant_id = current_tenant_id()))
  WITH CHECK (EXISTS (SELECT 1 FROM campaigns WHERE campaigns.id = campaign_contacts.campaign_id AND campaigns.tenant_id = current_tenant_id()));
CREATE POLICY campaign_contacts_delete ON campaign_contacts FOR DELETE
  USING (EXISTS (SELECT 1 FROM campaigns WHERE campaigns.id = campaign_contacts.campaign_id AND campaigns.tenant_id = current_tenant_id()));

-- Emails Sent (no direct tenant_id, access via campaign_contacts -> campaigns)
CREATE POLICY emails_sent_select ON emails_sent FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM campaign_contacts cc
    JOIN campaigns c ON c.id = cc.campaign_id
    WHERE cc.id = emails_sent.campaign_contact_id AND c.tenant_id = current_tenant_id()
  ));
CREATE POLICY emails_sent_insert ON emails_sent FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM campaign_contacts cc
    JOIN campaigns c ON c.id = cc.campaign_id
    WHERE cc.id = emails_sent.campaign_contact_id AND c.tenant_id = current_tenant_id()
  ));
CREATE POLICY emails_sent_update ON emails_sent FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM campaign_contacts cc
    JOIN campaigns c ON c.id = cc.campaign_id
    WHERE cc.id = emails_sent.campaign_contact_id AND c.tenant_id = current_tenant_id()
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM campaign_contacts cc
    JOIN campaigns c ON c.id = cc.campaign_id
    WHERE cc.id = emails_sent.campaign_contact_id AND c.tenant_id = current_tenant_id()
  ));
CREATE POLICY emails_sent_delete ON emails_sent FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM campaign_contacts cc
    JOIN campaigns c ON c.id = cc.campaign_id
    WHERE cc.id = emails_sent.campaign_contact_id AND c.tenant_id = current_tenant_id()
  ));

-- Replies (has tenant_id directly — use it instead of chaining through email_sent_id which can be NULL)
DROP POLICY IF EXISTS replies_select ON replies;
DROP POLICY IF EXISTS replies_insert ON replies;
DROP POLICY IF EXISTS replies_update ON replies;
DROP POLICY IF EXISTS replies_delete ON replies;

CREATE POLICY replies_select ON replies FOR SELECT
  USING (tenant_id = current_tenant_id());
CREATE POLICY replies_insert ON replies FOR INSERT
  WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY replies_update ON replies FOR UPDATE
  USING (tenant_id = current_tenant_id())
  WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY replies_delete ON replies FOR DELETE
  USING (tenant_id = current_tenant_id());

-- Interviews
CREATE POLICY interviews_select ON interviews FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY interviews_insert ON interviews FOR INSERT WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY interviews_update ON interviews FOR UPDATE USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY interviews_delete ON interviews FOR DELETE USING (tenant_id = current_tenant_id());

-- Extension Sessions
ALTER TABLE extension_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY extension_sessions_select ON extension_sessions FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY extension_sessions_insert ON extension_sessions FOR INSERT WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY extension_sessions_update ON extension_sessions FOR UPDATE USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY extension_sessions_delete ON extension_sessions FOR DELETE USING (tenant_id = current_tenant_id());

-- Extension Tasks
ALTER TABLE extension_tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY extension_tasks_select ON extension_tasks FOR SELECT USING (tenant_id = current_tenant_id());
CREATE POLICY extension_tasks_insert ON extension_tasks FOR INSERT WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY extension_tasks_update ON extension_tasks FOR UPDATE USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
CREATE POLICY extension_tasks_delete ON extension_tasks FOR DELETE USING (tenant_id = current_tenant_id());

-- Allow the application user to bypass RLS when needed (e.g., for migrations, admin ops)
-- The app should use SET LOCAL to set the tenant context for normal operations
-- For superuser operations (like seeding), RLS is bypassed automatically

COMMENT ON FUNCTION current_tenant_id() IS 'Returns the current tenant ID from the session variable app.current_tenant_id. Used by RLS policies.';
