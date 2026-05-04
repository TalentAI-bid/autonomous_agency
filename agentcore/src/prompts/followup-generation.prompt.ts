export interface FollowupSeller {
  offering: string;
  senderName?: string;
  senderSignatureBlock?: string;
}

export interface FollowupContact {
  firstName: string;
  lastName: string;
  title?: string | null;
  companyName?: string | null;
  companyIndustry?: string | null;
  companySize?: string | null;
}

export interface FollowupTouch {
  touchNumber: number;
  subject: string;
  body: string;
  sentAt: Date;
}

export interface FollowupSignal {
  claim: string;
  citation: string;
}

export interface FollowupPromptParams {
  seller: FollowupSeller;
  contact: FollowupContact;
  touch1: FollowupTouch;
  previousFollowups: FollowupTouch[];
  signals: FollowupSignal[];
  anglesUsed: string[];
  thisTouch: number;
  stepType: 'followup_short' | 'followup_value' | 'followup_breakup' | 'custom';
}

export interface FollowupGeneration {
  subject: string;
  body: string;
  angleUsed: string;
}

export function buildFollowupSystemPrompt(): string {
  return `You generate the next follow-up email in a B2B sales sequence.

You will receive:
- Contact: name, title, company
- Seller: who they are, what they sell
- Original email sent (subject + body) — touch 1
- Any previous follow-ups already sent
- This touch's number (2, 3, or 4) and stepType
- Real grounded signals about the company (if any) — only use what's provided, never invent
- "anglesUsed": array of angles already used so you don't repeat them

RULES:

1. NEVER repeat an angle from anglesUsed. Each touch must add NEW value or take a NEW angle.

2. NEVER start with "Just following up" or "Bumping this" alone. These are filler. If you reference the previous email, do it specifically — name the angle or the question.

3. SHORTER than the initial email:
   - Touch 2: 2-3 sentences max
   - Touch 3: 3-4 sentences (you're adding value, so a bit more room)
   - Touch 4: 1-2 sentences

4. By stepType:
   - followup_short (touch 2): brief check-in, ONE specific reference to the original angle, ONE clear soft CTA ("worth a quick chat?" or "should I close the loop?")
   - followup_value (touch 3): introduce a NEW angle — different value prop, a concrete insight relevant to their role, OR a "social proof" pattern ("we recently helped <similar shape of company> with <related problem>"). Do NOT repeat touch 1 or 2.
   - followup_breakup (touch 4): polite close. "Closing the loop on this — if not the right time, no worries. I'll stop reaching out." This often gets the highest reply rate of the sequence because of loss aversion.

5. NO fabricated facts. If you don't have a real grounded signal in the input, don't invent one. Reference only what's actually known (the company name, their role, the original angle).

6. NO hard sells. No urgency tricks. No "I'll be in your area." No fake personalization.

7. Subject line strategy:
   - Touch 2: same thread — use "Re: <original subject>" so it threads in their inbox
   - Touch 3: same thread — "Re: <original subject>"
   - Touch 4: optionally NEW subject ("Closing the loop on <topic>") — sometimes a fresh subject gets opened when the threaded one was ignored

8. Tone: human, direct, low-pressure. Write like a person, not a marketer.

9. Sign off the same way the original email did. Match the original's voice and signature.

OUTPUT FORMAT (strict JSON, no markdown):
{
  "subject": "...",
  "body": "...",
  "angleUsed": "<one phrase summarizing the angle, e.g. 'social proof — similar fintech', or 'breakup loss aversion'>"
}`;
}

function daysAgo(d: Date): number {
  const ms = Date.now() - d.getTime();
  return Math.max(0, Math.floor(ms / (24 * 60 * 60 * 1000)));
}

export function buildFollowupUserPrompt(params: FollowupPromptParams): string {
  const { seller, contact, touch1, previousFollowups, signals, anglesUsed, thisTouch, stepType } = params;
  const company = `${contact.companyName ?? 'their company'}${contact.companyIndustry ? ` — ${contact.companyIndustry}` : ''}${contact.companySize ? `, ${contact.companySize}` : ''}`;
  const previousBlock = previousFollowups.length
    ? previousFollowups
        .map((f) => `Touch ${f.touchNumber} (sent ${daysAgo(f.sentAt)}d ago):\nSubject: ${f.subject}\nBody:\n${f.body}\n---`)
        .join('\n')
    : '(none)';
  const signalsBlock = signals.length
    ? signals.map((s) => `- ${s.claim} (citation: "${s.citation}")`).join('\n')
    : '(none — write without specific company signals)';
  const anglesBlock = anglesUsed.length ? anglesUsed.join(', ') : '(none yet)';

  return `CONTACT
=======
Name: ${contact.firstName} ${contact.lastName}
Title: ${contact.title ?? 'unknown'}
Company: ${company}

SELLER
======
${seller.offering}
Sender name: ${seller.senderName ?? 'unknown'}
Sender signature: ${seller.senderSignatureBlock ?? '(none)'}

ORIGINAL EMAIL (touch 1, sent ${daysAgo(touch1.sentAt)} days ago)
================
Subject: ${touch1.subject}
Body:
${touch1.body}

PREVIOUS FOLLOWUPS
==================
${previousBlock}

GROUNDED SIGNALS (real facts only)
==================================
${signalsBlock}

ANGLES ALREADY USED
===================
${anglesBlock}

THIS TOUCH
==========
Touch number: ${thisTouch}
Step type: ${stepType}

Generate the follow-up email now. Return ONLY the JSON object.`;
}
