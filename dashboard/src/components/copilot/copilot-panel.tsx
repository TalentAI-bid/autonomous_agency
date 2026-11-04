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

import { Input } from '@/components/ui/input';
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

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const busy = isStreaming || isSending;
  const hasUserMessage = messages.some((m) => m.role === 'user');
  const starters = [
    'Describe my company',
    'Add the products we sell',
    'Who is our ideal customer?',
  ];

  const AssistantAvatar = () => (
    <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent-weak text-accent">
      <Sparkles size={12} />
    </span>
  );

  return (
    <div className="fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-line bg-bg-panel shadow-2xl sm:w-[440px]" role="dialog" aria-label="AI Setup Assistant">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-line px-4 py-3.5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent-weak text-accent">
          <Sparkles size={16} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="m-0 text-body font-semibold leading-tight text-ink">AI Setup Assistant</h2>
          <p className="m-0 text-xs text-ink-3">Answer a few questions and it fills in your company profile.</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close assistant"
          className="grid size-8 shrink-0 place-items-center rounded-lg border-0 bg-transparent text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        >
          <X size={16} />
        </button>
      </div>

      {/* Messages */}
      <div className="scroll-thin flex-1 space-y-4 overflow-y-auto bg-bg-sub px-4 py-4">
        {createSession.isPending && (
          <div className="flex items-center gap-2 text-body text-ink-3">
            <Loader2 className="size-4 animate-spin" />
            Starting assistant…
          </div>
        )}

        {messages.map((msg) => (
          <div key={msg.id} className={cn('flex gap-2', msg.role === 'user' ? 'justify-end' : 'justify-start')}>
            {msg.role === 'assistant' && <AssistantAvatar />}
            <div
              className={cn(
                'max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2.5 text-body leading-relaxed',
                msg.role === 'user'
                  ? 'rounded-br-md bg-accent text-white'
                  : 'rounded-tl-md border border-line bg-bg-panel text-ink',
              )}
            >
              {msg.role === 'assistant' ? cleanContent(msg.content) : msg.content}
            </div>
          </div>
        ))}

        {/* Streaming indicator */}
        {(isStreaming || statusText) && (
          <div className="flex justify-start gap-2">
            <AssistantAvatar />
            <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tl-md border border-line bg-bg-panel px-3.5 py-2.5 text-body leading-relaxed text-ink">
              {statusText && (
                <div className={cn('flex items-center gap-1.5 text-xs text-ink-3', streamingText && 'mb-1.5')}>
                  <Loader2 className="size-3 animate-spin" />
                  {statusText}
                </div>
              )}
              {streamingText
                ? cleanContent(streamingText)
                : !statusText && (
                    <span className="flex items-center gap-1 py-1" aria-label="Assistant is typing">
                      <span className="pulse-dot size-1.5 rounded-full bg-ink-4" />
                      <span className="pulse-dot size-1.5 rounded-full bg-ink-4 [animation-delay:200ms]" />
                      <span className="pulse-dot size-1.5 rounded-full bg-ink-4 [animation-delay:400ms]" />
                    </span>
                  )}
            </div>
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Profile apply bar */}
      {profileReady && (
        <div className="border-t border-line bg-accent-weak px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="grid size-8 shrink-0 place-items-center rounded-full bg-accent text-white">
              <Check size={15} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="m-0 text-body font-semibold text-accent-fg">
                Profile ready{productsCount > 0 ? ` · ${productsCount} ${productsCount === 1 ? 'product' : 'products'} detected` : ''}
              </p>
              <p className="m-0 text-xs text-ink-3">
                {productsCount > 0
                  ? 'Apply to fill your profile and create the products.'
                  : 'Apply it to fill in your company profile.'}
              </p>
            </div>
            <Button variant="brand" size="sm" onClick={handleApprove} disabled={approveProfile.isPending} className="shrink-0 gap-1.5">
              {approveProfile.isPending && <Loader2 className="size-3.5 animate-spin" />}
              Apply
            </Button>
          </div>
        </div>
      )}

      {/* Input */}
      <div className="border-t border-line px-4 py-3">
        {!hasUserMessage && !busy && messages.length > 0 && (
          <div className="mb-2.5 flex flex-wrap gap-1.5">
            {starters.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setInput(s)}
                className="rounded-full border border-line bg-bg-panel px-3 py-1 text-xs font-medium text-ink-2 transition-colors hover:border-accent-mid hover:bg-accent-weak hover:text-accent-fg"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        <form onSubmit={(e) => { e.preventDefault(); handleSend(); }} className="flex gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type your message…"
            className="h-10 flex-1"
            disabled={busy}
            autoFocus
          />
          <Button type="submit" variant="brand" size="icon" disabled={busy || !input.trim()} className="size-10 shrink-0" aria-label="Send">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          </Button>
        </form>
        <p className="m-0 mt-2 text-center text-2xs text-ink-4">Nothing is saved until you press Apply.</p>
      </div>
    </div>
  );
}
