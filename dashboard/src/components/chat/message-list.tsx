'use client';

import { useRef, useEffect } from 'react';
import { ChatBubble } from './chat-bubble';
import { TypingIndicator } from './typing-indicator';
import type { ChatMessage } from '@/types/chat';

interface MessageListProps {
  messages: ChatMessage[];
  isLoading: boolean;
  streamingText?: string;
  onApprove: () => void;
  onRequestChanges: () => void;
  isApproving: boolean;
  onQuickReply?: (replyText: string) => void;
}

export function MessageList({
  messages,
  isLoading,
  streamingText,
  onApprove,
  onRequestChanges,
  isApproving,
  onQuickReply,
}: MessageListProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, isLoading, streamingText]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6">
      {messages.map((msg) => (
        <ChatBubble
          key={msg.id}
          message={msg}
          onApprove={onApprove}
          onRequestChanges={onRequestChanges}
          isApproving={isApproving}
          onQuickReply={onQuickReply}
        />
      ))}
      {streamingText !== undefined && (
        <ChatBubble
          message={{
            id: 'streaming',
            conversationId: '',
            role: 'assistant',
            type: 'text',
            content: streamingText,
            orderIndex: -1,
            createdAt: new Date().toISOString(),
          }}
          isStreaming
          onApprove={onApprove}
          onRequestChanges={onRequestChanges}
          isApproving={isApproving}
        />
      )}
      {isLoading && <TypingIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}
