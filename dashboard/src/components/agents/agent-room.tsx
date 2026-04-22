'use client';

import { useState, useRef, useMemo, useEffect } from 'react';
import { useAgentRoomMessages, useSendHumanMessage, type AgentMessage } from '@/hooks/use-agent-room';
import { useRealtimeStore } from '@/stores/realtime.store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SystemAlertCard } from './system-alert-card';
import { cn } from '@/lib/utils';
import {
  Bot, Send, ChevronDown, ChevronRight, User, ArrowRight, MessageSquare,
  Search, Database, Star, Mail, AlertCircle, Brain,
} from 'lucide-react';

// ── Agent styles for avatars and filter pills ──────────────────────────────────

const AGENT_STYLES: Record<string, { color: string; bg: string; activeBg: string; icon: React.ElementType; label: string }> = {
  master:     { color: 'text-purple-400', bg: 'bg-purple-500/10',  activeBg: 'bg-purple-500/25',  icon: Bot,         label: 'Master' },
  discovery:  { color: 'text-blue-400',   bg: 'bg-blue-500/10',    activeBg: 'bg-blue-500/25',    icon: Search,      label: 'Discovery' },
  enrichment: { color: 'text-cyan-400',   bg: 'bg-cyan-500/10',    activeBg: 'bg-cyan-500/25',    icon: Database,    label: 'Enrichment' },
  scoring:    { color: 'text-amber-400',  bg: 'bg-amber-500/10',   activeBg: 'bg-amber-500/25',   icon: Star,        label: 'Scoring' },
  outreach:   { color: 'text-emerald-400',bg: 'bg-emerald-500/10', activeBg: 'bg-emerald-500/25', icon: Mail,        label: 'Outreach' },
  system:     { color: 'text-orange-400', bg: 'bg-orange-500/10',  activeBg: 'bg-orange-500/25',  icon: AlertCircle, label: 'System' },
  human:      { color: 'text-rose-400',   bg: 'bg-rose-500/10',    activeBg: 'bg-rose-500/25',    icon: User,        label: 'Human' },
};

const FILTER_KEYS = ['all', 'master', 'discovery', 'enrichment', 'scoring', 'outreach', 'system', 'human'] as const;

const MESSAGE_TYPE_BADGES: Record<string, { label: string; variant: string }> = {
  task_assignment: { label: 'Task',     variant: 'bg-purple-500/20 text-purple-300' },
  data_handoff:    { label: 'Data',     variant: 'bg-blue-500/20 text-blue-300' },
  reasoning:       { label: 'Thinking', variant: 'bg-amber-500/20 text-amber-300' },
  status_update:   { label: 'Status',   variant: 'bg-green-500/20 text-green-300' },
  human_message:   { label: 'Human',    variant: 'bg-rose-500/20 text-rose-300' },
  agent_response:  { label: 'Response', variant: 'bg-indigo-500/20 text-indigo-300' },
  system_alert:    { label: 'System',   variant: 'bg-orange-500/20 text-orange-300' },
};

// ── Status dot color helper ────────────────────────────────────────────────────

function getStatusDotColor(content: Record<string, unknown>): string {
  const status = String(content.status ?? content.state ?? '').toLowerCase();
  if (['completed', 'success', 'running', 'active', 'done'].some(s => status.includes(s))) return 'bg-emerald-400';
  if (['pending', 'waiting', 'paused', 'warning', 'queued'].some(s => status.includes(s))) return 'bg-amber-400';
  if (['failed', 'error', 'rejected', 'timeout'].some(s => status.includes(s))) return 'bg-red-400';
  return 'bg-zinc-400';
}

// ── MessageCard ────────────────────────────────────────────────────────────────

function MessageCard({ message }: { message: AgentMessage }) {
  const [expanded, setExpanded] = useState(false);
  const content = message.content;
  const typeBadge = MESSAGE_TYPE_BADGES[message.messageType] ?? { label: message.messageType, variant: 'bg-gray-500/20 text-gray-300' };

  // Resolve agent style
  const agentKey = message.messageType === 'system_alert' ? 'system'
    : message.fromAgent === 'human' ? 'human'
    : (AGENT_STYLES[message.fromAgent] ? message.fromAgent : 'master');
  const style = AGENT_STYLES[agentKey] ?? AGENT_STYLES.master;
  const AgentIcon = style.icon;

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
    <div className="flex items-start gap-3 px-3 py-2.5 hover:bg-muted/30 rounded-lg transition-colors animate-in fade-in slide-in-from-bottom-1 duration-300">
      {/* Avatar */}
      <div className={cn('w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5', style.bg)}>
        <AgentIcon className={cn('w-4 h-4', style.color)} />
      </div>

      {/* Content */}
      <div className="flex-1 min-w-0">
        {/* Header */}
        <div className="flex items-center gap-2 mb-1">
          <span className={cn('text-xs font-semibold', style.color)}>
            {style.label}
          </span>
          <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium', typeBadge.variant)}>
            {typeBadge.label}
          </span>
          {message.toAgent && message.toAgent !== 'all' && (
            <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
              <ArrowRight className="w-3 h-3" />
              {message.toAgent}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground ml-auto shrink-0">{time}</span>
        </div>

        {/* Body — type-specific rendering */}
        {message.messageType === 'system_alert' ? (
          <SystemAlertCard content={content} masterAgentId={message.masterAgentId} />
        ) : message.messageType === 'data_handoff' ? (
          <div>
            <p className="text-xs text-foreground/90 leading-relaxed">{summary}</p>
            {content.dataCompleteness != null && (
              <div className="mt-2 max-w-xs">
                <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
                  <span>Data completeness</span>
                  <span>{String(content.dataCompleteness)}%</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-500"
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
              className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <Brain className="w-3 h-3 text-amber-400" />
              <span className="italic">{summary}</span>
              {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
            </button>
            {expanded && (
              <pre className="mt-2 p-2.5 bg-muted/50 rounded-md text-[10px] overflow-x-auto whitespace-pre-wrap border border-border/50">
                {JSON.stringify(content, null, 2)}
              </pre>
            )}
          </div>
        ) : message.messageType === 'status_update' ? (
          <div className="flex items-center gap-2">
            <span className={cn('w-2 h-2 rounded-full shrink-0', getStatusDotColor(content))} />
            <p className="text-xs text-foreground/90">{summary}</p>
          </div>
        ) : message.messageType === 'task_assignment' ? (
          <div>
            <p className="text-xs text-foreground/90 leading-relaxed">
              {content.action ? (
                <span className="font-medium text-purple-300">{String(content.action).replace(/_/g, ' ')}</span>
              ) : null}
              {content.action && content.message ? ' — ' : ''}
              {content.message ? String(content.message) : (!content.action ? summary : '')}
            </p>
          </div>
        ) : (
          <div>
            <p className="text-xs text-foreground/90 leading-relaxed">{summary}</p>
            {typeof content === 'object' && content && Object.keys(content).length > 2 && (
              <>
                <button
                  onClick={() => setExpanded(!expanded)}
                  className="flex items-center gap-1 text-muted-foreground hover:text-foreground mt-1 text-[10px] transition-colors"
                >
                  {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  {expanded ? 'Less' : 'Details'}
                </button>
                {expanded && (
                  <pre className="mt-1.5 p-2 bg-muted/50 rounded-md text-[10px] overflow-x-auto whitespace-pre-wrap border border-border/50">
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
    <div className="flex flex-col h-[calc(100vh-180px)]">
      {/* Header */}
      <div className="flex items-center justify-between pb-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Agent Room</h2>
          <Badge variant="secondary" className="text-xs">{allMessages.length} messages</Badge>
        </div>
      </div>

      {/* Filter bar */}
      <div className="flex items-center gap-1.5 pb-3 overflow-x-auto scrollbar-none">
        {FILTER_KEYS.map((key) => {
          const isActive = activeFilter === key;
          const count = filterCounts[key] ?? 0;
          if (key === 'all') {
            return (
              <button
                key={key}
                onClick={() => setActiveFilter('all')}
                className={cn(
                  'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all shrink-0',
                  isActive
                    ? 'bg-primary/20 text-primary ring-1 ring-primary/30'
                    : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                All
                {count > 0 && <span className="text-[10px] opacity-70">{count}</span>}
              </button>
            );
          }
          const s = AGENT_STYLES[key];
          if (!s) return null;
          return (
            <button
              key={key}
              onClick={() => setActiveFilter(key)}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium transition-all shrink-0',
                isActive
                  ? cn(s.activeBg, s.color, 'ring-1 ring-current/30')
                  : 'bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              {s.label}
              {count > 0 && <span className="text-[10px] opacity-70">{count}</span>}
            </button>
          );
        })}
      </div>

      {/* Message feed */}
      <div
        ref={feedRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto min-h-0 space-y-0.5 pr-1"
      >
        {filteredMessages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Bot className="w-10 h-10 mb-3 opacity-30" />
            <p className="text-sm">No messages yet</p>
            <p className="text-xs mt-1">Agent messages will appear here in real-time</p>
          </div>
        ) : (
          filteredMessages.map((msg) => <MessageCard key={msg.id} message={msg} />)
        )}
      </div>

      {/* Human input */}
      <div className="flex items-center gap-2 pt-3 border-t border-border mt-2">
        <select
          value={targetAgent}
          onChange={(e) => setTargetAgent(e.target.value)}
          className="h-10 rounded-md border border-input bg-background px-3 text-xs min-w-[130px] focus:outline-none focus:ring-1 focus:ring-primary/50"
        >
          <option value="all">All Agents</option>
          <option value="master">Master</option>
          <option value="discovery">Discovery</option>
          <option value="enrichment">Enrichment</option>
          <option value="scoring">Scoring</option>
          <option value="outreach">Outreach</option>
        </select>
        <Input
          placeholder="Send instruction to agents..."
          value={messageText}
          onChange={(e) => setMessageText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
          className="flex-1 h-10"
        />
        <Button size="sm" className="h-10 px-4" onClick={handleSend} disabled={sendMessage.isPending || !messageText.trim()}>
          <Send className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
