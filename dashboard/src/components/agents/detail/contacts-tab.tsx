'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { BadgeCheck, ChevronRight, MapPin, Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type { Contact, MasterAgent } from '@/types';

function fullName(c: Contact) {
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'Unknown';
}

function initials(c: Contact) {
  const letters = [c.firstName, c.lastName].filter(Boolean).map((s) => s![0]);
  return (letters.join('') || (c.email ?? '?')[0]).toUpperCase().slice(0, 2);
}

function scoreTone(score: number) {
  if (score >= 75) return 'bg-up/10 text-up';
  if (score >= 50) return 'bg-warn/15 text-warn-fg';
  return 'bg-bg-sub text-ink-3';
}

function statusTone(status: string) {
  const s = status.toLowerCase();
  if (/repl|interest|meeting|won|qualif/.test(s)) return 'bg-up/10 text-up';
  if (/bounce|fail|invalid|unsub|lost|reject|dnc/.test(s)) return 'bg-down/10 text-down';
  if (/contact|sent|progress|queue|outreach/.test(s)) return 'bg-accent-weak text-accent-fg';
  return 'bg-bg-sub text-ink-2';
}

export function ContactsTab({
  agentId,
  agent,
  contacts,
  totalContacts,
}: {
  agentId: string;
  agent: MasterAgent;
  contacts: Contact[];
  totalContacts: number;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');

  const statuses = useMemo(() => Array.from(new Set(contacts.map((c) => c.status).filter(Boolean))), [contacts]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return contacts.filter((c) => {
      if (status !== 'all' && c.status !== status) return false;
      if (!q) return true;
      return [fullName(c), c.email, c.title, c.companyName, c.location].some((v) => (v ?? '').toLowerCase().includes(q));
    });
  }, [contacts, query, status]);

  const noun = agent.useCase === 'sales' ? 'prospects' : 'candidates';
  const filtering = query.trim() !== '' || status !== 'all';

  return (
    <section className="overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm">
      <header className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3.5">
        <div className="mr-auto flex items-center gap-2">
          <h2 className="m-0 text-body font-semibold text-ink">Contacts</h2>
          <span className="rounded-tag bg-bg-soft px-1.5 font-mono text-2xs leading-[18px] text-ink-3">{totalContacts}</span>
        </div>
        {contacts.length > 0 && (
          <>
            <div className="relative">
              <Search size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-4" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search name, company, email"
                aria-label="Search contacts"
                className="h-8 w-56 rounded-lg border-line bg-bg-panel pl-8 text-xs focus-visible:ring-accent-weak"
              />
            </div>
            {statuses.length > 1 && (
              <Select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                aria-label="Filter by status"
                className="h-8 rounded-lg border-line bg-bg-panel px-2.5 text-xs capitalize"
              >
                <option value="all">All statuses</option>
                {statuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            )}
          </>
        )}
      </header>

      {contacts.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <p className="m-0 text-body font-medium text-ink">No contacts yet</p>
          <p className="mb-0 mt-1 text-xs text-ink-3">Run the agent to start finding {noun}. They will show up here.</p>
        </div>
      ) : visible.length === 0 ? (
        <p className="m-0 px-5 py-10 text-center text-body text-ink-3">No contacts match your filters.</p>
      ) : (
        <>
          <ul className="m-0 list-none divide-y divide-line p-0">
            {visible.map((c) => {
              const score = c.score ?? 0;
              const role = [c.title, c.companyName ? `at ${c.companyName}` : ''].filter(Boolean).join(' ');
              return (
                <li key={c.id}>
                  <Link
                    href={`/agents/${agentId}/contacts/${c.id}`}
                    className="group flex items-center gap-3.5 px-5 py-3 transition-colors hover:bg-bg-soft"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-weak text-xs font-semibold text-accent-fg">
                      {initials(c)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-body font-medium text-ink">{fullName(c)}</span>
                        {c.emailVerified && <BadgeCheck size={13} className="shrink-0 text-up" aria-label="Email verified" />}
                      </div>
                      <div className="truncate text-xs text-ink-3">{role || c.email || '—'}</div>
                      {(c.location || (c.email && role)) && (
                        <div className="mt-0.5 flex items-center gap-3 truncate text-2xs text-ink-4">
                          {c.email && role && <span className="truncate">{c.email}</span>}
                          {c.location && (
                            <span className="flex shrink-0 items-center gap-1">
                              <MapPin size={10} />
                              {c.location}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {score > 0 && (
                        <span className={cn('rounded-md px-2 py-0.5 font-mono text-2xs font-medium', scoreTone(score))} title="Fit score">
                          {score}
                        </span>
                      )}
                      <span className={cn('rounded-md px-2 py-0.5 text-2xs font-medium capitalize', statusTone(c.status))}>{c.status}</span>
                      <ChevronRight size={14} className="text-ink-4 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-2" />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
          <footer className="border-t border-line px-5 py-2.5 text-xs text-ink-3">
            {filtering ? `${visible.length} of ${contacts.length} loaded` : `Showing ${contacts.length}`}
            {totalContacts > contacts.length && ` · ${totalContacts} in total`}
          </footer>
        </>
      )}
    </section>
  );
}
