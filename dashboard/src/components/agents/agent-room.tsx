'use client';

import { useState, useRef, useMemo, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { useAgentRoomMessages, useSendHumanMessage, type AgentMessage } from '@/hooks/use-agent-room';
import { useRealtimeStore } from '@/stores/realtime.store';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SystemAlertCard } from './system-alert-card';
import { cn } from '@/lib/utils';
import { Select } from '@/components/ui/select';
import {
  Bot, Send, ChevronDown, ChevronRight, User, ArrowRight, Search, Database, Star, Mail, AlertCircle, Brain,
} from 'lucide-react';

// ── Agent styles for avatars and filter pills ──────────────────────────────────

const AGENT_STYLES: Record<string, { color: string; bg: string; activeBg: string; icon: React.ElementType; label: string }> = {
  master:     { color: 'text-a-master', bg: 'bg-a-master/10',  activeBg: 'bg-a-master/25',  icon: Bot,         label: 'Master' },
  discovery:  { color: 'text-info',   bg: 'bg-info/10',    activeBg: 'bg-info/25',    icon: Search,      label: 'Discovery' },
  enrichment: { color: 'text-a-enrichment',   bg: 'bg-a-enrichment/10',    activeBg: 'bg-a-enrichment/25',    icon: Database,    label: 'Enrichment' },
  scoring:    { color: 'text-warn-fg',  bg: 'bg-warn/10',   activeBg: 'bg-warn/25',   icon: Star,        label: 'Scoring' },
  outreach:   { color: 'text-up',bg: 'bg-up/10', activeBg: 'bg-up/25', icon: Mail,        label: 'Outreach' },
  system:     { color: 'text-warn-fg', bg: 'bg-warn/10',  activeBg: 'bg-warn/25',  icon: AlertCircle, label: 'System' },
  human:      { color: 'text-down',   bg: 'bg-down/10',    activeBg: 'bg-down/25',    icon: User,        label: 'Human' },
};

const FILTER_KEYS = ['all', 'master', 'discovery', 'enrichment', 'scoring', 'outreach', 'system', 'human'] as const;

const MESSAGE_TYPE_BADGES: Record<string, { label: string; variant: string }> = {
  task_assignment: { label: 'Task',     variant: 'bg-a-master/20 text-a-master' },
  data_handoff:    { label: 'Data',     variant: 'bg-info/20 text-info' },
  reasoning:       { label: 'Thinking', variant: 'bg-warn/20 text-warn-fg' },
  status_update:   { label: 'Status',   variant: 'bg-up/20 text-up' },
  human_message:   { label: 'Human',    variant: 'bg-down/20 text-down' },
  agent_response:  { label: 'Response', variant: 'bg-info/20 text-info' },
  system_alert:    { label: 'System',   variant: 'bg-warn/20 text-warn-fg' },
};

// ── Status dot color helper ────────────────────────────────────────────────────

function getStatusDotColor(content: Record<string, unknown>): string {
  const status = String(content.status ?? content.state ?? '').toLowerCase();
  if (['completed', 'success', 'running', 'active', 'done'].some(s => status.includes(s))) return 'bg-up';
  if (['pending', 'waiting', 'paused', 'warning', 'queued'].some(s => status.includes(s))) return 'bg-warn';
  if (['failed', 'error', 'rejected', 'timeout'].some(s => status.includes(s))) return 'bg-down';
  return 'bg-ink-4';
}

// ── MessageCard ────────────────────────────────────────────────────────────────

function MessageCard({ message }: { message: AgentMessage }) {
  const [expanded, setExpanded] = useState(false);
  const content = message.content;
  const typeBadge = MESSAGE_TYPE_BADGES[message.messageType] ?? { label: message.messageType, variant: 'bg-ink-3/20 text-ink-3' };

  // Resolve agent style
  const agentKey = message.messageType === 'system_alert' ? 'system'
    : message.fromAgent === 'human' ? 'human'
    : (AGENT_STYLES[message.fromAgent] ? message.fromAgent : 'master');
  const style = AGENT_STYLES[agentKey] ?? AGENT_STYLES.master;
  const AgentIcon = style.icon;
  const isHuman = agentKey === 'human';

  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  const summary = useMemo(() => {
    if (typeof content === 'object' && content) {
      if (content.action) return String(content.action).replace(/_/g, ' ');
      if (content.query) return String(content.query);
      if (content.contactName) return String(content.contactName);
      if (content.companyName) return String(content.companyName);
      if (content.emailSubject) return String(content.emailSubject);
      if (content.message) return String(content.message);
      return JSON.stringify(content).slice(0, 140);
    }
    return String(content).slice(0, 140);
  }, [content]);

  return (
    <div className={cn('flex items-start gap-3 px-2 py-1.5 animate-in fade-in slide-in-from-bottom-1 duration-300', isHuman && 'flex-row-reverse')}>
      {/* Avatar */}
      <div className={cn('w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5 ring-1 ring-line', style.bg)}>
        <AgentIcon className={cn('w-4 h-4', style.color)} />
      </div>

      {/* Content */}
      <div
        className={cn(
          'min-w-0 rounded-2xl border px-3.5 py-2.5',
          isHuman ? 'max-w-[80%] rounded-tr-md border-accent-mid bg-accent-weak' : 'flex-1 rounded-tl-md border-line bg-bg-panel shadow-sm',
        )}
      >
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <span className={cn('text-xs font-semibold', style.color)}>
            {style.label}
          </span>
          <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-2xs font-medium', typeBadge.variant)}>
            {typeBadge.label}
          </span>
          {message.toAgent && message.toAgent !== 'all' && (
            <span className="flex items-center gap-0.5 text-2xs text-ink-3">
              <ArrowRight className="w-3 h-3" />
              {message.toAgent}
            </span>
          )}
          <span className="text-2xs text-ink-3 ml-auto shrink-0">{time}</span>
        </div>

        {/* Body — type-specific rendering */}
        {message.messageType === 'system_alert' ? (
          <SystemAlertCard content={content} masterAgentId={message.masterAgentId} />
        ) : message.messageType === 'data_handoff' ? (
          <div>
            <p className="text-body text-ink-2 leading-relaxed">{summary}</p>
            {content.dataCompleteness != null && (
              <div className="mt-2 max-w-xs">
                <div className="flex justify-between text-2xs text-ink-3 mb-1">
                  <span>Data completeness</span>
                  <span>{String(content.dataCompleteness)}%</span>
                </div>
                <div className="h-1.5 bg-bg-soft rounded-full overflow-hidden">
                  <div
                    className="h-full bg-info rounded-full transition-all duration-500"
                    style={{ width: `${Number(content.dataCompleteness)}%` }}
                  />
                </div>
              </div>
            )}
          </div>
        ) : message.messageType === 'reasoning' ? (
          <div>
            <button
              onClick={() => setExpanded(!expanded)}
              className="flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink transition-colors"
            >
              <Brain className="w-3 h-3 text-warn-fg" />
              <span className="italic">{summary}</span>
              {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>
            {expanded && (
              <pre className="mt-2 p-2.5 bg-bg-sub rounded-md text-2xs overflow-x-auto whitespace-pre-wrap border border-line">
                {JSON.stringify(content, null, 2)}
              </pre>
            )}
          </div>
        ) : message.messageType === 'status_update' ? (
          <div className="flex items-center gap-2">
            <span className={cn('w-2 h-2 rounded-full shrink-0', getStatusDotColor(content))} />
            <p className="text-body text-ink-2">{summary}</p>
          </div>
        ) : message.messageType === 'task_assignment' ? (
          <div>
            <p className="text-body text-ink-2 leading-relaxed">
              {content.action ? (
                <span className="font-medium text-a-master">{String(content.action).replace(/_/g, ' ')}</span>
              ) : null}
              {content.action && content.message ? ' — ' : ''}
              {content.message ? String(content.message) : (!content.action ? summary : '')}
            </p>
          </div>
        ) : (
          <div>
            <p className="text-body text-ink-2 leading-relaxed">{summary}</p>
            {typeof content === 'object' && content && Object.keys(content).length > 2 && (
              <>
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="flex items-center gap-1 text-ink-3 hover:text-ink mt-1 text-2xs transition-colors"
                >
                  {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  {expanded ? 'Less' : 'Details'}
                </button>
                {expanded && (
                  <pre className="mt-1.5 p-2 bg-bg-sub rounded-md text-2xs overflow-x-auto whitespace-pre-wrap border border-line">
                    {JSON.stringify(content, null, 2)}
                  </pre>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── AgentRoom ──────────────────────────────────────────────────────────────────

export function AgentRoom({ masterAgentId }: { masterAgentId: string }) {
  const { data: messagesRes } = useAgentRoomMessages(masterAgentId);
  const sendMessage = useSendHumanMessage(masterAgentId);
  const realtimeMessages = useRealtimeStore((s) => s.agentMessages);
  const [messageText, setMessageText] = useState('');
  const [targetAgent, setTargetAgent] = useState('all');
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const feedRef = useRef<HTMLDivElement>(null);
  const wasAtBottomRef = useRef(true);

  // Combine API + realtime messages, sorted oldest-first (chat order)
  const allMessages = useMemo(() => {
    const apiMsgs = (messagesRes as { data?: AgentMessage[] })?.data ?? (Array.isArray(messagesRes) ? messagesRes : []);
    const seenIds = new Set(apiMsgs.map((m: AgentMessage) => m.id));
    const newRealtime = (realtimeMessages ?? [])
      .filter((m) => !seenIds.has(m.id) && m.masterAgentId === masterAgentId) as AgentMessage[];
    return [...newRealtime, ...apiMsgs].sort(
      (a: AgentMessage, b: AgentMessage) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  }, [messagesRes, realtimeMessages, masterAgentId]);

  // Filter messages
  const filteredMessages = useMemo(() => {
    if (activeFilter === 'all') return allMessages;
    if (activeFilter === 'system') return allMessages.filter(m => m.messageType === 'system_alert');
    return allMessages.filter(m => m.fromAgent === activeFilter);
  }, [allMessages, activeFilter]);

  // Count messages per filter
  const filterCounts = useMemo(() => {
    const counts: Record<string, number> = { all: allMessages.length };
    for (const msg of allMessages) {
      if (msg.messageType === 'system_alert') {
        counts.system = (counts.system ?? 0) + 1;
      }
      if (msg.fromAgent && AGENT_STYLES[msg.fromAgent]) {
        counts[msg.fromAgent] = (counts[msg.fromAgent] ?? 0) + 1;
      } else if (msg.fromAgent === 'human') {
        counts.human = (counts.human ?? 0) + 1;
      } else {
        counts.master = (counts.master ?? 0) + 1;
      }
    }
    return counts;
  }, [allMessages]);

  // Auto-scroll to bottom when new messages arrive (if user was already at bottom)
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    if (wasAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [filteredMessages.length]);

  // Track whether user is scrolled to bottom
  const handleScroll = () => {
    const el = feedRef.current;
    if (!el) return;
    wasAtBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const handleSend = async () => {
    if (!messageText.trim()) return;
    await sendMessage.mutateAsync({
      toAgent: targetAgent,
      content: messageText.trim(),
      actionType: 'instruction',
    });
    setMessageText('');
  };

  return (
    <section className="flex h-[calc(100vh-180px)] min-h-[480px] flex-col overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm">
      <header className="space-y-3 border-b border-line px-5 py-3.5">
        <div className="flex items-center gap-2">
          <h2 className="m-0 text-body font-semibold text-ink">Agent Room</h2>
          <Badge variant="muted" size="sm" className="font-mono">{allMessages.length}</Badge>
          <span className="ml-auto text-xs text-ink-3">Live messages between your agents</span>
        </div>
        <div className="scroll-thin flex items-center gap-1.5 overflow-x-auto">
          {FILTER_KEYS.map((key) => {
            const isActive = activeFilter === key;
            const count = filterCounts[key] ?? 0;
            const label = key === 'all' ? 'All' : AGENT_STYLES[key]?.label;
            if (!label) return null;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setActiveFilter(key)}
                aria-pressed={isActive}
                className={cn(
                  'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition-colors',
                  isActive
                    ? 'border-accent-mid bg-accent-weak font-medium text-accent-fg'
                    : 'border-line bg-bg-panel text-ink-3 hover:bg-hover hover:text-ink',
                )}
              >
                {label}
                {count > 0 && <span className="font-mono text-2xs opacity-70">{count}</span>}
              </button>
            );
          })}
        </div>
      </header>

      <div ref={feedRef} onScroll={handleScroll} className="scroll-thin min-h-0 flex-1 space-y-1 overflow-y-auto bg-bg-sub p-3">
        {filteredMessages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
            <span className="mb-2 grid size-11 place-items-center rounded-panel bg-accent-weak text-accent-fg">
              <Bot size={20} />
            </span>
            <p className="m-0 text-body font-medium text-ink">No messages yet</p>
            <p className="m-0 text-xs text-ink-3">Agent messages will appear here in real time.</p>
          </div>
        ) : (
          filteredMessages.map((msg, i) => {
            const day = new Date(msg.createdAt).toDateString();
            const newDay = i === 0 || day !== new Date(filteredMessages[i - 1].createdAt).toDateString();
            return (
              <div key={msg.id}>
                {newDay && (
                  <div className="sticky top-0 z-10 flex justify-center py-2">
                    <span className="rounded-full border border-line bg-bg-panel px-3 py-0.5 text-2xs font-medium text-ink-3 shadow-sm">
                      {new Date(msg.createdAt).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}
                    </span>
                  </div>
                )}
                <MessageCard message={msg} />
              </div>
            );
          })
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-line bg-bg-sub px-4 py-3">
        <Select
          value={targetAgent}
          onChange={(e) => setTargetAgent(e.target.value)}
          aria-label="Send to"
          className="h-9 min-w-[130px] rounded-lg border-line bg-bg-panel px-3 text-xs"
        >
          <option value="all">All agents</option>
          <option value="master">Master</option>
          <option value="discovery">Discovery</option>
          <option value="enrichment">Enrichment</option>
          <option value="scoring">Scoring</option>
          <option value="outreach">Outreach</option>
        </Select>
        <Input
          placeholder="Send an instruction to the agents…"
          value={messageText}
          onChange={(e) => setMessageText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
          className="h-9 flex-1 rounded-lg border-line bg-bg-panel text-body focus-visible:ring-accent-weak"
        />
        <Button type="button" variant="brand" className="h-9 rounded-lg px-3.5" onClick={handleSend} disabled={sendMessage.isPending || !messageText.trim()} aria-label="Send">
          <Send size={14} />
        </Button>
      </footer>
    </section>
  );
}
