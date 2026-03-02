import { eq, and } from 'drizzle-orm';
import { BaseAgent } from './base-agent.js';
import { withTenant } from '../config/database.js';
import { masterAgents } from '../db/schema/index.js';
import {
  buildSystemPrompt as classificationSystemPrompt,
  buildUserPrompt as classificationUserPrompt,
  type ClassifiedResult,
} from '../prompts/classification.prompt.js';
import logger from '../utils/logger.js';

export class DiscoveryAgent extends BaseAgent {
  async execute(input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { searchQueries, maxResults = 10, masterAgentId, dryRun } = input as {
      searchQueries: string[];
      maxResults?: number;
      masterAgentId: string;
      dryRun?: boolean;
    };

    logger.info({ tenantId: this.tenantId, masterAgentId, queryCount: searchQueries.length }, 'DiscoveryAgent starting');

    // Load useCase from master agent
    let useCase: string | undefined;
    try {
      const [agent] = await withTenant(this.tenantId, async (tx) => {
        return tx.select({ useCase: masterAgents.useCase }).from(masterAgents)
          .where(and(eq(masterAgents.id, masterAgentId), eq(masterAgents.tenantId, this.tenantId)))
          .limit(1);
      });
      useCase = agent?.useCase;
    } catch (err) {
      logger.warn({ err, masterAgentId }, 'Failed to load useCase from master agent');
    }

    let candidatesFound = 0;
    let companiesFound = 0;
    let jobListingsProcessed = 0;
    let decisionMakersFound = 0;
    let teamPagesProcessed = 0;
    let irrelevantFiltered = 0;
    let skipped = 0;

    for (const query of searchQueries) {
      const results = await this.searchWeb(query, maxResults as number);

      if (results.length === 0) continue;

      // Batch-classify all results from this query via LLM
      const indexed = results.map((r, i) => ({
        index: i,
        url: r.url,
        title: r.title ?? '',
        snippet: r.snippet ?? '',
      }));

      let classified: ClassifiedResult[];
      try {
        classified = await this.extractJSON<ClassifiedResult[]>([
          { role: 'system', content: classificationSystemPrompt(useCase) },
          { role: 'user', content: classificationUserPrompt(indexed, useCase) },
        ]);
      } catch (err) {
        logger.warn({ err, query }, 'Classification failed, skipping query batch');
        skipped += results.length;
        continue;
      }

      for (const item of classified) {
        const result = results[item.index];
        if (!result?.url) { skipped++; continue; }

        if (item.classification === 'candidate_profile' || item.classification === 'decision_maker') {
          await this.handleCandidate(result, item, query, masterAgentId, dryRun);
          if (item.classification === 'decision_maker') {
            decisionMakersFound++;
          } else {
            candidatesFound++;
          }
        } else if (item.classification === 'company_page') {
          await this.handleCompany(result, item, query);
          companiesFound++;
        } else if (item.classification === 'team_page') {
          await this.handleTeamPage(result, item, query, masterAgentId, dryRun);
          teamPagesProcessed++;
        } else if (item.classification === 'job_listing') {
          await this.handleJobListing(result, item, query);
          jobListingsProcessed++;
        } else {
          irrelevantFiltered++;
        }
      }
    }

    logger.info(
      { tenantId: this.tenantId, candidatesFound, decisionMakersFound, companiesFound, teamPagesProcessed, jobListingsProcessed, irrelevantFiltered, skipped },
      'DiscoveryAgent completed',
    );

    return { candidatesFound, decisionMakersFound, companiesFound, teamPagesProcessed, jobListingsProcessed, irrelevantFiltered, skipped };
  }

  private async handleCandidate(
    result: { url: string; title: string; snippet: string },
    item: ClassifiedResult,
    query: string,
    masterAgentId: string,
    dryRun?: boolean,
  ): Promise<void> {
    const isLinkedIn = result.url.includes('linkedin.com/in/');

    // Parse name from LLM extraction
    const nameParts = (item.extractedName ?? '').split(/\s+/);
    const firstName = nameParts[0] || undefined;
    const lastName = nameParts.slice(1).join(' ') || undefined;

    const contact = await this.saveOrUpdateContact({
      linkedinUrl: isLinkedIn ? result.url : undefined,
      firstName,
      lastName,
      title: item.extractedTitle || undefined,
      companyName: item.extractedCompany || undefined,
      source: isLinkedIn ? 'linkedin_search' : 'web_search',
      status: 'discovered',
      rawData: {
        url: result.url,
        title: result.title,
        snippet: result.snippet,
        query,
        classificationConfidence: item.confidence,
        classificationReasoning: item.reasoning,
        classification: item.classification,
      },
    });

    if (isLinkedIn) {
      // LinkedIn profiles go through document agent for full scrape first
      await this.dispatchNext('document', {
        url: result.url,
        type: 'linkedin_profile',
        contactId: contact.id,
        masterAgentId,
        dryRun,
      });
    } else {
      // Non-LinkedIn candidates go straight to enrichment
      await this.dispatchNext('enrichment', {
        contactId: contact.id,
        masterAgentId,
        dryRun,
      });
    }

    await this.emitEvent('contact:discovered', {
      contactId: contact.id,
      source: isLinkedIn ? 'linkedin_search' : 'web_search',
      url: result.url,
      classification: item.classification,
    });
  }

  private async handleTeamPage(
    result: { url: string; title: string; snippet: string },
    item: ClassifiedResult,
    query: string,
    masterAgentId: string,
    dryRun?: boolean,
  ): Promise<void> {
    const companyName = item.extractedCompany || result.title.split(/[|–—-]/)[0]?.trim() || 'Unknown';

    // Save the company
    let domain: string | undefined;
    try {
      domain = new URL(result.url).hostname.replace('www.', '');
    } catch { /* ignore */ }

    await this.saveOrUpdateCompany({
      name: companyName,
      domain,
      rawData: {
        teamPageUrl: result.url,
        discoveryQuery: query,
      },
    });

    // Scrape the team page to extract people
    let pageContent = '';
    try {
      pageContent = await this.scrapeUrl(result.url);
    } catch (err) {
      logger.warn({ err, url: result.url }, 'Failed to scrape team page');
      return;
    }

    if (!pageContent || pageContent.length < 100) return;

    // Use LLM to extract people from the team page
    interface TeamMember { name: string; title: string; }
    let members: TeamMember[] = [];
    try {
      const extraction = await this.extractJSON<{ members: TeamMember[] }>([
        {
          role: 'system',
          content: `You are an expert at extracting team member information from company pages. Extract all people listed on the page with their name and title. Focus on leadership and decision-maker roles (C-suite, VP, Director, Head of, Manager). Return valid JSON.`,
        },
        {
          role: 'user',
          content: `Extract team members from this page content. Return JSON: { "members": [{ "name": "Full Name", "title": "Job Title" }] }\n\nPAGE CONTENT:\n${pageContent.slice(0, 5000)}`,
        },
      ]);
      members = extraction.members ?? [];
    } catch (err) {
      logger.warn({ err, url: result.url }, 'Failed to extract team members from page');
      return;
    }

    // Create contacts for each extracted member and dispatch enrichment
    for (const member of members.slice(0, 10)) {
      if (!member.name) continue;

      const nameParts = member.name.trim().split(/\s+/);
      const firstName = nameParts[0] || undefined;
      const lastName = nameParts.slice(1).join(' ') || undefined;

      const contact = await this.saveOrUpdateContact({
        firstName,
        lastName,
        title: member.title || undefined,
        companyName,
        source: 'web_search',
        status: 'discovered',
        rawData: {
          url: result.url,
          teamPageSource: true,
          query,
          classificationConfidence: item.confidence,
        },
      });

      await this.dispatchNext('enrichment', {
        contactId: contact.id,
        masterAgentId,
        dryRun,
      });
    }

    await this.emitEvent('team_page:processed', {
      companyName,
      url: result.url,
      membersExtracted: members.length,
    });

    logger.info({ url: result.url, companyName, membersExtracted: members.length }, 'Team page processed');
  }

  private async handleJobListing(
    result: { url: string; title: string; snippet: string },
    item: ClassifiedResult,
    query: string,
  ): Promise<void> {
    const companyName = item.extractedCompany || result.title.split(/[|–—-]/)[0]?.trim() || 'Unknown';

    let domain: string | undefined;
    try {
      domain = new URL(result.url).hostname.replace('www.', '');
    } catch { /* ignore */ }

    const company = await this.saveOrUpdateCompany({
      name: companyName,
      domain,
      rawData: {
        jobListings: [
          {
            title: item.extractedJobTitle || result.title,
            skills: item.extractedRequiredSkills ?? [],
            url: result.url,
            snippet: result.snippet,
            discoveryQuery: query,
          },
        ],
      },
    });

    await this.emitEvent('company:job_listing', {
      companyId: company.id,
      companyName,
      jobTitle: item.extractedJobTitle || result.title,
      url: result.url,
    });
  }

  private async handleCompany(
    result: { url: string; title: string; snippet: string },
    item: ClassifiedResult,
    query: string,
  ): Promise<void> {
    // Extract domain from URL
    let domain: string | undefined;
    try {
      domain = new URL(result.url).hostname.replace('www.', '');
    } catch { /* ignore */ }

    const companyName = item.extractedCompany || item.extractedName || result.title.split(/[|–—-]/)[0]?.trim() || 'Unknown';

    const company = await this.saveOrUpdateCompany({
      name: companyName,
      domain,
      linkedinUrl: result.url.includes('linkedin.com/company/') ? result.url : undefined,
      rawData: {
        discoveryUrl: result.url,
        discoveryTitle: result.title,
        discoverySnippet: result.snippet,
        discoveryQuery: query,
        classificationConfidence: item.confidence,
      },
    });

    await this.emitEvent('company:discovered', {
      companyId: company.id,
      name: companyName,
      domain,
      url: result.url,
    });
  }
}
