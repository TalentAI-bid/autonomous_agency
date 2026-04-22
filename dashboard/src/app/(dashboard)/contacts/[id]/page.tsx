'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import { useContact } from '@/hooks/use-contacts';
import { useContactTimeline, useDeals, useCrmStages } from '@/hooks/use-crm';
import { ActivityTimeline } from '@/components/crm/activity-timeline';
import { StageBadge } from '@/components/crm/stage-badge';
import { AddActivityDialog } from '@/components/crm/add-activity-dialog';
import { EmailComposeModal } from '@/components/contacts/email-compose-modal';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { formatDate, formatRelative } from '@/lib/utils';
import {
  ArrowLeft, User, Mail, Building, MapPin, Linkedin, Star, ExternalLink,
  Github, Globe, GraduationCap, Briefcase, Code, CheckCircle, AlertCircle,
  Activity, DollarSign, Send,
} from 'lucide-react';
import Link from 'next/link';
import type { ContactDeepData } from '@/types';

export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: contact, isLoading } = useContact(id);
  const { data: timeline } = useContactTimeline(id);
  const { data: deals } = useDeals({ contactId: id });
  const { data: stages } = useCrmStages();

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-48" />)}
        </div>
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <User className="w-8 h-8 mx-auto mb-3" />
        <p className="font-medium">Contact not found</p>
      </div>
    );
  }

  const [emailModalOpen, setEmailModalOpen] = useState(false);
  const deep = (contact.rawData ?? {}) as ContactDeepData;
  const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unknown';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/contacts">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold">{fullName}</h1>
            <Badge variant="secondary">{contact.status}</Badge>
            {(contact.score ?? 0) > 0 && (
              <Badge variant="outline" className="flex items-center gap-1">
                <Star className="w-3 h-3" />
                {contact.score}
              </Badge>
            )}
            {contact.email && (
              <Button variant="outline" size="sm" onClick={() => setEmailModalOpen(true)}>
                <Send className="w-3.5 h-3.5 mr-1.5" /> Draft Email
              </Button>
            )}
          </div>
          <div className="flex flex-wrap gap-4 mt-2 text-sm text-muted-foreground">
            {contact.title && <span>{contact.title}</span>}
            {contact.companyName && (
              <span className="flex items-center gap-1">
                <Building className="w-3.5 h-3.5" /> {contact.companyName}
              </span>
            )}
            {contact.location && (
              <span className="flex items-center gap-1">
                <MapPin className="w-3.5 h-3.5" /> {contact.location}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Summary Card */}
        {(deep.summary || deep.seniorityLevel || deep.totalYearsExperience) && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <User className="w-4 h-4" /> Summary
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {deep.summary && <p className="text-muted-foreground">{deep.summary}</p>}
              <div className="grid grid-cols-2 gap-2">
                {deep.seniorityLevel && (
                  <div>
                    <p className="text-muted-foreground">Seniority</p>
                    <p className="font-medium capitalize">{deep.seniorityLevel}</p>
                  </div>
                )}
                {(deep.totalYearsExperience ?? 0) > 0 && (
                  <div>
                    <p className="text-muted-foreground">Experience</p>
                    <p className="font-medium">{deep.totalYearsExperience} years</p>
                  </div>
                )}
                {(deep.dataCompleteness ?? 0) > 0 && (
                  <div>
                    <p className="text-muted-foreground">Data completeness</p>
                    <p className="font-medium">{deep.dataCompleteness}%</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Skills Card */}
        {((contact.skills ?? []).length > 0 || (deep.skillLevels ?? []).length > 0) && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Code className="w-4 h-4" /> Skills
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {(contact.skills ?? []).length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {contact.skills!.map((skill: string) => (
                    <Badge key={skill} variant="secondary">{skill}</Badge>
                  ))}
                </div>
              )}
              {(deep.skillLevels ?? []).length > 0 && (
                <div className="space-y-2 pt-2 border-t border-border">
                  {deep.skillLevels!.map((sl, i) => (
                    <div key={i} className="flex items-center justify-between text-sm">
                      <span className="font-medium">{sl.skill}</span>
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs capitalize">{sl.level}</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Experience Card */}
        {(contact.experience ?? []).length > 0 && (
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Briefcase className="w-4 h-4" /> Experience
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {(contact.experience as Array<Record<string, unknown>>).map((exp, i) => (
                  <div key={i} className="relative pl-6 border-l-2 border-border pb-4 last:pb-0">
                    <div className="absolute -left-[5px] top-1.5 w-2 h-2 rounded-full bg-primary" />
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm">{String(exp.title ?? '')}</span>
                      {!!exp.company && (
                        <span className="text-sm text-muted-foreground">at {String(exp.company)}</span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {String(exp.startDate ?? '')} — {String(exp.endDate ?? 'present')}
                    </p>
                    {!!exp.description && (
                      <p className="text-sm text-muted-foreground mt-1">{String(exp.description)}</p>
                    )}
                    {Array.isArray(exp.technologies) && exp.technologies.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {(exp.technologies as string[]).map((tech) => (
                          <Badge key={tech} variant="outline" className="text-xs">{tech}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Education Card */}
        {(contact.education ?? []).length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <GraduationCap className="w-4 h-4" /> Education
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {(contact.education as Array<Record<string, unknown>>).map((edu, i) => (
                  <div key={i} className="text-sm">
                    <p className="font-medium">{String(edu.degree ?? '')} {edu.field ? `in ${String(edu.field)}` : ''}</p>
                    <p className="text-muted-foreground">{String(edu.institution ?? '')}</p>
                    {!!edu.year && <p className="text-xs text-muted-foreground">{String(edu.year)}</p>}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* GitHub Card */}
        {(deep.githubUrl || (deep.githubStats && deep.githubStats.totalRepos > 0)) && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Github className="w-4 h-4" /> GitHub
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              {deep.githubUrl && (
                <a href={deep.githubUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-blue-400 hover:underline">
                  {deep.githubUrl} <ExternalLink className="w-3 h-3" />
                </a>
              )}
              {deep.githubStats && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <p className="text-muted-foreground">Repos</p>
                      <p className="font-medium">{deep.githubStats.totalRepos}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Stars</p>
                      <p className="font-medium">{deep.githubStats.totalStars}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Activity</p>
                      <p className="font-medium capitalize">{deep.githubStats.contributionLevel}</p>
                    </div>
                  </div>
                  {(deep.githubStats.topLanguages?.length ?? 0) > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {deep.githubStats.topLanguages!.map((lang) => (
                        <Badge key={lang} variant="secondary" className="text-xs">{lang}</Badge>
                      ))}
                    </div>
                  )}
                  {(deep.githubStats.topRepos?.length ?? 0) > 0 && (
                    <div className="space-y-2 pt-2 border-t border-border">
                      {deep.githubStats.topRepos!.map((repo, i) => (
                        <div key={i} className="flex items-center justify-between">
                          <div>
                            <span className="font-medium">{repo.name}</span>
                            {repo.language && (
                              <span className="text-xs text-muted-foreground ml-2">{repo.language}</span>
                            )}
                          </div>
                          <span className="flex items-center gap-1 text-xs text-muted-foreground">
                            <Star className="w-3 h-3" /> {repo.stars}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}

        {/* Contact Info Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Mail className="w-4 h-4" /> Contact Info
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {contact.email ? (
              <div className="flex items-center gap-2">
                <a href={`mailto:${contact.email}`} className="text-blue-400 hover:underline">
                  {contact.email}
                </a>
                {contact.emailVerified && (
                  <CheckCircle className="w-3.5 h-3.5 text-green-400" />
                )}
              </div>
            ) : (
              <p className="text-muted-foreground flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5" /> No email found
              </p>
            )}
            {contact.linkedinUrl && (
              <a href={contact.linkedinUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-blue-400 hover:underline">
                <Linkedin className="w-3.5 h-3.5" /> LinkedIn <ExternalLink className="w-3 h-3" />
              </a>
            )}
            {deep.personalWebsite && (
              <a href={deep.personalWebsite} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-blue-400 hover:underline">
                <Globe className="w-3.5 h-3.5" /> {deep.personalWebsite} <ExternalLink className="w-3 h-3" />
              </a>
            )}
            <p className="text-xs text-muted-foreground pt-2 border-t border-border">
              Discovered {formatDate(contact.createdAt)}
            </p>
          </CardContent>
        </Card>

        {/* Scoring Card */}
        {contact.scoreDetails && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Star className="w-4 h-4 text-amber-400" /> Score Breakdown
                <Badge variant="outline" className="ml-auto">{contact.score}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {Object.entries((contact.scoreDetails as Record<string, unknown>).breakdown ?? {}).map(([key, val]) => (
                <div key={key} className="space-y-1">
                  <div className="flex justify-between text-xs">
                    <span className="text-muted-foreground capitalize">{key}</span>
                    <span className="font-medium">{String(val)}</span>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className="h-full bg-primary rounded-full" style={{ width: `${Number(val)}%` }} />
                  </div>
                </div>
              ))}
              {Array.isArray((contact.scoreDetails as Record<string, unknown>).strengths) && (
                <div className="pt-2 border-t border-border">
                  <p className="text-xs text-muted-foreground mb-1">Strengths</p>
                  <div className="flex flex-wrap gap-1">
                    {((contact.scoreDetails as Record<string, unknown>).strengths as string[]).map((s, i) => (
                      <Badge key={i} variant="secondary" className="text-xs">{s}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {Array.isArray((contact.scoreDetails as Record<string, unknown>).concerns) &&
                ((contact.scoreDetails as Record<string, unknown>).concerns as string[]).length > 0 && (
                <div className="pt-2 border-t border-border">
                  <p className="text-xs text-muted-foreground mb-1">Concerns</p>
                  <div className="flex flex-wrap gap-1">
                    {((contact.scoreDetails as Record<string, unknown>).concerns as string[]).map((c, i) => (
                      <Badge key={i} variant="outline" className="text-xs">{c}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {typeof (contact.scoreDetails as Record<string, unknown>).reasoning === 'string' && (
                <p className="text-xs text-muted-foreground pt-2 border-t border-border">
                  {(contact.scoreDetails as Record<string, unknown>).reasoning as string}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Deals Card */}
        {(deals ?? []).length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <DollarSign className="w-4 h-4" /> Deals
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {deals!.map((deal) => {
                  const stage = stages?.find((s) => s.id === deal.stageId);
                  return (
                    <Link
                      key={deal.id}
                      href={`/crm/deals/${deal.id}`}
                      className="flex items-center justify-between rounded-lg border border-border p-3 hover:bg-accent/50 transition-colors"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-sm truncate">{deal.title}</p>
                        {deal.value && (
                          <p className="text-xs text-muted-foreground">
                            {deal.currency ?? '$'}{deal.value}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {stage && <StageBadge stage={stage} />}
                        <span className="text-xs text-muted-foreground">
                          {formatRelative(deal.createdAt)}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Activity Timeline Card */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center justify-between text-base">
              <span className="flex items-center gap-2">
                <Activity className="w-4 h-4" /> Activity Timeline
              </span>
              <AddActivityDialog contactId={id} />
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityTimeline activities={timeline ?? []} />
          </CardContent>
        </Card>
      </div>

      <EmailComposeModal
        contactId={id}
        contactName={fullName}
        contactEmail={contact.email}
        open={emailModalOpen}
        onOpenChange={setEmailModalOpen}
      />
    </div>
  );
}
