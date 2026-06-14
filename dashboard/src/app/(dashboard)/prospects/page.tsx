'use client';

import * as React from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { useProspects } from '@/hooks/use-prospect';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { Users } from 'lucide-react';
import { formatRelative } from '@/lib/utils';

const STAGES = [
  { value: '', label: 'All stages' },
  { value: 'new', label: 'New' },
  { value: 'first_touch_sent', label: 'First touch sent' },
  { value: 'awaiting_response', label: 'Awaiting response' },
  { value: 'engaged', label: 'Engaged' },
  { value: 'qualified', label: 'Qualified' },
  { value: 'meeting_scheduled', label: 'Meeting scheduled' },
  { value: 'in_evaluation', label: 'In evaluation' },
  { value: 'closed_won', label: 'Closed won' },
  { value: 'closed_lost', label: 'Closed lost' },
  { value: 'cold', label: 'Cold' },
  { value: 'dnc', label: 'DNC' },
];

const SOURCE_TYPES = [
  { value: '', label: 'All sources' },
  { value: 'ai_discovery', label: 'AI Discovery' },
  { value: 'manual_linkedin', label: 'LinkedIn (manual)' },
  { value: 'extension_capture', label: 'Extension' },
  { value: 'referral', label: 'Referral' },
  { value: 'imported_csv', label: 'CSV import' },
];

function StageBadge({ stage }: { stage: string | null }) {
  if (!stage) return <Badge variant="outline">—</Badge>;
  const variant: 'default' | 'success' | 'warning' | 'error' | 'blue' | 'purple' | 'outline' =
    stage === 'engaged' || stage === 'qualified' ? 'success' :
    stage === 'meeting_scheduled' ? 'purple' :
    stage === 'closed_won' ? 'success' :
    stage === 'closed_lost' || stage === 'dnc' ? 'error' :
    stage === 'cold' ? 'warning' :
    stage === 'awaiting_response' ? 'blue' :
    'outline';
  return <Badge variant={variant}>{stage.replace(/_/g, ' ')}</Badge>;
}

export default function ProspectsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [search, setSearch] = React.useState(searchParams.get('search') ?? '');
  const stage = searchParams.get('stage') ?? '';
  const sourceType = searchParams.get('sourceType') ?? '';
  const tag = searchParams.get('tag') ?? '';

  const filters = React.useMemo(
    () => ({
      search: search || undefined,
      stage: stage || undefined,
      sourceType: sourceType || undefined,
      tag: tag || undefined,
      limit: 50,
    }),
    [search, stage, sourceType, tag],
  );

  const { data, isLoading } = useProspects(filters);

  function setParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    router.push(`/prospects?${params.toString()}`);
  }

  return (
    <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 600 }}>Prospects</h1>
          <p style={{ fontSize: 12, color: 'var(--ink-3)' }}>
            {data ? `${data.data.length} shown · ${data.pagination.hasMore ? 'more available' : 'all loaded'}` : '—'}
          </p>
        </div>
        <Link href="/prospects/new">
          <Button>+ Add Prospect</Button>
        </Link>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <Input
          placeholder="Search name / email / company / title…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{ maxWidth: 320 }}
        />
        <select
          value={stage}
          onChange={(e) => setParam('stage', e.target.value)}
          style={{ height: 32, padding: '0 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-2)', color: 'var(--ink-1)' }}
        >
          {STAGES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select
          value={sourceType}
          onChange={(e) => setParam('sourceType', e.target.value)}
          style={{ height: 32, padding: '0 8px', border: '1px solid var(--border)', borderRadius: 6, background: 'var(--bg-2)', color: 'var(--ink-1)' }}
        >
          {SOURCE_TYPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <Input
          placeholder="Tag filter"
          value={tag}
          onChange={(e) => setParam('tag', e.target.value)}
          style={{ maxWidth: 160 }}
        />
      </div>

      {isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
        </div>
      ) : !data || data.data.length === 0 ? (
        <EmptyState
          icon={Users}
          title="No prospects match these filters"
          description="Try clearing the filters, or add a prospect manually."
          action={
            <Link href="/prospects/new"><Button>+ Add Prospect</Button></Link>
          }
        />
      ) : (
        <div style={{ overflow: 'hidden', border: '1px solid var(--border)', borderRadius: 8 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead style={{ background: 'var(--bg-1)' }}>
              <tr style={{ textAlign: 'left' }}>
                <th style={{ padding: '8px 12px' }}>Name</th>
                <th style={{ padding: '8px 12px' }}>Company</th>
                <th style={{ padding: '8px 12px' }}>Stage</th>
                <th style={{ padding: '8px 12px' }}>Last touch</th>
                <th style={{ padding: '8px 12px' }}>Source</th>
                <th style={{ padding: '8px 12px' }}>Tags</th>
              </tr>
            </thead>
            <tbody>
              {data.data.map((p) => (
                <tr
                  key={p.id}
                  onClick={() => router.push(`/prospects/${p.id}`)}
                  style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-1)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <td style={{ padding: '10px 12px' }}>
                    <div style={{ fontWeight: 500 }}>
                      {[p.firstName, p.lastName].filter(Boolean).join(' ') || '—'}
                      {p.doNotContact && <span style={{ marginLeft: 8, fontSize: 10, color: 'var(--ink-3)' }}>DNC</span>}
                    </div>
                    <div style={{ fontSize: 11, color: 'var(--ink-3)' }}>{p.title ?? ''}</div>
                  </td>
                  <td style={{ padding: '10px 12px' }}>{p.companyName ?? '—'}</td>
                  <td style={{ padding: '10px 12px' }}><StageBadge stage={p.currentStage} /></td>
                  <td style={{ padding: '10px 12px', fontSize: 12, color: 'var(--ink-3)' }}>
                    {p.lastTouchAt ? formatRelative(p.lastTouchAt) : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', fontSize: 12 }}>{p.sourceType}</td>
                  <td style={{ padding: '10px 12px' }}>
                    {p.customTags?.slice(0, 3).map((t) => (
                      <Badge key={t} variant="outline" style={{ marginRight: 4 }}>{t}</Badge>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
