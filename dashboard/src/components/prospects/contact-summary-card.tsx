'use client';

import * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { toast } from '@/hooks/use-toast';
import { useUpdateProspectTags, useMarkProspectDnc } from '@/hooks/use-prospect';
import type { ProspectDetailResponse } from '@/lib/api/prospects';
import { formatRelative, formatDate } from '@/lib/utils';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export function ContactSummaryCard({ prospect }: { prospect: ProspectDetailResponse }) {
  const stage = prospect.prospectStage?.currentStage ?? 'new';
  const fullName = [prospect.firstName, prospect.lastName].filter(Boolean).join(' ') || '—';

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

  return (
    <div
      className="border border-border rounded-panel p-4 bg-bg-sub flex flex-col gap-3"
    >
      <div>
        <div className="text-[18px] font-semibold">{fullName}</div>
        {prospect.title && <div className="text-label text-ink-3">{prospect.title}</div>}
        {prospect.companyName && <div className="text-label text-ink-2">{prospect.companyName}</div>}
        {prospect.location && <div className="text-xs text-ink-3">{prospect.location}</div>}
      </div>

      <div className="flex gap-1.5 flex-wrap">
        <Badge variant={
          stage === 'engaged' || stage === 'qualified' || stage === 'closed_won' ? 'success' :
          stage === 'dnc' || stage === 'closed_lost' ? 'error' :
          stage === 'cold' ? 'warning' :
          'outline'
        }>
          {stage.replace(/_/g, ' ')}
        </Badge>
        {prospect.prospectStage?.stageEnteredAt && (
          <span className="text-xs text-ink-3">
            entered {formatRelative(prospect.prospectStage.stageEnteredAt)}
          </span>
        )}
        {prospect.doNotContact && <Badge variant="error">DNC</Badge>}
      </div>

      <div className="flex gap-3 text-xs text-ink-3">
        <span>Score: <strong className="text-ink">{prospect.score ?? '—'}</strong></span>
        <span>Touches: <strong className="text-ink">{prospect.prospectStage?.totalTouches ?? 0}</strong></span>
        {prospect.prospectStage?.lastResponseAt && (
          <span>Replied: <strong className="text-ink">{formatRelative(prospect.prospectStage.lastResponseAt)}</strong></span>
        )}
      </div>

      <div className="flex flex-col gap-1 text-label">
        {prospect.email && <a href={`mailto:${prospect.email}`}>{prospect.email}</a>}
        {prospect.linkedinUrl && <a href={prospect.linkedinUrl} target="_blank" rel="noopener noreferrer">LinkedIn ↗</a>}
        {prospect.phone && <a href={`tel:${prospect.phone}`}>{prospect.phone}</a>}
        {prospect.whatsapp && <span>WhatsApp: {prospect.whatsapp}</span>}
        {prospect.twitterUrl && <a href={prospect.twitterUrl} target="_blank" rel="noopener noreferrer">Twitter ↗</a>}
      </div>

      <div>
        <div className="text-2xs text-ink-3 uppercase tracking-[0.4px] mb-1.5">Tags</div>
        <div className="flex gap-1 flex-wrap mb-2">
          {prospect.customTags.length === 0 ? (
            <span className="text-xs text-ink-3">No tags</span>
          ) : prospect.customTags.map((t) => (
            <Badge key={t} variant="outline" className="cursor-pointer" onClick={() => removeTag(t)} title="Click to remove">
              {t} ×
            </Badge>
          ))}
        </div>
        <div className="flex gap-1.5">
          <Input
            placeholder="Add tag"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
            className="flex-1 text-label"
          />
          <Button onClick={addTag} disabled={!tagInput.trim() || tagsMut.isPending} size="sm">Add</Button>
        </div>
      </div>

      <div>
        <div className="text-2xs text-ink-3 uppercase tracking-[0.4px] mb-1.5">Source</div>
        <div className="text-label">{prospect.sourceType}</div>
        <div className="text-2xs text-ink-3">Added {formatDate(prospect.createdAt)}</div>
      </div>

      <div className="flex gap-1.5 flex-wrap mt-2">
        {!prospect.doNotContact && (
          <Button variant="outline" size="sm" onClick={() => setDncOpen(true)}>Mark DNC</Button>
        )}
      </div>

      <Dialog open={dncOpen} onOpenChange={setDncOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark do-not-contact</DialogTitle>
          </DialogHeader>
          <Textarea
            value={dncReason}
            onChange={(e) => setDncReason(e.target.value)}
            placeholder="Reason (optional, but recommended for audit)"
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDncOpen(false)}>Cancel</Button>
            <Button onClick={submitDnc} disabled={dncMut.isPending}>Confirm</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
