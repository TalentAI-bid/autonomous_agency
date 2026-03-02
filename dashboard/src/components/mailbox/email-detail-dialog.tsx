'use client';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { formatDate } from '@/lib/utils';
import type { MailboxEmail } from '@/types';

interface EmailDetailDialogProps {
  email: MailboxEmail | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function classificationColor(c?: string): string {
  const map: Record<string, string> = {
    interested: 'bg-emerald-900/30 text-emerald-400',
    inquiry: 'bg-blue-900/30 text-blue-400',
    application: 'bg-indigo-900/30 text-indigo-400',
    partnership: 'bg-purple-900/30 text-purple-400',
    introduction: 'bg-cyan-900/30 text-cyan-400',
    objection: 'bg-orange-900/30 text-orange-400',
    not_now: 'bg-yellow-900/30 text-yellow-400',
    out_of_office: 'bg-zinc-800 text-zinc-400',
    unsubscribe: 'bg-red-900/30 text-red-400',
    bounce: 'bg-red-900/30 text-red-400',
    spam: 'bg-red-900/30 text-red-300',
    support_request: 'bg-amber-900/30 text-amber-400',
  };
  return map[c ?? ''] ?? 'bg-zinc-800 text-zinc-400';
}

export function EmailDetailDialog({ email, open, onOpenChange }: EmailDetailDialogProps) {
  if (!email) return null;

  const isSent = email.direction === 'sent';
  const date = email.sentAt ?? email.createdAt;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">{email.subject ?? '(No subject)'}</DialogTitle>
          <DialogDescription className="flex items-center gap-2 flex-wrap">
            {isSent ? (
              <span>To: {email.contactName ? `${email.contactName} <${email.toEmail}>` : email.toEmail}</span>
            ) : (
              <span>From: {email.contactName ? `${email.contactName} <${email.fromEmail}>` : email.fromEmail}</span>
            )}
            {email.classification && (
              <Badge className={classificationColor(email.classification)}>
                {email.classification.replace(/_/g, ' ')}
              </Badge>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-4 text-xs text-muted-foreground">
            {date && <span>{formatDate(date, 'MMM d, yyyy h:mm a')}</span>}
            {email.status && (
              <Badge variant="secondary" className="text-xs">{email.status}</Badge>
            )}
            {email.sentiment !== undefined && email.sentiment !== null && (
              <span>Sentiment: {email.sentiment > 0 ? '+' : ''}{email.sentiment.toFixed(2)}</span>
            )}
          </div>

          <div className="bg-muted/30 rounded-lg p-4 text-sm whitespace-pre-wrap leading-relaxed">
            {email.body ?? '(No content)'}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
