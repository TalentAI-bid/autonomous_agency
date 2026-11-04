'use client';

import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Check, FileText, Sparkles } from 'lucide-react';
import { PipelineProposalCard } from './pipeline-proposal-card';
import type { ChatMessage, PipelineProposalData, QuickReply } from '@/types/chat';

export function AiAvatar() {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-weak text-accent">
      <Sparkles size={14} />
    </span>
  );
}

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
    <div className={cn('mb-5 flex items-start gap-3', isUser && 'flex-row-reverse')}>
      {!isUser && <AiAvatar />}

      <div className={cn('min-w-0 max-w-[84%] space-y-2', isUser && 'flex flex-col items-end')}>
        {/* Attached files */}
        {files && files.length > 0 && (
          <div className={cn('flex flex-wrap gap-1.5', isUser && 'justify-end')}>
            {files.map((f, i) => (
              <Badge key={i} variant="outline" className="bg-bg-panel font-normal">
                <FileText size={12} className="text-ink-3" />
                {f.fileName}
              </Badge>
            ))}
          </div>
        )}

        {/* Message bubble */}
        {(displayContent || isStreaming) && (
          <div
            className={cn(
              'whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-body leading-relaxed',
              isUser ? 'rounded-tr-sm bg-accent text-white' : 'rounded-tl-sm bg-bg-soft text-ink',
            )}
          >
            {displayContent}
            {isStreaming && <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-ink-3 align-text-bottom" />}
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
                  size="dense"
                  variant={chip.variant === 'primary' ? 'brand' : 'panel'}
                  disabled={anyClicked}
                  onClick={() => handleChipClick(chip)}
                  className={cn('h-8 rounded-full px-3.5 text-xs font-medium', anyClicked && !isClicked && 'opacity-50')}
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

        {message.type === 'pipeline_approved' && (
          <Badge variant="up">
            <Check size={12} strokeWidth={2.5} /> Pipeline launched successfully
          </Badge>
        )}
      </div>
    </div>
  );
}
