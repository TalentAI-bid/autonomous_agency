'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { FileText } from 'lucide-react';
import { PipelineProposalCard } from './pipeline-proposal-card';
import type { ChatMessage, PipelineProposalData, QuickReply } from '@/types/chat';

interface ChatBubbleProps {
  message: ChatMessage;
  isStreaming?: boolean;
  onApprove: () => void;
  onRequestChanges: () => void;
  isApproving: boolean;
  onQuickReply?: (replyText: string) => void;
}

export function ChatBubble({ message, isStreaming, onApprove, onRequestChanges, isApproving, onQuickReply }: ChatBubbleProps) {
  const isUser = message.role === 'user';
  const meta = message.metadata as Record<string, unknown> | undefined;
  const files = meta?.files as Array<{ fileName: string }> | undefined;

  // Quick-reply chips can arrive via either a typed slot or metadata.quickReplies.
  const quickReplies: QuickReply[] | undefined =
    message.quickReplies ?? (meta?.quickReplies as QuickReply[] | undefined);

  const [clickedChipId, setClickedChipId] = useState<string | null>(null);

  // Strip <pipeline_proposal> + <quick_replies> blocks and stray XML-like tags
  const displayContent = message.content
    .replace(/<pipeline_proposal>[\s\S]*?<\/pipeline_proposal>/g, '')
    .replace(/<quick_replies>[\s\S]*?<\/quick_replies>/g, '')
    .replace(/<\/?[a-z_]+>/gi, '')
    .trim();

  const handleChipClick = (chip: QuickReply) => {
    if (clickedChipId) return;
    setClickedChipId(chip.id);
    onQuickReply?.(chip.replyText);
  };

  return (
    <div className={cn('flex items-start gap-3 mb-4', isUser && 'flex-row-reverse')}>
      {/* Avatar */}
      {!isUser && (
        <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium shrink-0">
          AI
        </div>
      )}

      <div className={cn('max-w-[80%] space-y-2', isUser && 'items-end')}>
        {/* File badges */}
        {files && files.length > 0 && (
          <div className={cn('flex flex-wrap gap-1.5', isUser && 'justify-end')}>
            {files.map((f, i) => (
              <Badge key={i} variant="secondary" className="gap-1 text-[10px]">
                <FileText className="w-3 h-3" />
                {f.fileName}
              </Badge>
            ))}
          </div>
        )}

        {/* Message bubble */}
        {(displayContent || isStreaming) && (
          <div
            className={cn(
              'rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap',
              isUser
                ? 'bg-primary text-primary-foreground rounded-tr-sm'
                : 'bg-muted rounded-tl-sm',
            )}
          >
            {displayContent}
            {isStreaming && (
              <span className="inline-block w-1.5 h-4 ml-0.5 bg-foreground/70 animate-pulse align-text-bottom" />
            )}
          </div>
        )}

        {/* Quick-reply chips (below the text bubble, above proposal card) */}
        {!isUser && !isStreaming && quickReplies && quickReplies.length > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1" role="group" aria-label="Quick replies">
            {quickReplies.map((chip) => {
              const isClicked = clickedChipId === chip.id;
              const anyClicked = clickedChipId !== null;
              return (
                <Button
                  key={chip.id}
                  type="button"
                  size="sm"
                  variant={chip.variant === 'primary' ? 'default' : 'secondary'}
                  disabled={anyClicked}
                  onClick={() => handleChipClick(chip)}
                  className={cn(
                    'h-7 px-3 text-xs transition-opacity',
                    anyClicked && !isClicked && 'opacity-50',
                    isClicked && 'ring-1 ring-primary',
                  )}
                >
                  {chip.label}
                </Button>
              );
            })}
          </div>
        )}

        {/* Pipeline proposal card */}
        {!isStreaming && message.proposalData && (
          <PipelineProposalCard
            proposal={message.proposalData as PipelineProposalData}
            onApprove={onApprove}
            onRequestChanges={onRequestChanges}
            isApproving={isApproving}
          />
        )}

        {/* Pipeline approved badge */}
        {message.type === 'pipeline_approved' && (
          <Badge variant="success" className="gap-1">
            Pipeline launched successfully
          </Badge>
        )}
      </div>
    </div>
  );
}
