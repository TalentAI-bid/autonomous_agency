'use client';

import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription,
} from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useMailboxThread, useSummarizeThread } from '@/hooks/use-mailbox';
import { formatDate } from '@/lib/utils';
import { Sparkles, ExternalLink, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import type { MailboxThread } from '@/types';

interface ThreadDetailDialogProps {
  thread: MailboxThread | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const priorityColors: Record<string, string> = {
  high: 'bg-red-900/30 text-red-400',
  medium: 'bg-yellow-900/30 text-yellow-400',
  low: 'bg-zinc-800 text-zinc-400',
};

const statusColors: Record<string, string> = {
  active: 'bg-emerald-900/30 text-emerald-400',
  needs_action: 'bg-red-900/30 text-red-400',
  waiting: 'bg-blue-900/30 text-blue-400',
  archived: 'bg-zinc-800 text-zinc-400',
};

export function ThreadDetailDialog({ thread, open, onOpenChange }: ThreadDetailDialogProps) {
  const { data: detail, isLoading } = useMailboxThread(open && thread ? thread.id : null);
  const summarize = useSummarizeThread();

  if (!thread) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            {thread.subject ?? '(No subject)'}
            <Badge className={priorityColors[thread.priority] ?? ''}>
              {thread.priority}
            </Badge>
            <Badge className={statusColors[thread.status] ?? ''}>
              {thread.status.replace(/_/g, ' ')}
            </Badge>
          </DialogTitle>
          <DialogDescription className="flex items-center gap-2 flex-wrap">
            {thread.contactName && <span>{thread.contactName}</span>}
            {thread.contactEmail && <span className="text-xs">({thread.contactEmail})</span>}
            <span className="text-xs">{thread.messageCount} message{thread.messageCount !== 1 ? 's' : ''}</span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* CRM Deal Link */}
          {thread.deal && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/30 border border-border/50">
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: thread.deal.stage?.color ?? '#6366f1' }}
              />
              <span className="text-sm font-medium">{thread.deal.title}</span>
              {thread.deal.stage?.name && (
                <Badge variant="secondary" className="text-xs">{thread.deal.stage.name}</Badge>
              )}
              {thread.deal.value && (
                <span className="text-xs text-muted-foreground">${thread.deal.value}</span>
              )}
              <Link
                href={`/crm?dealId=${thread.deal.id}`}
                className="ml-auto text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1"
              >
                View Deal <ExternalLink className="w-3 h-3" />
              </Link>
            </div>
          )}

          {/* Summary & Next Action */}
          {(detail?.summary || detail?.nextAction) && (
            <div className="p-3 rounded-lg bg-indigo-500/5 border border-indigo-500/20">
              {detail.summary && (
                <p className="text-sm text-muted-foreground mb-1">{detail.summary}</p>
              )}
              {detail.nextAction && (
                <p className="text-sm flex items-center gap-1">
                  <ArrowRight className="w-3 h-3 text-indigo-400" />
                  <span className="font-medium text-indigo-300">Next:</span> {detail.nextAction}
                </p>
              )}
            </div>
          )}

          {/* Summarize Button */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => summarize.mutate(thread.id)}
              disabled={summarize.isPending}
            >
              <Sparkles className="w-3.5 h-3.5 mr-1.5" />
              {summarize.isPending ? 'Summarizing...' : 'Summarize Thread'}
            </Button>
          </div>

          {/* Messages */}
          {isLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
            </div>
          ) : detail?.messages && detail.messages.length > 0 ? (
            <div className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Conversation
              </p>
              {detail.messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`rounded-lg p-4 text-sm ${
                    msg.direction === 'sent'
                      ? 'bg-blue-500/10 border border-blue-500/20 ml-6'
                      : 'bg-muted/30 border border-border/50 mr-6'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px]">
                        {msg.direction === 'sent' ? 'Sent' : 'Received'}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {msg.fromEmail}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground">
                      {formatDate(msg.date, 'MMM d, h:mm a')}
                    </span>
                  </div>
                  {msg.subject && (
                    <p className="text-xs text-muted-foreground mb-1">Subject: {msg.subject}</p>
                  )}
                  <div className="whitespace-pre-wrap leading-relaxed">
                    {msg.body ?? '(No content)'}
                  </div>
                  {msg.classification && (
                    <Badge className="mt-2 text-[10px]">{msg.classification.replace(/_/g, ' ')}</Badge>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground text-center py-4">No messages in this thread yet</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
