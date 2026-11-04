import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { ArrowUpRight, ChevronLeft, ChevronRight, MapPin, Phone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FitScoreBadge } from '@/components/companies/fit-score-badge';
import { cn } from '@/lib/utils';
import type { CompanyFitScoreVerdict } from '@/types';
import type { CompaniesTabState } from './use-companies-tab';

type Company = CompaniesTabState['companies'][number];

const tag = 'rounded-md px-2 py-0.5 text-2xs font-medium';

function CompanyRow({ agentId, company }: { agentId: string; company: Company }) {
  const raw = (company.rawData ?? {}) as Record<string, unknown>;
  const keyPeople = (raw.keyPeople as Array<{ name: string; title: string }>) ?? [];
  const completeness = company.dataCompleteness ?? 0;
  const hiringSignal = raw.hiringSignal === true;
  const openJob = typeof raw.openJob === 'string' ? raw.openJob : '';
  const jobUrl = typeof raw.jobUrl === 'string' ? raw.jobUrl : '';
  const jobPostedAt = typeof raw.jobPostedAt === 'string' ? raw.jobPostedAt : '';
  // Prefer the continuous fitScore; unscored companies are still shown, never hidden.
  const fitScore = raw.fitScore as CompanyFitScoreVerdict | undefined;
  // list_verification mode flags (strict company-list enrichment).
  const isListEntry = raw.listEntry === true;
  const linkedinNotFound = raw.linkedinNotFound === true;
  const gmapsNotFound = raw.gmapsNotFound === true;
  const crawl = (raw.crawl as Record<string, { url?: string; markdownLength?: number }> | undefined) ?? {};
  const crawledCount = [crawl.sourceUrl, crawl.website].filter((c) => c && (c.markdownLength ?? 0) > 0).length;
  // Google Maps enrichment (phone/address land on the company's rawData).
  const gmapsPhone = typeof raw.phone === 'string' ? raw.phone : '';
  const gmapsAddress = typeof raw.address === 'string' ? raw.address : '';
  const sub = [company.domain, company.industry, company.size].filter(Boolean).join(' · ');

  return (
    <li>
      <Link href={`/agents/${agentId}/companies/${company.id}`} className="group flex items-start gap-3.5 px-5 py-4 transition-colors hover:bg-bg-soft">
        <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-weak text-sm font-semibold uppercase text-accent-fg">
          {(company.name?.[0] ?? '?').toUpperCase()}
        </span>

        <div className="min-w-0 flex-1 space-y-2.5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="truncate text-body font-medium text-ink">{company.name}</div>
              {sub && <div className="truncate text-xs text-ink-3">{sub}</div>}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <FitScoreBadge score={fitScore?.buyer_fit_score} explanation={fitScore?.fit_summary} />
              {fitScore?.data_completeness === 'partial' && <span className={cn(tag, 'bg-warn/15 text-warn-fg')}>partial</span>}
              {company.funding && <span className={cn(tag, 'bg-bg-sub text-ink-2')}>{company.funding}</span>}
              <span
                className={cn(
                  tag,
                  completeness >= 50 ? 'bg-up/10 text-up' : completeness >= 30 ? 'bg-warn/15 text-warn-fg' : 'bg-bg-sub text-ink-3',
                )}
              >
                {completeness > 0 ? `${completeness}%` : 'New'}
              </span>
            </div>
          </div>

          {company.description && <p className="m-0 line-clamp-2 text-xs leading-relaxed text-ink-3">{company.description}</p>}

          {(gmapsPhone || gmapsAddress) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-3">
              {gmapsPhone && (
                <span className="inline-flex items-center gap-1.5">
                  <Phone size={11} className="shrink-0" />
                  {gmapsPhone}
                </span>
              )}
              {gmapsAddress && (
                <span className="inline-flex min-w-0 items-center gap-1.5">
                  <MapPin size={11} className="shrink-0" />
                  <span className="truncate">{gmapsAddress}</span>
                </span>
              )}
            </div>
          )}

          {(isListEntry || (hiringSignal && openJob)) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {isListEntry && (
                <>
                  {linkedinNotFound ? (
                    <span className={cn(tag, 'bg-down/10 text-down')}>No LinkedIn match</span>
                  ) : company.linkedinUrl ? (
                    <span className={cn(tag, 'bg-up/10 text-up')}>LinkedIn ✓</span>
                  ) : null}
                  <span className={cn(tag, gmapsNotFound ? 'bg-down/10 text-down' : 'bg-up/10 text-up')}>
                    {gmapsNotFound ? 'No Maps match' : 'Maps ✓'}
                  </span>
                  {crawledCount > 0 && (
                    <span className={cn(tag, 'bg-info/10 text-info')}>{crawledCount === 2 ? 'Site + source crawled' : 'Site crawled'}</span>
                  )}
                </>
              )}
              {hiringSignal && openJob && (
                <>
                  {jobUrl ? (
                    <a
                      href={jobUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className={cn(tag, 'inline-flex items-center gap-1 bg-up/10 text-up transition-colors hover:bg-up/20')}
                    >
                      Hiring: {openJob}
                      <ArrowUpRight size={11} />
                    </a>
                  ) : (
                    <span className={cn(tag, 'bg-up/10 text-up')}>Hiring: {openJob}</span>
                  )}
                  {jobPostedAt && <span className="text-2xs text-ink-4">Posted {jobPostedAt}</span>}
                </>
              )}
            </div>
          )}

          {keyPeople.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {keyPeople.slice(0, 3).map((person, i) => (
                <Badge key={i} variant="soft" className="font-normal">
                  <span className="font-medium text-ink">{person.name}</span>
                  {person.title && <span className="text-ink-3">· {person.title}</span>}
                </Badge>
              ))}
              {keyPeople.length > 3 && <span className="px-1 py-0.5 text-xs text-ink-4">+{keyPeople.length - 3} more</span>}
            </div>
          )}

          {Array.isArray(company.techStack) && company.techStack.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {company.techStack.slice(0, 5).map((tech, i) => (
                <Badge key={i} variant="info" size="sm">
                  {tech}
                </Badge>
              ))}
              {company.techStack.length > 5 && <span className="px-1 py-0.5 text-2xs text-ink-4">+{company.techStack.length - 5}</span>}
            </div>
          )}

          {completeness > 0 && (
            <div className="h-1 w-full overflow-hidden rounded-full bg-bg-soft" title={`Data completeness ${completeness}%`}>
              <div
                className={cn('h-full rounded-full transition-all', completeness >= 50 ? 'bg-up' : completeness >= 30 ? 'bg-warn' : 'bg-down')}
                style={{ width: `${Math.min(completeness, 100)}%` }}
              />
            </div>
          )}
        </div>

        <ChevronRight size={14} className="mt-2.5 shrink-0 text-ink-4 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-2" />
      </Link>
    </li>
  );
}

export function CompaniesTab({
  agentId,
  state,
  onGmapsEnrich,
  gmapsPending,
}: {
  agentId: string;
  state: CompaniesTabState;
  onGmapsEnrich: () => void;
  gmapsPending: boolean;
}) {
  const { companies, pagination, showOnlyWithData, cursorStack } = state;

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
        <div className="mr-auto flex items-center gap-2">
          <h2 className="m-0 text-body font-semibold text-ink">Companies</h2>
          <Badge variant="muted" size="sm" className="font-mono">
            {companies.length}
            {pagination?.hasMore ? '+' : ''}
          </Badge>
        </div>
        <Button size="sm"
          type="button"
          variant="panel"
          onClick={onGmapsEnrich}
          disabled={gmapsPending || companies.length === 0}
          title="Search each company on Google Maps by name and fill in phone, website and a generic email (info@/contact@). Falls back to a Google search when Maps has no match."
        >
          <MapPin size={13} />
          {gmapsPending ? 'Queuing…' : 'Enrich via Google Maps'}
        </Button>
        <Button size="sm" type="button" variant="panel" onClick={state.toggleShowOnlyWithData}>
          {showOnlyWithData ? 'Show all (incl. unenriched)' : 'Show only with data'}
        </Button>
      </header>

      {companies.length === 0 ? (
        <p className="m-0 px-5 py-10 text-center text-body text-ink-3">
          {showOnlyWithData
            ? 'No enriched companies yet. Switch to "Show all" to see discovered-but-unenriched stubs.'
            : 'No companies discovered yet.'}
        </p>
      ) : (
        <ul className="m-0 list-none divide-y divide-line p-0">
          {companies.map((company) => (
            <CompanyRow key={company.id} agentId={agentId} company={company} />
          ))}
        </ul>
      )}

      {(cursorStack.length > 1 || pagination?.hasMore) && (
        <footer className="flex items-center justify-between border-t border-line px-5 py-2.5">
          <Button size="sm" type="button" variant="panel" disabled={cursorStack.length <= 1} onClick={state.goPrevious}>
            <ChevronLeft size={13} /> Previous
          </Button>
          <span className="text-xs text-ink-3">Page {cursorStack.length}</span>
          <Button size="sm"
            type="button"
            variant="panel"
            disabled={!pagination?.hasMore || !pagination?.nextCursor}
            onClick={() => {
              if (pagination?.nextCursor) state.goNext(pagination.nextCursor);
            }}
          >
            Next <ChevronRight size={13} />
          </Button>
        </footer>
      )}
    </section>
  );
}
