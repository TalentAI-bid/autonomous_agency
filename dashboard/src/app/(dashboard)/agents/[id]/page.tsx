'use client';

import { useState, useMemo, useEffect } from 'react';
import { useParams, useSearchParams, useRouter, usePathname } from 'next/navigation';
import { Breadcrumb } from '@/components/layout/breadcrumb';
import { useMasterAgent, useStartAgent, useStopAgent, useAgentStats, useAgentEmails, useAgentDocuments, useGmapsEnrichAgent } from '@/hooks/use-agents';
import { useContacts } from '@/hooks/use-contacts';
import { useRealtimeStore } from '@/stores/realtime.store';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/utils';
import { Play, Square, Activity, Users, Bot, Mail, BarChart3, Building2, FileText, Brain, Zap, MessageSquare, Settings as SettingsIcon, ListChecks, Store } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { ActivityFeed } from '@/components/agents/activity-feed';
import { ExportButton } from '@/components/shared/export-button';
import { QuotaBadge } from '@/components/agents/quota-badge';
import { IssuesBanner } from '@/components/agents/issues-banner';
import OpportunitiesPage from './opportunities/page';
import { AgentRoom } from '@/components/agents/agent-room';
import { AgentSettingsTab } from '@/components/agents/agent-settings-tab';
import { AgentQueueTab } from '@/components/agents/agent-queue-tab';
import { AgentTabNav, agentTabFromQuery, type AgentTab, type AgentTabItem } from '@/components/agents/detail/agent-tab-nav';
import { useCompaniesTab } from '@/components/agents/detail/use-companies-tab';
import { OverviewTab } from '@/components/agents/detail/overview-tab';
import { ContactsTab } from '@/components/agents/detail/contacts-tab';
import { BusinessesTab } from '@/components/agents/detail/businesses-tab';
import { CompaniesTab } from '@/components/agents/detail/companies-tab';
import { DocumentsTab } from '@/components/agents/detail/documents-tab';
import { EmailsTab } from '@/components/agents/detail/emails-tab';
import { StrategyTab } from '@/components/agents/detail/strategy-tab';

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Initialize from ?tab= so deep-linking (and breadcrumb back-from-detail-page)
  // lands on the right tab. Keep URL in sync when the user clicks tabs.
  const [activeTab, setActiveTab] = useState<AgentTab>(() => agentTabFromQuery(searchParams.get('tab')));

  useEffect(() => {
    const t = agentTabFromQuery(searchParams.get('tab'));
    setActiveTab((prev) => (prev === t ? prev : t));
  }, [searchParams]);

  function selectTab(t: AgentTab) {
    setActiveTab(t);
    const q = new URLSearchParams(searchParams.toString());
    if (t === 'queue') q.delete('tab'); else q.set('tab', t);
    const qs = q.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }
  const { data: agentRes, isLoading } = useMasterAgent(id);
  const { data: contactsRes } = useContacts({ masterAgentId: id, limit: 100 });
  const { data: stats } = useAgentStats(id);
  const { data: emails } = useAgentEmails(id);
  const companiesTab = useCompaniesTab(id);
  const { data: documentsData } = useAgentDocuments(id);
  const startAgent = useStartAgent();
  const stopAgent = useStopAgent();
  const gmapsEnrich = useGmapsEnrichAgent();
  const { toast } = useToast();
  const allEvents = useRealtimeStore((s) => s.events);
  const events = useMemo(
    () => allEvents.filter((e) => (e.data as Record<string, unknown>)?.masterAgentId === id),
    [allEvents, id],
  );

  const agent = agentRes;
  const contacts = contactsRes?.data ?? [];
  const gmapsBusinesses = contacts.filter((c) => c.sourceType === 'gmaps_business');
  const totalContacts = stats?.totalContacts ?? contactsRes?.pagination?.total ?? 0;
  const agentDocuments = documentsData ?? [];

  async function handleStart() {
    try {
      await startAgent.mutateAsync(id);
      toast({ title: 'Agent started', description: 'Processing your mission...' });
    } catch {
      toast({ title: 'Failed to start agent', variant: 'destructive' });
    }
  }

  async function handleStop() {
    try {
      await stopAgent.mutateAsync(id);
      toast({ title: 'Agent stopped' });
    } catch {
      toast({ title: 'Failed to stop agent', variant: 'destructive' });
    }
  }

  async function handleGmapsEnrich() {
    try {
      const res = await gmapsEnrich.mutateAsync(id);
      toast({
        title: `Google Maps enrichment queued for ${res.enqueued} companies`,
        description: res.note,
      });
    } catch (err) {
      toast({
        title: 'Could not queue Google Maps enrichment',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      });
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="text-center py-16">
        <Bot className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
        <p className="text-muted-foreground">Agent not found</p>
      </div>
    );
  }

  const tabs: AgentTabItem[] = [
    { key: 'queue', label: 'Queue', icon: ListChecks },
    { key: 'overview', label: 'Overview', icon: BarChart3 },
    { key: 'contacts', label: 'Contacts', icon: Users, count: totalContacts },
    ...(gmapsBusinesses.length > 0
      ? [{ key: 'businesses' as AgentTab, label: 'Businesses', icon: Store, count: gmapsBusinesses.length }]
      : []),
    { key: 'opportunities', label: 'Opportunities', icon: Zap },
    { key: 'companies', label: 'Companies', icon: Building2, count: companiesTab.companies.length },
    { key: 'documents', label: 'Documents', icon: FileText, count: agentDocuments.length },
    { key: 'emails', label: 'Emails', icon: Mail, count: emails?.length ?? 0 },
    { key: 'activity', label: 'Activity', icon: Activity },
    { key: 'strategy', label: 'Strategy', icon: Brain },
    { key: 'room', label: 'Agent Room', icon: MessageSquare },
    { key: 'settings', label: 'Settings', icon: SettingsIcon },
  ];

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <Breadcrumb
        showBack
        backFallback="/agents"
        items={[
          { href: '/agents', label: 'Agents' },
          { label: agent.name ?? 'Agent' },
        ]}
      />

      {/* Agent Header */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-lg bg-info/10">
              <Bot className="w-6 h-6 text-info" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-bold">{agent.name}</h1>
                {agent.status === 'paused' &&
                (agent.config?.pauseReason as string | undefined) === 'extension_required' ? (
                  <Badge variant="warning" title="Connect the LinkedIn extension to run this agent — it resumes automatically.">
                    Paused · connect extension
                  </Badge>
                ) : (
                  <Badge variant={agent.status === 'running' ? 'success' : 'secondary'}>
                    {agent.status}
                  </Badge>
                )}
                <QuotaBadge masterAgentId={id} compact />
              </div>
              <p className="text-sm text-muted-foreground mt-1">{agent.useCase}</p>
              {agent.mission && (
                <p className="text-sm mt-2 text-foreground/80">{agent.mission}</p>
              )}
              <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Users className="w-3.5 h-3.5" />
                  {totalContacts} contacts
                </span>
                <span>Created {formatDate(agent.createdAt)}</span>
                <span>Updated {formatDate(agent.updatedAt)}</span>
              </div>
            </div>
            <div className="flex gap-2 shrink-0">
              <ExportButton masterAgentId={id} showFullBatch />
              {agent.status === 'running' ? (
                <Button variant="outline" size="sm" onClick={handleStop} disabled={stopAgent.isPending}>
                  <Square className="w-3.5 h-3.5 mr-1.5" />
                  Stop
                </Button>
              ) : (
                <Button size="sm" onClick={handleStart} disabled={startAgent.isPending}>
                  <Play className="w-3.5 h-3.5 mr-1.5" />
                  Run
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Pipeline issues banner (visible regardless of active tab) */}
      <IssuesBanner masterAgentId={id} />

      <AgentTabNav tabs={tabs} active={activeTab} onSelect={selectTab} />

      {/* Tab Content */}
      {activeTab === 'queue' && <AgentQueueTab agentId={id} agentName={agent.name} />}
      {activeTab === 'overview' && (
        <OverviewTab agentId={id} agent={agent} stats={stats} totalContacts={totalContacts} events={events} />
      )}
      {activeTab === 'contacts' && (
        <ContactsTab agentId={id} agent={agent} contacts={contacts} totalContacts={totalContacts} />
      )}
      {activeTab === 'businesses' && <BusinessesTab agentId={id} businesses={gmapsBusinesses} />}
      {activeTab === 'opportunities' && <OpportunitiesPage />}
      {activeTab === 'companies' && (
        <CompaniesTab
          agentId={id}
          state={companiesTab}
          onGmapsEnrich={handleGmapsEnrich}
          gmapsPending={gmapsEnrich.isPending}
        />
      )}
      {activeTab === 'documents' && <DocumentsTab documents={agentDocuments} />}
      {activeTab === 'emails' && <EmailsTab emails={emails} />}
      {activeTab === 'activity' && <ActivityFeed masterAgentId={id} />}
      {activeTab === 'strategy' && <StrategyTab agentId={id} agent={agent} />}
      {activeTab === 'room' && <AgentRoom masterAgentId={id} />}
      {activeTab === 'settings' && <AgentSettingsTab agent={agent} />}
    </div>
  );
}
