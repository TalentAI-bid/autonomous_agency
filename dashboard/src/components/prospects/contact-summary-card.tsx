'use client';

import * as React from 'react';
import { Mail, Linkedin, Phone, MessageCircle, Twitter, X, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { useUpdateProspectTags, useMarkProspectDnc } from '@/hooks/use-prospect';
import type { ProspectDetailResponse } from '@/lib/api/prospects';
import { formatRelative, formatDate } from '@/lib/utils';
import { cn } from '@/lib/utils';
import { StatusPill } from '@/components/home/home-parts';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

const AVATAR_TONES = ['bg-accent', 'bg-ink-2', 'bg-up', 'bg-info'];

function stageTone(stage: string): 'up' | 'down' | 'warn' | 'muted' {
  if (['engaged', 'qualified', 'closed_won', 'meeting_scheduled'].includes(stage)) return 'up';
  if (['dnc', 'closed_lost'].includes(stage)) return 'down';
  if (stage === 'cold') return 'warn';
  return 'muted';
}

const LABEL = 'mb-1.5 text-3xs font-medium uppercase tracking-[0.09em] text-ink-4';

function ContactRow({ icon: Icon, href, children }: { icon: LucideIcon; href?: string; children: React.ReactNode }) {
  const inner = (
    <>
      <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-bg-soft text-ink-3">
        <Icon size={13} />
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </>
  );
  const cls = 'flex items-center gap-2.5 text-body text-ink-2 no-underline';
  return href ? (
    <a href={href} target={href.startsWith('http') ? '_blank' : undefined} rel="noopener noreferrer" className={cn(cls, 'transition-colors hover:text-accent')}>
      {inner}
    </a>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

export function ContactSummaryCard({ prospect }: { prospect: ProspectDetailResponse }) {
  const stage = prospect.prospectStage?.currentStage ?? 'new';
  const fullName = [prospect.firstName, prospect.lastName].filter(Boolean).join(' ') || '—';
  const initials = (
    ((prospect.firstName ?? '').charAt(0) + (prospect.lastName ?? '').charAt(0)) ||
    (prospect.email ?? prospect.companyName ?? '?').charAt(0)
  ).toUpperCase();
  const tone = AVATAR_TONES[(fullName.charCodeAt(0) || 0) % AVATAR_TONES.length];

  const tagsMut = useUpdateProspectTags(prospect.id);
  const dncMut = useMarkProspectDnc(prospect.id);

  const [tagInput, setTagInput] = React.useState('');
  const [dncOpen, setDncOpen] = React.useState(false);
  const [dncReason, setDncReason] = React.useState('');

  function addTag() {
    const v = tagInput.trim();
    if (!v) return;
    tagsMut.mutate({ add: [v] }, {
      onSuccess: () => setTagInput(''),
      onError: () => toast({ title: 'Failed to add tag', variant: 'destructive' }),
    });
  }

  function removeTag(t: string) {
    tagsMut.mutate({ remove: [t] }, {
      onError: () => toast({ title: 'Failed to remove tag', variant: 'destructive' }),
    });
  }

  function submitDnc() {
    dncMut.mutate(dncReason.trim() || undefined, {
      onSuccess: () => {
        setDncOpen(false);
        toast({ title: 'Marked do-not-contact' });
      },
      onError: () => toast({ title: 'Failed to mark DNC', variant: 'destructive' }),
    });
  }

  const hasContacts = prospect.email || prospect.linkedinUrl || prospect.phone || prospect.whatsapp || prospect.twitterUrl;

  return (
    <section className="rounded-2xl border border-line bg-bg-panel shadow-sm">
      {/* Identity */}
      <div className="flex items-start gap-3.5 p-5">
        <span className={cn('grid size-12 shrink-0 place-items-center rounded-full text-body font-semibold text-white', tone)}>{initials}</span>
        <div className="min-w-0 flex-1">
          <h1 className="m-0 truncate font-display text-[22px] font-normal leading-tight tracking-[-0.01em] text-ink">{fullName}</h1>
          {prospect.title && <div className="mt-0.5 text-body text-ink-2">{prospect.title}</div>}
          {prospect.companyName && <div className="text-body text-ink-3">{prospect.companyName}</div>}
          {prospect.location && <div className="text-xs text-ink-4">{prospect.location}</div>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-5 pb-4">
        <StatusPill tone={stageTone(stage)}>
          <span className="capitalize">{stage.replace(/_/g, ' ')}</span>
        </StatusPill>
        {prospect.doNotContact && <StatusPill tone="down">Do not contact</StatusPill>}
        {prospect.prospectStage?.stageEnteredAt && (
          <span className="text-xs text-ink-3">entered {formatRelative(prospect.prospectStage.stageEnteredAt)}</span>
        )}
      </div>

      {/* Stats */}
      <dl className="m-0 grid grid-cols-3 border-y border-line">
        <div className="px-5 py-3">
          <dt className="text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">Score</dt>
          <dd className="m-0 mt-1 font-mono text-[18px] font-semibold text-ink">{prospect.score ?? '—'}</dd>
        </div>
        <div className="border-l border-line px-4 py-3">
          <dt className="text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">Touches</dt>
          <dd className="m-0 mt-1 font-mono text-[18px] font-semibold text-ink">{prospect.prospectStage?.totalTouches ?? 0}</dd>
        </div>
        <div className="border-l border-line px-4 py-3">
          <dt className="text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">Replied</dt>
          <dd className="m-0 mt-1 text-body font-semibold text-ink">
            {prospect.prospectStage?.lastResponseAt ? formatRelative(prospect.prospectStage.lastResponseAt) : '—'}
          </dd>
        </div>
      </dl>

      <div className="space-y-5 p-5">
        {/* Contact */}
        {hasContacts && (
          <div>
            <div className={LABEL}>Contact</div>
            <div className="flex flex-col gap-2">
              {prospect.email && <ContactRow icon={Mail} href={`mailto:${prospect.email}`}>{prospect.email}</ContactRow>}
              {prospect.linkedinUrl && <ContactRow icon={Linkedin} href={prospect.linkedinUrl}>LinkedIn profile</ContactRow>}
              {prospect.phone && <ContactRow icon={Phone} href={`tel:${prospect.phone}`}>{prospect.phone}</ContactRow>}
              {prospect.whatsapp && <ContactRow icon={MessageCircle}>WhatsApp: {prospect.whatsapp}</ContactRow>}
              {prospect.twitterUrl && <ContactRow icon={Twitter} href={prospect.twitterUrl}>Twitter</ContactRow>}
            </div>
          </div>
        )}

        {/* Tags */}
        <div>
          <div className={LABEL}>Tags</div>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {prospect.customTags.length === 0 ? (
              <span className="text-xs text-ink-3">No tags yet</span>
            ) : (
              prospect.customTags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 rounded-tag bg-bg-soft py-1 pl-2 pr-1 text-xs text-ink-2">
                  {t}
                  <button
                    type="button"
                    onClick={() => removeTag(t)}
                    aria-label={`Remove tag ${t}`}
                    className="grid size-4 place-items-center rounded-full border-0 bg-transparent text-ink-4 hover:bg-black/10 hover:text-ink"
                  >
                    <X size={11} />
                  </button>
                </span>
              ))
            )}
          </div>
          <div className="flex gap-1.5">
            <Input
              placeholder="Add a tag"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addTag();
                }
              }}
              className="h-9 flex-1"
            />
            <Button type="button" variant="panel" size="sm" onClick={addTag} disabled={!tagInput.trim() || tagsMut.isPending}>
              Add
            </Button>
          </div>
        </div>

        {/* Source */}
        <div>
          <div className={LABEL}>Source</div>
          <div className="text-body capitalize text-ink-2">{String(prospect.sourceType).replace(/_/g, ' ')}</div>
          <div className="text-xs text-ink-3">Added {formatDate(prospect.createdAt)}</div>
        </div>
      </div>

      {!prospect.doNotContact && (
        <div className="border-t border-line px-5 py-3">
          <button
            type="button"
            onClick={() => setDncOpen(true)}
            className="border-0 bg-transparent p-0 text-xs font-medium text-ink-3 transition-colors hover:text-down"
          >
            Mark as do-not-contact
          </button>
        </div>
      )}

      <Dialog open={dncOpen} onOpenChange={setDncOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark do-not-contact</DialogTitle>
          </DialogHeader>
          <p className="m-0 text-xs leading-relaxed text-ink-3">Agents will stop reaching out to {fullName}. You can add a reason for the audit trail.</p>
          <Textarea value={dncReason} onChange={(e) => setDncReason(e.target.value)} placeholder="Reason (optional, but recommended)" rows={3} />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDncOpen(false)}>Cancel</Button>
            <Button variant="destructive" size="sm" onClick={submitDnc} disabled={dncMut.isPending}>
              {dncMut.isPending ? 'Saving…' : 'Mark do-not-contact'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
