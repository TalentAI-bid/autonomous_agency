import { BaseAgent } from './base-agent.js';
import logger from '../utils/logger.js';

export class DiscoveryAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { searchQueries, maxResults = 10, masterAgentId } = input as {
      searchQueries: string[];
      maxResults?: number;
      masterAgentId: string;
    };

    logger.info({ tenantId: this.tenantId, masterAgentId, queryCount: searchQueries.length }, 'DiscoveryAgent starting');

    let discovered = 0;
    let linkedinProfiles = 0;
    let otherUrls = 0;
    let skipped = 0;

    for (const query of searchQueries) {
      const results = await this.searchWeb(query, maxResults as number);

      for (const result of results) {
        if (!result.url) { skipped++; continue; }

        const isLinkedIn = result.url.includes('linkedin.com/in/');

        if (isLinkedIn) {
          // Save as discovered contact with LinkedIn source, then dispatch document job
          const contact = await this.saveOrUpdateContact({
            linkedinUrl: result.url,
            source: 'linkedin_search',
            status: 'discovered',
            rawData: { title: result.title, snippet: result.snippet, query },
          });

          await this.dispatchNext('document', {
            url: result.url,
            type: 'linkedin_profile',
            contactId: contact.id,
            masterAgentId,
          });

          linkedinProfiles++;
          discovered++;

          await this.emitEvent('contact:discovered', {
            contactId: contact.id,
            source: 'linkedin_search',
            url: result.url,
          });
        } else {
          // Non-LinkedIn result: save as web_search contact
          const contact = await this.saveOrUpdateContact({
            source: 'web_search',
            status: 'discovered',
            rawData: { url: result.url, title: result.title, snippet: result.snippet, query },
          });

          // Dispatch enrichment to find more info
          await this.dispatchNext('enrichment', {
            contactId: contact.id,
            masterAgentId,
          });

          otherUrls++;
          discovered++;

          await this.emitEvent('contact:discovered', {
            contactId: contact.id,
            source: 'web_search',
            url: result.url,
          });
        }
      }
    }

    logger.info({ tenantId: this.tenantId, discovered, linkedinProfiles, otherUrls, skipped }, 'DiscoveryAgent completed');

    return { discovered, linkedinProfiles, otherUrls, skipped };
  }
}
