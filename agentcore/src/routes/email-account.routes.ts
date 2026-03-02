import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, desc } from 'drizzle-orm';
import { withTenant } from '../config/database.js';
import { emailAccounts } from '../db/schema/index.js';
import { encrypt } from '../utils/crypto.js';
import { checkQuota } from '../tools/email-queue.tool.js';
import { sendEmail } from '../tools/smtp.tool.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

const createSchema = z.object({
  name: z.string().min(1).max(255),
  provider: z.enum(['smtp', 'ses', 'sendgrid', 'custom']).default('smtp'),
  smtpHost: z.string().optional(),
  smtpPort: z.number().default(587),
  smtpUser: z.string().optional(),
  smtpPass: z.string().optional(),
  fromEmail: z.string().email(),
  fromName: z.string().optional(),
  replyTo: z.string().email().optional(),
  dailyQuota: z.number().min(1).default(500),
  hourlyQuota: z.number().min(1).default(50),
  isWarmup: z.boolean().default(false),
  priority: z.number().default(0),
  config: z.record(z.unknown()).optional(),
});

const updateSchema = createSchema.partial();

export default async function emailAccountRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/email-accounts
  fastify.get('/', async (request) => {
    const results = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(emailAccounts)
        .where(eq(emailAccounts.tenantId, request.tenantId))
        .orderBy(desc(emailAccounts.createdAt));
    });
    // Strip encrypted passwords from response
    const data = results.map(({ smtpPass, ...rest }) => ({ ...rest, hasPassword: !!smtpPass }));
    return { data };
  });

  // POST /api/email-accounts
  fastify.post('/', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const { smtpPass, ...rest } = parsed.data;
    const [account] = await withTenant(request.tenantId, async (tx) => {
      return tx.insert(emailAccounts).values({
        tenantId: request.tenantId,
        ...rest,
        smtpPass: smtpPass ? encrypt(smtpPass) : undefined,
        warmupStartDate: parsed.data.isWarmup ? new Date() : undefined,
      }).returning();
    });

    return reply.status(201).send({ data: account });
  });

  // GET /api/email-accounts/:id
  fastify.get<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const [account] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(emailAccounts)
        .where(and(eq(emailAccounts.id, id), eq(emailAccounts.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!account) throw new NotFoundError('EmailAccount', id);
    const { smtpPass, ...rest } = account;
    return { data: { ...rest, hasPassword: !!smtpPass } };
  });

  // PATCH /api/email-accounts/:id
  fastify.patch<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const parsed = updateSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError('Invalid input', parsed.error.flatten());

    const { smtpPass, ...rest } = parsed.data;
    const updateData: Record<string, unknown> = { ...rest, updatedAt: new Date() };
    if (smtpPass !== undefined) {
      updateData.smtpPass = smtpPass ? encrypt(smtpPass) : null;
    }

    const [account] = await withTenant(request.tenantId, async (tx) => {
      return tx.update(emailAccounts)
        .set(updateData)
        .where(and(eq(emailAccounts.id, id), eq(emailAccounts.tenantId, request.tenantId)))
        .returning();
    });
    if (!account) throw new NotFoundError('EmailAccount', id);
    return { data: account };
  });

  // DELETE /api/email-accounts/:id
  fastify.delete<{ Params: { id: string } }>('/:id', async (request) => {
    const { id } = request.params;
    const result = await withTenant(request.tenantId, async (tx) => {
      return tx.delete(emailAccounts)
        .where(and(eq(emailAccounts.id, id), eq(emailAccounts.tenantId, request.tenantId)))
        .returning({ id: emailAccounts.id });
    });
    if (result.length === 0) throw new NotFoundError('EmailAccount', id);
    return { success: true };
  });

  // POST /api/email-accounts/:id/test-send
  fastify.post<{ Params: { id: string } }>('/:id/test-send', async (request) => {
    const { id } = request.params;
    const body = request.body as { to: string };
    if (!body.to) throw new ValidationError('Missing "to" email address');

    const [account] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(emailAccounts)
        .where(and(eq(emailAccounts.id, id), eq(emailAccounts.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!account) throw new NotFoundError('EmailAccount', id);

    const result = await sendEmail({
      tenantId: request.tenantId,
      from: account.fromEmail,
      to: body.to,
      subject: 'AgentCore Test Email',
      html: '<p>This is a test email from AgentCore to verify your email account configuration.</p>',
      emailAccount: account,
    });

    return { data: { messageId: result.messageId } };
  });

  // GET /api/email-accounts/:id/quota-status
  fastify.get<{ Params: { id: string } }>('/:id/quota-status', async (request) => {
    const { id } = request.params;
    const [account] = await withTenant(request.tenantId, async (tx) => {
      return tx.select().from(emailAccounts)
        .where(and(eq(emailAccounts.id, id), eq(emailAccounts.tenantId, request.tenantId)))
        .limit(1);
    });
    if (!account) throw new NotFoundError('EmailAccount', id);

    const quota = await checkQuota(request.tenantId, id, account);
    return { data: quota };
  });
}
