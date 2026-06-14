'use client';

import * as React from 'react';
import {
  MapPin, Phone, Globe, Navigation, Star, Clock, Utensils, ExternalLink, Tag, Sparkles,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { useGenerateGmapsRecommendation, type GmapsRecommendation } from '@/hooks/use-gmaps-recommendation';
import { toast } from '@/hooks/use-toast';

// Renders the Google Maps place-detail captured into a contact's sourceMetadata
// by the extension scraper. Locale-bearing prose (reviews, about) is stored as
// raw HTML in the client's browser language (often Arabic) and rendered as-is,
// RTL-aware. The HTML was sanitized at capture time (scripts/handlers/javascript:
// stripped in maps-core.js) — that is the trust boundary here.

type Meta = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const LABEL: React.CSSProperties = {
  fontSize: 10, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 6,
};
const ROW: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink-1)' };
const SECTION: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6 };

function LinkRow({ icon, href, children }: { icon: React.ReactNode; href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" style={{ ...ROW, textDecoration: 'none' }}>
      {icon}<span>{children}</span>
    </a>
  );
}

function Collapsible({ label, html }: { label: string; html: string }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={SECTION}>
      <button
        onClick={() => setOpen((o) => !o)}
        style={{
          fontSize: 11, padding: '4px 10px', borderRadius: 999, border: '1px solid var(--border)',
          background: 'var(--bg-2)', color: 'var(--ink-2)', cursor: 'pointer', alignSelf: 'flex-start',
        }}
      >
        {open ? `Hide ${label}` : `Show ${label}`}
      </button>
      {open && (
        <div
          dir="auto"
          style={{
            maxHeight: 360, overflow: 'auto', fontSize: 12, lineHeight: 1.5,
            border: '1px solid var(--border)', borderRadius: 8, padding: 10, background: 'var(--bg-1)',
          }}
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
    <div style={SECTION}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ ...LABEL, marginBottom: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
          <Sparkles size={11} /> AI Recommendation
        </div>
        {contactId && (
          <button
            onClick={run}
            disabled={gen?.isPending}
            style={{
              fontSize: 11, padding: '3px 10px', borderRadius: 999, border: '1px solid var(--border)',
              background: 'var(--bg-1)', color: 'var(--ink-2)', cursor: gen?.isPending ? 'wait' : 'pointer',
            }}
          >
            {gen?.isPending ? 'Generating…' : rec ? 'Regenerate' : 'Generate'}
          </button>
        )}
      </div>
      {rec && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12 }} dir="auto">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Badge variant={fitColor as 'success' | 'error' | 'warning'}>{rec.fit} fit</Badge>
            {typeof rec.priorityScore === 'number' && (
              <span style={{ color: 'var(--ink-3)' }}>Priority {rec.priorityScore}/100</span>
            )}
          </div>
          {rec.reasoning && <div style={{ color: 'var(--ink-2)' }}>{rec.reasoning}</div>}
          {rec.outreachAngle && <div><strong>Angle:</strong> {rec.outreachAngle}</div>}
          {rec.recommendedService && <div><strong>Pitch:</strong> {rec.recommendedService}</div>}
          {rec.gaps?.length > 0 && (
            <div>
              <strong>Gaps:</strong>
              <ul style={{ margin: '2px 0 0', paddingInlineStart: 18 }}>
                {rec.gaps.map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            </div>
          )}
          {rec.suggestedOpener && (
            <div style={{ borderInlineStart: '2px solid var(--border)', paddingInlineStart: 8, color: 'var(--ink-2)', fontStyle: 'italic' }}>
              {rec.suggestedOpener}
            </div>
          )}
        </div>
      )}
      {!rec && <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>No recommendation yet.</div>}
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
    <div
      style={{
        border: '1px solid var(--border)', borderRadius: 12, padding: 16, background: 'var(--bg-2)',
        display: 'flex', flexDirection: 'column', gap: 14,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <MapPin size={14} />
        <div style={{ fontSize: 13, fontWeight: 600 }}>Google Maps</div>
      </div>

      {(category || rating != null || reviewsCount != null) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
          {category && <Badge variant="outline">{category}</Badge>}
          {rating != null && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Star size={12} fill="currentColor" /> {rating}
              {reviewsCount != null && <span style={{ color: 'var(--ink-3)' }}>({reviewsCount})</span>}
            </span>
          )}
        </div>
      )}

      {(phone || website || mapsUrl || directionsUrl || menuLink) && (
        <div style={SECTION}>
          {phone && <LinkRow icon={<Phone size={13} />} href={`tel:${phone}`}>{phone}</LinkRow>}
          {website && <LinkRow icon={<Globe size={13} />} href={website}>Website <ExternalLink size={11} /></LinkRow>}
          {menuLink && <LinkRow icon={<Utensils size={13} />} href={menuLink}>Menu <ExternalLink size={11} /></LinkRow>}
          {mapsUrl && <LinkRow icon={<MapPin size={13} />} href={mapsUrl}>View on Maps <ExternalLink size={11} /></LinkRow>}
          {directionsUrl && <LinkRow icon={<Navigation size={13} />} href={directionsUrl}>Directions <ExternalLink size={11} /></LinkRow>}
        </div>
      )}

      {(address || plusCode) && (
        <div style={SECTION}>
          {address && <div style={ROW}><MapPin size={13} />{address}</div>}
          {plusCode && <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{plusCode}</div>}
        </div>
      )}

      <AiRecommendation contactId={contactId} rec={aiRec} />

      {priceText && (
        <div>
          <div style={LABEL}>Price</div>
          <div style={{ fontSize: 12 }} dir="auto">{priceText}</div>
        </div>
      )}

      {(hoursRows.length > 0 || hoursStr) && (
        <div>
          <div style={LABEL}><Clock size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />Hours</div>
          {hoursRows.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 12 }} dir="auto">
              {hoursRows.map(([day, t]) => (
                <div key={day} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span style={{ color: 'var(--ink-2)' }}>{day}</span><span>{t}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 12 }} dir="auto">{hoursStr}</div>
          )}
        </div>
      )}

      {serviceOptions.length > 0 && (
        <div>
          <div style={LABEL}>Service options</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {serviceOptions.map((o) => <Badge key={o} variant="outline">{o}</Badge>)}
          </div>
        </div>
      )}

      {description && (
        <div>
          <div style={LABEL}>About</div>
          <div style={{ fontSize: 12, color: 'var(--ink-2)' }} dir="auto">{description}</div>
        </div>
      )}

      {photoUrls.length > 0 && (
        <div style={{ display: 'flex', gap: 6, overflowX: 'auto' }}>
          {photoUrls.map((u, i) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img key={i} src={u} alt="" style={{ height: 72, borderRadius: 8, flex: '0 0 auto' }} />
          ))}
        </div>
      )}

      {menu && (dishes.length > 0 || str(menu.cuisine) || str(menu.priceRange)) && (
        <div style={SECTION}>
          <div style={LABEL}><Utensils size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />Menu</div>
          {(str(menu.cuisine) || str(menu.priceRange)) && (
            <div style={{ fontSize: 12, color: 'var(--ink-2)' }} dir="auto">
              {[str(menu.cuisine), str(menu.priceRange)].filter(Boolean).join(' · ')}
            </div>
          )}
          {dishes.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12 }} dir="auto">
              {dishes.map((d, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <span>{[str(d.section), str(d.name)].filter(Boolean).join(' — ')}</span>
                  {str(d.price) && <span style={{ color: 'var(--ink-3)' }}>{str(d.price)}</span>}
                </div>
              ))}
            </div>
          )}
          {str(menu.source) && (
            <div style={{ fontSize: 10, color: 'var(--ink-3)' }}>source: {str(menu.source)}</div>
          )}
        </div>
      )}

      {ratingDistribution.length > 0 && (
        <div>
          <div style={LABEL}>Rating breakdown</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, fontSize: 11, color: 'var(--ink-2)' }} dir="auto">
            {ratingDistribution.map((r, i) => <div key={i}>{str(r.label)}</div>)}
          </div>
        </div>
      )}

      {(reviewsHtml || aboutHtml) && (
        <div style={{ ...SECTION, gap: 8 }}>
          {aboutHtml && <Collapsible label="full details" html={aboutHtml} />}
          {reviewsHtml && <Collapsible label="reviews" html={reviewsHtml} />}
        </div>
      )}

      {!phone && !website && !address && !mapsUrl && (
        <div style={{ fontSize: 11, color: 'var(--ink-3)', display: 'flex', alignItems: 'center', gap: 4 }}>
          <Tag size={11} /> Detail not fetched yet
        </div>
      )}
    </div>
  );
}
