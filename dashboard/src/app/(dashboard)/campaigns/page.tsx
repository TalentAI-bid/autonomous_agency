'use client';

import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import type { Campaign, PaginatedResponse } from '@/types';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDate } from '@/lib/utils';
import { Megaphone } from 'lucide-react';

export default function CampaignsPage() {
  const { data: res, isLoading } = useQuery({
    queryKey: ['campaigns'],
    queryFn: () => apiGet<PaginatedResponse<Campaign>>('/campaigns'),
    staleTime: 30000,
  });

  const campaigns = (res?.data as unknown as Campaign[]) ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Campaigns</h1>
        <p className="text-muted-foreground text-sm mt-1">Email outreach campaigns and sequences</p>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)}
        </div>
      ) : campaigns.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="p-4 rounded-full bg-muted">
              <Megaphone className="w-8 h-8 text-muted-foreground" />
            </div>
            <div className="text-center">
              <h3 className="font-semibold">No campaigns yet</h3>
              <p className="text-sm text-muted-foreground mt-1">Campaigns are created automatically when agents start outreach</p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {campaigns.map((campaign) => (
            <Card key={campaign.id}>
              <CardContent className="p-5">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="p-2 rounded-lg bg-purple-500/10 shrink-0">
                      <Megaphone className="w-4 h-4 text-purple-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold truncate">{campaign.name}</p>
                      {campaign.description && (
                        <p className="text-sm text-muted-foreground truncate mt-0.5">{campaign.description}</p>
                      )}
                      <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                        <span>Type: {campaign.type}</span>
                        <span>Created {formatDate(campaign.createdAt)}</span>
                      </div>
                    </div>
                  </div>
                  <Badge variant={campaign.status === 'active' ? 'success' : 'secondary'}>
                    {campaign.status}
                  </Badge>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
