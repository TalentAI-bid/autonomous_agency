'use client';

import { use } from 'react';
import { Breadcrumb } from '@/components/layout/breadcrumb';
import { useCompany } from '@/hooks/use-companies';
import { useContacts, useFindContactEmail } from '@/hooks/use-contacts';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  Globe, Building2, Users, Cpu, DollarSign,
  MapPin, Calendar, Briefcase, Heart, Newspaper, UserCircle,
  Mail, ExternalLink, Search, Linkedin, CheckCircle2,
  AlertTriangle, TrendingDown, FileText, Brain, ShieldAlert,
  Loader2,
} from 'lucide-react';
import Link from 'next/link';
import type { CompanyDeepData, PainPoint } from '@/types';

export default function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: company, isLoading } = useCompany(id);
  const { data: contactsRes } = useContacts({ companyId: id });
  const companyContacts = contactsRes?.data ?? [];
  const findEmail = useFindContactEmail();
  const { toast } = useToast();

  const handleFindEmail = async (contactId: string) => {
    try {
      const result = await findEmail.mutateAsync(contactId);
      if (result.email) {
        toast({
          title: 'Email found',
          description: `${result.email}${result.verified ? ' (verified)' : ''}`,
        });
      } else {
        toast({
          title: 'No email found',
          description:
            result.method === 'daily_limit'
              ? 'Reacher daily verification cap reached; try again tomorrow.'
              : result.method === 'exhausted'
              ? 'Tried all common patterns; none verified.'
              : result.method === 'no_patterns'
              ? 'Missing first/last name.'
              : `Method: ${result.method}`,
          variant: 'destructive',
        });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Email lookup failed';
      toast({ title: 'Email lookup failed', description: message, variant: 'destructive' });
    }
  };

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

  if (!company) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <Building2 className="w-8 h-8 mx-auto mb-3" />
        <p className="font-medium">Company not found</p>
      </div>
    );
  }

  const deep = (company.rawData ?? {}) as CompanyDeepData;

  const painPointIcon = (type: string) => {
    switch (type) {
      case 'no_website': return <Globe className="w-3 h-3" />;
      case 'broken_website': return <AlertTriangle className="w-3 h-3" />;
      case 'poor_seo': return <TrendingDown className="w-3 h-3" />;
      case 'thin_content': return <FileText className="w-3 h-3" />;
      case 'hiring_engineers': return <Search className="w-3 h-3" />;
      case 'llm_detected': return <Brain className="w-3 h-3" />;
      default: return <ShieldAlert className="w-3 h-3" />;
    }
  };

  /** Safely render a value that might be an object (e.g. headquarters: {city, state, country}) */
  const safeStr = (val: unknown): string => {
    if (!val) return '';
    if (typeof val === 'string') return val;
    if (typeof val === 'object') {
      // Join non-empty values: {city: "London", state: "", country: "UK"} → "London, UK"
      return Object.values(val as Record<string, unknown>)
        .filter((v) => v && typeof v === 'string' && v.trim())
        .join(', ');
    }
    return String(val);
  };

  return (
    <div className="space-y-6">
      {/* Breadcrumb + smart back */}
      <Breadcrumb
        showBack
        backFallback="/companies"
        items={[
          { href: '/companies', label: 'Companies' },
          { label: company.name ?? 'Company' },
        ]}
      />

      {/* Header */}
      <div className="flex items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold">{company.name}</h1>
          <div className="flex items-center gap-3 mt-1 text-sm text-muted-foreground">
            {company.domain && (
              <span className="flex items-center gap-1">
                <Globe className="w-3.5 h-3.5" />
                <a href={`https://${company.domain}`} target="_blank" rel="noopener noreferrer" className="hover:underline">
                  {company.domain}
                </a>
              </span>
            )}
            {company.industry && <Badge variant="secondary">{company.industry}</Badge>}
            {company.size && <span>{company.size} employees</span>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Basic Info */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="w-4 h-4" /> Overview
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {company.description && <p className="text-muted-foreground">{company.description}</p>}
            <div className="grid grid-cols-2 gap-2">
              <div>
                <p className="text-muted-foreground">Funding</p>
                <p className="font-medium">{company.funding || '—'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Founded</p>
                <p className="font-medium">{safeStr(deep.foundedYear) || '—'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">Headquarters</p>
                <p className="font-medium">{safeStr(deep.headquarters) || '—'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">LinkedIn</p>
                {company.linkedinUrl ? (
                  <a href={company.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline font-medium">
                    View Profile
                  </a>
                ) : (
                  <p className="font-medium">—</p>
                )}
              </div>
              {company.websiteStatus && (
                <div>
                  <p className="text-muted-foreground">Website</p>
                  <p className="font-medium capitalize">{company.websiteStatus.replace('_', ' ')}</p>
                </div>
              )}
              {company.seoScore != null && (
                <div>
                  <p className="text-muted-foreground">SEO Score</p>
                  <p className={`font-medium ${company.seoScore >= 70 ? 'text-emerald-500' : company.seoScore >= 40 ? 'text-amber-500' : 'text-rose-500'}`}>
                    {company.seoScore}/100
                  </p>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Tech Stack */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Cpu className="w-4 h-4" /> Tech Stack
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(company.techStack ?? []).length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {company.techStack!.map((tech) => (
                  <Badge key={tech} variant="secondary">{tech}</Badge>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No tech stack data available</p>
            )}
          </CardContent>
        </Card>

        {/* Pain Points */}
        {(company.painPoints ?? []).length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldAlert className="w-4 h-4" /> Pain Points
                <Badge variant="secondary" className="ml-1 text-xs">{company.painPoints!.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {company.painPoints!.map((p: PainPoint, i: number) => (
                  <Badge
                    key={i}
                    variant={p.severity === 'high' ? 'destructive' : p.severity === 'medium' ? 'warning' : 'secondary'}
                    className="flex items-center gap-1"
                  >
                    {painPointIcon(p.type)} {p.description}
                  </Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* People / Contacts */}
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users className="w-4 h-4" /> People
              {companyContacts.length > 0 && (
                <Badge variant="secondary" className="ml-1 text-xs">{companyContacts.length}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {companyContacts.length > 0 ? (
              <div className="space-y-3">
                {companyContacts.map((contact) => (
                  <div key={contact.id} className="flex items-center justify-between border-b border-border pb-3 last:border-0 last:pb-0">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="min-w-0">
                        <Link href={`/contacts/${contact.id}`} className="font-medium text-sm hover:underline">
                          {[contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unknown'}
                        </Link>
                        {contact.title && (
                          <p className="text-xs text-muted-foreground truncate">{contact.title}</p>
                        )}
                        {contact.email ? (
                          <div className="flex items-center gap-1 mt-0.5">
                            <a href={`mailto:${contact.email}`} className="text-xs text-blue-400 hover:underline truncate">
                              {contact.email}
                            </a>
                            {contact.emailVerified && (
                              <CheckCircle2 className="w-3 h-3 text-green-500 shrink-0" />
                            )}
                          </div>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            className="mt-1 h-6 text-xs gap-1"
                            disabled={findEmail.isPending && findEmail.variables === contact.id}
                            onClick={() => handleFindEmail(contact.id)}
                          >
                            {findEmail.isPending && findEmail.variables === contact.id ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Mail className="w-3 h-3" />
                            )}
                            Find email
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {contact.score != null && contact.score > 0 && (
                        <Badge variant="outline" className="text-xs">{contact.score}</Badge>
                      )}
                      {contact.linkedinUrl && (
                        <a href={contact.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-muted-foreground hover:text-foreground">
                          <Linkedin className="w-3.5 h-3.5" />
                        </a>
                      )}
                      <Link href={`/contacts/${contact.id}`}>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <ExternalLink className="w-3.5 h-3.5" />
                        </Button>
                      </Link>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No contacts discovered yet for this company</p>
            )}
          </CardContent>
        </Card>

        {/* Products */}
        {(deep.products ?? []).length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Briefcase className="w-4 h-4" /> Products
              </CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-sm">
                {deep.products!.map((product, i) => (
                  <li key={i} className="text-muted-foreground">
                    {product}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {/* Key People */}
        {(deep.keyPeople ?? []).length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <UserCircle className="w-4 h-4" /> Key People
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {deep.keyPeople!.map((person, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span className="font-medium">{person.name}</span>
                    <span className="text-muted-foreground">{person.title}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Open Positions */}
        {(deep.openPositions ?? []).length > 0 && (
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Briefcase className="w-4 h-4" /> Open Positions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {deep.openPositions!.map((pos, i) => (
                  <div key={i} className="border-b border-border pb-3 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm">
                        {pos.url ? (
                          <a href={pos.url} target="_blank" rel="noopener noreferrer" className="hover:underline flex items-center gap-1">
                            {pos.title} <ExternalLink className="w-3 h-3" />
                          </a>
                        ) : pos.title}
                      </span>
                      <span className="text-muted-foreground text-sm flex items-center gap-1">
                        <MapPin className="w-3 h-3" /> {pos.location || '—'}
                      </span>
                    </div>
                    {pos.salary && <p className="text-xs text-muted-foreground mt-1">{pos.salary}</p>}
                    {pos.description && <p className="text-xs text-muted-foreground mt-1">{pos.description}</p>}
                    {(pos.requiredSkills ?? []).length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {pos.requiredSkills!.map((skill) => (
                          <Badge key={skill} variant="secondary" className="text-xs">{skill}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Hiring Contacts */}
        {(deep.contactEmail || (deep.hiringContactEmails ?? []).length > 0) && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Mail className="w-4 h-4" /> Hiring Contacts
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              {deep.contactEmail && (
                <div>
                  <p className="text-muted-foreground text-xs">Company Email</p>
                  <a href={`mailto:${deep.contactEmail}`} className="text-blue-400 hover:underline">{deep.contactEmail}</a>
                </div>
              )}
              {(deep.hiringContactEmails ?? []).length > 0 && (
                <div>
                  <p className="text-muted-foreground text-xs">HR / Recruiting</p>
                  {deep.hiringContactEmails!.map((email, i) => (
                    <a key={i} href={`mailto:${email}`} className="block text-blue-400 hover:underline">{email}</a>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Job Listings Found */}
        {(deep.jobListings ?? []).length > 0 && (
          <Card className="md:col-span-2">
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Search className="w-4 h-4" /> Job Listings Found
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {deep.jobListings!.map((listing, i) => (
                  <div key={i} className="border-b border-border pb-3 last:border-0 last:pb-0">
                    <a href={listing.url} target="_blank" rel="noopener noreferrer" className="font-medium text-sm hover:underline flex items-center gap-1">
                      {listing.title} <ExternalLink className="w-3 h-3" />
                    </a>
                    {listing.snippet && <p className="text-xs text-muted-foreground mt-1">{listing.snippet}</p>}
                    {listing.skills.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {listing.skills.map((skill) => (
                          <Badge key={skill} variant="secondary" className="text-xs">{skill}</Badge>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Culture & Values */}
        {(deep.cultureValues ?? []).length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Heart className="w-4 h-4" /> Culture & Values
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {deep.cultureValues!.map((val, i) => (
                  <Badge key={i} variant="outline">{val}</Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Recent News */}
        {(deep.recentNews ?? []).length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Newspaper className="w-4 h-4" /> Recent News
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {deep.recentNews!.map((news, i) => (
                  <div key={i} className="flex items-center justify-between text-sm">
                    <span>{news.headline}</span>
                    <span className="text-muted-foreground text-xs flex items-center gap-1">
                      <Calendar className="w-3 h-3" /> {news.date}
                    </span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Competitors */}
        {(deep.competitors ?? []).length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="w-4 h-4" /> Competitors
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {deep.competitors!.map((comp, i) => (
                  <Badge key={i} variant="secondary">{comp}</Badge>
                ))}
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
