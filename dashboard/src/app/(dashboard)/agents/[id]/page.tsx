'use client';

import { useState, useMemo } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useMasterAgent, useStartAgent, useStopAgent, useAgentStats, useAgentEmails, useAgentCompanies, useAgentDocuments } from '@/hooks/use-agents';
import { useContacts } from '@/hooks/use-contacts';
import { useRealtimeStore } from '@/stores/realtime.store';
import { AgentMonitor } from '@/components/agents/agent-monitor';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate, getStatusColor } from '@/lib/utils';
import { Play, Square, Activity, Users, Bot, Mail, BarChart3, Target, Building2, FileText, Brain, Zap, MessageSquare } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { ActivityFeed } from '@/components/agents/activity-feed';
import { StrategyPanel } from '@/components/agents/strategy-panel';
import OpportunitiesPage from './opportunities/page';
import { AgentRoom } from '@/components/agents/agent-room';

type Tab = 'overview' | 'contacts' | 'opportunities' | 'companies' | 'documents' | 'emails' | 'activity' | 'strategy' | 'room';

export default function AgentDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const { data: agentRes, isLoading } = useMasterAgent(id);
  const { data: contactsRes } = useContacts({ masterAgentId: id, limit: 100 });
  const { data: stats } = useAgentStats(id);
  const { data: emails } = useAgentEmails(id);
  const { data: companiesData } = useAgentCompanies(id);
  const { data: documentsData } = useAgentDocuments(id);
  const startAgent = useStartAgent();
  const stopAgent = useStopAgent();
  const { toast } = useToast();
  const allEvents = useRealtimeStore((s) => s.events);
  const events = useMemo(
    () => allEvents.filter((e) => (e.data as Record<string, unknown>)?.masterAgentId === id),
    [allEvents, id],
  );

  const agent = agentRes;
  const contacts = contactsRes?.data ?? [];
  const totalContacts = stats?.totalContacts ?? contactsRes?.pagination?.total ?? 0;
  const config = (agent?.config ?? {}) as Record<string, unknown>;
  const agentCompanies = companiesData ?? [];
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

  const targetRoles = (config.targetRoles as string[]) ?? [];
  const requiredSkills = (config.requiredSkills as string[]) ?? [];
  const locations = (config.locations as string[]) ?? [];
  const byStatus = stats?.byStatus ?? {};

  const funnelStages = [
    { label: 'Discovered', value: byStatus.discovered ?? 0, color: 'bg-blue-500' },
    { label: 'Enriched', value: byStatus.enriched ?? 0, color: 'bg-indigo-500' },
    { label: 'Scored', value: byStatus.scored ?? 0, color: 'bg-purple-500' },
    { label: 'Contacted', value: byStatus.contacted ?? 0, color: 'bg-emerald-500' },
  ];

  const tabs: { key: Tab; label: string; icon: React.ElementType; count?: number }[] = [
    { key: 'overview', label: 'Overview', icon: BarChart3 },
    { key: 'contacts', label: 'Contacts', icon: Users, count: totalContacts },
    { key: 'opportunities', label: 'Opportunities', icon: Zap },
    { key: 'companies', label: 'Companies', icon: Building2, count: agentCompanies.length },
    { key: 'documents', label: 'Documents', icon: FileText, count: agentDocuments.length },
    { key: 'emails', label: 'Emails', icon: Mail, count: emails?.length ?? 0 },
    { key: 'activity', label: 'Activity', icon: Activity },
    { key: 'strategy', label: 'Strategy', icon: Brain },
    { key: 'room', label: 'Agent Room', icon: MessageSquare },
  ];

  return (
    <div className="space-y-6">
      {/* Agent Header */}
      <Card>
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-lg bg-blue-500/10">
              <Bot className="w-6 h-6 text-blue-400" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-bold">{agent.name}</h1>
                <Badge variant={agent.status === 'running' ? 'success' : 'secondary'}>
                  {agent.status}
                </Badge>
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

      {/* Tabs */}
      <div className="flex gap-1 border-b border-border">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:border-border'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
              {tab.count !== undefined && tab.count > 0 && (
                <Badge variant="secondary" className="text-xs ml-1 px-1.5 py-0">
                  {tab.count}
                </Badge>
              )}
            </button>
          );
        })}
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <>
          {/* Agent Monitor */}
          <AgentMonitor masterAgentId={id} />

          {/* Pipeline Stats + Parsed Requirements */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <BarChart3 className="w-4 h-4" />
                  Pipeline Stats
                  {stats?.avgScore != null && (
                    <Badge variant="outline" className="ml-auto text-xs">Avg Score: {stats.avgScore}</Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {funnelStages.map((stage) => (
                  <div key={stage.label} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{stage.label}</span>
                      <span className="font-medium">{stage.value}</span>
                    </div>
                    <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                      <div
                        className={`h-full ${stage.color} rounded-full transition-all`}
                        style={{ width: totalContacts > 0 ? `${(stage.value / totalContacts) * 100}%` : '0%' }}
                      />
                    </div>
                  </div>
                ))}
                {totalContacts === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No contacts yet. Run the agent to start the pipeline.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Target className="w-4 h-4" />
                  Parsed Requirements
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {targetRoles.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5">
                      {agent.useCase === 'sales' ? 'Target Decision-Makers' : 'Target Roles'}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {targetRoles.map((role) => (
                        <Badge key={role} variant="secondary" className="text-xs">{role}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {requiredSkills.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5">
                      {agent.useCase === 'sales' ? 'Target Company Attributes' : 'Required Skills'}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      {requiredSkills.map((skill) => (
                        <Badge key={skill} variant="outline" className="text-xs">{skill}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {locations.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1.5">Locations</p>
                    <div className="flex flex-wrap gap-1.5">
                      {locations.map((loc) => (
                        <Badge key={loc} variant="outline" className="text-xs">{loc}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {targetRoles.length === 0 && requiredSkills.length === 0 && locations.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    Requirements will appear after the agent runs.
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Live Events */}
          <Card>
            <CardHeader>
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-500" />
                Live Events
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 max-h-[300px] overflow-y-auto">
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">
                  {agent.status === 'running' ? 'Waiting for events...' : 'No events. Start the agent to see activity.'}
                </p>
              ) : (
                events.map((event, i) => (
                  <div key={i} className="flex gap-2 text-xs border-l-2 border-border pl-2 py-1">
                    <div className="min-w-0 flex-1">
                      <span className={`font-medium ${getStatusColor(event.event)}`}>{event.event}</span>
                      {event.data && typeof event.data === 'object' && 'message' in event.data && (
                        <p className="text-muted-foreground mt-0.5 truncate">{String(event.data.message)}</p>
                      )}
                    </div>
                    <span className="text-muted-foreground shrink-0">{formatDate(event.timestamp)}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </>
      )}

      {activeTab === 'contacts' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Users className="w-4 h-4" />
              Contacts ({totalContacts})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {contacts.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No contacts discovered yet. Run the agent to start finding {agent.useCase === 'sales' ? 'prospects' : 'candidates'}.
              </p>
            ) : (
              contacts.map((contact) => (
                <Link key={contact.id} href={`/contacts/${contact.id}`} className="block cursor-pointer">
                  <div className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors">
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{[contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.email || 'Unknown'}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {contact.title} {contact.companyName ? `at ${contact.companyName}` : ''}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 ml-2 shrink-0">
                      {(contact.score ?? 0) > 0 && (
                        <Badge variant="outline" className="text-xs">
                          {contact.score}
                        </Badge>
                      )}
                      <Badge variant="secondary" className="text-xs">{contact.status}</Badge>
                    </div>
                  </div>
                </Link>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === 'opportunities' && (
        <OpportunitiesPage />
      )}

      {activeTab === 'companies' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Building2 className="w-4 h-4" />
              Companies ({agentCompanies.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            {agentCompanies.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No companies discovered yet.
              </p>
            ) : (
              <div className="grid gap-3">
                {agentCompanies.map((company) => {
                  const raw = (company.rawData ?? {}) as Record<string, unknown>;
                  const keyPeople = (raw.keyPeople as Array<{ name: string; title: string }>) ?? [];
                  const completeness = company.dataCompleteness ?? 0;

                  return (
                    <Link key={company.id} href={`/companies/${company.id}`} className="block">
                      <div className="border rounded-lg p-4 hover:bg-muted/50 transition-colors space-y-3">
                        {/* Header: name + domain + badges */}
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="font-medium truncate">{company.name}</p>
                            <p className="text-xs text-muted-foreground">
                              {[company.domain, company.industry, company.size].filter(Boolean).join(' · ')}
                            </p>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {company.funding && (
                              <Badge variant="outline" className="text-xs">{company.funding}</Badge>
                            )}
                            <Badge
                              variant={completeness >= 50 ? 'default' : completeness >= 30 ? 'secondary' : 'outline'}
                              className="text-xs"
                            >
                              {completeness > 0 ? `${completeness}%` : 'New'}
                            </Badge>
                          </div>
                        </div>

                        {/* Description */}
                        {company.description && (
                          <p className="text-xs text-muted-foreground line-clamp-2">{company.description}</p>
                        )}

                        {/* Key People */}
                        {keyPeople.length > 0 && (
                          <div className="flex flex-wrap gap-1.5">
                            {keyPeople.slice(0, 3).map((person, i) => (
                              <span key={i} className="inline-flex items-center gap-1 text-xs bg-muted px-2 py-0.5 rounded-full">
                                <span className="font-medium">{person.name}</span>
                                {person.title && <span className="text-muted-foreground">· {person.title}</span>}
                              </span>
                            ))}
                            {keyPeople.length > 3 && (
                              <span className="text-xs text-muted-foreground px-2 py-0.5">
                                +{keyPeople.length - 3} more
                              </span>
                            )}
                          </div>
                        )}

                        {/* Tech stack chips */}
                        {Array.isArray(company.techStack) && company.techStack.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {company.techStack.slice(0, 5).map((tech, i) => (
                              <span key={i} className="text-[10px] bg-blue-500/10 text-blue-400 px-1.5 py-0.5 rounded">
                                {tech}
                              </span>
                            ))}
                            {company.techStack.length > 5 && (
                              <span className="text-[10px] text-muted-foreground px-1.5 py-0.5">
                                +{company.techStack.length - 5}
                              </span>
                            )}
                          </div>
                        )}

                        {/* Progress bar */}
                        {completeness > 0 && (
                          <div className="w-full bg-muted rounded-full h-1">
                            <div
                              className={`h-1 rounded-full transition-all ${
                                completeness >= 50 ? 'bg-green-500' : completeness >= 30 ? 'bg-yellow-500' : 'bg-red-500'
                              }`}
                              style={{ width: `${Math.min(completeness, 100)}%` }}
                            />
                          </div>
                        )}
                      </div>
                    </Link>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === 'documents' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <FileText className="w-4 h-4" />
              Documents ({agentDocuments.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {agentDocuments.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No documents yet.
              </p>
            ) : (
              agentDocuments.map((doc) => (
                <div key={doc.id} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{doc.fileName || doc.type}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {doc.type} · {formatDate(doc.createdAt)}
                    </p>
                  </div>
                  <Badge variant="secondary" className="text-xs">{doc.status}</Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === 'emails' && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Mail className="w-4 h-4" />
              Emails Sent ({emails?.length ?? 0})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 max-h-[500px] overflow-y-auto">
            {!emails || emails.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No emails sent yet. Emails are sent after scoring in the pipeline.
              </p>
            ) : (
              emails.map((email) => (
                <div key={email.id} className="flex items-center justify-between p-2 rounded-lg hover:bg-muted/50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{email.subject ?? 'No subject'}</p>
                    <p className="text-xs text-muted-foreground truncate">To: {email.toEmail}</p>
                  </div>
                  <div className="flex items-center gap-2 ml-2 shrink-0">
                    {email.repliedAt && <Badge variant="success" className="text-xs">Replied</Badge>}
                    {email.openedAt && !email.repliedAt && <Badge variant="outline" className="text-xs">Opened</Badge>}
                    {email.sentAt && (
                      <span className="text-xs text-muted-foreground">{formatDate(email.sentAt)}</span>
                    )}
                  </div>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === 'activity' && (
        <ActivityFeed masterAgentId={id} />
      )}

      {activeTab === 'strategy' && (
        <StrategyPanel masterAgentId={id} />
      )}

      {activeTab === 'room' && (
        <AgentRoom masterAgentId={id} />
      )}
    </div>
  );
}
