import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc, lt } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { documents } from '../db/schema/index.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const createDocumentSchema = z.object({
  type: z.enum(['job_spec', 'cv', 'whitepaper', 'spec', 'linkedin_profile', 'other']),
  fileName: z.string().max(255).optional(),
  filePath: z.string().max(500).optional(),
  mimeType: z.string().max(100).optional(),
  rawText: z.string().optional(),
  masterAgentId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
});

export default async function documentRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/documents
  fastify.get<{
    Querystring: { cursor?: string; limit?: string; type?: string; masterAgentId?: string };
  }>('/', async (request) => {
    const limit = Math.min(parseInt(request.query.limit || '20', 10), 100);
    const { cursor, type, masterAgentId } = request.query;

    const results = await withTenant(request.tenantId, async (tx) => {
      const conditions = [eq(documents.tenantId, request.tenantId)];
      if (type) conditions.push(eq(documents.type, type as any));
      if (masterAgentId) conditions.push(eq(documents.masterAgentId, masterAgentId));
      if (cursor) {
        try {
          const decoded = JSON.parse(Buffer.from(cursor, 'base64').toString());
          conditions.push(lt(documents.createdAt, new Date(decoded.createdAt)));
        } catch {
          throw new ValidationError('Invalid cursor');
        }
      }
      return tx.select().from(documents)
        .where(and(...conditions))
        .orderBy(desc(documents.createdAt))
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

    return { data, pagination: { hasMore, nextCursor } };
  });

  // POST /api/documents — Upload document (multipart or JSON)
  fastify.post('/', async (request, reply) => {
    // Check if multipart
    const contentType = request.headers['content-type'] || '';

    if (contentType.includes('multipart/form-data')) {
      // Handle multipart upload
      const data = await (request as any).file();
      if (!data) throw new ValidationError('No file uploaded');

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) {
        chunks.push(chunk);
      }
      const fileBuffer = Buffer.concat(chunks);
      const rawText = fileBuffer.toString('utf-8');

      const docType = (data.fields.type as any)?.value || 'other';
      const masterAgentId = (data.fields.masterAgentId as any)?.value;
      const contactId = (data.fields.contactId as any)?.value;

      const [doc] = await withTenant(request.tenantId, async (tx) => {
        return tx.insert(documents).values({
          tenantId: request.tenantId,
          type: docType,
          fileName: data.filename,
          mimeType: data.mimetype,
          rawText,
          masterAgentId: masterAgentId || null,
          contactId: contactId || null,
          status: 'uploaded',
        }).returning();
      });

      return reply.status(201).send({ data: doc });
    }

    // Handle JSON upload
    const parsed = createDocumentSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const [doc] = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(documents).values({
        tenantId: request.tenantId,
        ...parsed.data,
        status: 'uploaded',
      }).returning();
    });

    return reply.status(201).send({ data: doc });
  });

  // GET /api/documents/:id
  fastify.get<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const [doc] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(documents)
        .where(and(eq(documents.id, id), eq(documents.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!doc) throw new NotFoundError('Document', id);
    return { data: doc };
  });

  // DELETE /api/documents/:id
  fastify.delete<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const result = await withTenant(request.tenantId, async (tx) => {
      return tx.delete(documents)
        .where(and(eq(documents.id, id), eq(documents.tenantId, request.tenantId)))
        .returning({ id: documents.id });
    });
    if (result.length === 0) throw new NotFoundError('Document', id);
    return { success: true };
  });
}
