'use client';

import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/use-auth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import { User, Building, Key, Bell, Building2, Package, ChevronRight } from 'lucide-react';

export default function SettingsPage() {
  const { user, token } = useAuth();
  const { toast } = useToast();
  const router = useRouter();

  function copyToken() {
    if (token) {
      navigator.clipboard.writeText(token);
      toast({ title: 'Token copied to clipboard' });
    }
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">Manage your account and workspace preferences</p>
      </div>

      {/* Company Profile + Products — quick access */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Card
          onClick={() => router.push('/settings/company')}
          className="cursor-pointer transition-colors hover:border-primary"
        >
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Building2 className="w-4 h-4" />
                Company Profile
              </span>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </CardTitle>
            <CardDescription>
              Your company identity, positioning, and ideal customer profile
            </CardDescription>
          </CardHeader>
        </Card>

        <Card
          onClick={() => router.push('/settings/products')}
          className="cursor-pointer transition-colors hover:border-primary"
        >
          <CardHeader>
            <CardTitle className="text-base flex items-center justify-between">
              <span className="flex items-center gap-2">
                <Package className="w-4 h-4" />
                Products & Services
              </span>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </CardTitle>
            <CardDescription>
              Manage what you sell — agents use this to personalize outreach
            </CardDescription>
          </CardHeader>
        </Card>
      </div>

      {/* Profile */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <User className="w-4 h-4" />
            Profile
          </CardTitle>
          <CardDescription>Your personal account information</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>Name</Label>
            <Input defaultValue={user?.name} disabled />
          </div>
          <div className="space-y-2">
            <Label>Email</Label>
            <Input defaultValue={user?.email} disabled />
          </div>
          <div className="space-y-2">
            <Label>Role</Label>
            <div>
              <Badge variant="secondary">{user?.role ?? 'admin'}</Badge>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* API Token */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Key className="w-4 h-4" />
            API Token
          </CardTitle>
          <CardDescription>Use this token to authenticate API requests</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={token ? `${token.slice(0, 20)}...` : ''}
              readOnly
              className="font-mono text-xs"
            />
            <Button variant="outline" onClick={copyToken}>Copy</Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Include as <code className="bg-muted px-1 py-0.5 rounded">Authorization: Bearer &lt;token&gt;</code> in API requests
          </p>
        </CardContent>
      </Card>

      {/* Workspace */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Building className="w-4 h-4" />
            Workspace
          </CardTitle>
          <CardDescription>Organization-wide configuration</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label>API URL</Label>
            <Input value={process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'} readOnly />
          </div>
          <div className="space-y-2">
            <Label>WebSocket URL</Label>
            <Input value={process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws/realtime'} readOnly />
          </div>
        </CardContent>
      </Card>

      {/* Notifications (placeholder) */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Bell className="w-4 h-4" />
            Notifications
          </CardTitle>
          <CardDescription>Configure when you receive alerts</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Real-time notifications are delivered via WebSocket. Browser notification support coming soon.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
