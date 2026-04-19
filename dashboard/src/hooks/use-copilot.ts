'use client';

import { useState, useCallback, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiPost, apiGet } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

interface CopilotMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  type: string;
  content: string;
  proposalData?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  orderIndex: number;
  createdAt: string;
}

interface CopilotSession {
  conversation: { id: string; status: string; extractedConfig?: Record<string, unknown> };
  messages: CopilotMessage[];
}

export function useCreateCopilotSession() {
  return useMutation({
    mutationFn: () => apiPost<CopilotSession>('/copilot/sessions'),
  });
}

export function useCopilotSession(id: string | null) {
  return useQuery({
    queryKey: ['copilot-session', id],
    queryFn: () => apiGet<CopilotSession>(`/copilot/sessions/${id}`),
    enabled: !!id,
    staleTime: 10000,
  });
}

export function useSendCopilotMessage(sessionId: string | null) {
  const qc = useQueryClient();
  const [streamingText, setStreamingText] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [statusText, setStatusText] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const sendStream = useCallback(
    async (content: string): Promise<{ message: CopilotMessage; profileData: Record<string, unknown> | null; productsData: Array<Record<string, unknown>> | null } | null> => {
      if (!sessionId) return null;

      const token = useAuthStore.getState().token;
      abortRef.current = new AbortController();
      setIsStreaming(true);
      setStreamingText('');
      setStatusText('');

      try {
        const response = await fetch(
          `${API_URL}/api/copilot/sessions/${sessionId}/messages/stream`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({ content }),
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
        let result: { message: CopilotMessage; profileData: Record<string, unknown> | null; productsData: Array<Record<string, unknown>> | null } | null = null;

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
                if (currentEvent === 'token') {
                  setStreamingText((prev) => prev + parsed.text);
                } else if (currentEvent === 'status') {
                  setStatusText(parsed.text ?? '');
                } else if (currentEvent === 'done') {
                  result = parsed;
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
        setStatusText('');
        qc.invalidateQueries({ queryKey: ['copilot-session', sessionId] });
        return result;
      } catch (err) {
        setIsStreaming(false);
        setStreamingText('');
        setStatusText('');
        if ((err as Error).name === 'AbortError') return null;
        throw err;
      }
    },
    [sessionId, qc],
  );

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { sendStream, streamingText, isStreaming, statusText, abort };
}

export function useApproveCopilotProfile(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiPost<{ profile: Record<string, unknown>; productsCreated: number }>(`/copilot/sessions/${sessionId}/approve`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['copilot-session', sessionId] });
      qc.invalidateQueries({ queryKey: ['company-profile'] });
      qc.invalidateQueries({ queryKey: ['products'] });
    },
  });
}
