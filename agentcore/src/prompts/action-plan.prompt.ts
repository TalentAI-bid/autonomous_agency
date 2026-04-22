import type { ActionPlanItem } from '../db/schema/master-agents.js';
import type { PipelineContext } from '../types/pipeline-context.js';

/**
 * Build the action-plan checklist the user must answer before the agent
 * starts outreach. Deterministic per use case — no LLM call required.
 *
 * If a corresponding answer is already known from existing config (e.g. the
 * user pre-filled calendlyUrl on the master-agent config), we mark the item
 * as already-answered so the user doesn't have to re-type it.
 */
export function buildActionPlan(
  useCase: 'sales' | 'recruitment' | 'custom',
  pipelineCtx: PipelineContext | undefined,
  existingConfig: Record<string, unknown>,
): ActionPlanItem[] {
  if (useCase === 'recruitment') return recruitmentItems(pipelineCtx, existingConfig);
  if (useCase === 'sales') return salesItems(pipelineCtx, existingConfig);
  return customItems(existingConfig);
}

function recruitmentItems(
  ctx: PipelineContext | undefined,
  config: Record<string, unknown>,
): ActionPlanItem[] {
  const role = ctx?.targetRoles?.[0] ?? 'the role';
  return [
    {
      key: 'jobDescriptionUrl',
      question: `Link to the full job description for "${role}" (Notion, Google Doc, careers page, etc.)`,
      required: true,
      answer: pickString(config, 'jobDescriptionUrl', 'jdUrl'),
    },
    {
      key: 'compensation',
      question: 'Compensation range or comp band you are willing to disclose in outreach (e.g. "€60-80k base + equity")',
      required: true,
      answer: pickString(config, 'compensation', 'salary', 'salaryRange'),
    },
    {
      key: 'remotePolicy',
      question: 'Work model: remote, hybrid (how many days?), or on-site (which city)?',
      required: true,
      answer: pickString(config, 'remotePolicy', 'workModel'),
    },
    {
      key: 'interviewLoop',
      question: 'Interview process at a glance (how many rounds, what kind of stages, time-to-offer)',
      required: false,
      answer: pickString(config, 'interviewLoop', 'interviewProcess'),
    },
    {
      key: 'teamDescription',
      question: 'A 1-2 sentence description of the team this person would join (size, who they report to, what they ship)',
      required: true,
      answer: pickString(config, 'teamDescription'),
    },
    {
      key: 'whyJoin',
      question: 'One concrete reason a strong candidate should pick this role over their current job',
      required: true,
      answer: pickString(config, 'whyJoin', 'sellingPoint'),
    },
    {
      key: 'perks',
      question: 'Notable perks worth mentioning (equity, learning budget, sabbatical, etc.) — comma-separated',
      required: false,
      answer: pickString(config, 'perks'),
    },
    {
      key: 'calendlyUrl',
      question: 'Booking link for an intro call (Calendly, Cal.com, SavvyCal). Leave blank to ask candidates for times.',
      required: false,
      answer: pickString(config, 'calendlyUrl'),
    },
    {
      key: 'redFlags',
      question: 'Things to AVOID saying or any common candidate objections we should pre-empt',
      required: false,
      answer: pickString(config, 'redFlags'),
    },
  ];
}

function salesItems(
  ctx: PipelineContext | undefined,
  config: Record<string, unknown>,
): ActionPlanItem[] {
  const sales = ctx?.sales;
  return [
    {
      key: 'calendlyUrl',
      question: 'Booking link for a discovery call (Calendly, Cal.com, HubSpot Meetings)',
      required: true,
      answer: sales?.calendlyUrl ?? pickString(config, 'calendlyUrl'),
    },
    {
      key: 'caseStudyUrl',
      question: 'URL of one strong case study or customer success story we can reference',
      required: true,
      answer: pickString(config, 'caseStudyUrl'),
    },
    {
      key: 'topDifferentiator',
      question: 'In one sentence, what is your strongest differentiator vs. the obvious competitors?',
      required: true,
      answer:
        sales?.differentiators?.[0] ??
        pickString(config, 'topDifferentiator', 'differentiator'),
    },
    {
      key: 'demoVideo',
      question: 'Link to a short demo video or product walkthrough (Loom, YouTube). Leave blank if none.',
      required: false,
      answer: pickString(config, 'demoVideo', 'demoUrl'),
    },
    {
      key: 'logoPermission',
      question: 'Are we allowed to mention current customer logos by name in cold outreach? (yes / no / list the OK ones)',
      required: false,
      answer: pickString(config, 'logoPermission'),
    },
    {
      key: 'tonePreference',
      question: 'Tone you want for outreach — e.g. "professional and dry", "founder-to-founder casual", "playful but tight"',
      required: false,
      answer: ctx?.emailTone ?? pickString(config, 'tonePreference', 'emailTone'),
    },
    {
      key: 'redFlags',
      question: 'Industries / company types we should NOT contact (compliance, ethical, or competitive reasons)',
      required: false,
      answer: pickString(config, 'redFlags', 'excludedIndustries'),
    },
  ];
}

function customItems(config: Record<string, unknown>): ActionPlanItem[] {
  return [
    {
      key: 'goal',
      question: 'In one sentence, what outcome are you aiming for with this campaign?',
      required: true,
      answer: pickString(config, 'goal'),
    },
    {
      key: 'callToAction',
      question: 'What should the recipient DO after reading the email?',
      required: true,
      answer: pickString(config, 'callToAction'),
    },
    {
      key: 'links',
      question: 'Any URLs the agent should reference in outreach (comma-separated)',
      required: false,
      answer: pickString(config, 'links'),
    },
  ];
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

/** Check whether all required items have a non-empty answer. */
export function isActionPlanComplete(items: ActionPlanItem[]): boolean {
  return items.every((i) => !i.required || (i.answer && i.answer.trim().length > 0));
}

/** Fold completed answers back into the master-agent config + pipelineContext. */
export function applyActionPlanAnswers(
  items: ActionPlanItem[],
  config: Record<string, unknown>,
  pipelineCtx: PipelineContext | undefined,
): { config: Record<string, unknown>; pipelineContext: PipelineContext | undefined } {
  const next: Record<string, unknown> = { ...config };
  let nextCtx = pipelineCtx ? { ...pipelineCtx } : undefined;

  for (const item of items) {
    if (!item.answer || !item.answer.trim()) continue;
    const v = item.answer.trim();
    next[item.key] = v;
    if (!nextCtx) continue;

    if (item.key === 'calendlyUrl') {
      if (nextCtx.useCase === 'sales') {
        nextCtx.sales = { ...(nextCtx.sales ?? {}), calendlyUrl: v };
      }
    }
    if (item.key === 'topDifferentiator' && nextCtx.useCase === 'sales') {
      const existing = nextCtx.sales?.differentiators ?? [];
      nextCtx.sales = {
        ...(nextCtx.sales ?? {}),
        differentiators: existing.includes(v) ? existing : [v, ...existing],
      };
    }
    if (item.key === 'tonePreference') {
      nextCtx.emailTone = v;
    }
    if (item.key === 'jobDescriptionUrl' && nextCtx.useCase === 'recruitment') {
      (nextCtx as Record<string, unknown>).jobDescriptionUrl = v;
    }
  }

  return { config: next, pipelineContext: nextCtx };
}
