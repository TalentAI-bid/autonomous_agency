'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useCreateConversation, useConversation, useSendMessageStream, useApproveProposal } from '@/hooks/use-chat';
import { useToast } from '@/hooks/use-toast';
import { MessageList } from './message-list';
import { ChatInput } from './chat-input';
import { Loader2 } from 'lucide-react';
import type { ChatMessage } from '@/types/chat';

interface ChatInterfaceProps {
  onAgentCreated?: (id: string) => void;
}

export function ChatInterface({ onAgentCreated }: ChatInterfaceProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const initialized = useRef(false);

  const createConversation = useCreateConversation();
  const conversationQuery = useConversation(conversationId);
  const { sendStream, streamingText, isStreaming } = useSendMessageStream(conversationId);
  const approveProposal = useApproveProposal(conversationId);

  // Initialize conversation on mount
  useEffect(() => {
    if (initialized.current) return;
    initialized.current = true;

    createConversation.mutate(undefined, {
      onSuccess: (data) => {
        setConversationId(data.conversation.id);
        setMessages(data.messages);
      },
      onError: () => {
        toast({ title: 'Failed to start conversation', variant: 'destructive' });
      },
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      <div className="h-[calc(100vh-8rem)] flex flex-col items-center justify-center gap-3">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Starting conversation...</p>
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-8rem)] flex flex-col rounded-lg border bg-background">
      <MessageList
        messages={messages}
        isLoading={isSending && !isStreaming}
        streamingText={isStreaming ? streamingText : undefined}
        onApprove={handleApprove}
        onRequestChanges={handleRequestChanges}
        isApproving={approveProposal.isPending}
      />
      <ChatInput
        onSend={handleSend}
        disabled={isSending || isStreaming || approveProposal.isPending}
      />
    </div>
  );
}
