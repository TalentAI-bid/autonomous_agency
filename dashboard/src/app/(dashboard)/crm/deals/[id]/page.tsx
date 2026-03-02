'use client';

import { useParams } from 'next/navigation';
import { useDeal, useDealActivities, useMoveDealStage, useCrmStages } from '@/hooks/use-crm';
import { ActivityTimeline } from '@/components/crm/activity-timeline';
import { StageBadge } from '@/components/crm/stage-badge';
import { AddActivityDialog } from '@/components/crm/add-activity-dialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate, formatRelative } from '@/lib/utils';
import { ArrowLeft, DollarSign, User, Building, Clock, FileText } from 'lucide-react';
import Link from 'next/link';

export default function DealDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: deal, isLoading: dealLoading } = useDeal(id);
  const { data: activities, isLoading: activitiesLoading } = useDealActivities(id);
  const { data: stages } = useCrmStages();
  const moveDeal = useMoveDealStage();

  function handleStageChange(stageId: string) {
    if (stageId !== deal?.stageId) {
      moveDeal.mutate({ dealId: id, stageId });
    }
  }

  if (dealLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <Skeleton className="h-64 lg:col-span-2" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  if (!deal) {
    return (
      <div className="text-center py-16 text-muted-foreground">
        <FileText className="w-8 h-8 mx-auto mb-3" />
        <p className="font-medium">Deal not found</p>
      </div>
    );
  }

  const contactName = [deal.contact?.firstName, deal.contact?.lastName].filter(Boolean).join(' ') || 'Unknown Contact';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/crm">
          <Button variant="ghost" size="icon">
            <ArrowLeft className="w-4 h-4" />
          </Button>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold">{deal.title}</h1>
            {deal.stage && <StageBadge stage={deal.stage} />}
          </div>
          <div className="flex flex-wrap gap-4 mt-2 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <User className="w-3.5 h-3.5" /> {contactName}
            </span>
            {deal.contact?.email && (
              <span>{deal.contact.email}</span>
            )}
            {deal.contact?.companyName && (
              <span className="flex items-center gap-1">
                <Building className="w-3.5 h-3.5" /> {deal.contact.companyName}
              </span>
            )}
            {deal.value && (
              <span className="flex items-center gap-1">
                <DollarSign className="w-3.5 h-3.5" />
                {deal.value} {deal.currency ?? 'USD'}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left column: Deal info + Stage selector */}
        <div className="lg:col-span-2 space-y-6">
          {/* Deal Info Card */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Deal Information</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Stage selector */}
              <div>
                <p className="text-sm text-muted-foreground mb-2">Pipeline Stage</p>
                <div className="flex flex-wrap gap-2">
                  {(stages ?? []).map((stage) => (
                    <button
                      key={stage.id}
                      onClick={() => handleStageChange(stage.id)}
                      disabled={moveDeal.isPending}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                        stage.id === deal.stageId
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                      }`}
                      style={stage.id === deal.stageId ? { borderColor: stage.color, color: stage.color } : undefined}
                    >
                      {stage.name}
                    </button>
                  ))}
                </div>
              </div>

              {/* Metadata grid */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 pt-2 border-t border-border">
                <div>
                  <p className="text-xs text-muted-foreground">Created</p>
                  <p className="text-sm font-medium">{formatDate(deal.createdAt)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Last Updated</p>
                  <p className="text-sm font-medium">{formatRelative(deal.updatedAt)}</p>
                </div>
                {deal.expectedCloseAt && (
                  <div>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Clock className="w-3 h-3" /> Expected Close
                    </p>
                    <p className="text-sm font-medium">{formatDate(deal.expectedCloseAt)}</p>
                  </div>
                )}
                {deal.closedAt && (
                  <div>
                    <p className="text-xs text-muted-foreground">Closed At</p>
                    <p className="text-sm font-medium">{formatDate(deal.closedAt)}</p>
                  </div>
                )}
              </div>

              {/* Notes */}
              {deal.notes && (
                <div className="pt-2 border-t border-border">
                  <p className="text-xs text-muted-foreground mb-1">Notes</p>
                  <p className="text-sm text-foreground whitespace-pre-wrap">{deal.notes}</p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column: Activity Timeline */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between pb-3">
              <CardTitle className="text-base">Activity</CardTitle>
              <AddActivityDialog dealId={id} contactId={deal.contactId} />
            </CardHeader>
            <CardContent>
              {activitiesLoading ? (
                <div className="space-y-3">
                  {Array.from({ length: 3 }).map((_, i) => (
                    <Skeleton key={i} className="h-16" />
                  ))}
                </div>
              ) : (
                <ActivityTimeline activities={activities ?? []} />
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
