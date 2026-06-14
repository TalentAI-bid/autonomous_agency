import type { FastifyInstance } from 'fastify';
import { eq, sql, and, count, isNotNull, gt, avg } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { contacts, campaigns, masterAgents, interviews, emailsSent, campaignContacts, crmActivities } from '../db/schema/index.js';

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

      // Direct email counts from emailsSent table
      const [emailSentCount] = await tx
        .select({ count: count() })
        .from(emailsSent)
        .innerJoin(campaignContacts, eq(emailsSent.campaignContactId, campaignContacts.id))
        .innerJoin(campaigns, eq(campaignContacts.campaignId, campaigns.id))
        .where(and(eq(campaigns.tenantId, request.tenantId), isNotNull(emailsSent.sentAt)));

      const [emailOpenedCount] = await tx
        .select({ count: count() })
        .from(emailsSent)
        .innerJoin(campaignContacts, eq(emailsSent.campaignContactId, campaignContacts.id))
        .innerJoin(campaigns, eq(campaignContacts.campaignId, campaigns.id))
        .where(and(eq(campaigns.tenantId, request.tenantId), isNotNull(emailsSent.openedAt)));

      const [emailRepliedCount] = await tx
        .select({ count: count() })
        .from(emailsSent)
        .innerJoin(campaignContacts, eq(emailsSent.campaignContactId, campaignContacts.id))
        .innerJoin(campaigns, eq(campaignContacts.campaignId, campaigns.id))
        .where(and(eq(campaigns.tenantId, request.tenantId), isNotNull(emailsSent.repliedAt)));

      // Average contact score
      const [avgScoreResult] = await tx
        .select({ avg: avg(contacts.score) })
        .from(contacts)
        .where(and(eq(contacts.tenantId, request.tenantId), gt(contacts.score, 0)));

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
          sent: emailSentCount?.count || 0,
          opened: emailOpenedCount?.count || 0,
          replied: emailRepliedCount?.count || 0,
        },
        interviews: {
          scheduled: interviewCount?.count || 0,
        },
        avgScore: avgScoreResult?.avg ? Math.round(Number(avgScoreResult.avg)) : null,
      };
    });

    return { data };
  });

  // GET /api/analytics/outreach-activity — counts of outreach actions recorded
  // across channels (email + LinkedIn, incl. extension-reported sends) plus the
  // number of contacts that have responded.
  fastify.get('/outreach-activity', async (request) => {
    const data = await withTenant(request.tenantId, async (tx) => {
      const countByType = async (type: (typeof crmActivities.$inferInsert)['type']) => {
        const [row] = await tx
          .select({ count: count() })
          .from(crmActivities)
          .where(and(eq(crmActivities.tenantId, request.tenantId), eq(crmActivities.type, type)));
        return row?.count || 0;
      };

      const [emailsSent, linkedinMessagesSent, personsAddedWithNote, connectionsAccepted] = await Promise.all([
        countByType('email_sent'),
        countByType('linkedin_message_sent'),
        countByType('linkedin_connection_sent'),
        countByType('linkedin_connection_accepted'),
      ]);

      const [repliedRow] = await tx
        .select({ count: count() })
        .from(contacts)
        .where(and(eq(contacts.tenantId, request.tenantId), eq(contacts.status, 'replied')));

      return {
        emailsSent,
        linkedinMessagesSent,
        personsAddedWithNote,
        connectionsAccepted,
        responses: repliedRow?.count || 0,
      };
    });

    return { data };
  });
}
