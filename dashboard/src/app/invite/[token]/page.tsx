'use client';

import * as React from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth.store';
import { apiGet, apiPost } from '@/lib/api';
import type { User, Tenant, Workspace } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';

interface InvitationPreview {
  email: string;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  tenantName: string;
  inviterEmail: string | null;
  inviterName: string | null;
  expiresAt: string;
}

interface AcceptResponse {
  token: string;
  user: User;
  tenant: Tenant;
  workspaces: Workspace[];
}

export default function InviteAcceptPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';
  const router = useRouter();
  const { toast } = useToast();

  const sessionUser = useAuthStore((s) => s.user);
  const sessionToken = useAuthStore((s) => s.token);
  const login = useAuthStore((s) => s.login);
  const logout = useAuthStore((s) => s.logout);

  const [preview, setPreview] = React.useState<InvitationPreview | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);

  const [name, setName] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await apiGet<InvitationPreview>(`/auth/invitations/${token}`);
        if (!cancelled) setPreview(data);
      } catch {
        if (!cancelled) setError('This invitation link is invalid, expired, or has already been accepted.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const sameEmail = sessionUser?.email && preview?.email
    ? sessionUser.email.toLowerCase() === preview.email.toLowerCase()
    : false;
  const isLoggedIn = Boolean(sessionToken && sessionUser);

  async function acceptAsExistingUser() {
    setSubmitting(true);
    try {
      const res = await apiPost<AcceptResponse>(`/auth/invitations/${token}/accept`, {});
      login(res.token, res.user, res.tenant, res.workspaces);
      router.push('/dashboard');
    } catch {
      toast({ title: 'Could not accept invitation', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  }

  async function acceptAsNewUser(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || password.length < 8) {
      toast({ title: 'Name and a password (8+ chars) are required', variant: 'destructive' });
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiPost<AcceptResponse>(`/auth/invitations/${token}/accept`, {
        name: name.trim(),
        password,
      });
      login(res.token, res.user, res.tenant, res.workspaces);
      router.push('/dashboard');
    } catch {
      toast({ title: 'Could not create account', description: 'The email may already be registered. Sign in first, then reopen this link.', variant: 'destructive' });
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <p className="text-sm text-muted-foreground">Loading invitation…</p>
      </div>
    );
  }

  if (error || !preview) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <Card className="max-w-md w-full">
          <CardHeader>
            <CardTitle>Invitation unavailable</CardTitle>
            <CardDescription>{error ?? 'Unknown error'}</CardDescription>
          </CardHeader>
          <CardFooter>
            <Link href="/login" className="text-sm text-primary hover:underline">Go to sign in</Link>
          </CardFooter>
        </Card>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>Join {preview.tenantName}</CardTitle>
            <CardDescription>
              {preview.inviterEmail
                ? <>{preview.inviterName ?? preview.inviterEmail} invited you as a <Badge variant="secondary">{preview.role}</Badge></>
                : <>You&apos;ve been invited as a <Badge variant="secondary">{preview.role}</Badge></>}
              <div className="mt-1 text-xs">For: <span className="font-medium">{preview.email}</span></div>
            </CardDescription>
          </CardHeader>

          {isLoggedIn && !sameEmail && (
            <>
              <CardContent>
                <p className="text-sm">
                  You&apos;re signed in as <strong>{sessionUser?.email}</strong>, but this invitation is
                  for <strong>{preview.email}</strong>. Sign out and reopen this link to accept.
                </p>
              </CardContent>
              <CardFooter className="flex gap-2">
                <Button variant="outline" onClick={() => { logout(); router.refresh(); }}>Sign out</Button>
              </CardFooter>
            </>
          )}

          {isLoggedIn && sameEmail && (
            <CardFooter className="flex flex-col gap-3">
              <Button className="w-full" onClick={acceptAsExistingUser} disabled={submitting}>
                {submitting ? 'Joining…' : `Accept and join ${preview.tenantName}`}
              </Button>
            </CardFooter>
          )}

          {!isLoggedIn && (
            <form onSubmit={acceptAsNewUser}>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" value={preview.email} disabled />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="name">Full name</Label>
                  <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required placeholder="Jane Smith" />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password</Label>
                  <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={8} placeholder="At least 8 characters" />
                </div>
              </CardContent>
              <CardFooter className="flex flex-col gap-3">
                <Button type="submit" className="w-full" disabled={submitting}>
                  {submitting ? 'Creating account…' : 'Create account and join'}
                </Button>
                <p className="text-xs text-muted-foreground text-center">
                  Already have an account with this email?{' '}
                  <Link href="/login" className="text-primary hover:underline">Sign in</Link>
                  {' '}then reopen this link.
                </p>
              </CardFooter>
            </form>
          )}
        </Card>
      </div>
    </div>
  );
}
