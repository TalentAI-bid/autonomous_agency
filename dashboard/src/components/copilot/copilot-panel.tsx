'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  useCreateCopilotSession,
  useCopilotSession,
  useSendCopilotMessage,
  useApproveCopilotProfile,
} from '@/hooks/use-copilot';
import { Button } from '@/components/ui/button';
import { useToast } from '@/hooks/use-toast';
import { X, Send, Loader2, Check, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CopilotPanelProps {
  open: boolean;
  onClose: () => void;
}

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  profileData?: Record<string, unknown> | null;
}

export function CopilotPanel({ open, onClose }: CopilotPanelProps) {
  const { toast } = useToast();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [profileReady, setProfileReady] = useState(false);
  const [productsCount, setProductsCount] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const initialized = useRef(false);

  const createSession = useCreateCopilotSession();
  const sessionQuery = useCopilotSession(sessionId);
  const { sendStream, streamingText, isStreaming, statusText } = useSendCopilotMessage(sessionId);
  const approveProfile = useApproveCopilotProfile(sessionId);

  // Initialize session when panel opens
  useEffect(() => {
    if (!open || initialized.current) return;
    initialized.current = true;

    createSession.mutate(undefined, {
      onSuccess: (data) => {
        setSessionId(data.conversation.id);
        setMessages(data.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
        })));
      },
      onError: () => {
        toast({ title: 'Failed to start AI assistant', variant: 'destructive' });
      },
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sync messages from query
  useEffect(() => {
    if (sessionQuery.data?.messages) {
      setMessages(sessionQuery.data.messages.map((m) => ({
        id: m.id,
        role: m.role as 'user' | 'assistant',
        content: m.content,
        profileData: m.proposalData,
      })));
      // Check if any message has profile data
      const hasProfile = sessionQuery.data.messages.some((m) => m.proposalData);
      setProfileReady(hasProfile);
    }
  }, [sessionQuery.data]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, streamingText]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || isSending || isStreaming) return;

    const userMessage: Message = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: input.trim(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsSending(true);

    try {
      const result = await sendStream(userMessage.content);
      if (result?.profileData) {
        setProfileReady(true);
      }
      if (result?.productsData) {
        setProductsCount(result.productsData.length);
      }
    } catch {
      toast({ title: 'Failed to send message', variant: 'destructive' });
    } finally {
      setIsSending(false);
    }
  }, [input, isSending, isStreaming, sendStream, toast]);

  const handleApprove = useCallback(async () => {
    try {
      const result = await approveProfile.mutateAsync();
      const pCount = (result as { productsCreated?: number })?.productsCreated ?? 0;
      const msg = pCount > 0
        ? `Company profile saved and ${pCount} product(s) created!`
        : 'Company profile saved!';
      toast({ title: msg, variant: 'success' });
      onClose();
      // Reset for next open
      initialized.current = false;
      setSessionId(null);
      setMessages([]);
      setProfileReady(false);
      setProductsCount(0);
    } catch {
      toast({ title: 'Failed to save profile', variant: 'destructive' });
    }
  }, [approveProfile, toast, onClose]);

  // Strip XML tags from display content
  function cleanContent(content: string): string {
    return content
      .replace(/<company_profile>[\s\S]*?<\/company_profile>/g, '')
      .replace(/<products>[\s\S]*?<\/products>/g, '')
      .trim();
  }

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-[420px] bg-background border-l border-border shadow-2xl z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <h2 className="font-semibold text-sm">AI Setup Assistant</h2>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} className="h-8 w-8">
          <X className="w-4 h-4" />
        </Button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {createSession.isPending && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin" />
            Starting assistant...
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              'flex',
              msg.role === 'user' ? 'justify-end' : 'justify-start',
            )}
          >
            <div
              className={cn(
                'max-w-[85%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap',
                msg.role === 'user'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted',
              )}
            >
              {msg.role === 'assistant' ? cleanContent(msg.content) : msg.content}
            </div>
          </div>
        ))}

        {/* Streaming indicator */}
        {(isStreaming || statusText) && (
          <div className="flex justify-start">
            <div className="max-w-[85%] rounded-lg px-3 py-2 text-sm bg-muted whitespace-pre-wrap">
              {statusText && (
                <div className="flex items-center gap-1.5 text-muted-foreground mb-1">
                  <Loader2 className="w-3 h-3 animate-spin" />
                  {statusText}
                </div>
              )}
              {streamingText ? cleanContent(streamingText) : (
                !statusText && <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              )}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Profile apply bar */}
      {profileReady && (
        <div className="px-4 py-3 border-t border-border bg-primary/5">
          <div className="flex items-center gap-2">
            <div className="flex-1">
              <p className="text-sm font-medium">
                Profile ready{productsCount > 0 ? ` — ${productsCount} product(s) detected` : ''}
              </p>
              <p className="text-xs text-muted-foreground">
                {productsCount > 0
                  ? 'Apply to auto-fill your profile and create products'
                  : 'Apply it to auto-fill your company profile'}
              </p>
            </div>
            <Button
              size="sm"
              onClick={handleApprove}
              disabled={approveProfile.isPending}
              className="gap-1.5"
            >
              {approveProfile.isPending ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Check className="w-3.5 h-3.5" />
              )}
              Apply to Profile
            </Button>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="px-4 py-3 border-t border-border">
        <form
          onSubmit={(e) => { e.preventDefault(); handleSend(); }}
          className="flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message..."
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            disabled={isStreaming || isSending}
          />
          <Button
            type="submit"
            size="icon"
            disabled={isStreaming || isSending || !input.trim()}
            className="h-9 w-9 shrink-0"
          >
            {isSending || isStreaming ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </form>
      </div>
    </div>
  );
}
