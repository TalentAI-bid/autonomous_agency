import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { eq, and, desc, gte, sql } from 'drizzle-orm';
import ExcelJS from 'exceljs';
import { withTenant } from '../config/database.js';
import {
  companies,
  contacts,
  masterAgents,
  emailsSent,
  campaignContacts,
  replies,
} from '../db/schema/index.js';
import { ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

interface ExportFilters {
  masterAgentId?: string;
  since?: Date;
  limit: number;
}

function parseFilters(
  q: { masterAgentId?: string; since?: string; limit?: string },
  defaults: { limit: number; maxLimit: number; defaultSinceDays?: number },
): ExportFilters {
  const limitRaw = q.limit ? parseInt(q.limit, 10) : defaults.limit;
  if (!Number.isFinite(limitRaw) || limitRaw <= 0) {
    throw new ValidationError(`limit must be a positive integer (≤ ${defaults.maxLimit})`);
  }
  const limit = Math.min(limitRaw, defaults.maxLimit);

  let since: Date | undefined;
  if (q.since) {
    const parsed = new Date(q.since);
    if (Number.isNaN(parsed.getTime())) {
      throw new ValidationError('since must be a valid ISO date string');
    }
    since = parsed;
  } else if (defaults.defaultSinceDays !== undefined) {
    since = new Date(Date.now() - defaults.defaultSinceDays * 24 * 3600 * 1000);
  }

  return { masterAgentId: q.masterAgentId, since, limit };
}

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function setXlsxHeaders(reply: FastifyReply, baseFilename: string): void {
  reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  reply.header(
    'Content-Disposition',
    `attachment; filename="talentai-${baseFilename}-${todayStamp()}.xlsx"`,
  );
}

/** Format a column-spec into ExcelJS columns + apply bold to header row. */
function applyHeaderStyle(sheet: ExcelJS.Worksheet): void {
  const header = sheet.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle' };
  // Freeze the header so the user can scroll the data while keeping column titles visible.
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
}

function safeJSON(value: unknown): string {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function fullName(c: { firstName?: string | null; lastName?: string | null; email?: string | null }): string {
  const fn = (c.firstName ?? '').trim();
  const ln = (c.lastName ?? '').trim();
  const joined = [fn, ln].filter(Boolean).join(' ');
  return joined || c.email || '';
}

// ─── Data fetchers (one per export type) ────────────────────────────────────

interface CompanyRow {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size: string | null;
  linkedinUrl: string | null;
  description: string | null;
  rawData: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
  agentName: string | null;
}

async function fetchCompanies(tenantId: string, filters: ExportFilters): Promise<CompanyRow[]> {
  return withTenant(tenantId, async (tx) => {
    const conds = [eq(companies.tenantId, tenantId)];
    if (filters.masterAgentId) conds.push(eq(companies.masterAgentId, filters.masterAgentId));
    if (filters.since) conds.push(gte(companies.createdAt, filters.since));
    return tx
      .select({
        id: companies.id,
        name: companies.name,
        domain: companies.domain,
        industry: companies.industry,
        size: companies.size,
        linkedinUrl: companies.linkedinUrl,
        description: companies.description,
        rawData: companies.rawData,
        createdAt: companies.createdAt,
        updatedAt: companies.updatedAt,
        agentName: masterAgents.name,
      })
      .from(companies)
      .leftJoin(masterAgents, eq(masterAgents.id, companies.masterAgentId))
      .where(and(...conds))
      .orderBy(desc(companies.createdAt))
      .limit(filters.limit);
  });
}

interface ContactRow {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  emailVerified: boolean | null;
  linkedinUrl: string | null;
  title: string | null;
  rawData: Record<string, unknown> | null;
  score: number | null;
  status: string;
  createdAt: Date;
  companyName: string | null;
  companyDomain: string | null;
  companyIndustry: string | null;
  companySize: string | null;
  companyRawData: Record<string, unknown> | null;
  agentName: string | null;
}

async function fetchContacts(tenantId: string, filters: ExportFilters): Promise<ContactRow[]> {
  return withTenant(tenantId, async (tx) => {
    const conds = [eq(contacts.tenantId, tenantId)];
    if (filters.masterAgentId) conds.push(eq(contacts.masterAgentId, filters.masterAgentId));
    if (filters.since) conds.push(gte(contacts.createdAt, filters.since));
    return tx
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName,
        email: contacts.email,
        emailVerified: contacts.emailVerified,
        linkedinUrl: contacts.linkedinUrl,
        title: contacts.title,
        rawData: contacts.rawData,
        score: contacts.score,
        status: contacts.status,
        createdAt: contacts.createdAt,
        companyName: companies.name,
        companyDomain: companies.domain,
        companyIndustry: companies.industry,
        companySize: companies.size,
        companyRawData: companies.rawData,
        agentName: masterAgents.name,
      })
      .from(contacts)
      .leftJoin(companies, eq(companies.id, contacts.companyId))
      .leftJoin(masterAgents, eq(masterAgents.id, contacts.masterAgentId))
      .where(and(...conds))
      .orderBy(desc(contacts.createdAt))
      .limit(filters.limit);
  });
}

interface EmailSentRow {
  id: string;
  sentAt: Date | null;
  subject: string | null;
  body: string | null;
  contactId: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactTitle: string | null;
  contactEmail: string | null;
  companyName: string | null;
  companyIndustry: string | null;
  companySize: string | null;
  agentName: string | null;
  // Reply info — pulled in a second pass keyed by contactId + sentAt
  replyBody: string | null;
  replyClassification: string | null;
  replyReceivedAt: Date | null;
}

/**
 * `emails_sent` has no direct tenantId — join via campaign_contacts → contacts.
 * Optionally filter by master agent (via the contact's masterAgentId).
 */
async function fetchEmailsSent(tenantId: string, filters: ExportFilters): Promise<EmailSentRow[]> {
  return withTenant(tenantId, async (tx) => {
    const conds = [eq(contacts.tenantId, tenantId)];
    if (filters.masterAgentId) conds.push(eq(contacts.masterAgentId, filters.masterAgentId));
    if (filters.since) conds.push(gte(emailsSent.sentAt, filters.since));

    const rows = await tx
      .select({
        id: emailsSent.id,
        sentAt: emailsSent.sentAt,
        subject: emailsSent.subject,
        body: emailsSent.body,
        contactId: contacts.id,
        contactFirstName: contacts.firstName,
        contactLastName: contacts.lastName,
        contactTitle: contacts.title,
        contactEmail: contacts.email,
        companyName: companies.name,
        companyIndustry: companies.industry,
        companySize: companies.size,
        agentName: masterAgents.name,
      })
      .from(emailsSent)
      .innerJoin(campaignContacts, eq(campaignContacts.id, emailsSent.campaignContactId))
      .innerJoin(contacts, eq(contacts.id, campaignContacts.contactId))
      .leftJoin(companies, eq(companies.id, contacts.companyId))
      .leftJoin(masterAgents, eq(masterAgents.id, contacts.masterAgentId))
      .where(and(...conds))
      .orderBy(desc(emailsSent.sentAt))
      .limit(filters.limit);

    if (rows.length === 0) return [];

    // Single follow-up query for the first reply per (contactId, sentAt).
    // The `replies` table has emailSentId set when the reply was matched
    // back to a specific outbound email — we prefer that match.
    const sentIds = rows.map((r) => r.id);
    const replyRows = await tx
      .select({
        emailSentId: replies.emailSentId,
        contactId: replies.contactId,
        body: replies.body,
        classification: replies.classification,
        createdAt: replies.createdAt,
      })
      .from(replies)
      .where(and(
        eq(replies.tenantId, tenantId),
        sql`${replies.emailSentId} IN (${sql.join(sentIds.map((id) => sql`${id}`), sql`, `)})`,
      ));

    // Index the first reply per emailSentId by createdAt asc.
    const replyByEmailSent = new Map<string, { body: string | null; classification: string | null; createdAt: Date }>();
    for (const r of replyRows) {
      if (!r.emailSentId) continue;
      const existing = replyByEmailSent.get(r.emailSentId);
      if (!existing || r.createdAt < existing.createdAt) {
        replyByEmailSent.set(r.emailSentId, { body: r.body, classification: r.classification, createdAt: r.createdAt });
      }
    }

    return rows.map<EmailSentRow>((r) => {
      const reply = replyByEmailSent.get(r.id);
      return {
        ...r,
        replyBody: reply?.body ?? null,
        replyClassification: reply?.classification ?? null,
        replyReceivedAt: reply?.createdAt ?? null,
      };
    });
  });
}

interface ReplyRow {
  id: string;
  createdAt: Date;
  fromEmail: string | null;
  subject: string | null;
  body: string | null;
  classification: string | null;
  contactId: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactEmail: string | null;
  companyName: string | null;
  emailSentSubject: string | null;
}

async function fetchReplies(tenantId: string, filters: ExportFilters): Promise<ReplyRow[]> {
  return withTenant(tenantId, async (tx) => {
    const conds = [eq(replies.tenantId, tenantId)];
    if (filters.masterAgentId) conds.push(eq(contacts.masterAgentId, filters.masterAgentId));
    if (filters.since) conds.push(gte(replies.createdAt, filters.since));
    return tx
      .select({
        id: replies.id,
        createdAt: replies.createdAt,
        fromEmail: replies.fromEmail,
        subject: replies.subject,
        body: replies.body,
        classification: replies.classification,
        contactId: contacts.id,
        contactFirstName: contacts.firstName,
        contactLastName: contacts.lastName,
        contactEmail: contacts.email,
        companyName: companies.name,
        emailSentSubject: emailsSent.subject,
      })
      .from(replies)
      .leftJoin(contacts, eq(contacts.id, replies.contactId))
      .leftJoin(companies, eq(companies.id, contacts.companyId))
      .leftJoin(emailsSent, eq(emailsSent.id, replies.emailSentId))
      .where(and(...conds))
      .orderBy(desc(replies.createdAt))
      .limit(filters.limit);
  });
}

// ─── Sheet builders (each populates one worksheet on a workbook) ────────────

function buildCompaniesSheet(workbook: ExcelJS.Workbook, rows: CompanyRow[]): void {
  const sheet = workbook.addWorksheet('Companies');
  sheet.columns = [
    { header: 'ID', key: 'id', width: 38 },
    { header: 'Name', key: 'name', width: 30 },
    { header: 'Domain', key: 'domain', width: 28 },
    { header: 'Industry', key: 'industry', width: 22 },
    { header: 'Size', key: 'size', width: 14 },
    { header: 'LinkedIn URL', key: 'linkedinUrl', width: 40 },
    { header: 'Description', key: 'description', width: 50 },
    { header: 'People Count', key: 'peopleCount', width: 12 },
    { header: 'Top Person Name', key: 'topPersonName', width: 30 },
    { header: 'Top Person Title', key: 'topPersonTitle', width: 30 },
    { header: 'Top Person LinkedIn', key: 'topPersonLinkedIn', width: 40 },
    { header: 'All People', key: 'allPeople', width: 60 },
    { header: 'Open Positions', key: 'openPositions', width: 60 },
    { header: 'Created At', key: 'createdAt', width: 20 },
    { header: 'Updated At', key: 'updatedAt', width: 20 },
    { header: 'Master Agent Name', key: 'agentName', width: 28 },
    { header: 'Raw Data Full', key: 'rawDataFull', width: 80 },
  ];

  for (const r of rows) {
    const raw = (r.rawData ?? {}) as Record<string, unknown>;
    const people = Array.isArray(raw.people) ? (raw.people as Array<Record<string, unknown>>) : [];
    const top = people[0];
    const desc = (raw.description as string | undefined) ?? r.description ?? '';
    sheet.addRow({
      id: r.id,
      name: r.name,
      domain: r.domain ?? '',
      industry: r.industry ?? '',
      size: r.size ?? '',
      linkedinUrl: r.linkedinUrl ?? '',
      description: desc,
      peopleCount: people.length,
      topPersonName: (top?.name as string | undefined) ?? '',
      topPersonTitle: (top?.title as string | undefined) ?? '',
      topPersonLinkedIn: (top?.linkedinUrl as string | undefined) ?? '',
      allPeople: safeJSON(people),
      openPositions: safeJSON(raw.openPositions ?? []),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      agentName: r.agentName ?? '',
      rawDataFull: safeJSON(raw),
    });
  }

  // Description, allPeople, openPositions, rawDataFull — wrap text.
  for (const colKey of ['description', 'allPeople', 'openPositions', 'rawDataFull']) {
    const col = sheet.getColumn(colKey);
    col.alignment = { wrapText: true, vertical: 'top' };
  }
  applyHeaderStyle(sheet);
}

function buildContactsSheet(workbook: ExcelJS.Workbook, rows: ContactRow[]): void {
  const sheet = workbook.addWorksheet('Contacts');
  sheet.columns = [
    { header: 'ID', key: 'id', width: 38 },
    { header: 'First Name', key: 'firstName', width: 18 },
    { header: 'Last Name', key: 'lastName', width: 18 },
    { header: 'Email', key: 'email', width: 32 },
    { header: 'Email Verified', key: 'emailVerified', width: 14 },
    { header: 'LinkedIn URL', key: 'linkedinUrl', width: 40 },
    { header: 'Title', key: 'title', width: 30 },
    { header: 'LinkedIn Headline', key: 'headline', width: 40 },
    { header: 'Score', key: 'score', width: 8 },
    { header: 'Status', key: 'status', width: 16 },
    { header: 'Company Name', key: 'companyName', width: 30 },
    { header: 'Company Domain', key: 'companyDomain', width: 28 },
    { header: 'Company Industry', key: 'companyIndustry', width: 22 },
    { header: 'Company Size', key: 'companySize', width: 14 },
    { header: 'All People At Company', key: 'allPeopleAtCompany', width: 60 },
    { header: 'Master Agent Name', key: 'agentName', width: 28 },
    { header: 'Created At', key: 'createdAt', width: 20 },
  ];

  for (const r of rows) {
    const raw = (r.rawData ?? {}) as Record<string, unknown>;
    const headline = (raw.headline as string | undefined) ?? '';
    const companyRaw = (r.companyRawData ?? {}) as Record<string, unknown>;
    const peopleAtCompany = Array.isArray(companyRaw.people) ? companyRaw.people : [];
    sheet.addRow({
      id: r.id,
      firstName: r.firstName ?? '',
      lastName: r.lastName ?? '',
      email: r.email ?? '',
      emailVerified: r.emailVerified ? 'TRUE' : 'FALSE',
      linkedinUrl: r.linkedinUrl ?? '',
      title: r.title ?? (raw.title as string | undefined) ?? '',
      headline,
      score: r.score ?? '',
      status: r.status,
      companyName: r.companyName ?? '',
      companyDomain: r.companyDomain ?? '',
      companyIndustry: r.companyIndustry ?? '',
      companySize: r.companySize ?? '',
      allPeopleAtCompany: safeJSON(peopleAtCompany),
      agentName: r.agentName ?? '',
      createdAt: r.createdAt,
    });
  }

  for (const colKey of ['headline', 'allPeopleAtCompany']) {
    sheet.getColumn(colKey).alignment = { wrapText: true, vertical: 'top' };
  }
  applyHeaderStyle(sheet);
}

function buildEmailsSentSheet(workbook: ExcelJS.Workbook, rows: EmailSentRow[]): void {
  const sheet = workbook.addWorksheet('Emails Sent');
  sheet.columns = [
    { header: 'ID', key: 'id', width: 38 },
    { header: 'Sent At', key: 'sentAt', width: 20 },
    { header: 'Subject', key: 'subject', width: 40 },
    { header: 'Body', key: 'body', width: 80 },
    { header: 'Contact Name', key: 'contactName', width: 28 },
    { header: 'Contact Title', key: 'contactTitle', width: 30 },
    { header: 'Contact Email', key: 'contactEmail', width: 32 },
    { header: 'Company Name', key: 'companyName', width: 30 },
    { header: 'Company Industry', key: 'companyIndustry', width: 22 },
    { header: 'Company Size', key: 'companySize', width: 14 },
    { header: 'Got Reply', key: 'gotReply', width: 10 },
    { header: 'First Reply Body', key: 'replyBody', width: 80 },
    { header: 'First Reply Classification', key: 'replyClassification', width: 22 },
    { header: 'First Reply Received At', key: 'replyReceivedAt', width: 20 },
    { header: 'Days To Reply', key: 'daysToReply', width: 14 },
    { header: 'Master Agent Name', key: 'agentName', width: 28 },
  ];

  for (const r of rows) {
    const got = r.replyReceivedAt && r.sentAt;
    const days = got
      ? Math.round(((r.replyReceivedAt!.getTime() - r.sentAt!.getTime()) / (1000 * 60 * 60 * 24)) * 10) / 10
      : null;
    sheet.addRow({
      id: r.id,
      sentAt: r.sentAt,
      subject: r.subject ?? '',
      body: r.body ?? '',
      contactName: fullName({ firstName: r.contactFirstName, lastName: r.contactLastName, email: r.contactEmail }),
      contactTitle: r.contactTitle ?? '',
      contactEmail: r.contactEmail ?? '',
      companyName: r.companyName ?? '',
      companyIndustry: r.companyIndustry ?? '',
      companySize: r.companySize ?? '',
      gotReply: got ? 'TRUE' : 'FALSE',
      replyBody: r.replyBody ?? '',
      replyClassification: r.replyClassification ?? '',
      replyReceivedAt: r.replyReceivedAt,
      daysToReply: days ?? '',
      agentName: r.agentName ?? '',
    });
  }

  // Multi-line body cells.
  for (const colKey of ['body', 'replyBody']) {
    sheet.getColumn(colKey).alignment = { wrapText: true, vertical: 'top' };
  }
  // A taller default row height makes the wrapped body legible on first open.
  sheet.eachRow((row, rowNum) => {
    if (rowNum > 1) row.height = 60;
  });
  applyHeaderStyle(sheet);
}

function buildRepliesSheet(workbook: ExcelJS.Workbook, rows: ReplyRow[]): void {
  const sheet = workbook.addWorksheet('Replies');
  sheet.columns = [
    { header: 'Reply ID', key: 'id', width: 38 },
    { header: 'Received At', key: 'createdAt', width: 20 },
    { header: 'From Email', key: 'fromEmail', width: 32 },
    { header: 'Subject', key: 'subject', width: 40 },
    { header: 'Body', key: 'body', width: 80 },
    { header: 'Classification', key: 'classification', width: 18 },
    { header: 'Contact Name', key: 'contactName', width: 28 },
    { header: 'Company Name', key: 'companyName', width: 30 },
    { header: 'Sent Email Subject', key: 'emailSentSubject', width: 40 },
  ];

  for (const r of rows) {
    sheet.addRow({
      id: r.id,
      createdAt: r.createdAt,
      fromEmail: r.fromEmail ?? '',
      subject: r.subject ?? '',
      body: r.body ?? '',
      classification: r.classification ?? '',
      contactName: fullName({ firstName: r.contactFirstName, lastName: r.contactLastName, email: r.contactEmail }),
      companyName: r.companyName ?? '',
      emailSentSubject: r.emailSentSubject ?? '',
    });
  }

  sheet.getColumn('body').alignment = { wrapText: true, vertical: 'top' };
  sheet.eachRow((row, rowNum) => {
    if (rowNum > 1) row.height = 50;
  });
  applyHeaderStyle(sheet);
}

// ─── Streaming helper ───────────────────────────────────────────────────────

async function streamWorkbook(reply: FastifyReply, workbook: ExcelJS.Workbook): Promise<void> {
  // Stream the workbook to the raw response so we don't buffer the full
  // file in memory for large exports.
  await workbook.xlsx.write(reply.raw);
  reply.raw.end();
}

// ─── Routes ─────────────────────────────────────────────────────────────────

export default async function exportRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // GET /api/export/companies
  fastify.get<{ Querystring: { masterAgentId?: string; since?: string; limit?: string } }>(
    '/companies',
    async (request: FastifyRequest<{ Querystring: { masterAgentId?: string; since?: string; limit?: string } }>, reply) => {
      const filters = parseFilters(request.query, { limit: 500, maxLimit: 5000 });
      const rows = await fetchCompanies(request.tenantId, filters);
      logger.info({ tenantId: request.tenantId, rowCount: rows.length, filters }, 'export: companies');

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'TalentAI';
      workbook.created = new Date();
      buildCompaniesSheet(workbook, rows);
      setXlsxHeaders(reply, 'companies');
      await streamWorkbook(reply, workbook);
    },
  );

  // GET /api/export/contacts
  fastify.get<{ Querystring: { masterAgentId?: string; since?: string; limit?: string } }>(
    '/contacts',
    async (request, reply) => {
      const filters = parseFilters(request.query, { limit: 500, maxLimit: 5000 });
      const rows = await fetchContacts(request.tenantId, filters);
      logger.info({ tenantId: request.tenantId, rowCount: rows.length, filters }, 'export: contacts');

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'TalentAI';
      workbook.created = new Date();
      buildContactsSheet(workbook, rows);
      setXlsxHeaders(reply, 'contacts');
      await streamWorkbook(reply, workbook);
    },
  );

  // GET /api/export/emails-sent
  fastify.get<{ Querystring: { masterAgentId?: string; since?: string; limit?: string } }>(
    '/emails-sent',
    async (request, reply) => {
      const filters = parseFilters(request.query, { limit: 200, maxLimit: 5000, defaultSinceDays: 60 });
      const rows = await fetchEmailsSent(request.tenantId, filters);
      logger.info({ tenantId: request.tenantId, rowCount: rows.length, filters }, 'export: emails-sent');

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'TalentAI';
      workbook.created = new Date();
      buildEmailsSentSheet(workbook, rows);
      setXlsxHeaders(reply, 'emails-sent');
      await streamWorkbook(reply, workbook);
    },
  );

  // GET /api/export/full-batch — companies + contacts + emails sent + replies
  // for a single master agent over a window. The all-in-one export for
  // analyzing one agent's performance.
  fastify.get<{ Querystring: { masterAgentId?: string; since?: string; limit?: string } }>(
    '/full-batch',
    async (request, reply) => {
      const masterAgentId = request.query.masterAgentId;
      if (!masterAgentId) throw new ValidationError('masterAgentId is required for full-batch export');
      const filters = parseFilters(request.query, { limit: 5000, maxLimit: 5000, defaultSinceDays: 30 });

      const [companiesRows, contactsRows, emailsSentRows, repliesRows] = await Promise.all([
        fetchCompanies(request.tenantId, filters),
        fetchContacts(request.tenantId, filters),
        fetchEmailsSent(request.tenantId, filters),
        fetchReplies(request.tenantId, filters),
      ]);

      logger.info(
        {
          tenantId: request.tenantId,
          masterAgentId,
          since: filters.since,
          counts: {
            companies: companiesRows.length,
            contacts: contactsRows.length,
            emailsSent: emailsSentRows.length,
            replies: repliesRows.length,
          },
        },
        'export: full-batch',
      );

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'TalentAI';
      workbook.created = new Date();
      buildCompaniesSheet(workbook, companiesRows);
      buildContactsSheet(workbook, contactsRows);
      buildEmailsSentSheet(workbook, emailsSentRows);
      buildRepliesSheet(workbook, repliesRows);
      setXlsxHeaders(reply, `full-batch-${masterAgentId.slice(0, 8)}`);
      await streamWorkbook(reply, workbook);
    },
  );
}
