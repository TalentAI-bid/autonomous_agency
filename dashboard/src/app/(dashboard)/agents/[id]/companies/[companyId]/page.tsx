'use client';

import { use, type ReactNode } from 'react';
import { Breadcrumb } from '@/components/layout/breadcrumb';
import { useCompany } from '@/hooks/use-companies';
import { useMasterAgent } from '@/hooks/use-agents';
import { useContacts, useFindContactEmail } from '@/hooks/use-contacts';
import { EmailEditor } from '@/components/contacts/email-editor';
import { EditContactModal } from '@/components/contacts/edit-contact-modal';
import { AddPersonModal } from '@/components/contacts/add-person-modal';
import { useToast } from '@/hooks/use-toast';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { HomeSection, Chip, SectionTitle } from '@/components/home/home-parts';
import { cn, citedText } from '@/lib/utils';
import {
  Globe, Building2, Users, Cpu,
  MapPin, Calendar, Briefcase, Heart, Newspaper, UserCircle,
  Mail, ExternalLink, Search, Linkedin,
  AlertTriangle, TrendingDown, FileText, Brain, ShieldAlert,
  Loader2, Pencil, Plus,
} from 'lucide-react';
import Link from 'next/link';
import type { CompanyDeepData, CompanyFitScoreVerdict, PainPoint } from '@/types';
import { FitScorePanel } from '@/components/companies/fit-score-panel';
import { GmapsBusinessCard } from '@/components/prospects/gmaps-business-card';

const AVATAR_TONES = ['bg-accent', 'bg-ink-2', 'bg-up', 'bg-info'];

function Empty({ children }: { children: ReactNode }) {
  return <p className="m-0 px-4 pb-4 text-body text-ink-3">{children}</p>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="px-4 py-3">
      <dt className="text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">{label}</dt>
      <dd className="m-0 mt-1 text-body font-medium text-ink">{children}</dd>
    </div>
  );
}

export default function CompanyDetailPage({ params }: { params: Promise<{ id: string; companyId: string }> }) {
  // Route is /agents/[id]/companies/[companyId] — `id` is the agent, `companyId` is the company.
  const { id: agentId, companyId } = use(params);
  const { data: company, isLoading } = useCompany(companyId);
  const { data: agent } = useMasterAgent(agentId);
  const { data: contactsRes } = useContacts({ companyId });
  const companyContacts = contactsRes?.data ?? [];
  const findEmail = useFindContactEmail();
  const { toast } = useToast();

  const handleFindEmail = async (contactId: string) => {
    try {
      const result = await findEmail.mutateAsync(contactId);
      if (result.email) {
        toast({
          title: 'Email found',
          description: `${result.email}${result.verified ? ' (verified)' : ''}`,
        });
      } else {
        toast({
          title: 'No email found',
          description:
            result.method === 'daily_limit'
              ? 'Reacher daily verification cap reached; try again tomorrow.'
              : result.method === 'exhausted'
              ? 'Tried all common patterns; none verified.'
              : result.method === 'no_patterns'
              ? 'Missing first/last name.'
              : `Method: ${result.method}`,
          variant: 'destructive',
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Email lookup failed';
      toast({ title: 'Email lookup failed', description: message, variant: 'destructive' });
    }
  };

  if (isLoading) {
    return (
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-5" aria-hidden>
        <Skeleton className="h-5 w-72" />
        <Skeleton className="h-[170px] w-full rounded-2xl" />
        <Skeleton className="h-[120px] w-full rounded-2xl" />
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (!company) {
    return (
      <div className="mx-auto max-w-[1100px] p-5">
        <section className="rounded-2xl border border-line bg-bg-panel p-7 shadow-sm">
          <span className="grid size-9 place-items-center rounded-full bg-accent-weak text-accent">
            <Building2 size={16} />
          </span>
          <h2 className="mb-0 mt-4 font-display text-[26px] font-normal leading-tight tracking-[-0.01em] text-ink">Company not found</h2>
          <p className="mb-5 mt-2 max-w-[460px] text-body leading-relaxed text-ink-3">It may have been removed, or the link is out of date.</p>
          <Button asChild variant="brand">
            <Link href={`/agents/${agentId}?tab=companies`}>Back to companies</Link>
          </Button>
        </section>
      </div>
    );
  }

  const deep = (company.rawData ?? {}) as CompanyDeepData;
  // Prefer the new continuous fit-score (rawData.fitScore). Fall back to a
  // legacy triage row only if migration synthesized a fitScore from the old
  // verdict — the migration writes both shapes so reading fitScore is safe
  // for migrated rows too.
  const fitScore = (company.rawData as { fitScore?: CompanyFitScoreVerdict } | undefined)?.fitScore;

  const painPointIcon = (type: string) => {
    switch (type) {
      case 'no_website': return <Globe className="size-3" />;
      case 'broken_website': return <AlertTriangle className="size-3" />;
      case 'poor_seo': return <TrendingDown className="size-3" />;
      case 'thin_content': return <FileText className="size-3" />;
      case 'hiring_engineers': return <Search className="size-3" />;
      case 'llm_detected': return <Brain className="size-3" />;
      default: return <ShieldAlert className="size-3" />;
    }
  };

  /** Safely render a value that might be an object (e.g. headquarters: {city, state, country}) */
  const safeStr = (val: unknown): string => {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'object') {
      return Object.values(val as Record<string, unknown>)
        .filter((v) => v && typeof v === 'string' && v.trim())
        .join(', ');
    }
    return String(val);
  };

  const name = company.name ?? 'Company';
  const avatarTone = AVATAR_TONES[(name.charCodeAt(0) || 0) % AVATAR_TONES.length];
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0)).join('').toUpperCase() || '?';

  const mapsMeta = (company.rawData as { source?: string } | null)?.source === 'gmaps_extension';

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-5">
      {/* Breadcrumb + smart back */}
      <Breadcrumb
        showBack
        backFallback={`/agents/${agentId}`}
        items={[
          { href: '/agents', label: 'Agents' },
          { href: `/agents/${agentId}`, label: agent?.name ?? 'Agent' },
          { href: `/agents/${agentId}?tab=companies`, label: 'Companies' },
          { label: name },
        ]}
      />

      {/* Header + overview */}
      <section className="overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm">
        <div className="flex flex-wrap items-start gap-4 p-5">
          <span className={cn('grid size-12 shrink-0 place-items-center rounded-xl text-body font-semibold text-white', avatarTone)}>{initials}</span>
          <div className="min-w-0 flex-1">
            <h1 className="m-0 font-display text-[26px] font-normal leading-tight tracking-[-0.01em] text-ink">{name}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-body text-ink-3">
              {company.domain && (
                <a
                  href={`https://${company.domain}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-ink-2 no-underline hover:text-accent"
                >
                  <Globe size={13} /> {company.domain}
                </a>
              )}
              {company.industry && <Chip>{company.industry}</Chip>}
              {company.size && <span>{company.size} employees</span>}
            </div>
          </div>
          {company.linkedinUrl && (
            <Button size="sm" asChild variant="panel" className="shrink-0">
              <a href={company.linkedinUrl} target="_blank" rel="noopener noreferrer">
                <Linkedin className="mr-1.5 size-3.5" /> LinkedIn
              </a>
            </Button>
          )}
        </div>

        {company.description && <p className="m-0 px-5 pb-5 text-body leading-relaxed text-ink-2">{company.description}</p>}

        <dl className="m-0 grid grid-cols-2 divide-x divide-y divide-line border-t border-line sm:grid-cols-4 sm:divide-y-0 [&>div:nth-child(odd)]:border-l-0">
          <Fact label="Funding">{company.funding || '—'}</Fact>
          <Fact label="Founded">{safeStr(deep.foundedYear) || '—'}</Fact>
          <Fact label="Headquarters">{safeStr(deep.headquarters) || '—'}</Fact>
          <Fact label="Website">
            {company.websiteStatus ? (
              <span className="capitalize">{company.websiteStatus.replace('_', ' ')}</span>
            ) : (
              '—'
            )}
            {company.seoScore != null && (
              <span className={cn('ml-2 font-mono text-xs', company.seoScore >= 70 ? 'text-up' : company.seoScore >= 40 ? 'text-warn-fg' : 'text-down')}>
                SEO {company.seoScore}/100
              </span>
            )}
          </Fact>
        </dl>
      </section>

      {/* Fit score — always rendered (offers a "Score now" button when no verdict yet) */}
      <FitScorePanel companyId={company.id} triage={fitScore} />

      {/* People / Contacts */}
      <HomeSection
        title={<SectionTitle icon={Users}>People</SectionTitle>}
        meta={
          <div className="flex items-center gap-3">
            {companyContacts.length > 0 && <span>{companyContacts.length} {companyContacts.length === 1 ? 'person' : 'people'}</span>}
            <AddPersonModal masterAgentId={agentId} companyId={companyId} companyName={company.name} />
          </div>
        }
      >
        {companyContacts.length > 0 ? (
          companyContacts.map((contact) => {
            const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unknown';
            const pending = findEmail.isPending && findEmail.variables === contact.id;
            return (
              <div key={contact.id} className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
                <span className="grid size-9 shrink-0 place-items-center rounded-full bg-bg-soft text-xs font-semibold text-ink-2">
                  {fullName.charAt(0).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1 basis-56">
                  <Link href={`/agents/${agentId}/contacts/${contact.id}`} className="text-body font-medium text-ink no-underline hover:text-accent">
                    {fullName}
                  </Link>
                  {contact.title && <p className="m-0 truncate text-xs text-ink-3">{contact.title}</p>}
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    <EmailEditor
                      contactId={contact.id}
                      currentEmail={contact.email ?? null}
                      emailVerified={!!contact.emailVerified}
                      size="compact"
                    />
                    {!contact.email && (
                      <Button size="xs"
                        variant="ghost"
                        className="gap-1 text-ink-3"
                        disabled={pending}
                        onClick={() => handleFindEmail(contact.id)}
                        title="Auto-find email via patterns + Reacher"
                      >
                        {pending ? <Loader2 className="size-3 animate-spin" /> : <Mail className="size-3" />}
                        Auto-find
                      </Button>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  {contact.score != null && contact.score > 0 && <Chip tone="accent" className="font-mono">{contact.score}</Chip>}
                  {contact.linkedinUrl && (
                    <a
                      href={contact.linkedinUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label="LinkedIn profile"
                      className="grid size-7 place-items-center rounded-lg text-ink-3 transition-colors hover:bg-hover hover:text-ink"
                    >
                      <Linkedin className="size-3.5" />
                    </a>
                  )}
                  <EditContactModal
                    contact={contact}
                    trigger={
                      <Button variant="ghost" size="iconSm" title="Edit name / role">
                        <Pencil className="size-3.5" />
                      </Button>
                    }
                  />
                  <Button asChild variant="ghost" size="iconSm" title="Open contact">
                    <Link href={`/agents/${agentId}/contacts/${contact.id}`}>
                      <ExternalLink className="size-3.5" />
                    </Link>
                  </Button>
                </div>
              </div>
            );
          })
        ) : (
          <div className="flex flex-col items-start gap-3 border-t border-line px-4 py-6">
            <p className="m-0 text-body text-ink-3">No contacts discovered yet for this company.</p>
            <AddPersonModal
              masterAgentId={agentId}
              companyId={companyId}
              companyName={company.name}
              trigger={
                <Button size="sm" variant="panel">
                  <Plus className="mr-1.5 size-3.5" /> Add the first person
                </Button>
              }
            />
          </div>
        )}
      </HomeSection>

      <div className="grid items-start gap-4 md:grid-cols-2">
        {/* Tech Stack */}
        <HomeSection title={<SectionTitle icon={Cpu}>Tech stack</SectionTitle>}>
          {(company.techStack ?? []).length > 0 ? (
            <div className="flex flex-wrap gap-1.5 px-4 pb-4">
              {company.techStack!.map((tech) => (
                <Chip key={tech}>{tech}</Chip>
              ))}
            </div>
          ) : (
            <Empty>No tech stack data available.</Empty>
          )}
        </HomeSection>

        {/* Pain Points */}
        {(company.painPoints ?? []).length > 0 && (
          <HomeSection title={<SectionTitle icon={ShieldAlert}>Pain points</SectionTitle>} meta={`${company.painPoints!.length}`}>
            <div className="flex flex-wrap gap-1.5 px-4 pb-4">
              {company.painPoints!.map((p: PainPoint, i: number) => (
                <Chip key={i} tone={p.severity === 'high' ? 'down' : p.severity === 'medium' ? 'warn' : 'soft'}>
                  {painPointIcon(p.type)} {p.description}
                </Chip>
              ))}
            </div>
          </HomeSection>
        )}

        {/* Google Maps — phone / address / hours / reviews land on the company's
            rawData via the "Enrich via Google Maps" button. Same rich card the
            business-contact page uses, rendered straight from company.rawData so
            the info lives on the company, not a separate "business" entity. */}
        {mapsMeta && (
          <div className="md:col-span-2">
            <GmapsBusinessCard sourceType="gmaps_business" meta={company.rawData as Record<string, unknown>} />
          </div>
        )}

        {/* Products */}
        {(deep.products ?? []).length > 0 && (
          <HomeSection title={<SectionTitle icon={Briefcase}>Products</SectionTitle>} meta={`${deep.products!.length}`}>
            {deep.products!.map((product, i) => (
              <div key={i} className="border-t border-line px-4 py-2.5 text-body text-ink-2">
                {citedText(product)}
              </div>
            ))}
          </HomeSection>
        )}

        {/* Key People */}
        {(deep.keyPeople ?? []).length > 0 && (
          <HomeSection title={<SectionTitle icon={UserCircle}>Key people</SectionTitle>} meta={`${deep.keyPeople!.length}`}>
            {deep.keyPeople!.map((person, i) => (
              <div key={i} className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-body">
                <span className="font-medium text-ink">{person.name}</span>
                <span className="truncate text-xs text-ink-3">{person.title}</span>
              </div>
            ))}
          </HomeSection>
        )}

        {/* Hiring Contacts */}
        {(deep.contactEmail || (deep.hiringContactEmails ?? []).length > 0) && (
          <HomeSection title={<SectionTitle icon={Mail}>Hiring contacts</SectionTitle>}>
            <div className="space-y-3 border-t border-line px-4 py-3 text-body">
              {deep.contactEmail && (
                <div>
                  <p className="m-0 text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">Company email</p>
                  <a href={`mailto:${deep.contactEmail}`} className="text-info no-underline hover:underline">{deep.contactEmail}</a>
                </div>
              )}
              {(deep.hiringContactEmails ?? []).length > 0 && (
                <div>
                  <p className="m-0 text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">HR / Recruiting</p>
                  {deep.hiringContactEmails!.map((email, i) => (
                    <a key={i} href={`mailto:${email}`} className="block text-info no-underline hover:underline">{email}</a>
                  ))}
                </div>
              )}
            </div>
          </HomeSection>
        )}

        {/* Culture & Values */}
        {(deep.cultureValues ?? []).length > 0 && (
          <HomeSection title={<SectionTitle icon={Heart}>Culture &amp; values</SectionTitle>}>
            <div className="flex flex-wrap gap-1.5 px-4 pb-4">
              {deep.cultureValues!.map((val, i) => (
                <Chip key={i} title={typeof val === 'object' && val.citation ? val.citation : undefined}>{citedText(val)}</Chip>
              ))}
            </div>
          </HomeSection>
        )}

        {/* Recent News */}
        {(deep.recentNews ?? []).length > 0 && (
          <HomeSection title={<SectionTitle icon={Newspaper}>Recent news</SectionTitle>}>
            {deep.recentNews!.map((news, i) => (
              <div key={i} className="flex items-start justify-between gap-3 border-t border-line px-4 py-2.5 text-body">
                <span className="text-ink-2">{news.headline}</span>
                <span className="inline-flex shrink-0 items-center gap-1 text-xs text-ink-3">
                  <Calendar className="size-3" /> {news.date}
                </span>
              </div>
            ))}
          </HomeSection>
        )}

        {/* Competitors */}
        {(deep.competitors ?? []).length > 0 && (
          <HomeSection title={<SectionTitle icon={Users}>Competitors</SectionTitle>}>
            <div className="flex flex-wrap gap-1.5 px-4 pb-4">
              {deep.competitors!.map((comp, i) => (
                <Chip key={i} title={typeof comp === 'object' && comp.citation ? comp.citation : undefined}>{citedText(comp)}</Chip>
              ))}
            </div>
          </HomeSection>
        )}
      </div>

      {/* Open Positions */}
      {(deep.openPositions ?? []).length > 0 && (
        <HomeSection title={<SectionTitle icon={Briefcase}>Open positions</SectionTitle>} meta={`${deep.openPositions!.length}`}>
          {deep.openPositions!.map((pos, i) => (
            <div key={i} className="border-t border-line px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-body font-medium text-ink">
                  {pos.url ? (
                    <a href={pos.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-ink no-underline hover:text-accent">
                      {pos.title} <ExternalLink className="size-3" />
                    </a>
                  ) : pos.title}
                </span>
                <span className="inline-flex items-center gap-1 text-xs text-ink-3">
                  <MapPin className="size-3" /> {pos.location || '—'}
                </span>
              </div>
              {pos.salary && <p className="m-0 mt-1 text-xs font-medium text-ink-2">{pos.salary}</p>}
              {pos.description && <p className="m-0 mt-1 text-xs leading-relaxed text-ink-3">{pos.description}</p>}
              {(pos.requiredSkills ?? []).length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {pos.requiredSkills!.map((skill) => (
                    <Chip key={skill}>{skill}</Chip>
                  ))}
                </div>
              )}
            </div>
          ))}
        </HomeSection>
      )}

      {/* Job Listings Found */}
      {(deep.jobListings ?? []).length > 0 && (
        <HomeSection title={<SectionTitle icon={Search}>Job listings found</SectionTitle>} meta={`${deep.jobListings!.length}`}>
          {deep.jobListings!.map((listing, i) => (
            <div key={i} className="border-t border-line px-4 py-3">
              <a
                href={listing.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-body font-medium text-ink no-underline hover:text-accent"
              >
                {listing.title} <ExternalLink className="size-3" />
              </a>
              {listing.snippet && <p className="m-0 mt-1 text-xs leading-relaxed text-ink-3">{listing.snippet}</p>}
              {listing.skills.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {listing.skills.map((skill) => (
                    <Chip key={skill}>{skill}</Chip>
                  ))}
                </div>
              )}
            </div>
          ))}
        </HomeSection>
      )}
    </div>
  );
}
