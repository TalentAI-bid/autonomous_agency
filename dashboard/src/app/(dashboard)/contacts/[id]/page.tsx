'use client';

import { useParams } from 'next/navigation';
import { useContact } from '@/hooks/use-contacts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/utils';
import { User, Mail, Building, MapPin, Linkedin, Star, ExternalLink } from 'lucide-react';

export default function ContactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: res, isLoading } = useContact(id);
  const contact = res;

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto space-y-6">
        <Skeleton className="h-40" />
        <Skeleton className="h-60" />
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="text-center py-16">
        <User className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
        <p className="text-muted-foreground">Contact not found</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <Card>
        <CardContent className="p-6">
          <div className="flex items-start gap-4">
            <div className="p-3 rounded-full bg-muted">
              <User className="w-6 h-6 text-muted-foreground" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-xl font-bold">{[contact.firstName, contact.lastName].filter(Boolean).join(' ') || 'Unknown'}</h1>
                <Badge variant="secondary">{contact.status}</Badge>
                {(contact.score ?? 0) > 0 && (
                  <Badge variant="outline" className="flex items-center gap-1">
                    <Star className="w-3 h-3" />
                    {contact.score}
                  </Badge>
                )}
              </div>
              {contact.title && <p className="text-sm text-muted-foreground mt-1">{contact.title}</p>}
              <div className="flex flex-wrap gap-4 mt-3 text-sm text-muted-foreground">
                {contact.email && (
                  <a href={`mailto:${contact.email}`} className="flex items-center gap-1.5 hover:text-foreground transition-colors">
                    <Mail className="w-3.5 h-3.5" />
                    {contact.email}
                  </a>
                )}
                {contact.companyName && (
                  <span className="flex items-center gap-1.5">
                    <Building className="w-3.5 h-3.5" />
                    {contact.companyName}
                  </span>
                )}
                {contact.location && (
                  <span className="flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5" />
                    {contact.location}
                  </span>
                )}
                {contact.linkedinUrl && (
                  <a href={contact.linkedinUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 hover:text-foreground transition-colors">
                    <Linkedin className="w-3.5 h-3.5" />
                    LinkedIn
                    <ExternalLink className="w-3 h-3" />
                  </a>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-3">Discovered {formatDate(contact.createdAt)}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {typeof contact.rawData?.summary === 'string' && (
        <Card>
          <CardHeader><CardTitle className="text-sm font-medium">Summary</CardTitle></CardHeader>
          <CardContent><p className="text-sm text-muted-foreground">{contact.rawData.summary}</p></CardContent>
        </Card>
      )}

      {contact.skills && contact.skills.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-sm font-medium">Skills</CardTitle></CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {contact.skills.map((skill: string) => (
                <Badge key={skill} variant="secondary">{skill}</Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {contact.scoreDetails && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <Star className="w-4 h-4 text-amber-400" />
              Score Breakdown (Overall: {contact.score})
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {Object.entries(contact.scoreDetails.breakdown ?? {}).map(([key, val]) => (
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
            {typeof contact.scoreDetails.reasoning === 'string' && (
              <p className="text-xs text-muted-foreground mt-2 pt-2 border-t border-border">
                {contact.scoreDetails.reasoning}
              </p>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
