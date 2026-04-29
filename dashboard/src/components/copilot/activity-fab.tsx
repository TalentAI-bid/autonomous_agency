'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useParseActivity, type CopilotParseResult, type CopilotContactCandidate } from '@/hooks/use-copilot-activity';
import { useCreateActivity } from '@/hooks/use-crm';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import { Sparkles, X, Send, ImageIcon, Loader2, ArrowRight, Check } from 'lucide-react';

// Pages where the FAB is hidden — auth/login flows should stay clean.
const HIDDEN_PATH_PATTERNS = [/^\/login/, /^\/signup/, /^\/forgot-password/];

export function ActivityFab() {
  const pathname = usePathname();
  const [open, setOpen] = React.useState(false);

  if (HIDDEN_PATH_PATTERNS.some((re) => re.test(pathname))) return null;

  return (
    <>
      <button
        type="button"
        aria-label="AI activity copilot"
        onClick={() => setOpen(true)}
        className={cn(
          'fixed bottom-6 right-6 z-40 flex h-14 w-14 items-center justify-center rounded-full',
          'bg-primary text-primary-foreground shadow-lg ring-1 ring-primary/30',
          'transition-transform hover:scale-105 active:scale-95',
          open && 'opacity-0 pointer-events-none',
        )}
      >
        <Sparkles className="h-5 w-5" />
      </button>

      {open && <FabPanel onClose={() => setOpen(false)} />}
    </>
  );
}

// ─── Slide-up panel ────────────────────────────────────────────────────────

function FabPanel({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const parse = useParseActivity();
  const createActivity = useCreateActivity();

  const [text, setText] = React.useState('');
  const [imageFile, setImageFile] = React.useState<File | null>(null);
  const [imageUrl, setImageUrl] = React.useState<string | null>(null);
  const [ocrProgress, setOcrProgress] = React.useState<number | null>(null);
  const [ocrText, setOcrText] = React.useState<string>('');
  const [result, setResult] = React.useState<CopilotParseResult | null>(null);
  const [pickedCandidate, setPickedCandidate] = React.useState<CopilotContactCandidate | null>(null);
  const [isOcring, setIsOcring] = React.useState(false);

  // Manage the object URL so we don't leak it.
  React.useEffect(() => {
    if (!imageFile) { setImageUrl(null); return; }
    const url = URL.createObjectURL(imageFile);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [imageFile]);

  // OCR an uploaded image. tesseract.js is lazy-loaded so the bundle stays small.
  async function runOcr(file: File) {
    setIsOcring(true);
    setOcrProgress(0);
    setOcrText('');
    try {
      const Tesseract = (await import('tesseract.js')).default;
      const result = await Tesseract.recognize(file, 'eng', {
        logger: (m: { status: string; progress: number }) => {
          if (m.status === 'recognizing text') setOcrProgress(Math.round(m.progress * 100));
        },
      });
      setOcrText(result.data.text.trim());
    } catch (err) {
      toast({
        title: 'Could not read the image',
        description: err instanceof Error ? err.message : 'Try typing the note instead.',
        variant: 'destructive',
      });
    } finally {
      setIsOcring(false);
      setOcrProgress(null);
    }
  }

  function handleFileChange(file: File | null) {
    setImageFile(file);
    setOcrText('');
    if (file) runOcr(file);
  }

  async function handleParse() {
    if (!text.trim() && !ocrText.trim()) {
      toast({ title: 'Nothing to parse', description: 'Type a note or attach a screenshot.' });
      return;
    }
    try {
      const res = await parse.mutateAsync({
        text: text.trim() || undefined,
        ocrText: ocrText.trim() || undefined,
      });
      setResult(res);
      setPickedCandidate(res.candidates[0] ?? null);
    } catch (err) {
      toast({
        title: 'Parsing failed',
        description: err instanceof Error ? err.message : 'Try rephrasing.',
        variant: 'destructive',
      });
    }
  }

  async function handleSave() {
    if (!result) return;
    try {
      await createActivity.mutateAsync({
        contactId: pickedCandidate?.id,
        type: result.draft.type,
        title: result.draft.title,
        description: result.draft.description || undefined,
      });
      qc.invalidateQueries({ queryKey: ['crm'] });
      toast({ title: 'Activity logged', description: result.draft.title });
      onClose();
    } catch (err) {
      toast({
        title: 'Could not save activity',
        description: err instanceof Error ? err.message : 'Try again.',
        variant: 'destructive',
      });
    }
  }

  // Editable draft fields — let the user tweak before saving
  type Draft = CopilotParseResult['draft'];
  function setDraftField<K extends keyof Draft>(k: K, v: Draft[K]) {
    setResult((prev) => (prev ? { ...prev, draft: { ...prev.draft, [k]: v } } : prev));
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-end p-4 sm:p-6 pointer-events-none">
      <div
        className="pointer-events-auto w-full sm:w-[420px] max-h-[85vh] flex flex-col rounded-2xl bg-card border border-border shadow-2xl overflow-hidden"
        role="dialog"
        aria-label="Activity copilot"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border bg-primary/5">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <span className="text-sm font-semibold">Activity Copilot</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-4 space-y-4">
          {!result ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="copilot-text" className="text-xs">
                  What happened?
                </Label>
                <textarea
                  id="copilot-text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={'e.g. "20-min call with Jane Doe at LiveRamp, she asked for pricing by Friday"'}
                  rows={3}
                  className={cn(
                    'flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm',
                    'placeholder:text-muted-foreground',
                    'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                    'resize-none',
                  )}
                />
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">Or drop a screenshot</Label>
                <ImageDrop onFile={handleFileChange} imageUrl={imageUrl} />
                {isOcring && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Reading image{ocrProgress != null ? ` (${ocrProgress}%)` : '…'}
                  </div>
                )}
                {ocrText && !isOcring && (
                  <details className="text-xs text-muted-foreground">
                    <summary className="cursor-pointer">Extracted text ({ocrText.length} chars)</summary>
                    <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-2 text-[11px]">{ocrText}</pre>
                  </details>
                )}
              </div>

              <Button
                onClick={handleParse}
                disabled={parse.isPending || isOcring || (!text.trim() && !ocrText.trim())}
                className="w-full"
              >
                {parse.isPending ? (
                  <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Parsing…</>
                ) : (
                  <><Send className="h-4 w-4 mr-2" />Parse with AI</>
                )}
              </Button>
            </>
          ) : (
            <DraftPreview
              result={result}
              picked={pickedCandidate}
              onPick={setPickedCandidate}
              onChangeDraft={setDraftField}
              onBack={() => setResult(null)}
            />
          )}
        </div>

        {/* Footer */}
        {result && (
          <div className="border-t border-border px-4 py-3 flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setResult(null)}>Edit input</Button>
            <Button size="sm" onClick={handleSave} disabled={createActivity.isPending}>
              {createActivity.isPending ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Saving…</>
              ) : (
                <><Check className="h-4 w-4 mr-2" />Save activity</>
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Image drop zone ───────────────────────────────────────────────────────

function ImageDrop({ onFile, imageUrl }: { onFile: (f: File | null) => void; imageUrl: string | null }) {
  const [dragOver, setDragOver] = React.useState(false);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) onFile(file);
  }

  if (imageUrl) {
    return (
      <div className="relative inline-block">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={imageUrl} alt="Pasted screenshot" className="max-h-40 rounded-md border border-border" />
        <button
          type="button"
          onClick={() => onFile(null)}
          aria-label="Remove image"
          className="absolute -top-2 -right-2 flex h-5 w-5 items-center justify-center rounded-full bg-card shadow ring-1 ring-border hover:bg-accent"
        >
          <X className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <label
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={cn(
        'flex h-24 cursor-pointer items-center justify-center rounded-md border border-dashed transition-colors',
        dragOver ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/30',
      )}
    >
      <input
        type="file"
        accept="image/*"
        className="sr-only"
        onChange={(e) => onFile(e.target.files?.[0] ?? null)}
      />
      <div className="flex flex-col items-center gap-1 text-xs text-muted-foreground">
        <ImageIcon className="h-4 w-4" />
        <span>Drop or click to upload</span>
      </div>
    </label>
  );
}

// ─── Draft preview ─────────────────────────────────────────────────────────

interface DraftPreviewProps {
  result: CopilotParseResult;
  picked: CopilotContactCandidate | null;
  onPick: (c: CopilotContactCandidate | null) => void;
  onChangeDraft: <K extends keyof CopilotParseResult['draft']>(k: K, v: CopilotParseResult['draft'][K]) => void;
  onBack: () => void;
}

const ACTIVITY_TYPE_LABELS: Record<string, string> = {
  note_added: 'Note',
  call_logged: 'Call',
  meeting_scheduled: 'Meeting',
  manual_email_sent: 'Email sent',
  manual_email_received: 'Email received',
  linkedin_connection_sent: 'LI: connect sent',
  linkedin_connection_accepted: 'LI: connect accepted',
  linkedin_message_sent: 'LI: message sent',
  linkedin_message_received: 'LI: message received',
  linkedin_followup_sent: 'LI: follow-up',
};

function DraftPreview({ result, picked, onPick, onChangeDraft }: DraftPreviewProps) {
  const draft = result.draft;
  const candidates = result.candidates;

  return (
    <div className="space-y-4">
      <div className="rounded-md bg-primary/5 border border-primary/30 px-3 py-2 text-xs">
        <span className="font-semibold text-primary">{ACTIVITY_TYPE_LABELS[draft.type] ?? draft.type}</span>
        {draft.suggestedStageSlug && (
          <>
            <span className="mx-1 text-muted-foreground">·</span>
            <span className="text-muted-foreground">suggests stage: {draft.suggestedStageSlug}</span>
          </>
        )}
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Contact</Label>
        {candidates.length > 0 ? (
          <div className="space-y-1">
            {candidates.map((c) => {
              const name = [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || 'Unknown';
              const isPicked = picked?.id === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onPick(isPicked ? null : c)}
                  className={cn(
                    'flex w-full items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
                    isPicked ? 'border-primary bg-primary/5' : 'border-input hover:bg-accent/30',
                  )}
                >
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{name}</span>
                    {c.email && <span className="block truncate text-xs text-muted-foreground">{c.email}</span>}
                  </span>
                  <span className="ml-2 flex shrink-0 items-center gap-2">
                    {c.matchType === 'email' && (
                      <span className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-400">
                        email
                      </span>
                    )}
                    {isPicked && <Check className="h-3.5 w-3.5 text-primary" />}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            {draft.contactName
              ? `No matches for "${draft.contactName}". This activity will be logged without a contact.`
              : 'No contact mentioned. This activity will be logged as a free-floating note.'}
          </p>
        )}
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="copilot-title" className="text-xs">Title</Label>
        <Input
          id="copilot-title"
          value={draft.title}
          onChange={(e) => onChangeDraft('title', e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="copilot-desc" className="text-xs">Description</Label>
        <textarea
          id="copilot-desc"
          rows={4}
          value={draft.description}
          onChange={(e) => onChangeDraft('description', e.target.value)}
          className={cn(
            'flex w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
            'resize-none',
          )}
        />
      </div>

      <div className="rounded-md border border-dashed border-border px-3 py-2 text-[11px] text-muted-foreground flex items-start gap-1.5">
        <ArrowRight className="h-3 w-3 mt-0.5 shrink-0" />
        Click "Save activity" to log this. You can still tweak any field above.
      </div>
    </div>
  );
}
