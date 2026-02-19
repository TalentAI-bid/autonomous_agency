import { eq, and } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { contacts, companies } from '../db/schema/index.js';
import { findEmail } from '../tools/email-finder.tool.js';
import { buildSystemPrompt, buildUserPrompt } from '../prompts/enrichment.prompt.js';
import logger from '../utils/logger.js';

export class EnrichmentAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { contactId, masterAgentId } = input as { contactId: string; masterAgentId: string };

    logger.info({ tenantId: this.tenantId, contactId }, 'EnrichmentAgent starting');

    // 1. Load contact
    const [contact] = await withTenant(this.tenantId, async (tx) => {
      return tx.select().from(contacts)
        .where(and(eq(contacts.id, contactId), eq(contacts.tenantId, this.tenantId)))
        .limit(1);
    });
    if (!contact) throw new Error(`Contact ${contactId} not found`);

    let companyId = contact.companyId;
    let companyEnriched = false;

    // 2. Enrich company if we have companyName but no companyId
    if (contact.companyName && !companyId) {
      try {
        // Search for company info
        const searchResults = await this.searchWeb(`${contact.companyName} company about`);
        const companyUrl = searchResults.find((r) => !r.url.includes('linkedin.com'))?.url;
        const websiteContent = companyUrl ? await this.scrapeUrl(companyUrl) : '';
        const searchSnippets = searchResults.map((r) => `${r.title}: ${r.snippet}`).join('\n');

        const enriched = await this.extractJSON<{
          name: string;
          domain: string;
          industry: string;
          size: string;
          techStack: string[];
          funding: string;
          description: string;
          linkedinUrl: string;
        }>([
          { role: 'system', content: buildSystemPrompt() },
          {
            role: 'user',
            content: buildUserPrompt({
              companyName: contact.companyName,
              websiteContent,
              searchResults: searchSnippets,
            }),
          },
        ]);

        // Save company
        const [company] = await withTenant(this.tenantId, async (tx) => {
          return tx.insert(companies).values({
            tenantId: this.tenantId,
            name: enriched.name || contact.companyName || 'Unknown',
            domain: enriched.domain || undefined,
            industry: enriched.industry || undefined,
            size: enriched.size || undefined,
            techStack: enriched.techStack?.length ? enriched.techStack : undefined,
            funding: enriched.funding || undefined,
            description: enriched.description || undefined,
            linkedinUrl: enriched.linkedinUrl || undefined,
          }).returning();
        });

        companyId = company!.id;
        companyEnriched = true;

        // Link contact to company
        await withTenant(this.tenantId, async (tx) => {
          await tx.update(contacts)
            .set({ companyId: company!.id, updatedAt: new Date() })
            .where(eq(contacts.id, contactId));
        });
      } catch (err) {
        logger.warn({ err, contactId, companyName: contact.companyName }, 'Company enrichment failed');
      }
    }

    // 3. Email discovery if no email
    let emailFound = contact.email;
    let emailVerified = contact.emailVerified ?? false;

    if (!emailFound && contact.firstName && contact.lastName && contact.companyName) {
      try {
        // Try to find company domain
        let domain = '';
        if (companyId) {
          const [company] = await withTenant(this.tenantId, async (tx) => {
            return tx.select().from(companies)
              .where(eq(companies.id, companyId!))
              .limit(1);
          });
          domain = company?.domain ?? '';
        }

        if (!domain) {
          // Search for domain
          const domainResults = await this.searchWeb(`${contact.companyName} official website`);
          const domainUrl = domainResults.find((r) =>
            !r.url.includes('linkedin.com') &&
            !r.url.includes('facebook.com') &&
            r.url.startsWith('https://'),
          )?.url;
          if (domainUrl) {
            try {
              domain = new URL(domainUrl).hostname.replace('www.', '');
            } catch { /* ignore */ }
          }
        }

        if (domain) {
          const result = await findEmail(
            this.tenantId,
            contact.firstName,
            contact.lastName,
            domain,
          );
          if (result) {
            emailFound = result.email;
            emailVerified = result.verified;
          }
        }
      } catch (err) {
        logger.warn({ err, contactId }, 'Email discovery failed');
      }
    }

    // 4. Update contact with enriched data
    await withTenant(this.tenantId, async (tx) => {
      await tx.update(contacts)
        .set({
          email: emailFound ?? undefined,
          emailVerified,
          companyId: companyId ?? undefined,
          status: 'enriched',
          updatedAt: new Date(),
        })
        .where(eq(contacts.id, contactId));
    });

    // 5. Dispatch scoring
    await this.dispatchNext('scoring', { contactId, masterAgentId });

    await this.emitEvent('contact:enriched', {
      contactId,
      email: emailFound,
      emailVerified,
      companyEnriched,
      companyId,
    });

    logger.info({ tenantId: this.tenantId, contactId, emailFound: !!emailFound, companyEnriched }, 'EnrichmentAgent completed');

    return {
      email: emailFound,
      emailVerified,
      companyEnriched,
      companyId,
    };
  }
}
