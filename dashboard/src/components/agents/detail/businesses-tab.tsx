import Link from 'next/link';
import { ChevronRight, Phone, Sparkles, Star, Store } from 'lucide-react';
import { ListPanel } from './list-panel';
import type { Contact } from '@/types';

/** Google Maps businesses captured as contacts (sourceType === 'gmaps_business'). */
export function BusinessesTab({ agentId, businesses }: { agentId: string; businesses: Contact[] }) {
  return (
    <ListPanel title="Businesses" count={businesses.length} isEmpty={businesses.length === 0} empty="No Google Maps businesses captured yet.">
      {businesses.map((b) => {
        const meta = (b.sourceMetadata ?? {}) as Record<string, unknown>;
        const category = typeof meta.category === 'string' ? meta.category : '';
        const rating = typeof meta.rating === 'number' ? meta.rating : null;
        const reviews = typeof meta.reviewsCount === 'number' ? meta.reviewsCount : null;
        const price = typeof meta.pricePerPerson === 'string' ? meta.pricePerPerson : typeof meta.priceLevel === 'string' ? meta.priceLevel : '';
        const menuLink = typeof meta.menuLink === 'string' ? meta.menuLink : '';
        const hasRec = !!(meta.aiRecommendation && typeof meta.aiRecommendation === 'object');
        return (
          <li key={b.id}>
            <Link href={`/agents/${agentId}/contacts/${b.id}`} className="group flex items-center gap-3.5 px-5 py-3 transition-colors hover:bg-bg-soft">
              <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-accent-weak text-accent-fg">
                <Store size={16} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-body font-medium text-ink" dir="auto">
                  {b.companyName || b.firstName || 'Business'}
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-ink-3" dir="auto">
                  {category && <span>{category}</span>}
                  {rating != null && (
                    <span className="inline-flex items-center gap-1">
                      <Star size={11} className="fill-warn text-warn" />
                      {rating}
                      {reviews != null ? ` (${reviews})` : ''}
                    </span>
                  )}
                  {price && <span>{price}</span>}
                  {b.phone && (
                    <span className="inline-flex items-center gap-1">
                      <Phone size={11} />
                      {b.phone}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {hasRec && (
                  <span className="inline-flex items-center gap-1 rounded-md bg-accent-weak px-2 py-0.5 text-2xs font-medium text-accent-fg">
                    <Sparkles size={10} /> AI
                  </span>
                )}
                {menuLink && <span className="rounded-md bg-bg-sub px-2 py-0.5 text-2xs font-medium text-ink-2">Menu</span>}
                <span className="rounded-md bg-bg-sub px-2 py-0.5 text-2xs font-medium capitalize text-ink-2">{b.status}</span>
                <ChevronRight size={14} className="text-ink-4 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-2" />
              </div>
            </Link>
          </li>
        );
      })}
    </ListPanel>
  );
}
