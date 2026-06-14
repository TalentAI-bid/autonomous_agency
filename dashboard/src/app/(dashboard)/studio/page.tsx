'use client';

import { useState, useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useToast } from '@/hooks/use-toast';
import { Sparkles, Copy, RefreshCw, ExternalLink, Mail, MessageSquare, Handshake, Send, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { useGenerateStudioMessage, type StudioChannel, type StudioTrack, type MessageType, type StudioComposition } from '@/hooks/use-studio';

const CHANNELS: Array<{ id: StudioChannel; label: string; icon: string }> = [
  { id: 'email_cold', label: 'Cold Email', icon: '📧' },
  { id: 'linkedin_dm', label: 'LinkedIn DM', icon: '💼' },
  { id: 'linkedin_connection_request', label: 'LinkedIn Connection Request', icon: '🤝' },
  { id: 'twitter_dm', label: 'Twitter / X DM', icon: '🐦' },
  { id: 'whatsapp', label: 'WhatsApp', icon: '💬' },
  { id: 'telegram', label: 'Telegram', icon: '🚀' },
];

const TRACKS: Array<{ id: StudioTrack; label: string; description: string; icon: string }> = [
  { id: 'sales', label: 'Sales', description: 'Pitch our service to a potential buyer.', icon: '💰' },
  { id: 'partnership', label: 'Partnership', description: 'Propose collaboration with a peer / competitor.', icon: '🤝' },
  { id: 'collaboration', label: 'Collaboration', description: 'Build a mutual-value relationship with an adjacent partner.', icon: '🌐' },
];

const MESSAGE_TYPES: Array<{ id: MessageType; label: string }> = [
  { id: 'first_message', label: '📩 First Message' },
  { id: 'first_followup', label: '🔄 First Follow-up' },
  { id: 'second_followup', label: '🔁 Second Follow-up' },
  { id: 'breakup', label: '👋 Breakup / Final' },
  { id: 'reactivation', label: '♻️ Reactivation' },
  { id: 'post_meeting', label: '🤝 Post-Meeting' },
  { id: 'post_no_show', label: '📅 Post-No-Show' },
];

function channelIconLucide(channel: StudioChannel) {
  switch (channel) {
    case 'email_cold': return <Mail className="w-4 h-4" />;
    case 'linkedin_dm': return <MessageSquare className="w-4 h-4" />;
    case 'linkedin_connection_request': return <Handshake className="w-4 h-4" />;
    case 'twitter_dm': return <Send className="w-4 h-4" />;
    case 'whatsapp':
    case 'telegram':
      return <Smartphone className="w-4 h-4" />;
  }
}

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
  }

  const wordCount = useMemo(() => result ? result.body.trim().split(/\s+/).filter(Boolean).length : 0, [result]);
  const channelMeta = CHANNELS.find(c => c.id === channel);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Sparkles className="w-6 h-6 text-amber-400" />
            Message Studio
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Generate a one-shot outreach message for any prospect on any channel. Uses your{' '}
            <Link href="/settings/messaging" className="text-blue-400 hover:underline">configured messaging</Link>.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* LEFT: Form */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Compose</CardTitle>
            <CardDescription>Pick a channel + track, fill in the recipient, generate.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm font-medium mb-1.5 block">Channel *</Label>
              <select
                value={channel}
                onChange={(e) => setChannel(e.target.value as StudioChannel)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {CHANNELS.map(c => (
                  <option key={c.id} value={c.id}>{c.icon} {c.label}</option>
                ))}
              </select>
            </div>

            <div>
              <Label className="text-sm font-medium mb-1.5 block">Message Type *</Label>
              <select
                value={messageType}
                onChange={(e) => setMessageType(e.target.value as MessageType)}
                className="w-full h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {MESSAGE_TYPES.map(t => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>
              {messageType === 'reactivation' && (
                <p className="text-xs text-muted-foreground mt-1.5">
                  💡 Mention something specific that changed (their company news, market shift, your new offering).
                </p>
              )}
            </div>

            {messageType === 'post_no_show' && (
              <div>
                <Label className="text-xs">Original Meeting Time (optional)</Label>
                <Input
                  value={missedMeetingTime}
                  onChange={(e) => setMissedMeetingTime(e.target.value)}
                  placeholder="e.g. Tuesday 3pm UTC"
                />
              </div>
            )}

            <div>
              <Label className="text-sm font-medium mb-1.5 block">Track *</Label>
              <div className="space-y-1">
                {TRACKS.map(t => (
                  <label key={t.id} className="flex items-start gap-2 p-2 rounded hover:bg-muted/40 cursor-pointer">
                    <input
                      type="radio"
                      name="track"
                      value={t.id}
                      checked={track === t.id}
                      onChange={() => setTrack(t.id)}
                      className="mt-1"
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{t.icon} {t.label}</p>
                      <p className="text-xs text-muted-foreground">{t.description}</p>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className="border-t pt-4 space-y-3">
              <h3 className="text-sm font-medium">Recipient</h3>
              <div>
                <Label className="text-xs">Name *</Label>
                <Input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} placeholder="Igor Lavrih" />
              </div>
              <div>
                <Label className="text-xs">Company</Label>
                <Input value={recipientCompany} onChange={(e) => setRecipientCompany(e.target.value)} placeholder="Hoppacard" />
              </div>
              <div>
                <Label className="text-xs">Title</Label>
                <Input value={recipientTitle} onChange={(e) => setRecipientTitle(e.target.value)} placeholder="Co-Founder &amp; CEO" />
              </div>
              <div>
                <Label className="text-xs">Location</Label>
                <Input value={recipientLocation} onChange={(e) => setRecipientLocation(e.target.value)} placeholder="Eindhoven, NL" />
              </div>
              <div>
                <Label className="text-xs">LinkedIn URL</Label>
                <Input value={recipientLinkedinUrl} onChange={(e) => setRecipientLinkedinUrl(e.target.value)} placeholder="https://linkedin.com/in/..." />
              </div>
            </div>

            <div className="border-t pt-4">
              <Label className="text-sm font-medium mb-1.5 block">
                {messageType === 'post_meeting'
                  ? 'What was discussed? *'
                  : 'Additional Context (optional)'}
              </Label>
              <Textarea
                value={customContext}
                onChange={(e) => setCustomContext(e.target.value)}
                placeholder={
                  messageType === 'post_meeting'
                    ? 'Required. Quick recap: the conversation, the key takeaway, what they cared about, what was decided.'
                    : 'How you got their info, any hints, a specific angle you want the message to take, etc.'
                }
                rows={3}
              />
              {messageType === 'post_meeting' && !customContext.trim() && (
                <p className="text-xs text-amber-500 mt-1">Post-Meeting requires a recap of the conversation.</p>
              )}
            </div>

            <Button
              onClick={handleGenerate}
              disabled={generate.isPending || (messageType === 'post_meeting' && !customContext.trim())}
              className="w-full"
            >
              {generate.isPending ? <Skeleton className="h-4 w-4 mr-2 rounded-full" /> : <Sparkles className="w-4 h-4 mr-2" />}
              Generate Message
            </Button>
          </CardContent>
        </Card>

        {/* RIGHT: Output */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              {channelMeta && <span>{channelMeta.icon}</span>}
              {channelMeta?.label ?? 'Output'}
              {result && <Badge variant="secondary" className="text-[10px] ml-auto">{result.track} track</Badge>}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {generate.isPending ? (
              <div className="space-y-3 py-6">
                <Skeleton className="h-6 w-3/4" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : !result ? (
              <div className="text-center py-12 text-muted-foreground space-y-2">
                <p className="text-sm">👋 Fill in the form and click <span className="font-medium">Generate Message</span>.</p>
                <p className="text-xs">
                  The system uses your configured ICP and value proposition from{' '}
                  <Link href="/settings/messaging" className="text-blue-400 hover:underline">Settings → Messaging</Link>.
                </p>
              </div>
            ) : channel === 'email_cold' ? (
              <div className="space-y-4">
                {result.subject && (
                  <div>
                    <Label className="text-xs text-muted-foreground">Subject</Label>
                    <div className="mt-1 px-3 py-2 rounded border bg-muted/30 text-sm font-medium">
                      {result.subject}
                    </div>
                  </div>
                )}
                <div>
                  <Label className="text-xs text-muted-foreground">Body</Label>
                  <div className="mt-1 px-3 py-2 rounded border bg-muted/30 text-sm whitespace-pre-wrap">
                    {result.body}
                  </div>
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                  <span>📊 {wordCount} words</span>
                  <span>•</span>
                  <span>{result.characterCount} chars</span>
                  {result.classification && (<><span>•</span><span>{result.classification}</span></>)}
                </div>
                <div className="flex flex-wrap gap-2 pt-2 border-t">
                  {result.subject && (
                    <Button size="sm" variant="outline" onClick={() => handleCopy(result.subject!, 'Subject')}>
                      <Copy className="w-3.5 h-3.5 mr-1.5" /> Copy Subject
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => handleCopy(result.body, 'Body')}>
                    <Copy className="w-3.5 h-3.5 mr-1.5" /> Copy Body
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => handleCopy(`Subject: ${result.subject ?? ''}\n\n${result.body}`, 'Email')}>
                    <Copy className="w-3.5 h-3.5 mr-1.5" /> Copy All
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleGenerate}>
                    <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Regenerate
                  </Button>
                  {result.subject && (
                    <a
                      href={`mailto:?subject=${encodeURIComponent(result.subject)}&body=${encodeURIComponent(result.body)}`}
                    >
                      <Button size="sm" variant="outline">
                        <Mail className="w-3.5 h-3.5 mr-1.5" /> Open in Mail App
                      </Button>
                    </a>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-2xl border bg-muted/30 p-4 whitespace-pre-wrap text-sm">
                  {result.body}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                  {channel === 'linkedin_connection_request' ? (
                    <span>
                      📊 {result.characterCount}/300 characters {result.characterCount <= 300 ? '✓' : '✗ over limit'}
                    </span>
                  ) : (
                    <span>📊 {wordCount} words • {result.characterCount} chars</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-2 pt-2 border-t">
                  <Button size="sm" variant="outline" onClick={() => handleCopy(result.body, 'Message')}>
                    {channelIconLucide(channel)}<span className="ml-1.5">Copy Message</span>
                  </Button>
                  <Button size="sm" variant="outline" onClick={handleGenerate}>
                    <RefreshCw className="w-3.5 h-3.5 mr-1.5" /> Regenerate
                  </Button>
                  {(() => {
                    const ext = externalLinkFor(channel, recipientLinkedinUrl);
                    if (!ext) return null;
                    return (
                      <a href={ext.href} target="_blank" rel="noopener noreferrer">
                        <Button size="sm" variant="outline">
                          <ExternalLink className="w-3.5 h-3.5 mr-1.5" /> {ext.label}
                        </Button>
                      </a>
                    );
                  })()}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
