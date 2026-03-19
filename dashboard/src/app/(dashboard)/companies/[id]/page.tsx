'use client';

import { use } from 'react';
import { useCompany } from '@/hooks/use-companies';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  ArrowLeft, Globe, Building2, Users, Cpu, DollarSign,
  MapPin, Calendar, Briefcase, Heart, Newspaper, UserCircle,
  Mail, ExternalLink, Search,
} from 'lucide-react';
import Link from 'next/link';
import type { CompanyDeepData } from '@/types';

export default function CompanyDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const { data: company, isLoading } = useCompany(id);

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
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/companies">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
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
