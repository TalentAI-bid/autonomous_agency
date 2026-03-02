import { eq, and } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { documents, masterAgents } from '../db/schema/index.js';
import { parsePDF } from '../tools/pdf-parser.tool.js';
import { parseDOCX } from '../tools/docx-parser.tool.js';
import {
  buildCVSystemPrompt,
  buildJobSpecSystemPrompt,
  buildUserPrompt as buildDocUserPrompt,
  type CVExtracted,
  type JobSpecExtracted,
} from '../prompts/document.prompt.js';
import logger from '../utils/logger.js';

export class DocumentAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const {
      documentId,
      url,
      type,
      contactId: inputContactId,
      masterAgentId,
      buffer: bufferBase64,
      mimeType,
      dryRun,
    } = input as {
      documentId?: string;
      url?: string;
      type: 'cv' | 'linkedin_profile' | 'job_spec' | 'spec';
      contactId?: string;
      masterAgentId: string;
      buffer?: string;
      mimeType?: string;
      dryRun?: boolean;
    };

    logger.info({ tenantId: this.tenantId, documentId, type, url }, 'DocumentAgent starting');

    // 1. Get raw text
    let rawText = '';

    if (documentId) {
      const [doc] = await withTenant(this.tenantId, async (tx) => {
        return tx.select().from(documents)
          .where(and(eq(documents.id, documentId), eq(documents.tenantId, this.tenantId)))
          .limit(1);
      });
      if (doc?.rawText) {
        rawText = doc.rawText;
      } else if (doc?.filePath) {
        // File already stored; load & parse
        const fs = await import('fs/promises');
        const buffer = await fs.readFile(doc.filePath);
        if (doc.mimeType?.includes('pdf') || doc.fileName?.endsWith('.pdf')) {
          rawText = (await parsePDF(buffer)).text;
        } else if (doc.mimeType?.includes('word') || doc.fileName?.endsWith('.docx')) {
          rawText = (await parseDOCX(buffer)).text;
        }
      }
    } else if (url) {
      rawText = await this.scrapeUrl(url);
    } else if (bufferBase64) {
      const buffer = Buffer.from(bufferBase64, 'base64');
      if (mimeType?.includes('pdf')) {
        rawText = (await parsePDF(buffer)).text;
      } else if (mimeType?.includes('word')) {
        rawText = (await parseDOCX(buffer)).text;
      }
    }

    if (typeof rawText !== 'string') {
      rawText = String(rawText || '');
    }

    if (!rawText) {
      logger.warn({ tenantId: this.tenantId, documentId, url, type }, 'DocumentAgent: no raw text extracted, continuing pipeline');
      // Still dispatch enrichment so the pipeline continues even when scraping fails (e.g. LinkedIn blocks)
      if (inputContactId) {
        await this.dispatchNext('enrichment', { contactId: inputContactId, masterAgentId, dryRun });
      }
      return { extracted: null, contactId: inputContactId, documentStatus: 'skipped' };
    }

    // 2. Extract structured data using Together AI
    const isCV = type === 'cv' || type === 'linkedin_profile';
    const systemPrompt = isCV ? buildCVSystemPrompt() : buildJobSpecSystemPrompt();
    const userPrompt = buildDocUserPrompt({ type, rawText });

    const extracted = await this.extractJSON<CVExtracted | JobSpecExtracted>([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ]);

    // 3. Update document record if we have documentId
    if (documentId) {
      await withTenant(this.tenantId, async (tx) => {
        await tx.update(documents)
          .set({ extractedData: extracted as unknown as Record<string, unknown>, rawText, status: 'processed' })
          .where(eq(documents.id, documentId));
      });
    }

    // 4. Handle CV / LinkedIn profile
    let contactId = inputContactId;
    if (isCV) {
      const cvData = extracted as CVExtracted;
      const contact = await this.saveOrUpdateContact({
        id: inputContactId,
        firstName: cvData.firstName || cvData.name?.split(' ')[0],
        lastName: cvData.lastName || cvData.name?.split(' ').slice(1).join(' '),
        title: cvData.title,
        companyName: cvData.company,
        location: cvData.location,
        email: cvData.email || undefined,
        linkedinUrl: cvData.linkedinUrl || undefined,
        skills: cvData.skills,
        experience: cvData.experience as Record<string, unknown>[],
        education: cvData.education as Record<string, unknown>[],
        source: type === 'linkedin_profile' ? 'linkedin_profile' : 'cv_upload',
        status: 'discovered',
      });
      contactId = contact.id;

      // Link document to contact
      if (documentId) {
        await withTenant(this.tenantId, async (tx) => {
          await tx.update(documents).set({ contactId: contact.id }).where(eq(documents.id, documentId));
        });
      }

      await this.emitEvent('contact:discovered', { contactId: contact.id, type, source: url ?? documentId });

      // Dispatch enrichment for new contact
      await this.dispatchNext('enrichment', { contactId: contact.id, masterAgentId, dryRun });
    }

    // 5. Handle job spec / spec
    if (type === 'job_spec' || type === 'spec') {
      const specData = extracted as JobSpecExtracted;
      await withTenant(this.tenantId, async (tx) => {
        const [agent] = await tx.select().from(masterAgents)
          .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
          .limit(1);
        if (agent) {
          await tx.update(masterAgents)
            .set({
              config: { ...((agent.config as Record<string, unknown>) ?? {}), jobSpec: specData },
              updatedAt: new Date(),
            })
            .where(eq(masterAgents.id, masterAgentId));
        }
      });
    }

    return { extracted, contactId, documentStatus: 'processed' };
  }
}
