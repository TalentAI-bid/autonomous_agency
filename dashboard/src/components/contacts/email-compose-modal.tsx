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
import { Loader2, Send, RefreshCw, Copy } from 'lucide-react';

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
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [drafted, setDrafted] = useState(false);

  const generateDraft = useCallback(async () => {
    setDrafting(true);
    try {
      const result = await apiPost<{ subject: string; body: string }>(
        `/contacts/${contactId}/draft-email`,
        {},
      );
      setSubject(result.subject);
      setBody(result.body);
      setDrafted(true);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to generate draft';
      toast({ title: 'Draft failed', description: msg, variant: 'destructive' });
    } finally {
      setDrafting(false);
    }
  }, [contactId, toast]);

  const handleSend = useCallback(async () => {
    if (!subject.trim() || !body.trim()) {
      toast({ title: 'Missing fields', description: 'Subject and body are required', variant: 'destructive' });
      return;
    }
    setSending(true);
    try {
      await apiPost(`/contacts/${contactId}/send-email`, { subject, body });
      toast({
        title: 'Email sent',
        description: `Email sent to ${contactEmail || contactName}`,
        variant: 'success',
      });
      onOpenChange(false);
      setSubject('');
      setBody('');
      setDrafted(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to send email';
      toast({ title: 'Send failed', description: msg, variant: 'destructive' });
    } finally {
      setSending(false);
    }
  }, [contactId, contactEmail, contactName, subject, body, toast, onOpenChange]);

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
        ) : (
          <div className="space-y-4">
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
          <Button variant="outline" size="sm" onClick={handleCopy} disabled={!subject && !body}>
            <Copy className="w-3.5 h-3.5 mr-1.5" /> Copy
          </Button>
          <Button variant="outline" size="sm" onClick={generateDraft} disabled={drafting}>
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
            Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
