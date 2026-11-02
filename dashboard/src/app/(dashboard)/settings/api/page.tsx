'use client';

import { useState } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field, Panel, readOnlyInput } from '@/components/settings/settings-ui';

export default function ApiSettingsPage() {
  const { token } = useAuth();
  const { toast } = useToast();
  const [reveal, setReveal] = useState(false);
  const [copied, setCopied] = useState(false);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';
  const wsUrl = process.env.NEXT_PUBLIC_WS_URL ?? 'ws://localhost:4000/ws/realtime';

  async function copyToken() {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      toast({ title: 'Token copied to clipboard' });
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast({ title: 'Could not copy the token', variant: 'destructive' });
    }
  }

  const shown = !token ? '' : reveal ? token : `${token.slice(0, 12)}${'•'.repeat(16)}`;

  return (
    <div className="space-y-5">
      <Panel title="API access" description="Use this token to authenticate requests to the Keenpipe API.">
        <div className="space-y-4">
          <Field label="Access token">
            <div className="flex gap-2">
              <Input value={shown} readOnly aria-label="Access token" className="h-9 flex-1 rounded-lg border-line bg-bg-sub font-mono text-xs text-ink-2" />
              <Button
                type="button"
                variant="panel"
                size="dense"
                onClick={() => setReveal((r) => !r)}
                aria-label={reveal ? 'Hide token' : 'Show token'}
                className="size-9 rounded-lg p-0"
              >
                {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
              </Button>
              <Button type="button" variant="panel" size="dense" onClick={copyToken} disabled={!token} className="h-9 gap-1.5 rounded-lg px-3.5 text-body font-medium">
                {copied ? <Check size={14} className="text-up" /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </Field>
          <div>
            <div className="mb-1.5 text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">Usage</div>
            <pre className="m-0 overflow-x-auto rounded-row bg-bg-sub px-3.5 py-3 font-mono text-xs leading-relaxed text-ink-2">
              {`Authorization: Bearer <token>`}
            </pre>
          </div>
          <p className="m-0 text-xs text-ink-3">The token is tied to your account and the workspace you are in. Keep it private.</p>
        </div>
      </Panel>

      <Panel title="Workspace endpoints" description="Where this app talks to the backend.">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="API URL">
            <Input value={apiUrl} readOnly className={`${readOnlyInput} font-mono text-xs`} />
          </Field>
          <Field label="WebSocket URL">
            <Input value={wsUrl} readOnly className={`${readOnlyInput} font-mono text-xs`} />
          </Field>
        </div>
      </Panel>
    </div>
  );
}
