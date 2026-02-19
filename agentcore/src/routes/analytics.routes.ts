import type { FastifyInstance } from 'fastify';
import { eq, sql, and, count } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { contacts, campaigns, masterAgents, interviews, emailsSent, campaignContacts } from '../db/schema/index.js';

export default async function analyticsRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/analytics/dashboard
  fastify.get('/dashboard', async (request) => {
    const data = await withTenant(request.tenantId, async (tx) => {
      // Total contacts
      const [contactCount] = await tx
        .select({ count: count() })
        .from(contacts)
        .where(eq(contacts.tenantId, request.tenantId));

      // Contacts by status
      const contactsByStatus = await tx
        .select({
          status: contacts.status,
          count: count(),
        })
        .from(contacts)
        .where(eq(contacts.tenantId, request.tenantId))
        .groupBy(contacts.status);

      // Active campaigns
      const [activeCampaignCount] = await tx
        .select({ count: count() })
        .from(campaigns)
        .where(and(eq(campaigns.tenantId, request.tenantId), eq(campaigns.status, 'active')));

      // Total campaigns
      const [totalCampaignCount] = await tx
        .select({ count: count() })
        .from(campaigns)
        .where(eq(campaigns.tenantId, request.tenantId));

      // Master agents
      const [masterAgentCount] = await tx
        .select({ count: count() })
        .from(masterAgents)
        .where(eq(masterAgents.tenantId, request.tenantId));

      // Running agents
      const [runningAgentCount] = await tx
        .select({ count: count() })
        .from(masterAgents)
        .where(and(eq(masterAgents.tenantId, request.tenantId), eq(masterAgents.status, 'running')));

      // Interviews scheduled
      const [interviewCount] = await tx
        .select({ count: count() })
        .from(interviews)
        .where(eq(interviews.tenantId, request.tenantId));

      // Aggregate campaign stats
      const campaignStats = await tx
        .select({ stats: campaigns.stats })
        .from(campaigns)
        .where(eq(campaigns.tenantId, request.tenantId));

      let totalSent = 0;
      let totalOpened = 0;
      let totalReplied = 0;
      let totalMeetingsBooked = 0;
      for (const c of campaignStats) {
        const s = c.stats as { sent?: number; opened?: number; replied?: number; meetingsBooked?: number } | null;
        if (s) {
          totalSent += s.sent || 0;
          totalOpened += s.opened || 0;
          totalReplied += s.replied || 0;
          totalMeetingsBooked += s.meetingsBooked || 0;
        }
      }

      return {
        contacts: {
          total: contactCount?.count || 0,
          byStatus: Object.fromEntries(contactsByStatus.map((r) => [r.status, r.count])),
        },
        campaigns: {
          total: totalCampaignCount?.count || 0,
          active: activeCampaignCount?.count || 0,
        },
        masterAgents: {
          total: masterAgentCount?.count || 0,
          running: runningAgentCount?.count || 0,
        },
        emails: {
          sent: totalSent,
          opened: totalOpened,
          replied: totalReplied,
        },
        interviews: {
          scheduled: interviewCount?.count || 0,
        },
        meetingsBooked: totalMeetingsBooked,
      };
    });

    return { data };
  });
}
