import type { FastifyInstance } from 'fastify';
import { eq, and, desc, count, ilike, or, sql, gte, inArray } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { emailQueue, emailsSent, replies, contacts, emailThreads, deals, crmStages } from '../db/schema/index.js';
import { dispatchJob } from '../services/queue.service.js';

export default async function mailboxRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/mailbox/sent — Paginated outbound emails
  fastify.get('/sent', async (request) => {
    const { limit = 25, cursor, search } = request.query as {
      limit?: number;
      cursor?: string;
      search?: string;
    };

    const data = await withTenant(request.tenantId, async (tx) => {
      const conditions = [
        eq(emailQueue.tenantId, request.tenantId),
      ];

      if (search) {
        conditions.push(
          or(
            ilike(emailQueue.subject, `%${search}%`),
            ilike(emailQueue.toEmail, `%${search}%`),
          )!,
        );
      }

      if (cursor) {
        conditions.push(sql`${emailQueue.createdAt} < ${cursor}`);
      }

      const rows = await tx
        .select({
          id: emailQueue.id,
          fromEmail: emailQueue.fromEmail,
          toEmail: emailQueue.toEmail,
          subject: emailQueue.subject,
          body: emailQueue.body,
          status: emailQueue.status,
          sentAt: emailQueue.sentAt,
          createdAt: emailQueue.createdAt,
          scheduledAt: emailQueue.scheduledAt,
          contactId: emailQueue.contactId,
          contactFirstName: contacts.firstName,
          contactLastName: contacts.lastName,
          openedAt: emailsSent.openedAt,
        })
        .from(emailQueue)
        .leftJoin(contacts, eq(emailQueue.contactId, contacts.id))
        .leftJoin(emailsSent, eq(emailQueue.trackingId, emailsSent.trackingId))
        .where(and(...conditions))
        .orderBy(desc(emailQueue.createdAt))
        .limit(Number(limit) + 1);

      const hasMore = rows.length > Number(limit);
      const items = hasMore ? rows.slice(0, Number(limit)) : rows;
      const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.createdAt.toISOString() : undefined;

      return {
        data: items.map((r) => ({
          id: r.id,
          direction: 'sent' as const,
          fromEmail: r.fromEmail,
          toEmail: r.toEmail,
          subject: r.subject,
          body: r.body,
          status: r.status,
          sentAt: r.sentAt?.toISOString(),
          createdAt: r.createdAt.toISOString(),
          scheduledAt: r.scheduledAt?.toISOString(),
          contactId: r.contactId,
          contactName: [r.contactFirstName, r.contactLastName].filter(Boolean).join(' ') || undefined,
          openedAt: r.openedAt?.toISOString() ?? null,
        })),
        nextCursor,
        hasMore,
      };
    });

    return { data: { data: data.data, nextCursor: data.nextCursor, hasMore: data.hasMore } };
  });

  // GET /api/mailbox/inbox — Paginated inbound emails (with tenant isolation fix)
  fastify.get('/inbox', async (request) => {
    const { limit = 25, cursor, search, classification } = request.query as {
      limit?: number;
      cursor?: string;
      search?: string;
      classification?: string;
    };

    const data = await withTenant(request.tenantId, async (tx) => {
      // Use replies.tenantId for direct tenant isolation (fallback to contacts join for old rows)
      const conditions = [
        or(
          eq(replies.tenantId, request.tenantId),
          eq(contacts.tenantId, request.tenantId),
        )!,
      ];

      if (search) {
        conditions.push(
          or(
            ilike(replies.subject, `%${search}%`),
            ilike(replies.fromEmail, `%${search}%`),
            ilike(replies.body, `%${search}%`),
          )!,
        );
      }

      if (classification) {
        conditions.push(eq(replies.classification, classification as any));
      }

      if (cursor) {
        conditions.push(sql`${replies.createdAt} < ${cursor}`);
      }

      const rows = await tx
        .select({
          id: replies.id,
          fromEmail: replies.fromEmail,
          subject: replies.subject,
          body: replies.body,
          classification: replies.classification,
          sentiment: replies.sentiment,
          isInbound: replies.isInbound,
          processedAt: replies.processedAt,
          createdAt: replies.createdAt,
          contactId: replies.contactId,
          threadId: replies.threadId,
          contactFirstName: contacts.firstName,
          contactLastName: contacts.lastName,
          contactEmail: contacts.email,
        })
        .from(replies)
        .leftJoin(contacts, eq(replies.contactId, contacts.id))
        .where(and(...conditions))
        .orderBy(desc(replies.createdAt))
        .limit(Number(limit) + 1);

      const hasMore = rows.length > Number(limit);
      const items = hasMore ? rows.slice(0, Number(limit)) : rows;
      const nextCursor = hasMore && items.length > 0 ? items[items.length - 1]!.createdAt.toISOString() : undefined;

      return {
        data: items.map((r) => ({
          id: r.id,
          direction: 'received' as const,
          fromEmail: r.fromEmail ?? r.contactEmail,
          subject: r.subject,
          body: r.body,
          classification: r.classification,
          sentiment: r.sentiment,
          isInbound: r.isInbound,
          processedAt: r.processedAt?.toISOString(),
          createdAt: r.createdAt.toISOString(),
          contactId: r.contactId,
          threadId: r.threadId,
          contactName: [r.contactFirstName, r.contactLastName].filter(Boolean).join(' ') || undefined,
        })),
        nextCursor,
        hasMore,
      };
    });

    return { data: { data: data.data, nextCursor: data.nextCursor, hasMore: data.hasMore } };
  });

  // GET /api/mailbox/stats — Quick counts
  fastify.get('/stats', async (request) => {
    const data = await withTenant(request.tenantId, async (tx) => {
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const [totalSentResult] = await tx
        .select({ count: count() })
        .from(emailQueue)
        .where(and(eq(emailQueue.tenantId, request.tenantId), eq(emailQueue.status, 'sent')));

      const [todaySentResult] = await tx
        .select({ count: count() })
        .from(emailQueue)
        .where(and(
          eq(emailQueue.tenantId, request.tenantId),
          eq(emailQueue.status, 'sent'),
          gte(emailQueue.sentAt, today),
        ));

      const [totalReceivedResult] = await tx
        .select({ count: count() })
        .from(replies)
        .where(eq(replies.tenantId, request.tenantId));

      const [todayReceivedResult] = await tx
        .select({ count: count() })
        .from(replies)
        .where(and(
          eq(replies.tenantId, request.tenantId),
          gte(replies.createdAt, today),
        ));

      const byClassification = await tx
        .select({ classification: replies.classification, count: count() })
        .from(replies)
        .where(eq(replies.tenantId, request.tenantId))
        .groupBy(replies.classification);

      return {
        totalSent: totalSentResult?.count ?? 0,
        totalReceived: totalReceivedResult?.count ?? 0,
        todaySent: todaySentResult?.count ?? 0,
        todayReceived: todayReceivedResult?.count ?? 0,
        byClassification: Object.fromEntries(
          byClassification.map((r) => [r.classification ?? 'unclassified', r.count]),
        ),
      };
    });

    return { data };
  });

  // ── Thread Endpoints ─────────────────────────────────────────────────────

  // GET /api/mailbox/threads — List threads (paginated, filterable)
  fastify.get('/threads', async (request) => {
    const { limit = 25, cursor, status, priority, contactId, search } = request.query as {
      limit?: number;
      cursor?: string;
      status?: string;
      priority?: string;
      contactId?: string;
      search?: string;
    };

    const data = await withTenant(request.tenantId, async (tx) => {
      const conditions = [eq(emailThreads.tenantId, request.tenantId)];

      if (status) {
        conditions.push(eq(emailThreads.status, status as any));
      }
      if (priority) {
        conditions.push(eq(emailThreads.priority, priority as any));
      }
      if (contactId) {
        conditions.push(eq(emailThreads.contactId, contactId));
      }
      if (search) {
        conditions.push(ilike(emailThreads.subject, `%${search}%`));
      }
      if (cursor) {
        conditions.push(sql`${emailThreads.lastMessageAt} < ${cursor}`);
      }

      const rows = await tx
        .select({
          id: emailThreads.id,
          subject: emailThreads.subject,
          status: emailThreads.status,
          priority: emailThreads.priority,
          messageCount: emailThreads.messageCount,
          lastMessageAt: emailThreads.lastMessageAt,
          summary: emailThreads.summary,
          nextAction: emailThreads.nextAction,
          dealId: emailThreads.dealId,
          contactId: emailThreads.contactId,
          contactFirstName: contacts.firstName,
          contactLastName: contacts.lastName,
          contactEmail: contacts.email,
          dealTitle: deals.title,
          dealValue: deals.value,
          stageId: deals.stageId,
          stageName: crmStages.name,
          stageColor: crmStages.color,
          createdAt: emailThreads.createdAt,
          updatedAt: emailThreads.updatedAt,
        })
        .from(emailThreads)
        .leftJoin(contacts, eq(emailThreads.contactId, contacts.id))
        .leftJoin(deals, eq(emailThreads.dealId, deals.id))
        .leftJoin(crmStages, eq(deals.stageId, crmStages.id))
        .where(and(...conditions))
        .orderBy(desc(emailThreads.lastMessageAt))
        .limit(Number(limit) + 1);

      const hasMore = rows.length > Number(limit);
      const items = hasMore ? rows.slice(0, Number(limit)) : rows;
      const nextCursor = hasMore && items.length > 0 && items[items.length - 1]!.lastMessageAt
        ? items[items.length - 1]!.lastMessageAt!.toISOString()
        : undefined;

      return {
        data: items.map((r) => ({
          id: r.id,
          subject: r.subject,
          status: r.status,
          priority: r.priority,
          messageCount: r.messageCount,
          lastMessageAt: r.lastMessageAt?.toISOString(),
          summary: r.summary,
          nextAction: r.nextAction,
          dealId: r.dealId,
          contactId: r.contactId,
          contactName: [r.contactFirstName, r.contactLastName].filter(Boolean).join(' ') || undefined,
          contactEmail: r.contactEmail,
          deal: r.dealId ? {
            id: r.dealId,
            title: r.dealTitle,
            value: r.dealValue,
            stage: r.stageId ? {
              id: r.stageId,
              name: r.stageName,
              color: r.stageColor,
            } : undefined,
          } : undefined,
          createdAt: r.createdAt.toISOString(),
          updatedAt: r.updatedAt.toISOString(),
        })),
        nextCursor,
        hasMore,
      };
    });

    return { data: { data: data.data, nextCursor: data.nextCursor, hasMore: data.hasMore } };
  });

  // GET /api/mailbox/threads/:id — Thread detail with all messages
  fastify.get('/threads/:id', async (request) => {
    const { id } = request.params as { id: string };

    const data = await withTenant(request.tenantId, async (tx) => {
      // Load thread
      const [thread] = await tx
        .select({
          id: emailThreads.id,
          subject: emailThreads.subject,
          status: emailThreads.status,
          priority: emailThreads.priority,
          messageCount: emailThreads.messageCount,
          lastMessageAt: emailThreads.lastMessageAt,
          summary: emailThreads.summary,
          nextAction: emailThreads.nextAction,
          dealId: emailThreads.dealId,
          contactId: emailThreads.contactId,
          contactFirstName: contacts.firstName,
          contactLastName: contacts.lastName,
          contactEmail: contacts.email,
          createdAt: emailThreads.createdAt,
          updatedAt: emailThreads.updatedAt,
        })
        .from(emailThreads)
        .leftJoin(contacts, eq(emailThreads.contactId, contacts.id))
        .where(and(eq(emailThreads.id, id), eq(emailThreads.tenantId, request.tenantId)))
        .limit(1);

      if (!thread) return null;

      // Load inbound messages
      const inboundMessages = await tx
        .select({
          id: replies.id,
          fromEmail: replies.fromEmail,
          subject: replies.subject,
          body: replies.body,
          classification: replies.classification,
          sentiment: replies.sentiment,
          createdAt: replies.createdAt,
        })
        .from(replies)
        .where(eq(replies.threadId, id));

      // Load outbound messages
      const outboundMessages = await tx
        .select({
          id: emailQueue.id,
          fromEmail: emailQueue.fromEmail,
          toEmail: emailQueue.toEmail,
          subject: emailQueue.subject,
          body: emailQueue.body,
          status: emailQueue.status,
          sentAt: emailQueue.sentAt,
          createdAt: emailQueue.createdAt,
        })
        .from(emailQueue)
        .where(eq(emailQueue.threadId, id));

      // Load deal info if linked
      let dealInfo = null;
      if (thread.dealId) {
        const [deal] = await tx
          .select({
            id: deals.id,
            title: deals.title,
            value: deals.value,
            currency: deals.currency,
            notes: deals.notes,
            stageId: deals.stageId,
            stageName: crmStages.name,
            stageSlug: crmStages.slug,
            stageColor: crmStages.color,
          })
          .from(deals)
          .leftJoin(crmStages, eq(deals.stageId, crmStages.id))
          .where(eq(deals.id, thread.dealId))
          .limit(1);
        dealInfo = deal ?? null;
      }

      // Merge and sort messages chronologically
      const messages = [
        ...inboundMessages.map((m) => ({
          id: m.id,
          direction: 'received' as const,
          fromEmail: m.fromEmail,
          subject: m.subject,
          body: m.body,
          classification: m.classification,
          sentiment: m.sentiment,
          date: m.createdAt.toISOString(),
        })),
        ...outboundMessages.map((m) => ({
          id: m.id,
          direction: 'sent' as const,
          fromEmail: m.fromEmail,
          toEmail: m.toEmail,
          subject: m.subject,
          body: m.body,
          status: m.status,
          date: (m.sentAt ?? m.createdAt).toISOString(),
        })),
      ].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      return {
        ...thread,
        lastMessageAt: thread.lastMessageAt?.toISOString(),
        createdAt: thread.createdAt.toISOString(),
        updatedAt: thread.updatedAt.toISOString(),
        contactName: [thread.contactFirstName, thread.contactLastName].filter(Boolean).join(' ') || undefined,
        deal: dealInfo,
        messages,
      };
    });

    if (!data) {
      return { statusCode: 404, data: null };
    }

    return { data };
  });

  // POST /api/mailbox/threads/:id/summarize — Trigger LLM summarization
  fastify.post('/threads/:id/summarize', async (request) => {
    const { id } = request.params as { id: string };

    await dispatchJob(request.tenantId, 'mailbox', {
      action: 'summarize_thread',
      threadId: id,
    });

    return { data: { queued: true, threadId: id } };
  });

  // POST /api/mailbox/bulk-action — Bulk operations
  fastify.post('/bulk-action', async (request) => {
    const { action, threadIds } = request.body as { action: string; threadIds: string[] };

    if (!action || !threadIds || threadIds.length === 0) {
      return { statusCode: 400, data: { error: 'action and threadIds are required' } };
    }

    await dispatchJob(request.tenantId, 'mailbox', {
      action: 'bulk_action',
      bulkAction: action,
      threadIds,
    });

    return { data: { queued: true, action, count: threadIds.length } };
  });

  // GET /api/mailbox/digest — Mailbox overview
  fastify.get('/digest', async (request) => {
    const data = await withTenant(request.tenantId, async (tx) => {
      const [needsAction] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(emailThreads)
        .where(and(eq(emailThreads.tenantId, request.tenantId), eq(emailThreads.status, 'needs_action')));

      const [active] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(emailThreads)
        .where(and(eq(emailThreads.tenantId, request.tenantId), eq(emailThreads.status, 'active')));

      const [waiting] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(emailThreads)
        .where(and(eq(emailThreads.tenantId, request.tenantId), eq(emailThreads.status, 'waiting')));

      const [highPriority] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(emailThreads)
        .where(and(
          eq(emailThreads.tenantId, request.tenantId),
          eq(emailThreads.priority, 'high'),
          sql`${emailThreads.status} != 'archived'`,
        ));

      const [totalThreads] = await tx
        .select({ count: sql<number>`count(*)` })
        .from(emailThreads)
        .where(eq(emailThreads.tenantId, request.tenantId));

      return {
        needsAction: Number(needsAction?.count ?? 0),
        active: Number(active?.count ?? 0),
        waiting: Number(waiting?.count ?? 0),
        highPriority: Number(highPriority?.count ?? 0),
        totalThreads: Number(totalThreads?.count ?? 0),
      };
    });

    return { data };
  });

  // PATCH /api/mailbox/threads/:id — Update thread status/priority manually
  fastify.patch('/threads/:id', async (request) => {
    const { id } = request.params as { id: string };
    const { status, priority, nextAction } = request.body as {
      status?: string;
      priority?: string;
      nextAction?: string;
    };

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (status) updates.status = status;
    if (priority) updates.priority = priority;
    if (nextAction !== undefined) updates.nextAction = nextAction;

    const [updated] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(emailThreads)
        .set(updates)
        .where(and(eq(emailThreads.id, id), eq(emailThreads.tenantId, request.tenantId)))
        .returning({
          id: emailThreads.id,
          status: emailThreads.status,
          priority: emailThreads.priority,
          nextAction: emailThreads.nextAction,
        });
    });

    if (!updated) {
      return { statusCode: 404, data: null };
    }

    return { data: updated };
  });
}
