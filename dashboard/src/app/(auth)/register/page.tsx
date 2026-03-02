'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuthStore } from '@/stores/auth.store';
import { apiPost } from '@/lib/api';
import type { AuthResponse } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { useToast } from '@/hooks/use-toast';

export default function RegisterPage() {
  const router = useRouter();
  const { login } = useAuthStore();
  const { toast } = useToast();
  const [form, setForm] = useState({ name: '', email: '', password: '', tenantName: '', tenantSlug: '' });
  const [loading, setLoading] = useState(false);

  function update(field: string, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    if (field === 'tenantName') {
      setForm((f) => ({ ...f, tenantSlug: value.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-') }));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const res = await apiPost<{ token: string; user: AuthResponse['data']['user']; tenant: AuthResponse['data']['tenant'] }>('/auth/register', form);
      login(res.token, res.user, res.tenant);
      router.push('/dashboard');
    } catch {
      toast({ title: 'Registration failed', description: 'Please check your details and try again', variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <h1 className="text-3xl font-bold text-foreground">AgentCore</h1>
          <p className="text-muted-foreground mt-1">Create your workspace</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Create account</CardTitle>
            <CardDescription>Set up your organization and start automating recruiting</CardDescription>
          </CardHeader>
          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Full name</Label>
                <Input id="name" placeholder="Jane Smith" value={form.name} onChange={(e) => update('name', e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" placeholder="jane@company.com" value={form.email} onChange={(e) => update('email', e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="password">Password</Label>
                <Input id="password" type="password" placeholder="••••••••" value={form.password} onChange={(e) => update('password', e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tenantName">Company name</Label>
                <Input id="tenantName" placeholder="Acme Corp" value={form.tenantName} onChange={(e) => update('tenantName', e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tenantSlug">Workspace slug</Label>
                <Input id="tenantSlug" placeholder="acme-corp" value={form.tenantSlug} onChange={(e) => update('tenantSlug', e.target.value)} required />
                <p className="text-xs text-muted-foreground">Used for your workspace URL. Lowercase letters, numbers, and hyphens only.</p>
              </div>
            </CardContent>
            <CardFooter className="flex flex-col gap-3">
              <Button type="submit" className="w-full" disabled={loading}>
                {loading ? 'Creating account...' : 'Create account'}
              </Button>
              <p className="text-sm text-muted-foreground text-center">
                Already have an account?{' '}
                <Link href="/login" className="text-primary hover:underline">
                  Sign in
                </Link>
              </p>
            </CardFooter>
          </form>
        </Card>
      </div>
    </div>
  );
}
