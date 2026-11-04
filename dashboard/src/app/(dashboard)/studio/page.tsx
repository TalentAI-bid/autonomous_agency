'use client';

import { useState, useMemo, type ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import Link from 'next/link';
import {
  Check,
  Copy,
  ExternalLink,
  Globe,
  Handshake,
  Lightbulb,
  Linkedin,
  Loader2,
  Mail,
  MessageCircle,
  RefreshCw,
  Send,
  Sparkles,
  TrendingUp,
  UserPlus,
  type LucideIcon,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';
import {
  useGenerateStudioMessage,
  type StudioChannel,
  type StudioTrack,
  type MessageType,
  type StudioComposition,
} from '@/hooks/use-studio';

const CHANNELS: Array<{ id: StudioChannel; label: string; short: string; icon: LucideIcon }> = [
  { id: 'email_cold', label: 'Cold email', short: 'Email', icon: Mail },
  { id: 'linkedin_dm', label: 'LinkedIn DM', short: 'LinkedIn DM', icon: Linkedin },
  { id: 'linkedin_connection_request', label: 'LinkedIn connection request', short: 'Connection', icon: UserPlus },
  { id: 'twitter_dm', label: 'X / Twitter DM', short: 'X DM', icon: Send },
  { id: 'whatsapp', label: 'WhatsApp', short: 'WhatsApp', icon: MessageCircle },
  { id: 'telegram', label: 'Telegram', short: 'Telegram', icon: Send },
];

const TRACKS: Array<{ id: StudioTrack; label: string; description: string; icon: LucideIcon }> = [
  { id: 'sales', label: 'Sales', description: 'Pitch your service to a potential buyer.', icon: TrendingUp },
  { id: 'partnership', label: 'Partnership', description: 'Propose a collaboration with a peer.', icon: Handshake },
  { id: 'collaboration', label: 'Collaboration', description: 'Build mutual value with an adjacent partner.', icon: Globe },
];

const MESSAGE_TYPES: Array<{ id: MessageType; label: string }> = [
  { id: 'first_message', label: 'First message' },
  { id: 'first_followup', label: 'First follow-up' },
  { id: 'second_followup', label: 'Second follow-up' },
  { id: 'breakup', label: 'Breakup / final' },
  { id: 'reactivation', label: 'Reactivation' },
  { id: 'post_meeting', label: 'Post-meeting' },
  { id: 'post_no_show', label: 'Post-no-show' },
];

function externalLinkFor(channel: StudioChannel, linkedinUrl?: string): { href: string; label: string } | null {
  switch (channel) {
    case 'email_cold':
      return null;
    case 'linkedin_dm':
    case 'linkedin_connection_request':
      return linkedinUrl ? { href: linkedinUrl, label: 'Open LinkedIn' } : { href: 'https://www.linkedin.com', label: 'Open LinkedIn' };
    case 'twitter_dm':
      return { href: 'https://twitter.com/messages', label: 'Open X' };
    case 'whatsapp':
      return { href: 'https://web.whatsapp.com', label: 'Open WhatsApp' };
    case 'telegram':
      return { href: 'https://web.telegram.org', label: 'Open Telegram' };
  }
}

const labelCls = 'text-3xs font-medium uppercase tracking-[0.09em] text-ink-4';
const inputCls = 'h-9 rounded-lg border-line bg-bg-panel text-body focus-visible:ring-accent-weak';
const selectCls = 'w-full h-9 rounded-lg border-line bg-bg-panel px-3 text-body';

function Section({ step, title, children }: { step: number; title: string; children: ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-full bg-accent-weak text-3xs font-semibold text-accent-fg">{step}</span>
        <h3 className="m-0 text-body font-semibold text-ink">{title}</h3>
      </div>
      {children}
    </div>
  );
}

function Field({ label, optional, children }: { label: string; optional?: boolean; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className={labelCls}>
        {label}
        {optional && <span className="ml-1 normal-case tracking-normal text-ink-4">(optional)</span>}
      </Label>
      {children}
    </div>
  );
}

export default function StudioPage() {
  const { toast } = useToast();
  const [channel, setChannel] = useState<StudioChannel>('email_cold');
  const [track, setTrack] = useState<StudioTrack>('sales');
  const [messageType, setMessageType] = useState<MessageType>('first_message');
  const [missedMeetingTime, setMissedMeetingTime] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientCompany, setRecipientCompany] = useState('');
  const [recipientTitle, setRecipientTitle] = useState('');
  const [recipientLocation, setRecipientLocation] = useState('');
  const [recipientLinkedinUrl, setRecipientLinkedinUrl] = useState('');
  const [customContext, setCustomContext] = useState('');
  const [result, setResult] = useState<StudioComposition | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const generate = useGenerateStudioMessage();

  async function handleGenerate() {
    if (!recipientName.trim()) {
      toast({ title: 'Recipient name required', variant: 'destructive' });
      return;
    }
    if (messageType === 'post_meeting' && !customContext.trim()) {
      toast({
        title: 'Meeting context required',
        description: 'Describe what was discussed in the Additional Context field.',
        variant: 'destructive',
      });
      return;
    }
    // For post_no_show, fold the optional missed-meeting time into customContext
    // so the model sees it. Keeps the backend payload shape unchanged.
    let mergedContext = customContext.trim();
    if (messageType === 'post_no_show' && missedMeetingTime.trim()) {
      const prefix = `Original meeting time: ${missedMeetingTime.trim()}.`;
      mergedContext = mergedContext ? `${prefix} ${mergedContext}` : prefix;
    }
    try {
      const res = await generate.mutateAsync({
        channel,
        track,
        messageType,
        recipient: {
          name: recipientName.trim(),
          company: recipientCompany.trim() || undefined,
          title: recipientTitle.trim() || undefined,
          location: recipientLocation.trim() || undefined,
          linkedinUrl: recipientLinkedinUrl.trim() || undefined,
        },
        customContext: mergedContext || undefined,
      });
      setResult(res.composition);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Generation failed';
      toast({ title: 'Generation failed', description: msg, variant: 'destructive' });
    }
  }

  function handleCopy(text: string, label: string) {
    navigator.clipboard.writeText(text);
    toast({ title: `${label} copied` });
    setCopied(label);
    setTimeout(() => setCopied((c) => (c === label ? null : c)), 1800);
  }

  const wordCount = useMemo(() => (result ? result.body.trim().split(/\s+/).filter(Boolean).length : 0), [result]);
  const channelMeta = CHANNELS.find((c) => c.id === channel)!;
  const ChannelIcon = channelMeta.icon;
  const ext = externalLinkFor(channel, recipientLinkedinUrl);
  const needsRecap = messageType === 'post_meeting' && !customContext.trim();

  function CopyBtn({ text, label, children }: { text: string; label: string; children: ReactNode }) {
    return (
      <Button size="sm" type="button" variant="panel" onClick={() => handleCopy(text, label)}>
        {copied === label ? <Check size={13} className="text-up" /> : <Copy size={13} />}
        {children}
      </Button>
    );
  }

  return (
    <div className="mx-auto max-w-[1180px] p-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="m-0 font-display text-title font-medium text-ink">Message Studio</h1>
          <p className="mb-0 mt-1 text-body text-ink-3">
            Write a one-off outreach message for any prospect, on any channel. It follows your{' '}
            <Link href="/settings/messaging" className="font-medium text-accent-fg hover:underline">
              messaging settings
            </Link>
            .
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* LEFT: compose */}
        <section className="overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm">
          <header className="border-b border-line px-5 py-3.5">
            <h2 className="m-0 text-body font-semibold text-ink">Compose</h2>
            <p className="mb-0 mt-0.5 text-xs text-ink-3">Choose where it goes, who it is for, then generate.</p>
          </header>

          <div className="space-y-6 p-5">
            <Section step={1} title="Channel & type">
              <div className="grid grid-cols-3 gap-2">
                {CHANNELS.map((c) => {
                  const Icon = c.icon;
                  const active = channel === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setChannel(c.id)}
                      aria-pressed={active}
                      className={cn(
                        'flex h-14 flex-col items-center justify-center gap-1 rounded-card border text-2xs transition-colors',
                        active
                          ? 'border-accent-mid bg-accent-weak font-medium text-accent-fg'
                          : 'border-line bg-bg-panel text-ink-2 hover:bg-hover',
                      )}
                    >
                      <Icon size={15} />
                      {c.short}
                    </button>
                  );
                })}
              </div>
              <Field label="Message type">
                <Select value={messageType} onChange={(e) => setMessageType(e.target.value as MessageType)} className={selectCls}>
                  {MESSAGE_TYPES.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </Select>
                {messageType === 'reactivation' && (
                  <p className="m-0 flex items-start gap-1.5 text-xs text-ink-3">
                    <Lightbulb size={13} className="mt-px shrink-0 text-warn-fg" />
                    Mention something specific that changed: their company news, a market shift, your new offering.
                  </p>
                )}
              </Field>
              {messageType === 'post_no_show' && (
                <Field label="Original meeting time" optional>
                  <Input
                    value={missedMeetingTime}
                    onChange={(e) => setMissedMeetingTime(e.target.value)}
                    placeholder="e.g. Tuesday 3pm UTC"
                    className={inputCls}
                  />
                </Field>
              )}
            </Section>

            <Section step={2} title="Track">
              <div className="grid gap-2 sm:grid-cols-3">
                {TRACKS.map((t) => {
                  const Icon = t.icon;
                  const active = track === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setTrack(t.id)}
                      aria-pressed={active}
                      className={cn(
                        'flex flex-col items-start gap-1 rounded-card border p-3 text-left transition-colors',
                        active ? 'border-accent-mid bg-accent-weak' : 'border-line bg-bg-panel hover:bg-hover',
                      )}
                    >
                      <span className={cn('flex items-center gap-1.5 text-body font-medium', active ? 'text-accent-fg' : 'text-ink')}>
                        <Icon size={14} />
                        {t.label}
                      </span>
                      <span className="text-2xs leading-snug text-ink-3">{t.description}</span>
                    </button>
                  );
                })}
              </div>
            </Section>

            <Section step={3} title="Recipient">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name *">
                  <Input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder="Igor Lavrih" className={inputCls} />
                </Field>
                <Field label="Company" optional>
                  <Input value={recipientCompany} onChange={(e) => setRecipientCompany(e.target.value)} placeholder="Hoppacard" className={inputCls} />
                </Field>
                <Field label="Title" optional>
                  <Input value={recipientTitle} onChange={(e) => setRecipientTitle(e.target.value)} placeholder="Co-Founder & CEO" className={inputCls} />
                </Field>
                <Field label="Location" optional>
                  <Input value={recipientLocation} onChange={(e) => setRecipientLocation(e.target.value)} placeholder="Eindhoven, NL" className={inputCls} />
                </Field>
              </div>
              <Field label="LinkedIn URL" optional>
                <Input
                  value={recipientLinkedinUrl}
                  onChange={(e) => setRecipientLinkedinUrl(e.target.value)}
                  placeholder="https://linkedin.com/in/..."
                  className={inputCls}
                />
              </Field>
            </Section>

            <Section step={4} title={messageType === 'post_meeting' ? 'What was discussed? *' : 'Extra context'}>
              <Textarea
                value={customContext}
                onChange={(e) => setCustomContext(e.target.value)}
                placeholder={
                  messageType === 'post_meeting'
                    ? 'Required. Quick recap: the conversation, the key takeaway, what they cared about, what was decided.'
                    : 'How you got their info, any hints, a specific angle you want the message to take. Optional.'
                }
                rows={3}
                className="rounded-lg border-line bg-bg-panel text-body focus-visible:ring-accent-weak"
              />
              {needsRecap && <p className="m-0 text-xs text-warn-fg">Post-meeting messages need a recap of the conversation.</p>}
            </Section>

            <Button size="lg" type="button" variant="brand" onClick={handleGenerate} disabled={generate.isPending || needsRecap} className="w-full">
              {generate.isPending ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />}
              {generate.isPending ? 'Writing…' : result ? 'Generate again' : 'Generate message'}
            </Button>
          </div>
        </section>

        {/* RIGHT: output */}
        <section className="overflow-hidden rounded-2xl border border-line bg-bg-panel shadow-sm lg:sticky lg:top-4">
          <header className="flex items-center gap-2.5 border-b border-line px-5 py-3.5">
            <span className="flex size-7 items-center justify-center rounded-row bg-accent-weak text-accent-fg">
              <ChannelIcon size={14} />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="m-0 text-body font-semibold text-ink">{channelMeta.label}</h2>
              <p className="mb-0 mt-0.5 text-xs text-ink-3">
                {MESSAGE_TYPES.find((t) => t.id === messageType)?.label} · {TRACKS.find((t) => t.id === track)?.label}
              </p>
            </div>
            {result && <Badge variant="soft" size="sm" className="capitalize">{result.track} track</Badge>}
          </header>

          <div className="p-5">
            {generate.isPending ? (
              <div className="flex flex-col items-center gap-3 py-16 text-center">
                <Loader2 size={22} className="animate-spin text-accent" />
                <p className="m-0 text-body text-ink-2">Writing your message…</p>
                <p className="m-0 text-xs text-ink-3">This usually takes a few seconds.</p>
              </div>
            ) : !result ? (
              <div className="flex flex-col items-center gap-2 py-14 text-center">
                <span className="flex size-11 items-center justify-center rounded-panel bg-accent-weak text-accent-fg">
                  <Sparkles size={20} />
                </span>
                <p className="m-0 mt-1 text-body font-medium text-ink">Your message will appear here</p>
                <p className="m-0 max-w-[320px] text-xs leading-relaxed text-ink-3">
                  Fill in the recipient and click Generate. The ICP and value proposition come from{' '}
                  <Link href="/settings/messaging" className="font-medium text-accent-fg hover:underline">
                    Settings → Messaging
                  </Link>
                  .
                </p>
              </div>
            ) : (
              <div className="space-y-4">
                {channel === 'email_cold' && result.subject && (
                  <div className="space-y-1.5">
                    <div className={labelCls}>Subject</div>
                    <div className="rounded-card border border-line bg-bg-sub px-3 py-2 text-body font-medium text-ink">{result.subject}</div>
                  </div>
                )}
                <div className="space-y-1.5">
                  {channel === 'email_cold' && <div className={labelCls}>Body</div>}
                  <div
                    className={cn(
                      'whitespace-pre-wrap border border-line bg-bg-sub text-body leading-relaxed text-ink',
                      channel === 'email_cold' ? 'rounded-card px-3.5 py-3' : 'rounded-2xl rounded-tl-md px-4 py-3.5',
                    )}
                  >
                    {result.body}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-3">
                  {channel === 'linkedin_connection_request' ? (
                    <span className={result.characterCount <= 300 ? 'text-up' : 'text-down'}>
                      {result.characterCount}/300 characters {result.characterCount <= 300 ? '✓' : '· over the limit'}
                    </span>
                  ) : (
                    <span>
                      {wordCount} words · {result.characterCount} characters
                    </span>
                  )}
                  {channel === 'email_cold' && result.classification && <span>· {result.classification}</span>}
                </div>

                <div className="flex flex-wrap gap-2 border-t border-line pt-4">
                  {channel === 'email_cold' ? (
                    <>
                      {result.subject && <CopyBtn text={result.subject} label="Subject">Copy subject</CopyBtn>}
                      <CopyBtn text={result.body} label="Body">Copy body</CopyBtn>
                      <CopyBtn text={`Subject: ${result.subject ?? ''}\n\n${result.body}`} label="Email">Copy all</CopyBtn>
                    </>
                  ) : (
                    <CopyBtn text={result.body} label="Message">Copy message</CopyBtn>
                  )}
                  <Button size="sm" type="button" variant="panel" onClick={handleGenerate}>
                    <RefreshCw size={13} /> Regenerate
                  </Button>
                  {channel === 'email_cold' && result.subject && (
                    <Button size="sm" asChild variant="panel">
                      <a href={`mailto:?subject=${encodeURIComponent(result.subject)}&body=${encodeURIComponent(result.body)}`}>
                        <Mail size={13} /> Open in mail app
                      </a>
                    </Button>
                  )}
                  {ext && (
                    <Button size="sm" asChild variant="panel">
                      <a href={ext.href} target="_blank" rel="noopener noreferrer">
                        <ExternalLink size={13} /> {ext.label}
                      </a>
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
