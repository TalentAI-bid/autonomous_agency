import Link from 'next/link';
import { Building2, MapPin, Phone } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { FitScoreBadge } from '@/components/companies/fit-score-badge';
import type { CompanyFitScoreVerdict } from '@/types';
import type { CompaniesTabState } from './use-companies-tab';

type Company = CompaniesTabState['companies'][number];

function CompanyCard({ agentId, company }: { agentId: string; company: Company }) {
  const raw = (company.rawData ?? {}) as Record<string, unknown>;
  const keyPeople = (raw.keyPeople as Array<{ name: string; title: string }>) ?? [];
  const completeness = company.dataCompleteness ?? 0;
  const hiringSignal = raw.hiringSignal === true;
  const openJob = typeof raw.openJob === 'string' ? raw.openJob : '';
  const jobUrl = typeof raw.jobUrl === 'string' ? raw.jobUrl : '';
  const jobPostedAt = typeof raw.jobPostedAt === 'string' ? raw.jobPostedAt : '';
  // Prefer the new continuous fitScore; fall back to nothing
  // for unscored companies (they're still shown — never hidden).
  const fitScore = (raw.fitScore as CompanyFitScoreVerdict | undefined);
  // list_verification mode flags (strict company-list enrichment).
  const isListEntry = raw.listEntry === true;
  const linkedinNotFound = raw.linkedinNotFound === true;
  const gmapsNotFound = raw.gmapsNotFound === true;
  const crawl = (raw.crawl as Record<string, { url?: string; markdownLength?: number }> | undefined) ?? {};
  const crawledCount = [crawl.sourceUrl, crawl.website].filter((c) => c && (c.markdownLength ?? 0) > 0).length;
  // Google Maps enrichment (phone/address land on the company's rawData).
  const gmapsPhone = typeof raw.phone === 'string' ? raw.phone : '';
  const gmapsAddress = typeof raw.address === 'string' ? raw.address : '';

  return (
    <Link href={`/agents/${agentId}/companies/${company.id}`} className="block">
      <div className="border rounded-lg p-4 hover:bg-muted/50 transition-colors space-y-3">
        {/* Header: name + domain + badges */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <p className="font-medium truncate">{company.name}</p>
            <p className="text-xs text-muted-foreground">
              {[company.domain, company.industry, company.size].filter(Boolean).join(' · ')}
            </p>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <FitScoreBadge score={fitScore?.buyer_fit_score} explanation={fitScore?.fit_summary} />
            {fitScore?.data_completeness === 'partial' && (
              <Badge variant="outline" className="text-2xs text-warn-fg border-warn/40">
                partial
              </Badge>
            )}
            {company.funding && (
              <Badge variant="outline" className="text-xs">{company.funding}</Badge>
            )}
            <Badge
              variant={completeness >= 50 ? 'default' : completeness >= 30 ? 'secondary' : 'outline'}
              className="text-xs"
            >
              {completeness > 0 ? `${completeness}%` : 'New'}
            </Badge>
          </div>
        </div>

        {/* Google Maps contact details (phone / address) */}
        {(gmapsPhone || gmapsAddress) && (
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            {gmapsPhone && (
              <span className="inline-flex items-center gap-1.5">
                <Phone className="w-3 h-3 shrink-0" />
                {gmapsPhone}
              </span>
            )}
            {gmapsAddress && (
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="w-3 h-3 shrink-0" />
                <span className="truncate">{gmapsAddress}</span>
              </span>
            )}
          </div>
        )}

        {/* list_verification status row */}
        {isListEntry && (
          <div className="flex flex-wrap items-center gap-1.5">
            {linkedinNotFound ? (
              <Badge variant="outline" className="text-2xs text-down border-down/40">No LinkedIn match</Badge>
            ) : company.linkedinUrl ? (
              <Badge variant="outline" className="text-2xs text-up border-up/40">LinkedIn ✓</Badge>
            ) : null}
            {gmapsNotFound ? (
              <Badge variant="outline" className="text-2xs text-down border-down/40">No Maps match</Badge>
            ) : (
              <Badge variant="outline" className="text-2xs text-up border-up/40">Maps ✓</Badge>
            )}
            {crawledCount > 0 && (
              <Badge variant="outline" className="text-2xs text-info border-info/40">
                {crawledCount === 2 ? 'Site + source crawled' : 'Site crawled'}
              </Badge>
            )}
          </div>
        )}

        {/* Hiring signal chip — shows what role this company is hiring for */}
        {hiringSignal && openJob && (
          <div className="flex flex-wrap items-center gap-2">
            {jobUrl ? (
              <a
                href={jobUrl}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="inline-flex items-center gap-1 text-xs bg-up/10 text-up hover:bg-up/20 px-2 py-0.5 rounded-full transition-colors"
              >
                <span className="font-medium">Hiring:</span>
                <span>{openJob}</span>
                <span className="text-up/70">↗</span>
              </a>
            ) : (
              <span className="inline-flex items-center gap-1 text-xs bg-up/10 text-up px-2 py-0.5 rounded-full">
                <span className="font-medium">Hiring:</span>
                <span>{openJob}</span>
              </span>
            )}
            {jobPostedAt && (
              <span className="text-2xs text-muted-foreground">Posted {jobPostedAt}</span>
            )}
          </div>
        )}

        {/* Description */}
        {company.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">{company.description}</p>
        )}

        {/* Key People */}
        {keyPeople.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {keyPeople.slice(0, 3).map((person, i) => (
              <span key={i} className="inline-flex items-center gap-1 text-xs bg-muted px-2 py-0.5 rounded-full">
                <span className="font-medium">{person.name}</span>
                {person.title && <span className="text-muted-foreground">· {person.title}</span>}
              </span>
            ))}
            {keyPeople.length > 3 && (
              <span className="text-xs text-muted-foreground px-2 py-0.5">
                +{keyPeople.length - 3} more
              </span>
            )}
          </div>
        )}

        {/* Tech stack chips */}
        {Array.isArray(company.techStack) && company.techStack.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {company.techStack.slice(0, 5).map((tech, i) => (
              <span key={i} className="text-2xs bg-info/10 text-info px-1.5 py-0.5 rounded">
                {tech}
              </span>
            ))}
            {company.techStack.length > 5 && (
              <span className="text-2xs text-muted-foreground px-1.5 py-0.5">
                +{company.techStack.length - 5}
              </span>
            )}
          </div>
        )}

        {/* Progress bar */}
        {completeness > 0 && (
          <div className="w-full bg-muted rounded-full h-1">
            <div
              className={`h-1 rounded-full transition-all ${
                completeness >= 50 ? 'bg-up' : completeness >= 30 ? 'bg-warn' : 'bg-down'
              }`}
              style={{ width: `${Math.min(completeness, 100)}%` }}
            />
          </div>
        )}
      </div>
    </Link>
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
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Building2 className="w-4 h-4" />
          Companies ({companies.length}{pagination?.hasMore ? '+' : ''})
        </CardTitle>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onGmapsEnrich}
            disabled={gmapsPending || companies.length === 0}
            title="Search each company on Google Maps by name and fill in phone, website and a generic email (info@/contact@). Falls back to a Google search when Maps has no match."
            className="text-xs px-2 py-1 rounded border bg-background hover:bg-muted/50 transition-colors inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <MapPin className="w-3.5 h-3.5" />
            {gmapsPending ? 'Queuing…' : 'Enrich via Google Maps'}
          </button>
          <button
            type="button"
            onClick={state.toggleShowOnlyWithData}
            className="text-xs px-2 py-1 rounded border bg-background hover:bg-muted/50 transition-colors"
          >
            {showOnlyWithData ? 'Show all (incl. unenriched)' : 'Show only with data'}
          </button>
        </div>
      </CardHeader>
      <CardContent>
        {companies.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            {showOnlyWithData
              ? 'No enriched companies yet. Toggle "Show all" to see discovered-but-unenriched stubs.'
              : 'No companies discovered yet.'}
          </p>
        ) : (
          <div className="grid gap-3">
            {companies.map((company) => (
              <CompanyCard key={company.id} agentId={agentId} company={company} />
            ))}
          </div>
        )}
        {(cursorStack.length > 1 || pagination?.hasMore) && (
          <div className="flex items-center justify-between pt-4 mt-3 border-t">
            <button
              type="button"
              disabled={cursorStack.length <= 1}
              onClick={state.goPrevious}
              className="text-xs px-3 py-1.5 rounded border bg-background hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              ← Previous
            </button>
            <span className="text-xs text-muted-foreground">
              Page {cursorStack.length}
            </span>
            <button
              type="button"
              disabled={!pagination?.hasMore || !pagination?.nextCursor}
              onClick={() => {
                if (pagination?.nextCursor) state.goNext(pagination.nextCursor);
              }}
              className="text-xs px-3 py-1.5 rounded border bg-background hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              Next →
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
