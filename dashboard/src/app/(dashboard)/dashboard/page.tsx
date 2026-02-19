'use client';

import { useAgents } from '@/hooks/use-agents';
import { useContacts } from '@/hooks/use-contacts';
import { useRealtimeStore } from '@/stores/realtime.store';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate, getStatusColor } from '@/lib/utils';
import { Bot, Users, Mail, TrendingUp, Activity, ArrowRight } from 'lucide-react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

function StatCard({ title, value, icon: Icon, trend, color }: { title: string; value: string | number; icon: React.ElementType; trend?: string; color?: string }) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
            {trend && <p className="text-xs text-emerald-500 mt-1">{trend}</p>}
          </div>
          <div className={`p-3 rounded-lg ${color || 'bg-blue-500/10'}`}>
            <Icon className="w-5 h-5 text-blue-400" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const { data: agentsRes, isLoading: agentsLoading } = useAgents();
  const { data: contactsRes, isLoading: contactsLoading } = useContacts({ limit: 5 });
  const events = useRealtimeStore((s) => s.events);

  const agents = agentsRes ?? [];
  const contacts = contactsRes?.data ?? [];

  const activeAgents = agents.filter((a) => a.status === 'running').length;
  const totalContacts = contactsRes?.pagination?.total ?? 0;

  // Pipeline funnel stats from contacts
  const discovered = contacts.filter((c) => c.status === 'discovered').length;
  const enriched = contacts.filter((c) => c.status === 'enriched').length;
  const scored = contacts.filter((c) => c.status === 'scored' || (c.score ?? 0) > 0).length;
  const contacted = contacts.filter((c) => c.status === 'contacted').length;

  const recentEvents = events.slice(0, 10);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-muted-foreground text-sm mt-1">Overview of your recruiting pipeline</p>
        </div>
        <Link href="/agents/new">
          <Button size="sm">
            <Bot className="w-4 h-4 mr-2" />
            New Agent
          </Button>
        </Link>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {agentsLoading || contactsLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-[104px]" />)
        ) : (
          <>
            <StatCard title="Active Agents" value={activeAgents} icon={Bot} color="bg-blue-500/10" />
            <StatCard title="Total Contacts" value={totalContacts} icon={Users} color="bg-emerald-500/10" />
            <StatCard title="Emails Sent" value="—" icon={Mail} color="bg-purple-500/10" />
            <StatCard title="Avg. Score" value="—" icon={TrendingUp} color="bg-amber-500/10" />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Pipeline Funnel */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Pipeline Funnel</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[
              { label: 'Discovered', value: discovered, color: 'bg-blue-500' },
              { label: 'Enriched', value: enriched, color: 'bg-indigo-500' },
              { label: 'Scored', value: scored, color: 'bg-purple-500' },
              { label: 'Contacted', value: contacted, color: 'bg-emerald-500' },
            ].map((stage) => (
              <div key={stage.label} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{stage.label}</span>
                  <span className="font-medium">{stage.value}</span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className={`h-full ${stage.color} rounded-full transition-all`}
                    style={{ width: discovered > 0 ? `${(stage.value / discovered) * 100}%` : '0%' }}
                  />
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Active Agents */}
        <Card className="lg:col-span-1">
          <CardHeader className="flex flex-row items-center justify-between pb-3">
            <CardTitle className="text-sm font-medium">Agents</CardTitle>
            <Link href="/agents">
              <Button variant="ghost" size="sm" className="h-7 text-xs">
                View all <ArrowRight className="w-3 h-3 ml-1" />
              </Button>
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {agentsLoading ? (
              Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12" />)
            ) : agents.length === 0 ? (
              <div className="text-center py-6">
                <Bot className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">No agents yet</p>
                <Link href="/agents/new">
                  <Button variant="outline" size="sm" className="mt-3">Create Agent</Button>
                </Link>
              </div>
            ) : (
              agents.slice(0, 5).map((agent) => (
                <Link key={agent.id} href={`/agents/${agent.id}`}>
                  <div className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{agent.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{agent.useCase}</p>
                    </div>
                    <Badge variant={agent.status === 'running' ? 'success' : 'secondary'} className="ml-2 shrink-0 text-xs">
                      {agent.status}
                    </Badge>
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>

        {/* Real-time Activity */}
        <Card className="lg:col-span-1">
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Activity className="w-4 h-4 text-emerald-500" />
              Live Activity
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 max-h-[280px] overflow-y-auto">
            {recentEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No recent activity</p>
            ) : (
              recentEvents.map((event, i) => (
                <div key={i} className="flex gap-2 text-xs">
                  <span className="text-muted-foreground shrink-0 mt-0.5">{formatDate(event.timestamp)}</span>
                  <span className={`font-medium ${getStatusColor(event.event)}`}>{event.event}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
