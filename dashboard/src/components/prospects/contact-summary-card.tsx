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
      style={{
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 16,
        background: 'var(--bg-2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div>
        <div style={{ fontSize: 18, fontWeight: 600 }}>{fullName}</div>
        {prospect.title && <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{prospect.title}</div>}
        {prospect.companyName && <div style={{ fontSize: 12, color: 'var(--ink-2)' }}>{prospect.companyName}</div>}
        {prospect.location && <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{prospect.location}</div>}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <Badge variant={
          stage === 'engaged' || stage === 'qualified' || stage === 'closed_won' ? 'success' :
          stage === 'dnc' || stage === 'closed_lost' ? 'error' :
          stage === 'cold' ? 'warning' :
          'outline'
        }>
          {stage.replace(/_/g, ' ')}
        </Badge>
        {prospect.prospectStage?.stageEnteredAt && (
          <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            entered {formatRelative(prospect.prospectStage.stageEnteredAt)}
          </span>
        )}
        {prospect.doNotContact && <Badge variant="error">DNC</Badge>}
      </div>

      <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--ink-3)' }}>
        <span>Score: <strong style={{ color: 'var(--ink-1)' }}>{prospect.score ?? '—'}</strong></span>
        <span>Touches: <strong style={{ color: 'var(--ink-1)' }}>{prospect.prospectStage?.totalTouches ?? 0}</strong></span>
        {prospect.prospectStage?.lastResponseAt && (
          <span>Replied: <strong style={{ color: 'var(--ink-1)' }}>{formatRelative(prospect.prospectStage.lastResponseAt)}</strong></span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
        {prospect.email && <a href={`mailto:${prospect.email}`}>{prospect.email}</a>}
        {prospect.linkedinUrl && <a href={prospect.linkedinUrl} target="_blank" rel="noopener noreferrer">LinkedIn ↗</a>}
        {prospect.phone && <a href={`tel:${prospect.phone}`}>{prospect.phone}</a>}
        {prospect.whatsapp && <span>WhatsApp: {prospect.whatsapp}</span>}
        {prospect.twitterUrl && <a href={prospect.twitterUrl} target="_blank" rel="noopener noreferrer">Twitter ↗</a>}
      </div>

      <div>
        <div style={{ fontSize: 10, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Tags</div>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 8 }}>
          {prospect.customTags.length === 0 ? (
            <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>No tags</span>
          ) : prospect.customTags.map((t) => (
            <Badge key={t} variant="outline" style={{ cursor: 'pointer' }} onClick={() => removeTag(t)} title="Click to remove">
              {t} ×
            </Badge>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <Input
            placeholder="Add tag"
            value={tagInput}
            onChange={(e) => setTagInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }}
            style={{ flex: 1, fontSize: 12 }}
          />
          <Button onClick={addTag} disabled={!tagInput.trim() || tagsMut.isPending} size="sm">Add</Button>
        </div>
      </div>

      <div>
        <div style={{ fontSize: 10, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6 }}>Source</div>
        <div style={{ fontSize: 12 }}>{prospect.sourceType}</div>
        <div style={{ fontSize: 10, color: 'var(--ink-3)' }}>Added {formatDate(prospect.createdAt)}</div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
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
