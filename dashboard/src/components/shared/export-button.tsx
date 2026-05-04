'use client';

import * as React from 'react';
import { Download, ChevronDown, FileSpreadsheet, Loader2 } from 'lucide-react';
import axiosInstance from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

interface ExportButtonProps {
  /** When set, exports are scoped to one master agent. */
  masterAgentId?: string;
  /** When true (only on agent detail pages), the "Full Batch" option is shown. */
  showFullBatch?: boolean;
  className?: string;
}

type ExportKind = 'companies' | 'contacts' | 'emails-sent' | 'full-batch';

interface ExportOption {
  kind: ExportKind;
  label: string;
  endpoint: string;
  filenamePrefix: string;
}

function buildOptions(showFullBatch: boolean): ExportOption[] {
  const opts: ExportOption[] = [
    { kind: 'companies', label: 'Export Companies (.xlsx)', endpoint: '/export/companies', filenamePrefix: 'companies' },
    { kind: 'contacts', label: 'Export Contacts (.xlsx)', endpoint: '/export/contacts', filenamePrefix: 'contacts' },
    { kind: 'emails-sent', label: 'Export Emails Sent (.xlsx)', endpoint: '/export/emails-sent', filenamePrefix: 'emails-sent' },
  ];
  if (showFullBatch) {
    opts.push({ kind: 'full-batch', label: 'Export Full Batch (.xlsx)', endpoint: '/export/full-batch', filenamePrefix: 'full-batch' });
  }
  return opts;
}

export function ExportButton({ masterAgentId, showFullBatch = false, className }: ExportButtonProps) {
  const [open, setOpen] = React.useState(false);
  const [downloading, setDownloading] = React.useState<ExportKind | null>(null);
  const [since, setSince] = React.useState<string>(''); // YYYY-MM-DD optional
  const containerRef = React.useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  async function runExport(opt: ExportOption) {
    setDownloading(opt.kind);
    toast({ title: 'Generating export…', description: opt.label });
    try {
      const params: Record<string, string> = {};
      if (masterAgentId) params.masterAgentId = masterAgentId;
      if (since) params.since = new Date(since).toISOString();

      const response = await axiosInstance.get(opt.endpoint, {
        params,
        responseType: 'blob',
      });

      const blob = new Blob([response.data], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      const today = new Date().toISOString().slice(0, 10);
      link.setAttribute('download', `talentai-${opt.filenamePrefix}-${today}.xlsx`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

      toast({ title: 'Export downloaded', description: opt.label });
      setOpen(false);
    } catch (err) {
      const description = err instanceof Error ? err.message : 'Export failed.';
      toast({ title: 'Export failed', description, variant: 'destructive' });
    } finally {
      setDownloading(null);
    }
  }

  const options = buildOptions(showFullBatch);

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen((v) => !v)}
        disabled={downloading !== null}
      >
        {downloading ? (
          <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />
        ) : (
          <Download className="w-3.5 h-3.5 mr-1.5" />
        )}
        Export
        <ChevronDown className="w-3 h-3 ml-1.5 opacity-70" />
      </Button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1 w-[280px] rounded-md border border-border bg-popover shadow-md">
          {showFullBatch && (
            <div className="px-3 py-2 border-b border-border">
              <label className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
                Since (optional)
              </label>
              <Input
                type="date"
                value={since}
                onChange={(e) => setSince(e.target.value)}
                className="h-7 text-xs"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">
                Filters companies/contacts/emails to those created after this date.
              </p>
            </div>
          )}
          <ul className="py-1">
            {options.map((opt) => {
              const isLoading = downloading === opt.kind;
              return (
                <li key={opt.kind}>
                  <button
                    type="button"
                    onClick={() => runExport(opt)}
                    disabled={downloading !== null}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {isLoading ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />
                    ) : (
                      <FileSpreadsheet className="w-3.5 h-3.5 text-muted-foreground" />
                    )}
                    <span className="flex-1">{opt.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
