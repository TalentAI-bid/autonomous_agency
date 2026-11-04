'use client';

import { useRef, useState } from 'react';
import { CardSection } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { Field } from '@/components/settings/settings-ui';
import { Button } from '@/components/ui/button';
import { useEmailAccounts } from '@/hooks/use-email-settings';
import { useUpdateAgent, useStartAgent } from '@/hooks/use-agents';
import { useToast } from '@/hooks/use-toast';
import { apiUpload } from '@/lib/api';
import type { MasterAgent } from '@/types';

import { Select } from '@/components/ui/select';
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
    <div className="space-y-5">
      <CardSection title="Company verification list" description="Check a fixed list of companies instead of discovering new ones.">
        <div className="space-y-4">
          <p className="m-0 text-xs leading-relaxed text-ink-3">
            Upload a CSV or Excel list of companies. The agent will strictly investigate only these companies: finding each on LinkedIn (info + team),
            on Google Maps, and crawling any website link in the file plus the real site found on LinkedIn. It discovers nothing new. Google Maps
            lookups run in batches of 20 every ~2h (free plan: 200 Maps searches/day), so verification spans hours or days; LinkedIn runs in parallel.
          </p>
          {verificationCount > 0 && (
            <Badge variant="accent" className="w-fit">
              <FileSpreadsheet size={13} /> Current list: {verificationCount} companies
            </Badge>
          )}
          <label
            htmlFor="verification-file"
            className="flex cursor-pointer items-center gap-3 rounded-card border border-dashed border-line-strong bg-bg-sub px-4 py-3.5 transition-colors hover:bg-hover"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-bg-panel text-ink-3">
              <Upload size={16} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-body font-medium text-ink">{listFile ? listFile.name : 'Choose a CSV or Excel file'}</span>
              <span className="block text-xs text-ink-3">{listFile ? `${(listFile.size / 1024).toFixed(1)} KB` : '.csv or .xlsx'}</span>
            </span>
            <input
              id="verification-file"
              ref={fileInputRef}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => setListFile(e.target.files?.[0] ?? null)}
              className="sr-only"
            />
          </label>
          <div className="flex justify-end">
            <Button type="button" variant="brand" onClick={handleUploadList} disabled={!listFile || uploading || startAgent.isPending}>
              {uploading ? 'Uploading…' : 'Upload & verify'}
            </Button>
          </div>
        </div>
      </CardSection>

      <CardSection title="Sending email account" description="Which mailbox this agent sends from.">
        <div className="space-y-4">
          <Field label="Outbound email account">
            {accounts.length > 0 ? (
              <Select
                id="agent-email-account"
                value={selected}
                onChange={(e) => setSelected(e.target.value)}
                className="h-9 w-full rounded-lg border-line bg-bg-panel px-3 text-body"
              >
                <option value="">Default (auto-select highest priority)</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name} ({account.fromEmail})
                  </option>
                ))}
              </Select>
            ) : (
              <p className="m-0 text-xs text-ink-3">
                No email accounts configured.{' '}
                <Link href="/settings/email" className="font-medium text-accent-fg hover:underline">
                  Connect one in Settings
                </Link>
              </p>
            )}
          </Field>
          <p className="m-0 text-xs text-ink-3">
            Used as the sender for new and pending drafts generated by this agent. Already-sent emails are not affected.
          </p>
          <div className="flex justify-end">
            <Button type="button" variant="brand" onClick={handleSave} disabled={!dirty || update.isPending}>
              {update.isPending ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </div>
      </CardSection>
    </div>
  );
}
