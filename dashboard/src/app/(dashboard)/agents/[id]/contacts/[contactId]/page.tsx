'use client';

import { useState } from 'react';
import { Card } from '@/components/ui/card';
import { useParams } from 'next/navigation';
import { Breadcrumb } from '@/components/layout/breadcrumb';
import { useContact, useUpdateContact } from '@/hooks/use-contacts';
import { useToast } from '@/hooks/use-toast';
import { useMasterAgent } from '@/hooks/use-agents';
import { useContactTimeline, useDeals, useCrmStages } from '@/hooks/use-crm';
import { ActivityTimeline } from '@/components/crm/activity-timeline';
import { StageBadge } from '@/components/crm/stage-badge';
import { AddActivityDialog } from '@/components/crm/add-activity-dialog';
import { EmailComposeModal } from '@/components/contacts/email-compose-modal';
import { EmailEditor } from '@/components/contacts/email-editor';
import { EditContactModal } from '@/components/contacts/edit-contact-modal';
import { SequencePanel } from '@/components/contacts/sequence-panel';
import { GmapsBusinessCard } from '@/components/prospects/gmaps-business-card';
import { HomeSection, StatusPill, Chip, SectionTitle } from '@/components/home/home-parts';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { cn, formatDate, formatRelative } from '@/lib/utils';
import {
  User, Mail, Building, MapPin, Linkedin, Star, ExternalLink,
  Github, Globe, GraduationCap, Briefcase, Code,
  Activity, DollarSign, Send, Reply,
} from 'lucide-react';
import Link from 'next/link';
import type { ContactDeepData } from '@/types';

const AVATAR_TONES = ['bg-accent', 'bg-ink-2', 'bg-up', 'bg-info'];
const LABEL = 'm-0 text-3xs font-medium uppercase tracking-[0.09em] text-ink-4';

function statusTone(status: string): 'up' | 'down' | 'warn' | 'muted' {
  if (['replied', 'qualified', 'interview_scheduled'].includes(status)) return 'up';
  if (status === 'rejected') return 'down';
  if (status === 'contacted') return 'warn';
  return 'muted';
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="px-4 py-3">
      <dt className={LABEL}>{label}</dt>
      <dd className="m-0 mt-1 text-body font-medium text-ink">{children}</dd>
    </div>
  );
}

export default function ContactDetailPage() {
  // Route is /agents/[id]/contacts/[contactId] — `id` is the agent, `contactId` is the contact.
  const { id: agentId, contactId } = useParams<{ id: string; contactId: string }>();
  const { data: contact, isLoading } = useContact(contactId);
  const { data: agent } = useMasterAgent(agentId);
  const { data: timeline } = useContactTimeline(contactId);
  const { data: deals } = useDeals({ contactId });
  const { data: stages } = useCrmStages();
  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const updateContact = useUpdateContact();
  const { toast } = useToast();

  const handleMarkResponded = async () => {
    try {
      await updateContact.mutateAsync({ id: contactId, status: 'replied' });
      toast({ title: 'Marked as responded' });
    } catch (err) {
      toast({
        title: 'Failed to update',
        description: err instanceof Error ? err.message : 'Please try again',
        variant: 'destructive',
      });
    }
  };

  if (isLoading) {
    return (
      <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-5" aria-hidden>
        <Skeleton className="h-5 w-72" />
        <Skeleton className="h-[130px] w-full rounded-2xl" />
        <div className="grid gap-4 md:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-40 rounded-xl" />)}
        </div>
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="mx-auto max-w-[1100px] p-5">
        <Card as="section" className="p-7">
          <span className="grid size-9 place-items-center rounded-full bg-accent-weak text-accent">
            <User size={16} />
          </span>
          <h2 className="mb-0 mt-4 font-display text-[26px] font-normal leading-tight tracking-[-0.01em] text-ink">Contact not found</h2>
          <p className="mb-5 mt-2 max-w-[460px] text-body leading-relaxed text-ink-3">It may have been removed, or the link is out of date.</p>
          <Button asChild variant="brand">
            <Link href={`/agents/${agentId}?tab=contacts`}>Back to contacts</Link>
          </Button>
        </Card>
      </div>
    );
  }

  const deep = (contact.rawData ?? {}) as ContactDeepData;
  const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unknown';
  const initials =
    (((contact.firstName ?? '').charAt(0) + (contact.lastName ?? '').charAt(0)) || (contact.email ?? '?').charAt(0)).toUpperCase();
  const avatarTone = AVATAR_TONES[(fullName.charCodeAt(0) || 0) % AVATAR_TONES.length];
  const scoreDetails = contact.scoreDetails as Record<string, unknown> | undefined;
  const strengths = Array.isArray(scoreDetails?.strengths) ? (scoreDetails!.strengths as string[]) : [];
  const concerns = Array.isArray(scoreDetails?.concerns) ? (scoreDetails!.concerns as string[]) : [];
  const reasoning = typeof scoreDetails?.reasoning === 'string' ? (scoreDetails.reasoning as string) : null;

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-4 p-5">
      {/* Breadcrumb + smart back */}
      <Breadcrumb
        showBack
        backFallback={`/agents/${agentId}`}
        items={[
          { href: '/agents', label: 'Agents' },
          { href: `/agents/${agentId}`, label: agent?.name ?? 'Agent' },
          { href: `/agents/${agentId}?tab=contacts`, label: 'Contacts' },
          { label: fullName },
        ]}
      />

      {/* Header */}
      <Card as="section" className="p-5">
        <div className="flex flex-wrap items-start gap-4">
          <span className={cn('grid size-12 shrink-0 place-items-center rounded-full text-body font-semibold text-white', avatarTone)}>
            {initials}
          </span>
          <div className="min-w-0 flex-1 basis-64">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="m-0 font-display text-[26px] font-normal leading-tight tracking-[-0.01em] text-ink">{fullName}</h1>
              <StatusPill tone={statusTone(contact.status)}>
                <span className="capitalize">{contact.status.replace(/_/g, ' ')}</span>
              </StatusPill>
              {(contact.score ?? 0) > 0 && (
                <Chip tone="accent" className="font-mono">
                  <Star className="size-3" /> {contact.score}
                </Chip>
              )}
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-body text-ink-3">
              {contact.title && <span className="text-ink-2">{contact.title}</span>}
              {contact.companyName && (
                <span className="inline-flex items-center gap-1.5">
                  <Building size={13} /> {contact.companyName}
                </span>
              )}
              {contact.location && (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin size={13} /> {contact.location}
                </span>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <EditContactModal contact={contact} />
            {contact.status !== 'replied' && (
              <Button variant="outline" size="sm" onClick={handleMarkResponded} disabled={updateContact.isPending}>
                <Reply className="mr-1.5 size-3.5" /> Mark as responded
              </Button>
            )}
            {contact.email && (
              <Button variant="brand" size="sm" onClick={() => setEmailModalOpen(true)}>
                <Send className="mr-1.5 size-3.5" /> Draft email
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Followup sequence panel — hidden when no campaign_contact rows exist */}
      <SequencePanel contactId={contactId} />

      {/* Google Maps business detail — renders only for gmaps_business contacts */}
      <GmapsBusinessCard contactId={contact.id} sourceType={contact.sourceType} meta={contact.sourceMetadata} />

      <div className="grid items-start gap-4 md:grid-cols-2">
        {/* Contact info */}
        <HomeSection title={<SectionTitle icon={Mail}>Contact info</SectionTitle>}>
          <div className="space-y-3 border-t border-line px-4 py-3.5 text-body">
            <EmailEditor
              contactId={contact.id}
              currentEmail={contact.email ?? null}
              emailVerified={!!contact.emailVerified}
              size="inline"
            />
            {contact.linkedinUrl && (
              <a href={contact.linkedinUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 text-info no-underline hover:underline">
                <Linkedin size={14} /> LinkedIn <ExternalLink size={12} />
              </a>
            )}
            {deep.personalWebsite && (
              <a href={deep.personalWebsite} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 break-all text-info no-underline hover:underline">
                <Globe size={14} className="shrink-0" /> {deep.personalWebsite} <ExternalLink size={12} className="shrink-0" />
              </a>
            )}
          </div>
          <p className="m-0 border-t border-line px-4 py-2.5 text-xs text-ink-3">Discovered {formatDate(contact.createdAt)}</p>
        </HomeSection>

        {/* Summary */}
        {(deep.summary || deep.seniorityLevel || deep.totalYearsExperience) && (
          <HomeSection title={<SectionTitle icon={User}>Summary</SectionTitle>}>
            {deep.summary && <p className="m-0 border-t border-line px-4 py-3.5 text-body leading-relaxed text-ink-2">{deep.summary}</p>}
            <dl className="m-0 grid grid-cols-3 divide-x divide-line border-t border-line">
              {deep.seniorityLevel && <Stat label="Seniority"><span className="capitalize">{deep.seniorityLevel}</span></Stat>}
              {(deep.totalYearsExperience ?? 0) > 0 && <Stat label="Experience">{deep.totalYearsExperience} years</Stat>}
              {(deep.dataCompleteness ?? 0) > 0 && <Stat label="Data">{deep.dataCompleteness}%</Stat>}
            </dl>
          </HomeSection>
        )}

        {/* Skills */}
        {((contact.skills ?? []).length > 0 || (deep.skillLevels ?? []).length > 0) && (
          <HomeSection title={<SectionTitle icon={Code}>Skills</SectionTitle>}>
            {(contact.skills ?? []).length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-4 pb-4">
                {contact.skills!.map((skill: string) => (
                  <Chip key={skill}>{skill}</Chip>
                ))}
              </div>
            )}
            {(deep.skillLevels ?? []).map((sl, i) => (
              <div key={i} className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-body">
                <span className="font-medium text-ink">{sl.skill}</span>
                <Chip className="capitalize">{sl.level}</Chip>
              </div>
            ))}
          </HomeSection>
        )}

        {/* Score breakdown */}
        {scoreDetails && (
          <HomeSection
            title={<SectionTitle icon={Star}>Score breakdown</SectionTitle>}
            meta={<Chip tone="accent" className="font-mono">{contact.score}</Chip>}
          >
            <div className="space-y-3 border-t border-line px-4 py-3.5">
              {Object.entries((scoreDetails.breakdown ?? {}) as Record<string, unknown>).map(([key, val]) => (
                <div key={key}>
                  <div className="mb-1.5 flex justify-between text-xs">
                    <span className="capitalize text-ink-2">{key}</span>
                    <span className="font-mono font-medium text-ink">{String(val)}</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-bg-soft">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, Math.max(0, Number(val)))}%` }} />
                  </div>
                </div>
              ))}
            </div>
            {strengths.length > 0 && (
              <div className="border-t border-line px-4 py-3">
                <p className={cn(LABEL, 'mb-2')}>Strengths</p>
                <div className="flex flex-wrap gap-1.5">
                  {strengths.map((s, i) => <Chip key={i} tone="up">{s}</Chip>)}
                </div>
              </div>
            )}
            {concerns.length > 0 && (
              <div className="border-t border-line px-4 py-3">
                <p className={cn(LABEL, 'mb-2')}>Concerns</p>
                <div className="flex flex-wrap gap-1.5">
                  {concerns.map((c, i) => <Chip key={i} tone="warn">{c}</Chip>)}
                </div>
              </div>
            )}
            {reasoning && <p className="m-0 border-t border-line px-4 py-3 text-xs leading-relaxed text-ink-3">{reasoning}</p>}
          </HomeSection>
        )}

        {/* Education */}
        {(contact.education ?? []).length > 0 && (
          <HomeSection title={<SectionTitle icon={GraduationCap}>Education</SectionTitle>}>
            {(contact.education as Array<Record<string, unknown>>).map((edu, i) => (
              <div key={i} className="border-t border-line px-4 py-3">
                <p className="m-0 text-body font-medium text-ink">
                  {String(edu.degree ?? '')} {edu.field ? `in ${String(edu.field)}` : ''}
                </p>
                <p className="m-0 text-xs text-ink-3">
                  {String(edu.institution ?? '')}
                  {!!edu.year && <> · {String(edu.year)}</>}
                </p>
              </div>
            ))}
          </HomeSection>
        )}

        {/* GitHub */}
        {(deep.githubUrl || (deep.githubStats && deep.githubStats.totalRepos > 0)) && (
          <HomeSection title={<SectionTitle icon={Github}>GitHub</SectionTitle>}>
            {deep.githubUrl && (
              <a
                href={deep.githubUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 break-all border-t border-line px-4 py-2.5 text-body text-info no-underline hover:underline"
              >
                {deep.githubUrl} <ExternalLink size={12} className="shrink-0" />
              </a>
            )}
            {deep.githubStats && (
              <>
                <dl className="m-0 grid grid-cols-3 divide-x divide-line border-t border-line">
                  <Stat label="Repos"><span className="font-mono">{deep.githubStats.totalRepos}</span></Stat>
                  <Stat label="Stars"><span className="font-mono">{deep.githubStats.totalStars}</span></Stat>
                  <Stat label="Activity"><span className="capitalize">{deep.githubStats.contributionLevel}</span></Stat>
                </dl>
                {(deep.githubStats.topLanguages?.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-1.5 border-t border-line px-4 py-3">
                    {deep.githubStats.topLanguages!.map((lang) => (
                      <Chip key={lang}>{lang}</Chip>
                    ))}
                  </div>
                )}
                {(deep.githubStats.topRepos?.length ?? 0) > 0 &&
                  deep.githubStats.topRepos!.map((repo, i) => (
                    <div key={i} className="flex items-center justify-between gap-3 border-t border-line px-4 py-2.5 text-body">
                      <div className="min-w-0">
                        <span className="font-medium text-ink">{repo.name}</span>
                        {repo.language && <span className="ml-2 text-xs text-ink-3">{repo.language}</span>}
                      </div>
                      <span className="inline-flex shrink-0 items-center gap-1 font-mono text-xs text-ink-3">
                        <Star className="size-3" /> {repo.stars}
                      </span>
                    </div>
                  ))}
              </>
            )}
          </HomeSection>
        )}

        {/* Deals */}
        {(deals ?? []).length > 0 && (
          <HomeSection title={<SectionTitle icon={DollarSign}>Deals</SectionTitle>} meta={`${deals!.length}`}>
            {deals!.map((deal) => {
              const stage = stages?.find((s) => s.id === deal.stageId);
              return (
                <Link
                  key={deal.id}
                  href={`/crm/deals/${deal.id}`}
                  className="flex items-center justify-between gap-3 border-t border-line px-4 py-3 no-underline transition-colors hover:bg-hover"
                >
                  <div className="min-w-0">
                    <p className="m-0 truncate text-body font-medium text-ink">{deal.title}</p>
                    {deal.value && (
                      <p className="m-0 font-mono text-xs text-ink-3">
                        {deal.currency ?? '$'}{deal.value}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {stage && <StageBadge stage={stage} />}
                    <span className="text-xs text-ink-3">{formatRelative(deal.createdAt)}</span>
                  </div>
                </Link>
              );
            })}
          </HomeSection>
        )}
      </div>

      {/* Experience */}
      {(contact.experience ?? []).length > 0 && (
        <HomeSection title={<SectionTitle icon={Briefcase}>Experience</SectionTitle>} meta={`${contact.experience!.length}`}>
          <div className="border-t border-line px-5 py-4">
            {(contact.experience as Array<Record<string, unknown>>).map((exp, i) => (
              <div key={i} className="relative border-l-2 border-line pb-5 pl-5 last:pb-0">
                <span className="absolute -left-[5px] top-1.5 size-2 rounded-full bg-accent" />
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="text-body font-medium text-ink">{String(exp.title ?? '')}</span>
                  {!!exp.company && <span className="text-body text-ink-3">at {String(exp.company)}</span>}
                </div>
                <p className="m-0 mt-0.5 font-mono text-xs text-ink-4">
                  {String(exp.startDate ?? '')} — {String(exp.endDate ?? 'present')}
                </p>
                {!!exp.description && <p className="m-0 mt-1.5 text-body leading-relaxed text-ink-2">{String(exp.description)}</p>}
                {Array.isArray(exp.technologies) && exp.technologies.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {(exp.technologies as string[]).map((tech) => (
                      <Chip key={tech}>{tech}</Chip>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </HomeSection>
      )}

      {/* Activity timeline */}
      <HomeSection
        title={<SectionTitle icon={Activity}>Activity timeline</SectionTitle>}
        meta={<AddActivityDialog contactId={contactId} />}
      >
        <div className="border-t border-line px-4 py-3">
          <ActivityTimeline activities={timeline ?? []} />
        </div>
      </HomeSection>

      <EmailComposeModal
        contactId={contactId}
        contactName={fullName}
        contactEmail={contact.email}
        open={emailModalOpen}
        onOpenChange={setEmailModalOpen}
      />
    </div>
  );
}
