'use client';

import * as React from 'react';
import {
  MapPin, Phone, Globe, Navigation, Star, Clock, Utensils, ExternalLink, Tag, Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useGenerateGmapsRecommendation, type GmapsRecommendation } from '@/hooks/use-gmaps-recommendation';
import { toast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

// Renders the Google Maps place-detail captured into a contact's sourceMetadata
// by the extension scraper. Locale-bearing prose (reviews, about) is stored as
// raw HTML in the client's browser language (often Arabic) and rendered as-is,
// RTL-aware. The HTML was sanitized at capture time (scripts/handlers/javascript:
// stripped in maps-core.js) — that is the trust boundary here.

type Meta = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const LABEL = 'mb-1.5 text-[10px] uppercase tracking-[0.4px] text-ink-3';
const ROW = 'flex items-center gap-1.5 text-xs text-ink';
const SECTION = 'flex flex-col gap-1.5';

function LinkRow({ icon, href, children }: { icon: React.ReactNode; href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={ROW}>
      {icon}<span>{children}</span>
    </a>
  );
}

function Collapsible({ label, html }: { label: string; html: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className={SECTION}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="cursor-pointer self-start rounded-full border border-border bg-bg-sub px-2.5 py-1 text-[11px] text-ink-2"
      >
        {open ? `Hide ${label}` : `Show ${label}`}
      </button>
      {open && (
        <div
          dir="auto"
          className="max-h-[360px] overflow-auto rounded-lg border border-border bg-bg-panel p-2.5 text-xs leading-normal"
          // Sanitized at capture time in maps-core.js (no scripts/handlers).
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  );
}

function AiRecommendation({ contactId, rec }: { contactId?: string; rec: GmapsRecommendation | null }) {
  const gen = useGenerateGmapsRecommendation(contactId ?? '');
  const run = () => {
    if (!contactId) return;
    gen.mutate(undefined, { onError: () => toast({ title: 'Failed to generate recommendation', variant: 'destructive' }) });
  };
  const fitColor = rec?.fit === 'high' ? 'success' : rec?.fit === 'low' ? 'error' : 'warning';
  return (
    <div className={SECTION}>
      <div className="flex items-center justify-between gap-2">
        <div className={cn(LABEL, 'mb-0 flex items-center gap-1')}>
          <Sparkles size={11} /> AI Recommendation
        </div>
        {contactId && (
          <button
            onClick={run}
            disabled={gen?.isPending}
            className={cn(
              'rounded-full border border-border bg-bg-panel px-2.5 py-[3px] text-[11px] text-ink-2',
              gen?.isPending ? 'cursor-wait' : 'cursor-pointer',
            )}
          >
            {gen?.isPending ? 'Generating…' : rec ? 'Regenerate' : 'Generate'}
          </button>
        )}
      </div>
      {rec && (
        <div className="flex flex-col gap-1.5 text-xs" dir="auto">
          <div className="flex items-center gap-2">
            <Badge variant={fitColor as 'success' | 'error' | 'warning'}>{rec.fit} fit</Badge>
            {typeof rec.priorityScore === 'number' && (
              <span className="text-ink-3">Priority {rec.priorityScore}/100</span>
            )}
          </div>
          {rec.reasoning && <div className="text-ink-2">{rec.reasoning}</div>}
          {rec.outreachAngle && <div><strong>Angle:</strong> {rec.outreachAngle}</div>}
          {rec.recommendedService && <div><strong>Pitch:</strong> {rec.recommendedService}</div>}
          {rec.gaps?.length > 0 && (
            <div>
              <strong>Gaps:</strong>
              <ul className="m-0 mt-0.5 ps-[18px]">
                {rec.gaps.map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            </div>
          )}
          {rec.suggestedOpener && (
            <div className="border-s-2 border-border ps-2 italic text-ink-2">
              {rec.suggestedOpener}
            </div>
          )}
        </div>
      )}
      {!rec && <div className="text-[11px] text-ink-3">No recommendation yet.</div>}
    </div>
  );
}

export function GmapsBusinessCard({ contactId, sourceType, meta }: { contactId?: string; sourceType?: string; meta?: Meta | null }) {
  const m = (meta ?? {}) as Meta;
  const isGmaps = sourceType === 'gmaps_business' || str(m.source) === 'gmaps_extension';
  if (!isGmaps) return null;

  const category = str(m.category);
  const rating = num(m.rating);
  const reviewsCount = num(m.reviewsCount);
  const phone = str(m.phone);
  const website = str(m.website);
  const mapsUrl = str(m.mapsUrl);
  const directionsUrl = str(m.directionsUrl);
  const menuLink = str(m.menuLink);
  const address = str(m.address);
  const plusCode = str(m.plusCode);
  const priceLevel = str(m.priceLevel);
  const pricePerPerson = str(m.pricePerPerson);
  const description = str(m.description);
  const serviceOptions = arr<string>(m.serviceOptions);
  const ratingDistribution = arr<{ label?: string }>(m.ratingDistribution);
  const photoUrls = arr<string>(m.photoUrls);
  const reviewsHtml = str(m.reviewsHtml);
  const aboutHtml = str(m.aboutHtml);
  const hours = m.hours;
  const menu = (m.menu && typeof m.menu === 'object' ? (m.menu as Record<string, unknown>) : null);

  const priceText = [priceLevel, pricePerPerson].filter(Boolean).join(' · ');

  const hoursRows: Array<[string, string]> = hours && typeof hours === 'object' && !Array.isArray(hours)
    ? Object.entries(hours as Record<string, string>)
    : [];
  const hoursStr = typeof hours === 'string' ? hours : '';

  const dishes = menu ? arr<{ name?: string; price?: string; section?: string }>(menu.dishes) : [];
  const aiRec = (m.aiRecommendation && typeof m.aiRecommendation === 'object'
    ? (m.aiRecommendation as unknown as GmapsRecommendation) : null);

  return (
    <div className="flex flex-col gap-3.5 rounded-xl border border-border bg-bg-sub p-4">
      <div className="flex items-center gap-1.5">
        <MapPin size={14} />
        <div className="text-[13px] font-semibold">Google Maps</div>
      </div>

      {(category || rating != null || reviewsCount != null) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {category && <Badge variant="outline">{category}</Badge>}
          {rating != null && (
            <span className="inline-flex items-center gap-[3px]">
              <Star size={12} fill="currentColor" /> {rating}
              {reviewsCount != null && <span className="text-ink-3">({reviewsCount})</span>}
            </span>
          )}
        </div>
      )}

      {(phone || website || mapsUrl || directionsUrl || menuLink) && (
        <div className={SECTION}>
          {phone && <LinkRow icon={<Phone size={13} />} href={`tel:${phone}`}>{phone}</LinkRow>}
          {website && <LinkRow icon={<Globe size={13} />} href={website}>Website <ExternalLink size={11} /></LinkRow>}
          {menuLink && <LinkRow icon={<Utensils size={13} />} href={menuLink}>Menu <ExternalLink size={11} /></LinkRow>}
          {mapsUrl && <LinkRow icon={<MapPin size={13} />} href={mapsUrl}>View on Maps <ExternalLink size={11} /></LinkRow>}
          {directionsUrl && <LinkRow icon={<Navigation size={13} />} href={directionsUrl}>Directions <ExternalLink size={11} /></LinkRow>}
        </div>
      )}

      {(address || plusCode) && (
        <div className={SECTION}>
          {address && <div className={ROW}><MapPin size={13} />{address}</div>}
          {plusCode && <div className="text-[11px] text-ink-3">{plusCode}</div>}
        </div>
      )}

      <AiRecommendation contactId={contactId} rec={aiRec} />

      {priceText && (
        <div>
          <div className={LABEL}>Price</div>
          <div className="text-xs" dir="auto">{priceText}</div>
        </div>
      )}

      {(hoursRows.length > 0 || hoursStr) && (
        <div>
          <div className={LABEL}><Clock size={11} className="mr-1 inline align-middle"/>Hours</div>
          {hoursRows.length > 0 ? (
            <div className="flex flex-col gap-0.5 text-xs" dir="auto">
              {hoursRows.map(([day, t]) => (
                <div key={day} className="flex justify-between gap-3">
                  <span className="text-ink-2">{day}</span><span>{t}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs" dir="auto">{hoursStr}</div>
          )}
        </div>
      )}

      {serviceOptions.length > 0 && (
        <div>
          <div className={LABEL}>Service options</div>
          <div className="flex flex-wrap gap-1">
            {serviceOptions.map((o) => <Badge key={o} variant="outline">{o}</Badge>)}
          </div>
        </div>
      )}

      {description && (
        <div>
          <div className={LABEL}>About</div>
          <div className="text-xs text-ink-2" dir="auto">{description}</div>
        </div>
      )}

      {photoUrls.length > 0 && (
        <div className="flex gap-1.5 overflow-x-auto">
          {photoUrls.map((u, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={u} alt="" className="h-[72px] flex-none rounded-lg"/>
          ))}
        </div>
      )}

      {menu && (dishes.length > 0 || str(menu.cuisine) || str(menu.priceRange)) && (
        <div className={SECTION}>
          <div className={LABEL}><Utensils size={11} className="mr-1 inline align-middle"/>Menu</div>
          {(str(menu.cuisine) || str(menu.priceRange)) && (
            <div className="text-xs text-ink-2" dir="auto">
              {[str(menu.cuisine), str(menu.priceRange)].filter(Boolean).join(' · ')}
            </div>
          )}
          {dishes.length > 0 && (
            <div className="flex flex-col gap-[3px] text-xs" dir="auto">
              {dishes.map((d, i) => (
                <div key={i} className="flex justify-between gap-3">
                  <span>{[str(d.section), str(d.name)].filter(Boolean).join(' — ')}</span>
                  {str(d.price) && <span className="text-ink-3">{str(d.price)}</span>}
                </div>
              ))}
            </div>
          )}
          {str(menu.source) && (
            <div className="text-[10px] text-ink-3">source: {str(menu.source)}</div>
          )}
        </div>
      )}

      {ratingDistribution.length > 0 && (
        <div>
          <div className={LABEL}>Rating breakdown</div>
          <div className="flex flex-col gap-0.5 text-[11px] text-ink-2" dir="auto">
            {ratingDistribution.map((r, i) => <div key={i}>{str(r.label)}</div>)}
          </div>
        </div>
      )}

      {(reviewsHtml || aboutHtml) && (
        <div className={cn(SECTION, 'gap-2')}>
          {aboutHtml && <Collapsible label="full details" html={aboutHtml} />}
          {reviewsHtml && <Collapsible label="reviews" html={reviewsHtml} />}
        </div>
      )}

      {!phone && !website && !address && !mapsUrl && (
        <div className="flex items-center gap-1 text-[11px] text-ink-3">
          <Tag size={11} /> Detail not fetched yet
        </div>
      )}
    </div>
  );
}
