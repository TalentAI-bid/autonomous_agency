'use client';

import { useRef, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useEmailAccounts } from '@/hooks/use-email-settings';
import { useUpdateAgent, useStartAgent } from '@/hooks/use-agents';
import { useToast } from '@/hooks/use-toast';
import { apiUpload } from '@/lib/api';
import type { MasterAgent } from '@/types';

export function AgentSettingsTab({ agent }: { agent: MasterAgent }) {
  const { data: accountsRaw = [] } = useEmailAccounts();
  const accounts = accountsRaw.filter((a) => a.isActive);
  const update = useUpdateAgent();
  const startAgent = useStartAgent();
  const { toast } = useToast();

  // ── Company-list verification upload (list_verification mode) ──────────────
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [listFile, setListFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const verificationCount = Array.isArray((agent.config as Record<string, unknown> | undefined)?.verificationList)
    ? ((agent.config as Record<string, unknown>).verificationList as unknown[]).length
    : 0;

  async function handleUploadList() {
    if (!listFile) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', listFile);
      const res = await apiUpload<{ count: number }>(`/master-agents/${agent.id}/verification-list`, formData);
      toast({ title: `Imported ${res.count} companies`, description: 'Starting verification…' });
      await startAgent.mutateAsync(agent.id);
      setListFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      toast({ title: 'Upload failed', description: message, variant: 'destructive' });
    } finally {
      setUploading(false);
    }
  }

  const config = (agent.config ?? {}) as Record<string, unknown>;
  const currentId = (config.emailAccountId as string | undefined) ?? '';
  const [selected, setSelected] = useState<string>(currentId);

  const dirty = selected !== currentId;

  async function handleSave() {
    let nextConfig: Record<string, unknown>;
    if (selected) {
      nextConfig = { ...config, emailAccountId: selected };
    } else {
      const { emailAccountId: _drop, ...rest } = config;
      nextConfig = rest;
    }
    try {
      await update.mutateAsync({ id: agent.id, config: nextConfig });
      toast({ title: 'Settings saved' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save settings';
      toast({ title: 'Save failed', description: message, variant: 'destructive' });
    }
  }

  return (
    <div className="space-y-6">
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Company verification list</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Upload a CSV or Excel list of companies. The agent will strictly investigate only these
          companies — finding each on LinkedIn (info + team), Google Maps, and crawling any website
          link in the file plus the real site found on LinkedIn. It discovers nothing new.
          Google Maps lookups run in batches of 20 every ~2h (free plan: 200 Maps searches/day),
          so verification spans hours/days; LinkedIn runs in parallel.
          {verificationCount > 0 && (
            <span className="block mt-1 text-foreground">Current list: {verificationCount} companies.</span>
          )}
        </p>
        <input
          ref={fileInputRef}
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={(e) => setListFile(e.target.files?.[0] ?? null)}
          className="block w-full text-sm text-muted-foreground file:mr-3 file:rounded-md file:border-0 file:bg-primary file:px-3 file:py-2 file:text-sm file:text-primary-foreground"
        />
        <div className="flex justify-end">
          <Button onClick={handleUploadList} disabled={!listFile || uploading || startAgent.isPending}>
            {uploading ? 'Uploading…' : 'Upload & verify'}
          </Button>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium">Sending email account</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="agent-email-account">Outbound email account</Label>
          {accounts.length > 0 ? (
            <select
              id="agent-email-account"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            >
              <option value="">Default (auto-select highest priority)</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name} ({account.fromEmail})
                </option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-muted-foreground">
              No email accounts configured.{' '}
              <a href="/settings/email" className="text-primary underline">
                Settings &gt; Email
              </a>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Used as the sender for new and pending drafts generated by this agent.
            Already-sent emails are not affected.
          </p>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!dirty || update.isPending}>
            {update.isPending ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </CardContent>
    </Card>
    </div>
  );
}
