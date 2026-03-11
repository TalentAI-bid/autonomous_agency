'use client';

import { useState, useRef, useMemo } from 'react';
import { useAgentRoomMessages, useSendHumanMessage, type AgentMessage } from '@/hooks/use-agent-room';
import { useRealtimeStore } from '@/stores/realtime.store';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Bot, Send, ChevronDown, ChevronRight, User, ArrowRight, MessageSquare } from 'lucide-react';

const AGENT_COLUMNS = [
  { key: 'master', label: 'Master', color: 'text-purple-400', bgColor: 'bg-purple-500/10' },
  { key: 'discovery', label: 'Discovery', color: 'text-blue-400', bgColor: 'bg-blue-500/10' },
  { key: 'enrichment', label: 'Enrichment', color: 'text-cyan-400', bgColor: 'bg-cyan-500/10' },
  { key: 'scoring', label: 'Scoring', color: 'text-amber-400', bgColor: 'bg-amber-500/10' },
  { key: 'outreach', label: 'Outreach', color: 'text-emerald-400', bgColor: 'bg-emerald-500/10' },
  { key: 'human', label: 'Human', color: 'text-rose-400', bgColor: 'bg-rose-500/10' },
];

const MESSAGE_TYPE_BADGES: Record<string, { label: string; variant: string }> = {
  task_assignment: { label: 'Task', variant: 'bg-purple-500/20 text-purple-300' },
  data_handoff: { label: 'Data', variant: 'bg-blue-500/20 text-blue-300' },
  reasoning: { label: 'Thinking', variant: 'bg-amber-500/20 text-amber-300' },
  status_update: { label: 'Status', variant: 'bg-green-500/20 text-green-300' },
  human_message: { label: 'Human', variant: 'bg-rose-500/20 text-rose-300' },
  agent_response: { label: 'Response', variant: 'bg-indigo-500/20 text-indigo-300' },
};

function MessageCard({ message }: { message: AgentMessage }) {
  const [expanded, setExpanded] = useState(false);
  const typeBadge = MESSAGE_TYPE_BADGES[message.messageType] ?? { label: message.messageType, variant: 'bg-gray-500/20 text-gray-300' };
  const content = message.content;

  const summary = useMemo(() => {
    if (typeof content === 'object' && content) {
      if (content.action) return String(content.action);
      if (content.query) return String(content.query);
      if (content.contactName) return String(content.contactName);
      if (content.companyName) return String(content.companyName);
      if (content.emailSubject) return String(content.emailSubject);
      if (content.message) return String(content.message);
      return JSON.stringify(content).slice(0, 120);
    }
    return String(content).slice(0, 120);
  }, [content]);

  const time = new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  return (
    <div className="border border-border rounded-lg p-2.5 mb-2 text-xs hover:border-border/80 transition-colors">
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${typeBadge.variant}`}>
          {typeBadge.label}
        </span>
        <span className="text-muted-foreground text-[10px]">{time}</span>
      </div>
      <p className="text-foreground/90 leading-relaxed">{summary}</p>
      {message.messageType === 'reasoning' && content && Object.keys(content).length > 2 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 text-muted-foreground hover:text-foreground mt-1 text-[10px]"
        >
          {expanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          {expanded ? 'Less' : 'Details'}
        </button>
      )}
      {expanded && (
        <pre className="mt-1.5 p-2 bg-muted rounded text-[10px] overflow-x-auto whitespace-pre-wrap">
          {JSON.stringify(content, null, 2)}
        </pre>
      )}
      {message.messageType === 'data_handoff' && content && (
        <div className="mt-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          {content.dataCompleteness != null && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-muted">
              {String(content.dataCompleteness)}% complete
            </span>
          )}
          {message.toAgent && (
            <>
              <ArrowRight className="w-3 h-3" />
              <span>{message.toAgent}</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export function AgentRoom({ masterAgentId }: { masterAgentId: string }) {
  const { data: messagesRes } = useAgentRoomMessages(masterAgentId);
  const sendMessage = useSendHumanMessage(masterAgentId);
  const realtimeMessages = useRealtimeStore((s) => s.agentMessages);
  const [messageText, setMessageText] = useState('');
  const [targetAgent, setTargetAgent] = useState('all');
  const columnRefs = useRef<Record<string, HTMLDivElement | null>>({});

  // Combine API messages with realtime messages for instant updates
  const allMessages = useMemo(() => {
    const apiMsgs = (messagesRes as { data?: AgentMessage[] })?.data ?? (Array.isArray(messagesRes) ? messagesRes : []);
    const seenIds = new Set(apiMsgs.map((m: AgentMessage) => m.id));
    const newRealtime = (realtimeMessages ?? [])
      .filter((m) => !seenIds.has(m.id) && m.masterAgentId === masterAgentId) as AgentMessage[];
    return [...newRealtime, ...apiMsgs].sort((a: AgentMessage, b: AgentMessage) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [messagesRes, realtimeMessages, masterAgentId]);

  // Group messages by agent column
  const messagesByAgent = useMemo(() => {
    const grouped: Record<string, AgentMessage[]> = {};
    for (const col of AGENT_COLUMNS) {
      grouped[col.key] = [];
    }
    for (const msg of allMessages) {
      const col = msg.fromAgent === 'human' ? 'human' : (grouped[msg.fromAgent] !== undefined ? msg.fromAgent : 'master');
      grouped[col]?.push(msg);
    }
    return grouped;
  }, [allMessages]);

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
      <div className="flex items-center justify-between pb-4">
        <div className="flex items-center gap-2">
          <MessageSquare className="w-5 h-5 text-primary" />
          <h2 className="text-lg font-semibold">Agent Room</h2>
          <Badge variant="secondary" className="text-xs">{allMessages.length} messages</Badge>
        </div>
      </div>

      {/* Column layout */}
      <div className="flex-1 grid grid-cols-6 gap-3 min-h-0 overflow-hidden">
        {AGENT_COLUMNS.map((col) => {
          const msgs = messagesByAgent[col.key] ?? [];
          return (
            <div key={col.key} className="flex flex-col min-h-0">
              <div className={`flex items-center gap-2 px-3 py-2 rounded-t-lg ${col.bgColor}`}>
                {col.key === 'human' ? (
                  <User className={`w-3.5 h-3.5 ${col.color}`} />
                ) : (
                  <Bot className={`w-3.5 h-3.5 ${col.color}`} />
                )}
                <span className={`text-xs font-medium ${col.color}`}>{col.label}</span>
                {msgs.length > 0 && (
                  <Badge variant="secondary" className="text-[10px] ml-auto px-1 py-0">{msgs.length}</Badge>
                )}
              </div>
              <div
                ref={(el) => { columnRefs.current[col.key] = el; }}
                className="flex-1 overflow-y-auto p-2 border border-t-0 border-border rounded-b-lg bg-background/50 space-y-0"
              >
                {msgs.length === 0 ? (
                  <p className="text-[10px] text-muted-foreground text-center py-8">No messages</p>
                ) : (
                  msgs.map((msg) => <MessageCard key={msg.id} message={msg} />)
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Human input */}
      <div className="flex items-center gap-2 pt-3 border-t border-border mt-3">
        <select
          value={targetAgent}
          onChange={(e) => setTargetAgent(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-2 text-xs min-w-[120px]"
        >
          <option value="all">All Agents</option>
          <option value="discovery">Discovery</option>
          <option value="enrichment">Enrichment</option>
          <option value="scoring">Scoring</option>
          <option value="outreach">Outreach</option>
          <option value="master">Master</option>
        </select>
        <Input
          placeholder="Send instruction to agents..."
          value={messageText}
          onChange={(e) => setMessageText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
          className="flex-1 text-sm"
        />
        <Button size="sm" onClick={handleSend} disabled={sendMessage.isPending || !messageText.trim()}>
          <Send className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
