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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Users, Mail, Trash2, Copy, X, Loader2 } from 'lucide-react';

const INVITABLE_ROLES: InvitableRole[] = ['admin', 'member', 'viewer'];
const ALL_ROLES: TeamRole[] = ['owner', 'admin', 'member', 'viewer'];

function roleBadgeVariant(role: TeamRole): 'default' | 'secondary' | 'outline' {
  if (role === 'owner') return 'default';
  if (role === 'admin') return 'secondary';
  return 'outline';
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function TeamSettingsPage() {
  const tenant = useAuthStore((s) => s.tenant);
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

  const members = membersQuery.data ?? [];
  const invitations = invitesQuery.data ?? [];
  const ownerCount = members.filter((m) => m.role === 'owner').length;
  const myMembership = members.find((m) => m.userId === currentUser?.id);
  const canManage = myMembership?.role === 'owner' || myMembership?.role === 'admin';

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    if (!email.trim()) return;
    try {
      const result = await invite.mutateAsync({ email: email.trim(), role });
      try { await navigator.clipboard.writeText(result.inviteUrl); } catch { /* ignore */ }
      toast({ title: 'Invitation sent', description: 'Invite link copied to clipboard.' });
      setEmail('');
      setRole('member');
    } catch (err) {
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

  async function handleRemove(userId: string, email: string) {
    if (!confirm(`Remove ${email} from this workspace?`)) return;
    try {
      await removeMember.mutateAsync(userId);
      toast({ title: 'Member removed' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to remove member';
      toast({ title: 'Remove failed', description: message, variant: 'destructive' });
    }
  }

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Users className="w-5 h-5" />
          Team
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Manage who has access to <span className="font-medium">{tenant?.name ?? 'this workspace'}</span>
        </p>
      </div>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Mail className="w-4 h-4" />
              Invite an employee
            </CardTitle>
            <CardDescription>
              Send an email invitation. The invite link is also copied to your clipboard.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
              <div className="flex-1 w-full space-y-1.5">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="employee@example.com"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="invite-role">Role</Label>
                <select
                  id="invite-role"
                  value={role}
                  onChange={(e) => setRole(e.target.value as InvitableRole)}
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                >
                  {INVITABLE_ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <Button type="submit" disabled={invite.isPending || !email.trim()}>
                {invite.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Send invite'}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Members</CardTitle>
          <CardDescription>
            People who can sign in to this workspace.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {membersQuery.isLoading ? (
            <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-10" /></div>
          ) : members.length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {members.map((m) => {
                const isMe = m.userId === currentUser?.id;
                const isLastOwner = m.role === 'owner' && ownerCount <= 1;
                return (
                  <div key={m.userId} className="flex items-center justify-between py-3 gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate flex items-center gap-2">
                        {m.name || m.email}
                        {isMe && <Badge variant="outline" className="text-xs">you</Badge>}
                      </div>
                      <div className="text-xs text-muted-foreground truncate">{m.email}</div>
                      <div className="text-xs text-muted-foreground">Joined {formatDate(m.joinedAt)}</div>
                    </div>
                    <div className="flex items-center gap-2">
                      {canManage ? (
                        <select
                          value={m.role}
                          onChange={(e) => handleRoleChange(m.userId, e.target.value as TeamRole)}
                          disabled={updateRole.isPending || isLastOwner}
                          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
                        >
                          {ALL_ROLES.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                      ) : (
                        <Badge variant={roleBadgeVariant(m.role)}>{m.role}</Badge>
                      )}
                      {canManage && !isLastOwner && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={removeMember.isPending}
                          onClick={() => handleRemove(m.userId, m.email)}
                          aria-label={`Remove ${m.email}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      {canManage && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pending invitations</CardTitle>
            <CardDescription>
              Invites that haven&apos;t been accepted yet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {invitesQuery.isLoading ? (
              <Skeleton className="h-10" />
            ) : invitations.length === 0 ? (
              <p className="text-sm text-muted-foreground">No pending invitations.</p>
            ) : (
              <div className="divide-y divide-border">
                {invitations.map((inv) => (
                  <div key={inv.id} className="flex items-center justify-between py-3 gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium truncate">{inv.email}</div>
                      <div className="text-xs text-muted-foreground">
                        <Badge variant={roleBadgeVariant(inv.role)} className="mr-2">{inv.role}</Badge>
                        Sent {formatDate(inv.createdAt)} · expires {formatDate(inv.expiresAt)}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button variant="outline" size="sm" onClick={() => handleCopyLink(inv.inviteUrl)}>
                        <Copy className="w-3.5 h-3.5 mr-1" /> Copy link
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleRevoke(inv.id)}
                        disabled={revoke.isPending}
                        aria-label={`Revoke invite for ${inv.email}`}
                      >
                        <X className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
