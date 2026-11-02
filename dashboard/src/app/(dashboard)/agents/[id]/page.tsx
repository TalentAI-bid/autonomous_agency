'use client';

import { useState, useMemo, useEffect } from 'react';
import { useParams, useSearchParams, useRouter, usePathname } from 'next/navigation';
import { Breadcrumb } from '@/components/layout/breadcrumb';
import { useMasterAgent, useStartAgent, useStopAgent, useAgentStats, useAgentEmails, useAgentDocuments, useGmapsEnrichAgent } from '@/hooks/use-agents';
import { useContacts } from '@/hooks/use-contacts';
import { useRealtimeStore } from '@/stores/realtime.store';
import { Skeleton } from '@/components/ui/skeleton';
import { Activity, Users, Bot, Mail, BarChart3, Building2, FileText, Brain, Zap, MessageSquare, Settings as SettingsIcon, ListChecks, Store } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { ActivityFeed } from '@/components/agents/activity-feed';
import { IssuesBanner } from '@/components/agents/issues-banner';
import OpportunitiesPage from './opportunities/page';
import { AgentRoom } from '@/components/agents/agent-room';
import { AgentSettingsTab } from '@/components/agents/agent-settings-tab';
import { AgentQueueTab } from '@/components/agents/agent-queue-tab';
import { AgentHeader } from '@/components/agents/detail/agent-header';
import { AgentTabNav, agentTabFromQuery, type AgentTab, type AgentTabGroup } from '@/components/agents/detail/agent-tab-nav';
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
    if (t === 'approvals') q.delete('tab'); else q.set('tab', t);
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
      <div className="mx-auto max-w-[1180px] space-y-5 p-6">
        <Skeleton className="h-56 rounded-2xl" />
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="mx-auto max-w-[1180px] p-6 py-16 text-center">
        <Bot className="mx-auto mb-3 size-10 text-ink-4" />
        <p className="m-0 text-body text-ink-3">Agent not found</p>
      </div>
    );
  }

  const groups: AgentTabGroup[] = [
    {
      label: 'Workflow',
      tabs: [
        { key: 'approvals', label: 'Approvals', icon: ListChecks },
        { key: 'contacts', label: 'Contacts', icon: Users, count: totalContacts },
        ...(gmapsBusinesses.length > 0
          ? [{ key: 'businesses' as AgentTab, label: 'Businesses', icon: Store, count: gmapsBusinesses.length }]
          : []),
        { key: 'companies', label: 'Companies', icon: Building2, count: companiesTab.companies.length },
        { key: 'opportunities', label: 'Opportunities', icon: Zap },
      ],
    },
    {
      label: 'Insights',
      tabs: [
        { key: 'overview', label: 'Overview', icon: BarChart3 },
        { key: 'activity', label: 'Activity', icon: Activity },
        { key: 'strategy', label: 'Strategy', icon: Brain },
        { key: 'room', label: 'Agent Room', icon: MessageSquare },
      ],
    },
    {
      label: 'Content',
      tabs: [
        { key: 'documents', label: 'Documents', icon: FileText, count: agentDocuments.length },
        { key: 'emails', label: 'Emails', icon: Mail, count: emails?.length ?? 0 },
      ],
    },
    { label: 'Setup', tabs: [{ key: 'settings', label: 'Settings', icon: SettingsIcon }] },
  ];

  return (
    <div className="mx-auto max-w-[1180px] space-y-5 p-6">
      {/* Breadcrumb */}
      <Breadcrumb
        showBack
        backFallback="/agents"
        items={[
          { href: '/agents', label: 'Agents' },
          { label: agent.name ?? 'Agent' },
        ]}
      />

      <AgentHeader
        agent={agent}
        stats={stats}
        totalContacts={totalContacts}
        starting={startAgent.isPending}
        stopping={stopAgent.isPending}
        onStart={handleStart}
        onStop={handleStop}
      />

      {/* Pipeline issues banner (visible regardless of active tab) */}
      <IssuesBanner masterAgentId={id} />

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[212px_minmax(0,1fr)]">
      <AgentTabNav groups={groups} active={activeTab} onSelect={selectTab} />

      {/* Tab Content */}
      <div className="min-w-0">
      {activeTab === 'approvals' && <AgentQueueTab agentId={id} agentName={agent.name} />}
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
      </div>
    </div>
  );
}
