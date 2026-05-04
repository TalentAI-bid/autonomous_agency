'use client';

import { useState } from 'react';
import {
  useContactSequence,
  useStopSequence,
  useUnsubscribeContact,
  type FollowupSequenceData,
} from '@/hooks/use-followup';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { CheckCircle2, XCircle, Clock, MailX, Send, Loader2, AlertTriangle } from 'lucide-react';

interface SequencePanelProps {
  contactId: string;
}

const STATUS_LABEL: Record<string, { label: string; className: string }> = {
  in_sequence:    { label: 'In sequence', className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  pending:        { label: 'Pending',     className: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30' },
  active:         { label: 'Active',      className: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30' },
  completed:      { label: 'Completed',   className: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  stopped_manual: { label: 'Stopped',     className: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
  failed:         { label: 'Failed',      className: 'bg-red-500/15 text-red-400 border-red-500/30' },
  replied:        { label: 'Replied',     className: 'bg-blue-500/15 text-blue-400 border-blue-500/30' },
  bounced:        { label: 'Bounced',     className: 'bg-red-500/15 text-red-400 border-red-500/30' },
  unsubscribed:   { label: 'Unsubscribed', className: 'bg-amber-500/15 text-amber-400 border-amber-500/30' },
};

function formatLocal(dateStr: string | null, tz?: string | null): string {
  if (!dateStr) return '—';
  try {
    const d = new Date(dateStr);
    return d.toLocaleString(undefined, {
      timeZone: tz ?? undefined,
      dateStyle: 'medium',
      timeStyle: 'short',
    });
  } catch {
    return dateStr;
  }
}

export function SequencePanel({ contactId }: SequencePanelProps) {
  const { data, isLoading, error } = useContactSequence(contactId);
  const stopMutation = useStopSequence(contactId);
  const unsubMutation = useUnsubscribeContact(contactId);
  const { toast } = useToast();
  const [showUnsubConfirm, setShowUnsubConfirm] = useState(false);

  if (isLoading) return null;
  if (error || !data) return null;
  return <SequencePanelContent data={data} contactId={contactId} stopMutation={stopMutation} unsubMutation={unsubMutation} toast={toast} showUnsubConfirm={showUnsubConfirm} setShowUnsubConfirm={setShowUnsubConfirm} />;
}

function SequencePanelContent({
  data,
  stopMutation,
  unsubMutation,
  toast,
  showUnsubConfirm,
  setShowUnsubConfirm,
}: {
  data: FollowupSequenceData;
  contactId: string;
  stopMutation: ReturnType<typeof useStopSequence>;
  unsubMutation: ReturnType<typeof useUnsubscribeContact>;
  toast: ReturnType<typeof useToast>['toast'];
  showUnsubConfirm: boolean;
  setShowUnsubConfirm: (v: boolean) => void;
}) {
  const sequences = data.sequences ?? [];
  if (sequences.length === 0) return null;

  // Show only the first sequence — the typical case is one default sequence per contact.
  const seq = sequences[0]!;
  const cc = seq.campaignContact;
  const totalActiveSteps = seq.steps.filter((s) => s.active).length;
  const status = STATUS_LABEL[cc.status] ?? STATUS_LABEL.pending!;
  const isActive = cc.status === 'in_sequence' || cc.status === 'active' || cc.status === 'pending';
  const isUnsubscribed = data.contact.unsubscribed;

  const handleStop = async () => {
    try {
      const result = await stopMutation.mutateAsync({ reason: 'replied' });
      toast({
        title: 'Sequence stopped',
        description: `${result.stopped} sequence(s) stopped, ${result.cancelled} pending job(s) cancelled.`,
      });
    } catch (err) {
      toast({
        title: 'Stop failed',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    }
  };

  const handleUnsubscribe = async () => {
    setShowUnsubConfirm(false);
    try {
      const result = await unsubMutation.mutateAsync({ reason: 'unsubscribed' });
      toast({
        title: 'Contact unsubscribed',
        description: `Stopped ${result.stopped} sequence(s). This contact will not receive future emails.`,
      });
    } catch (err) {
      toast({
        title: 'Unsubscribe failed',
        description: err instanceof Error ? err.message : String(err),
        variant: 'destructive',
      });
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Send className="w-4 h-4" />
          Sequence
          <Badge className={`text-xs border ${status.className}`}>{status.label}</Badge>
        </CardTitle>
        {isActive && !isUnsubscribed && (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={handleStop}
              disabled={stopMutation.isPending}
              className="h-7 text-xs"
            >
              {stopMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <XCircle className="w-3 h-3 mr-1" />}
              Stop sequence (got a reply)
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setShowUnsubConfirm(true)}
              disabled={unsubMutation.isPending}
              className="h-7 text-xs text-red-400 border-red-500/40 hover:bg-red-500/10"
            >
              <MailX className="w-3 h-3 mr-1" />
              Unsubscribe
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {isUnsubscribed && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-amber-500" />
            <div>
              <p className="font-medium">This contact is unsubscribed</p>
              <p className="text-xs text-muted-foreground">No further emails will be sent automatically.</p>
            </div>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Progress</p>
            <p className="text-sm">
              Touch {cc.currentStep} of {Math.max(totalActiveSteps, 1)} sent
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Next scheduled</p>
            <p className="text-sm flex items-center gap-1">
              {cc.nextScheduledAt ? (
                <>
                  <Clock className="w-3 h-3 text-muted-foreground" />
                  {formatLocal(cc.nextScheduledAt, data.contact.timezone)}
                  {data.contact.timezone && <span className="text-xs text-muted-foreground"> · {data.contact.timezone}</span>}
                </>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </p>
          </div>
        </div>

        {cc.stoppedReason && (
          <div>
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-1">Stop reason</p>
            <p className="text-sm">{cc.stoppedReason}{cc.stoppedAt ? ` · ${formatLocal(cc.stoppedAt)}` : ''}</p>
          </div>
        )}

        {/* Touch timeline */}
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">Touches</p>
          <ol className="space-y-2">
            {seq.steps.sort((a, b) => a.stepNumber - b.stepNumber).map((step) => {
              const send = seq.sends.find((s) => (s.touchNumber ?? 1) === step.stepNumber);
              const sent = !!send;
              const isCurrent = !sent && step.stepNumber === cc.currentStep + 1 && cc.nextScheduledAt;
              const isInactive = !step.active;
              return (
                <li key={step.id} className="flex items-start gap-3 text-xs">
                  <div className="mt-0.5">
                    {sent ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> :
                     isCurrent ? <Clock className="w-4 h-4 text-amber-500" /> :
                     <div className="w-4 h-4 rounded-full border border-muted-foreground/30" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">Touch {step.stepNumber}</span>
                      <Badge variant="outline" className="text-[10px]">{step.stepType.replace(/_/g, ' ')}</Badge>
                      {isInactive && <Badge variant="outline" className="text-[10px] text-muted-foreground">disabled</Badge>}
                      {sent && <span className="text-muted-foreground">— sent {formatLocal(send!.sentAt, data.contact.timezone)}</span>}
                      {isCurrent && !sent && <span className="text-muted-foreground">— scheduled {formatLocal(cc.nextScheduledAt, data.contact.timezone)}</span>}
                    </div>
                    {sent && send!.subject && (
                      <p className="text-muted-foreground truncate mt-0.5">{send!.subject}</p>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>

        <p className="text-[10px] text-muted-foreground border-t pt-2">
          Campaign: {seq.campaign.name}{cc.lastActionAt ? ` · last touch ${formatLocal(cc.lastActionAt)}` : ''}
        </p>
      </CardContent>

      {/* Unsubscribe confirm dialog */}
      {showUnsubConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowUnsubConfirm(false)}>
          <div className="bg-background border rounded-lg p-6 max-w-sm w-full" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start gap-3 mb-4">
              <AlertTriangle className="w-5 h-5 text-red-400 mt-0.5 shrink-0" />
              <div>
                <h3 className="font-medium">Unsubscribe this contact?</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  This stops all sequences and prevents any future emails to this contact.
                </p>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => setShowUnsubConfirm(false)}>Cancel</Button>
              <Button size="sm" variant="outline" onClick={handleUnsubscribe} disabled={unsubMutation.isPending} className="text-red-400 border-red-500/40 hover:bg-red-500/10">
                {unsubMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <MailX className="w-3 h-3 mr-1" />}
                Unsubscribe
              </Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
