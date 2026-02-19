import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, lt, ilike, sql } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { contacts } from '../db/schema/index.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const createContactSchema = z.object({
  firstName: z.string().max(255).optional(),
  lastName: z.string().max(255).optional(),
  email: z.string().email().optional(),
  linkedinUrl: z.string().url().max(500).optional(),
  title: z.string().max(255).optional(),
  companyName: z.string().max(255).optional(),
  location: z.string().max(255).optional(),
  skills: z.array(z.string()).optional(),
  source: z.enum(['linkedin_search', 'linkedin_profile', 'cv_upload', 'manual', 'web_search']).optional(),
  status: z.enum(['discovered', 'enriched', 'scored', 'contacted', 'replied', 'qualified', 'interview_scheduled', 'rejected', 'archived']).optional(),
  masterAgentId: z.string().uuid().optional(),
});

const updateContactSchema = createContactSchema.partial();

const importContactsSchema = z.array(createContactSchema).min(1).max(1000);

export default async function contactRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/contacts — Paginated list with filters
  fastify.get<{
    Querystring: {
      cursor?: string;
      limit?: string;
      status?: string;
      source?: string;
      search?: string;
      minScore?: string;
      maxScore?: string;
      masterAgentId?: string;
    };
  }>('/', async (request) => {
    const limit = Math.min(parseInt(request.query.limit || '20', 10), 100);
    const { cursor, status, source, search, minScore, maxScore, masterAgentId } = request.query;

    const results = await withTenant(request.tenantId, async (tx) => {
      const conditions = [eq(contacts.tenantId, request.tenantId)];

      if (status) conditions.push(eq(contacts.status, status as any));
      if (source) conditions.push(eq(contacts.source, source as any));
      if (masterAgentId) conditions.push(eq(contacts.masterAgentId, masterAgentId));
      if (minScore) conditions.push(sql`${contacts.score} >= ${parseInt(minScore, 10)}`);
      if (maxScore) conditions.push(sql`${contacts.score} <= ${parseInt(maxScore, 10)}`);
      if (search) {
        conditions.push(sql`(
          ${contacts.firstName} ILIKE ${'%' + search + '%'} OR
          ${contacts.lastName} ILIKE ${'%' + search + '%'} OR
          ${contacts.email} ILIKE ${'%' + search + '%'} OR
          ${contacts.companyName} ILIKE ${'%' + search + '%'}
        )`);
      }
      if (cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
          conditions.push(lt(contacts.createdAt, new Date(decoded.createdAt)));
        } catch {
          throw new ValidationError('Invalid cursor format');
        }
      }

      return tx.select().from(contacts)
        .where(and(...conditions))
        .orderBy(desc(contacts.createdAt))
        .limit(limit + 1);
    });

    const hasMore = results.length > limit;
    const data = hasMore ? results.slice(0, limit) : results;
    const nextCursor = hasMore && data.length > 0
      ? Buffer.from(JSON.stringify({
          createdAt: data[data.length - 1]!.createdAt.toISOString(),
          id: data[data.length - 1]!.id,
        })).toString('base64')
      : null;

    return { data, pagination: { hasMore, nextCursor, count: data.length } };
  });

  // GET /api/contacts/:id
  fastify.get<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const [contact] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!contact) throw new NotFoundError('Contact', id);
    return { data: contact };
  });

  // POST /api/contacts
  fastify.post('/', async (request, reply) => {
    const parsed = createContactSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [contact] = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(contacts).values({
        tenantId: request.tenantId,
        ...parsed.data,
      }).returning();
    });

    return reply.status(201).send({ data: contact });
  });

  // PATCH /api/contacts/:id
  fastify.patch<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const parsed = updateContactSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [contact] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(contacts)
        .set({ ...parsed.data, updatedAt: new Date() })
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .returning();
    });
    if (!contact) throw new NotFoundError('Contact', id);
    return { data: contact };
  });

  // DELETE /api/contacts/:id
  fastify.delete<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const result = await withTenant(request.tenantId, async (tx) => {
      return tx.delete(contacts)
        .where(and(eq(contacts.id, id), eq(contacts.tenantId, request.tenantId)))
        .returning({ id: contacts.id });
    });
    if (result.length === 0) throw new NotFoundError('Contact', id);
    return { success: true };
  });

  // POST /api/contacts/import — Bulk import
  fastify.post('/import', async (request, reply) => {
    const parsed = importContactsSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const imported = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(contacts)
        .values(parsed.data.map((c) => ({ tenantId: request.tenantId, ...c })))
        .returning();
    });

    return reply.status(201).send({ data: imported, count: imported.length });
  });
}
