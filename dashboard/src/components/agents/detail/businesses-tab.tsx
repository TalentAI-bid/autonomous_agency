import Link from 'next/link';
import { Phone, Star, Store } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { Contact } from '@/types';

/** Google Maps businesses captured as contacts (sourceType === 'gmaps_business'). */
export function BusinessesTab({ agentId, businesses }: { agentId: string; businesses: Contact[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Store className="w-4 h-4" />
          Businesses ({businesses.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {businesses.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">
            No Google Maps businesses captured yet.
          </p>
        ) : (
          businesses.map((b) => {
            const meta = (b.sourceMetadata ?? {}) as Record<string, unknown>;
            const category = typeof meta.category === 'string' ? meta.category : '';
            const rating = typeof meta.rating === 'number' ? meta.rating : null;
            const reviews = typeof meta.reviewsCount === 'number' ? meta.reviewsCount : null;
            const price = typeof meta.pricePerPerson === 'string' ? meta.pricePerPerson
              : (typeof meta.priceLevel === 'string' ? meta.priceLevel : '');
            const menuLink = typeof meta.menuLink === 'string' ? meta.menuLink : '';
            const hasRec = !!(meta.aiRecommendation && typeof meta.aiRecommendation === 'object');
            return (
              <Link key={b.id} href={`/agents/${agentId}/contacts/${b.id}`} className="block cursor-pointer">
                <div className="flex items-center justify-between p-3 rounded-lg border hover:bg-muted/50 transition-colors">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate" dir="auto">{b.companyName || b.firstName || 'Business'}</p>
                    <p className="text-xs text-muted-foreground truncate flex items-center gap-2 flex-wrap" dir="auto">
                      {category && <span>{category}</span>}
                      {rating != null && (
                        <span className="inline-flex items-center gap-0.5">
                          <Star className="w-3 h-3" /> {rating}{reviews != null ? ` (${reviews})` : ''}
                        </span>
                      )}
                      {price && <span>{price}</span>}
                      {b.phone && (
                        <span className="inline-flex items-center gap-0.5"><Phone className="w-3 h-3" /> {b.phone}</span>
                      )}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 ml-2 shrink-0">
                    {hasRec && <Badge variant="outline" className="text-xs">AI</Badge>}
                    {menuLink && <Badge variant="secondary" className="text-xs">Menu</Badge>}
                    <Badge variant="secondary" className="text-xs">{b.status}</Badge>
                  </div>
                </div>
              </Link>
            );
          })
        )}
      </CardContent>
    </Card>
  );
}
