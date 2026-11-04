'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useCreateConversation, useConversation, useSendMessageStream, useApproveProposal } from '@/hooks/use-chat';
import { useToast } from '@/hooks/use-toast';
import { MessageList } from './message-list';
import { ChatInput } from './chat-input';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ChatMessage } from '@/types/chat';

const STARTERS = [
  'Manufacturers in France who need a distributor',
  'Design and marketing agencies in Tunisia',
  'Hire senior React engineers in Berlin',
];

interface ChatInterfaceProps {
  onAgentCreated?: (id: string) => void;
}

export function ChatInterface({ onAgentCreated }: ChatInterfaceProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const startRef = useRef<ReturnType<typeof createConversation.mutateAsync> | null>(null);
  const [startFailed, setStartFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const createConversation = useCreateConversation();
  const conversationQuery = useConversation(conversationId);
  const { sendStream, streamingText, isStreaming } = useSendMessageStream(conversationId);
  const approveProposal = useApproveProposal(conversationId);

  // Start the conversation once. The request is kept in a ref so React Strict
  // Mode's dev-only remount re-attaches to the same request instead of
  // skipping it (which left the page loading forever) or creating a second one.
  useEffect(() => {
    let active = true;
    if (!startRef.current) startRef.current = createConversation.mutateAsync();
    startRef.current
      .then((data) => {
        if (!active) return;
        setConversationId(data.conversation.id);
        setMessages(data.messages);
      })
      .catch(() => {
        if (!active) return;
        setStartFailed(true);
        toast({ title: 'Failed to start conversation', variant: 'destructive' });
      });
    return () => {
      active = false;
    };
  }, [attempt]); // eslint-disable-line react-hooks/exhaustive-deps

  function retryStart() {
    startRef.current = null;
    setStartFailed(false);
    setAttempt((n) => n + 1);
  }

  // Sync messages when conversation query updates
  useEffect(() => {
    if (conversationQuery.data?.messages) {
      setMessages(conversationQuery.data.messages);
    }
  }, [conversationQuery.data]);

  const handleSend = useCallback(async (content: string, files?: File[]) => {
    if (!conversationId) return;
    setIsSending(true);

    // Optimistically add user message
    const optimisticMsg: ChatMessage = {
      id: `temp-${Date.now()}`,
      conversationId,
      role: 'user',
      type: files?.length ? 'file_upload' : 'text',
      content,
      metadata: files?.length ? { files: files.map((f) => ({ fileName: f.name })) } : undefined,
      orderIndex: messages.length,
      createdAt: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    try {
      const result = await sendStream(content, files);
      if (result?.message) {
        setMessages((prev) => {
          // Replace any optimistic messages and add the final assistant message
          return [...prev, result.message];
        });
      }
    } catch {
      toast({ title: 'Failed to send message', variant: 'destructive' });
    } finally {
      setIsSending(false);
    }
  }, [conversationId, messages.length, sendStream, toast]);

  const handleApprove = useCallback(() => {
    if (!conversationId) return;
    approveProposal.mutate(undefined, {
      onSuccess: (data) => {
        toast({ title: 'Pipeline launched successfully!' });
        if (onAgentCreated) {
          onAgentCreated(data.masterAgentId);
        } else {
          router.push(`/agents/${data.masterAgentId}`);
        }
      },
      onError: () => {
        toast({ title: 'Failed to launch pipeline', variant: 'destructive' });
      },
    });
  }, [conversationId, approveProposal, toast, onAgentCreated, router]);

  const handleRequestChanges = useCallback(() => {
    const textarea = document.querySelector('textarea');
    textarea?.focus();
  }, []);

  // Loading state while creating the initial conversation
  if (!conversationId) {
    return (
      <div className="flex h-[calc(100vh-10rem)] min-h-[420px] flex-col items-center justify-center gap-3 rounded-2xl border border-line bg-bg-panel px-6 text-center shadow-sm">
        {startFailed ? (
          <>
            <p className="m-0 text-body font-medium text-ink">The assistant could not start.</p>
            <p className="m-0 max-w-[380px] text-xs text-ink-3">
              The conversation request failed. Check that the backend is running and an AI provider key is configured, then try again.
            </p>
            <Button type="button" variant="brand" onClick={retryStart} className="mt-1">
              Try again
            </Button>
          </>
        ) : (
          <>
            <Loader2 size={22} className="animate-spin text-accent" />
            <p className="m-0 text-body text-ink-3">Starting the conversation…</p>
            <p className="m-0 text-xs text-ink-4">The assistant writes its first message, which can take a few seconds.</p>
          </>
        )}
      </div>
    );
  }

  // Offer starting points until the user has said something.
  const showStarters = !messages.some((m) => m.role === 'user') && !isSending && !isStreaming;

  return (
    <div className="flex h-[calc(100vh-10rem)] min-h-[420px] flex-col overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm">
      <MessageList
        messages={messages}
        isLoading={isSending && !isStreaming}
        streamingText={isStreaming ? streamingText : undefined}
        onApprove={handleApprove}
        onRequestChanges={handleRequestChanges}
        isApproving={approveProposal.isPending}
        onQuickReply={(replyText) => { void handleSend(replyText); }}
      />
      {showStarters && (
        <div className="px-4 pb-3">
          <div className="mb-2 text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">Try one of these</div>
          <div className="flex flex-wrap gap-2">
            {STARTERS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => void handleSend(s)}
                className="rounded-full border border-line bg-bg-panel px-3.5 py-1.5 text-left text-xs text-ink-2 transition-colors hover:border-accent-line hover:bg-accent-tint hover:text-accent-fg"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}
      <ChatInput
        onSend={handleSend}
        disabled={isSending || isStreaming || approveProposal.isPending}
      />
    </div>
  );
}
