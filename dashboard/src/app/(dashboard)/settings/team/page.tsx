'use client';

import * as React from 'react';
import {
  useTeamMembers,
  useTeamInvitations,
  useInviteMember,
  useRevokeInvitation,
  useUpdateMemberRole,
  useRemoveMember,
  type TeamRole,
  type InvitableRole,
} from '@/hooks/use-team';
import { useAuthStore } from '@/stores/auth.store';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Check, CheckCircle2, ChevronDown, Copy, Loader2, X } from 'lucide-react';

const INVITABLE_ROLES: InvitableRole[] = ['admin', 'member', 'viewer'];
const ALL_ROLES: TeamRole[] = ['owner', 'admin', 'member', 'viewer'];

const ROLE_LABEL: Record<TeamRole, string> = { owner: 'Owner', admin: 'Admin', member: 'Member', viewer: 'Viewer' };
const ROLE_HINT: Record<TeamRole, string> = {
  owner: 'Everything, including billing and deleting the workspace.',
  admin: 'Manage the team and settings; approve, edit and send; create agents.',
  member: 'Approve, edit and send; create agents; cannot change settings.',
  viewer: 'Read only. Sees the queue, leads and reports; cannot send.',
};

const AVATAR_TONES = ['bg-accent', 'bg-ink-2', 'bg-up', 'bg-info'];

function initials(name: string | null, email: string): string {
  const src = (name || email.split('@')[0] || '?').replace(/[._-]+/g, ' ').trim();
  const parts = src.split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : parts[0]?.[1] ?? '')).toUpperCase();
}

function avatarTone(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[h % AVATAR_TONES.length];
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function RoleSelect<T extends TeamRole>({
  value,
  options,
  onChange,
  disabled,
  compact,
  id,
  label,
}: {
  value: T;
  options: readonly T[];
  onChange: (role: T) => void;
  disabled?: boolean;
  compact?: boolean;
  id?: string;
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        id={id}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex w-full items-center justify-between gap-2 rounded-lg border border-line bg-bg-panel text-ink transition-colors hover:border-line-strong focus-visible:border-accent-mid focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-weak disabled:cursor-not-allowed disabled:bg-bg-soft disabled:text-ink-4 disabled:hover:border-line',
          compact ? 'h-8 min-w-[104px] px-2.5 text-xs' : 'h-10 px-3 text-body',
          open && 'border-accent-mid ring-2 ring-accent-weak',
        )}
      >
        <span className="font-medium">{ROLE_LABEL[value]}</span>
        <ChevronDown size={compact ? 13 : 14} className={cn('shrink-0 text-ink-4 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <ul
          role="listbox"
          className={cn(
            'absolute z-30 m-0 mt-1.5 w-72 list-none rounded-xl border border-line bg-bg-panel p-1.5 shadow-lg',
            compact ? 'right-0' : 'left-0',
          )}
        >
          {options.map((r) => {
            const active = r === value;
            return (
              <li key={r} role="option" aria-selected={active}>
                <button
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    if (!active) onChange(r);
                  }}
                  className={cn('flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors', active ? 'bg-accent-weak' : 'hover:bg-hover')}
                >
                  <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-accent">{active && <Check size={14} />}</span>
                  <span className="min-w-0">
                    <span className={cn('block text-body font-medium', active ? 'text-accent-fg' : 'text-ink')}>{ROLE_LABEL[r]}</span>
                    <span className="mt-0.5 block text-xs leading-snug text-ink-3">{ROLE_HINT[r]}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Panel({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-bg-panel shadow-sm">
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <h2 className="m-0 text-body font-semibold text-ink">{title}</h2>
        {aside}
      </header>
      {children}
    </section>
  );
}

export default function TeamSettingsPage() {
  const currentUser = useAuthStore((s) => s.user);
  const { toast } = useToast();

  const membersQuery = useTeamMembers();
  const invitesQuery = useTeamInvitations();
  const invite = useInviteMember();
  const revoke = useRevokeInvitation();
  const updateRole = useUpdateMemberRole();
  const removeMember = useRemoveMember();

  const [email, setEmail] = React.useState('');
  const [role, setRole] = React.useState<InvitableRole>('member');
  const [sent, setSent] = React.useState<{ email: string; role: InvitableRole } | null>(null);

  const members = membersQuery.data ?? [];
  const invitations = invitesQuery.data ?? [];
  const ownerCount = members.filter((m) => m.role === 'owner').length;
  const myMembership = members.find((m) => m.userId === currentUser?.id);
  const canManage = myMembership?.role === 'owner' || myMembership?.role === 'admin';

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    const target = email.trim();
    try {
      const result = await invite.mutateAsync({ email: target, role });
      try { await navigator.clipboard.writeText(result.inviteUrl); } catch { /* ignore */ }
      setSent({ email: target, role });
      setEmail('');
    } catch (err) {
      setSent(null);
      const message = err instanceof Error ? err.message : 'Failed to send invitation';
      toast({ title: 'Invite failed', description: message, variant: 'destructive' });
    }
  }

  async function handleCopyLink(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      toast({ title: 'Link copied to clipboard' });
    } catch {
      toast({ title: 'Copy failed', variant: 'destructive' });
    }
  }

  async function handleRevoke(id: string) {
    try {
      await revoke.mutateAsync(id);
      toast({ title: 'Invitation revoked' });
    } catch {
      toast({ title: 'Revoke failed', variant: 'destructive' });
    }
  }

  async function handleRoleChange(userId: string, newRole: TeamRole) {
    try {
      await updateRole.mutateAsync({ userId, role: newRole });
      toast({ title: 'Role updated' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update role';
      toast({ title: 'Update failed', description: message, variant: 'destructive' });
    }
  }

  async function handleRemove(userId: string, memberEmail: string) {
    if (!confirm(`Remove ${memberEmail} from this workspace?`)) return;
    try {
      await removeMember.mutateAsync(userId);
      toast({ title: 'Member removed' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove member';
      toast({ title: 'Remove failed', description: message, variant: 'destructive' });
    }
  }

  return (
    <div className="space-y-4">
      <Panel
        title="Members"
        aside={!membersQuery.isLoading && <span className="text-xs text-ink-3">{members.length} {members.length === 1 ? 'member' : 'members'}</span>}
      >
        {membersQuery.isLoading ? (
          <div className="space-y-3 p-5"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
        ) : members.length === 0 ? (
          <p className="m-0 px-5 py-6 text-body text-ink-3">No members yet.</p>
        ) : (
          <ul className="m-0 list-none divide-y divide-line p-0">
            {members.map((m) => {
              const isMe = m.userId === currentUser?.id;
              const isLastOwner = m.role === 'owner' && ownerCount <= 1;
              return (
                <li key={m.userId} className="flex items-center gap-3 px-5 py-3.5">
                  <span className={cn('grid size-9 shrink-0 place-items-center rounded-full text-xs font-semibold text-white', avatarTone(m.email))}>
                    {initials(m.name, m.email)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <span className="truncate text-body font-semibold text-ink">{m.name || m.email}</span>
                      {isMe && <span className="text-xs text-ink-4">you</span>}
                    </div>
                    <div className="truncate text-xs text-ink-3" title={`Joined ${formatDate(m.joinedAt)}`}>
                      {m.email} · {ROLE_HINT[m.role]}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2.5">
                    {canManage ? (
                      <RoleSelect
                        compact
                        value={m.role}
                        options={ALL_ROLES}
                        onChange={(r) => handleRoleChange(m.userId, r)}
                        disabled={updateRole.isPending || isLastOwner}
                        label={`Role for ${m.email}`}
                      />
                    ) : (
                      <span className="rounded-tag bg-bg-soft px-2 py-1 text-xs text-ink-2">{ROLE_LABEL[m.role]}</span>
                    )}
                    {isLastOwner ? (
                      <span className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-tag bg-bg-soft px-2 py-1 text-2xs text-ink-3">
                        <span className="size-1.5 rounded-full bg-ink-4" /> Only owner — cannot change
                      </span>
                    ) : (
                      canManage && (
                        <button
                          type="button"
                          disabled={removeMember.isPending}
                          onClick={() => handleRemove(m.userId, m.email)}
                          className="text-xs font-medium text-ink-2 hover:text-down disabled:opacity-50"
                          aria-label={`Remove ${m.email}`}
                        >
                          Remove
                        </button>
                      )
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {canManage && (
        <Panel title="Invite someone">
          <form onSubmit={handleInvite} className="space-y-3 p-5">
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px_auto] sm:items-end">
              <div className="space-y-1.5">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (sent) setSent(null);
                  }}
                  placeholder="Example: name@company.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-role">Role</Label>
                <RoleSelect id="invite-role" value={role} options={INVITABLE_ROLES} onChange={setRole} />
              </div>
              <Button type="submit" variant="brand" disabled={invite.isPending || !email.trim()}>
                {invite.isPending ? <Loader2 className="size-4 animate-spin" /> : 'Send invitation'}
              </Button>
            </div>
            <p className="m-0 text-xs text-ink-3">{ROLE_HINT[role]}</p>
            {sent && (
              <div className="flex items-start gap-2 rounded-lg border border-up/25 bg-up/10 px-3 py-2.5 text-xs text-up">
                <CheckCircle2 size={14} className="mt-px shrink-0" />
                <span>
                  Invitation sent to <span className="font-medium">{sent.email}</span> as {ROLE_LABEL[sent.role]}. The invite link was also copied to your clipboard.
                </span>
              </div>
            )}
          </form>
        </Panel>
      )}

      {canManage && (invitesQuery.isLoading || invitations.length > 0) && (
        <Panel
          title="Pending invitations"
          aside={<span className="text-xs text-ink-3">{invitations.length} waiting</span>}
        >
          {invitesQuery.isLoading ? (
            <div className="p-5"><Skeleton className="h-10" /></div>
          ) : (
            <ul className="m-0 list-none divide-y divide-line p-0">
              {invitations.map((inv) => (
                <li key={inv.id} className="flex items-center gap-3 px-5 py-3.5">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full border border-dashed border-line-strong text-xs font-semibold text-ink-3">
                    {initials(null, inv.email)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-body font-semibold text-ink">{inv.email}</div>
                    <div className="truncate text-xs text-ink-3">
                      {ROLE_LABEL[inv.role]} · sent {formatDate(inv.createdAt)} · expires {formatDate(inv.expiresAt)}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-2.5">
                    <Button type="button" variant="panel" size="dense" onClick={() => handleCopyLink(inv.inviteUrl)} className="h-7 rounded-lg">
                      <Copy size={12} /> Copy link
                    </Button>
                    <button
                      type="button"
                      onClick={() => handleRevoke(inv.id)}
                      disabled={revoke.isPending}
                      className="inline-flex items-center gap-1 text-xs font-medium text-ink-2 hover:text-down disabled:opacity-50"
                      aria-label={`Revoke invite for ${inv.email}`}
                    >
                      <X size={12} /> Revoke
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      )}
    </div>
  );
}
