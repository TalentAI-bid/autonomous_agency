'use client';

import { useState, useCallback, useEffect } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { apiPost } from '@/lib/api';
import { Loader2, Send, RefreshCw, Copy, Handshake, Globe, Ban } from 'lucide-react';

type Track = 'NORMAL_OUTREACH' | 'PARTNERSHIP_OUTREACH' | 'COLLABORATION_OUTREACH' | 'SKIP';
type Classification = 'POTENTIAL_BUYER' | 'DIRECT_COMPETITOR' | 'ADJACENT_PARTNER' | 'WRONG_FIT';

interface DraftResponse {
  subject: string;
  body: string;
  track?: Track;
  classification?: Classification;
  partnershipAngle?: string;
  collaborationAngle?: string;
  proposedExchange?: string;
  skipReason?: string;
  warningMessage?: string;
}

interface EmailComposeModalProps {
  contactId: string;
  contactName: string;
  contactEmail?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function EmailComposeModal({
  contactId,
  contactName,
  contactEmail,
  open,
  onOpenChange,
}: EmailComposeModalProps) {
  const { toast } = useToast();
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [draftMeta, setDraftMeta] = useState<DraftResponse | null>(null);
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [drafted, setDrafted] = useState(false);

  const generateDraft = useCallback(async (opts: { forceNormal?: boolean } = {}) => {
    setDrafting(true);
    try {
      const result = await apiPost<DraftResponse>(
        `/contacts/${contactId}/draft-email`,
        opts.forceNormal ? { hint: 'force_normal: classify as POTENTIAL_BUYER and write a NORMAL_OUTREACH email' } : {},
      );
      setSubject(result.subject ?? '');
      setBody(result.body ?? '');
      setDraftMeta(result);
      setDrafted(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to generate draft';
      toast({ title: 'Draft failed', description: msg, variant: 'destructive' });
    } finally {
      setDrafting(false);
    }
  }, [contactId, toast]);

  const track = draftMeta?.track ?? 'NORMAL_OUTREACH';
  const classification = draftMeta?.classification ?? 'POTENTIAL_BUYER';
  const isSkip = track === 'SKIP';
  const isPartnership = track === 'PARTNERSHIP_OUTREACH';
  const isCollaboration = track === 'COLLABORATION_OUTREACH';

  const handleSend = useCallback(async () => {
    if (isSkip) {
      // SKIP track is acknowledge-only.
      onOpenChange(false);
      setSubject(''); setBody(''); setDraftMeta(null); setDrafted(false);
      return;
    }
    if (!subject.trim() || !body.trim()) {
      toast({ title: 'Missing fields', description: 'Subject and body are required', variant: 'destructive' });
      return;
    }
    setSending(true);
    try {
      await apiPost(`/contacts/${contactId}/send-email`, {
        subject,
        body,
        track: draftMeta?.track,
        classification: draftMeta?.classification,
        partnershipAngle: draftMeta?.partnershipAngle,
        collaborationAngle: draftMeta?.collaborationAngle,
        proposedExchange: draftMeta?.proposedExchange,
      });
      toast({
        title: isPartnership ? 'Partnership email sent' : isCollaboration ? 'Collaboration email sent' : 'Email sent',
        description: `Sent to ${contactEmail || contactName}`,
        variant: 'success',
      });
      onOpenChange(false);
      setSubject(''); setBody(''); setDraftMeta(null); setDrafted(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send email';
      toast({ title: 'Send failed', description: msg, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }, [contactId, contactEmail, contactName, subject, body, toast, onOpenChange, draftMeta, isSkip, isPartnership, isCollaboration]);

  const handleCopy = useCallback(() => {
    const text = `Subject: ${subject}\n\n${body}`;
    navigator.clipboard.writeText(text);
    toast({ title: 'Copied to clipboard' });
  }, [subject, body, toast]);

  // Auto-generate when parent opens us. Radix Dialog's onOpenChange does NOT
  // fire on programmatic open from the parent, so we drive it from a useEffect.
  useEffect(() => {
    if (open && !drafted && !drafting) {
      generateDraft();
    }
    if (!open) {
      setSubject('');
      setBody('');
      setDraftMeta(null);
      setDrafted(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleOpenChange = useCallback((isOpen: boolean) => {
    onOpenChange(isOpen);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Compose Email</DialogTitle>
          <DialogDescription>
            To: {contactName} {contactEmail && <Badge variant="outline" className="ml-1">{contactEmail}</Badge>}
          </DialogDescription>
        </DialogHeader>

        {drafting ? (
          <div className="space-y-4 py-6">
            <div className="flex items-center justify-center gap-2 text-muted-foreground">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Generating personalized draft...</span>
            </div>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : isSkip ? (
          <div className="space-y-4">
            <div className="rounded-lg border border-zinc-700 bg-zinc-900/40 p-4">
              <div className="flex items-center gap-2 mb-2">
                <Ban className="w-4 h-4 text-zinc-400" />
                <h3 className="text-sm font-semibold text-zinc-200">Skipped — Wrong Fit</h3>
              </div>
              <p className="text-sm text-zinc-400">
                {draftMeta?.skipReason || 'Classified as wrong fit — no commercial relationship makes sense.'}
              </p>
              <p className="text-xs text-zinc-500 mt-2">
                If this looks wrong (e.g. the company does actually hire engineers), regenerate a normal pitch below.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {(isPartnership || isCollaboration) && draftMeta?.warningMessage && (
              <div
                className={`rounded-lg border p-3 ${
                  isPartnership
                    ? 'border-amber-700/50 bg-amber-950/30'
                    : 'border-blue-700/50 bg-blue-950/30'
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  {isPartnership ? (
                    <Handshake className="w-4 h-4 text-amber-400" />
                  ) : (
                    <Globe className="w-4 h-4 text-blue-400" />
                  )}
                  <h3 className={`text-sm font-semibold ${isPartnership ? 'text-amber-300' : 'text-blue-300'}`}>
                    {isPartnership ? 'Partnership Email — Direct Competitor Detected' : 'Collaboration Email — Adjacent Partner'}
                  </h3>
                </div>
                <p className={`text-xs ${isPartnership ? 'text-amber-200/80' : 'text-blue-200/80'}`}>
                  {draftMeta.warningMessage}
                </p>
                {isPartnership && draftMeta.partnershipAngle && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    <Badge variant="warning" className="text-[10px]">Angle: {draftMeta.partnershipAngle}</Badge>
                    {draftMeta.proposedExchange && (
                      <Badge variant="outline" className="text-[10px]" title={draftMeta.proposedExchange}>
                        Exchange: {draftMeta.proposedExchange.slice(0, 40)}{draftMeta.proposedExchange.length > 40 ? '…' : ''}
                      </Badge>
                    )}
                  </div>
                )}
                {isCollaboration && draftMeta.collaborationAngle && (
                  <Badge variant="blue" className="text-[10px] mt-2">Angle: {draftMeta.collaborationAngle}</Badge>
                )}
              </div>
            )}
            <div>
              <label className="text-sm font-medium mb-1.5 block">Subject</label>
              <Input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Email subject..."
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Body</label>
              <Textarea
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="Email body..."
                rows={10}
                className="resize-y"
              />
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {isSkip ? (
            <>
              <Button variant="outline" size="sm" onClick={() => generateDraft({ forceNormal: true })} disabled={drafting}>
                <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${drafting ? 'animate-spin' : ''}`} /> Generate normal pitch anyway
              </Button>
              <Button size="sm" onClick={handleSend}>
                Acknowledge &amp; close
              </Button>
            </>
          ) : (
            <>
              <Button variant="outline" size="sm" onClick={handleCopy} disabled={!subject && !body}>
                <Copy className="w-3.5 h-3.5 mr-1.5" /> Copy
              </Button>
              <Button variant="outline" size="sm" onClick={() => generateDraft()} disabled={drafting}>
                <RefreshCw className={`w-3.5 h-3.5 mr-1.5 ${drafting ? 'animate-spin' : ''}`} /> Regenerate
              </Button>
              <Button
                size="sm"
                onClick={handleSend}
                disabled={sending || drafting || !contactEmail}
              >
                {sending ? (
                  <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
                ) : (
                  <Send className="w-3.5 h-3.5 mr-1.5" />
                )}
                {isPartnership ? 'Send Partnership Email' : isCollaboration ? 'Send Collaboration Email' : 'Send'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
