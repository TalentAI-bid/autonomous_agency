'use client';

import { useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, apiGet, apiUpload } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import type { ConversationWithMessages, ChatMessage, PipelineProposalData } from '@/types/chat';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

export function useCreateConversation() {
  return useMutation({
    mutationFn: () => apiPost<ConversationWithMessages>('/chat/conversations'),
  });
}

export function useConversation(id: string | null) {
  return useQuery({
    queryKey: ['conversation', id],
    queryFn: () => apiGet<ConversationWithMessages>(`/chat/conversations/${id}`),
    enabled: !!id,
    staleTime: 10000,
  });
}

export function useSendMessage(conversationId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ content, files }: { content: string; files?: File[] }) => {
      const formData = new FormData();
      formData.append('content', content);
      if (files) {
        for (const file of files) {
          formData.append('files', file);
        }
      }
      return apiUpload<{ message: ChatMessage }>(
        `/chat/conversations/${conversationId}/messages`,
        formData,
      );
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
    },
  });
}

export function useSendMessageStream(conversationId: string | null) {
  const qc = useQueryClient();
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const sendStream = useCallback(
    async (
      content: string,
      files?: File[],
    ): Promise<{ message: ChatMessage; proposalData: PipelineProposalData | null } | null> => {
      if (!conversationId) return null;

      const token = useAuthStore.getState().token;
      const formData = new FormData();
      formData.append('content', content);
      if (files) {
        for (const file of files) {
          formData.append('files', file);
        }
      }

      abortRef.current = new AbortController();
      setIsStreaming(true);
      setStreamingText('');

      try {
        const response = await fetch(
          `${API_URL}/api/chat/conversations/${conversationId}/messages/stream`,
          {
            method: 'POST',
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: formData,
            signal: abortRef.current.signal,
            credentials: 'include',
          },
        );

        if (!response.ok) {
          throw new Error(`Stream request failed: ${response.status}`);
        }

        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        let buffer = '';
        let result: { message: ChatMessage; proposalData: PipelineProposalData | null } | null = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          let currentEvent = '';
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7).trim();
            } else if (line.startsWith('data: ')) {
              const data = line.slice(6);
              try {
                const parsed = JSON.parse(data);
                if (currentEvent === 'token' || (!currentEvent && parsed.text)) {
                  setStreamingText((prev) => prev + parsed.text);
                } else if (currentEvent === 'done') {
                  result = parsed as { message: ChatMessage; proposalData: PipelineProposalData | null };
                } else if (currentEvent === 'error') {
                  throw new Error(parsed.error || 'Stream error');
                }
              } catch (e) {
                if (e instanceof SyntaxError) {
                  // Skip malformed JSON
                } else {
                  throw e;
                }
              }
              currentEvent = '';
            }
          }
        }

        setIsStreaming(false);
        setStreamingText('');
        qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
        return result;
      } catch (err) {
        setIsStreaming(false);
        setStreamingText('');
        if ((err as Error).name === 'AbortError') return null;
        throw err;
      }
    },
    [conversationId, qc],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { sendStream, streamingText, isStreaming, abort };
}

export function useApproveProposal(conversationId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiPost<{ masterAgentId: string }>(`/chat/conversations/${conversationId}/approve`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['conversation', conversationId] });
      qc.invalidateQueries({ queryKey: ['agents'] });
    },
  });
}
