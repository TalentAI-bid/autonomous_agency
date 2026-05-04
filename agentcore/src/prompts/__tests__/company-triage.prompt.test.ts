import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildTriageSystemPrompt,
  buildTriageUserPrompt,
  type SellerProfile,
  type ScrapedCompany,
  type TriageVerdict,
} from '../company-triage.prompt.js';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const extractJSONMock = vi.fn();
const withTenantMock = vi.fn();

vi.mock('../../tools/together-ai.tool.js', () => ({
  extractJSON: (...args: unknown[]) => extractJSONMock(...args),
  SMART_MODEL: 'deepseek.v3.2',
}));

vi.mock('../../config/database.js', () => ({
  withTenant: (_tenantId: string, cb: (tx: unknown) => unknown) => withTenantMock(cb),
}));

vi.mock('../../utils/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// ─── Test fixtures ──────────────────────────────────────────────────────────

const baseSeller: SellerProfile = {
  offering: 'AI-powered B2B sales engineering tools',
  targetIndustries: ['SaaS', 'FinTech'],
  sizeMin: 20,
  sizeMax: 500,
  geography: 'Europe',
  buyerFunctions: ['Engineering', 'CTO', 'VP Engineering'],
  exclusions: ['Trade associations', 'Media outlets', 'Universities'],
};

function makeCompany(overrides: Partial<ScrapedCompany> = {}): ScrapedCompany {
  return {
    name: 'Acme Co',
    domain: 'acme.com',
    industry: 'Software',
    size: '51-200',
    headquarters: 'Berlin, DE',
    founded: '2020',
    linkedinUrl: 'https://linkedin.com/company/acme',
    description: 'We build sales tools.',
    specialties: ['SaaS', 'B2B'],
    rawMeta: ['51-200 employees', 'Berlin'],
    people: [],
    openPositions: [],
    ...overrides,
  };
}

function emptySignals(): TriageVerdict['signals'] {
  return {
    hiring_signals: [],
    funding_signals: [],
    growth_signals: [],
    tech_signals: [],
    pain_hypotheses: [],
  };
}

function fakeCompanyRow(scraped: ScrapedCompany) {
  return {
    id: 'company-uuid',
    tenantId: 'tenant-uuid',
    masterAgentId: 'agent-uuid',
    name: scraped.name,
    domain: scraped.domain ?? null,
    industry: scraped.industry ?? null,
    size: scraped.size ?? null,
    techStack: null,
    funding: null,
    linkedinUrl: scraped.linkedinUrl ?? null,
    description: scraped.description ?? null,
    rawData: {
      headquarters: scraped.headquarters,
      founded: scraped.founded,
      specialties: scraped.specialties,
      rawMeta: scraped.rawMeta,
      people: scraped.people,
      openPositions: scraped.openPositions,
    },
    score: null,
    scoreDetails: null,
    dataCompleteness: 50,
    painPoints: null,
    websiteStatus: null,
    seoScore: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

const fakeAgentRow = {
  id: 'agent-uuid',
  tenantId: 'tenant-uuid',
  name: 'Test Agent',
  description: 'desc',
  mission: 'AI-powered B2B sales engineering tools for European SaaS',
  useCase: 'sales' as const,
  status: 'idle' as const,
  config: {
    sellerProfile: baseSeller,
  },
  actionPlan: null,
  reviewMode: 'manual' as const,
  dailyRuntimeBudgetMs: 3_600_000,
  createdBy: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

function setupTxStubs(scraped: ScrapedCompany) {
  // First withTenant call returns { company, agent }; subsequent UPDATE call returns nothing.
  // Each callback receives a fake tx with chained query builders.
  withTenantMock.mockImplementation(async (cb: (tx: unknown) => unknown) => {
    const fakeTx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => {
              // Companies query first, then masterAgents query
              const callOrder = (fakeTx as unknown as { _seq: number })._seq ?? 0;
              (fakeTx as unknown as { _seq: number })._seq = callOrder + 1;
              if (callOrder === 0) return [fakeCompanyRow(scraped)];
              return [fakeAgentRow];
            },
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: async () => undefined,
        }),
      }),
    };
    return cb(fakeTx);
  });
}

// ─── Pure prompt tests ──────────────────────────────────────────────────────

describe('buildTriageSystemPrompt', () => {
  it('contains all required rule sections', () => {
    const sys = buildTriageSystemPrompt();
    expect(sys).toContain('IS THIS A BUYER?');
    expect(sys).toContain('KEY PERSON SELECTION');
    expect(sys).toContain('SIGNAL EXTRACTION (grounded only)');
    expect(sys).toContain('OUTPUT SCHEMA (strict)');
    expect(sys).toContain('"verdict": "accept" | "reject" | "review"');
    expect(sys).toContain('wrong_entity_type_association');
    expect(sys).toContain('no_decision_maker_in_scraped_list');
    expect(sys).toContain('A score above 60 REQUIRES at least one real, cited signal');
  });
});

describe('buildTriageUserPrompt', () => {
  it('interpolates seller and company fields and lists scraped people in order', () => {
    const company = makeCompany({
      people: [
        { name: 'Alice First', title: 'Random Affiliate' },
        { name: 'Bob Second', title: 'CEO at Acme Co' },
      ],
    });
    const out = buildTriageUserPrompt(baseSeller, company);
    expect(out).toContain('What we sell: AI-powered B2B sales engineering tools');
    expect(out).toContain('Industries: SaaS, FinTech');
    expect(out).toContain('Size: 20-500 employees');
    expect(out).toContain('Acme Co');
    expect(out).toContain('Berlin, DE');
    expect(out).toContain('- Alice First — Random Affiliate');
    expect(out).toContain('- Bob Second — CEO at Acme Co');
  });

  it('renders "(none)" when people / openPositions are empty', () => {
    const out = buildTriageUserPrompt(baseSeller, makeCompany());
    expect(out).toMatch(/People scraped from \/people page[^\n]*\n  \(none\)/);
    expect(out).toMatch(/Open positions detected:\n  \(none\)/);
  });

  it('renders openPositions with title and location', () => {
    const out = buildTriageUserPrompt(
      baseSeller,
      makeCompany({
        openPositions: [{ title: 'Senior Backend Engineer', location: 'Berlin', description: 'Go + k8s' }],
      }),
    );
    expect(out).toContain('Senior Backend Engineer @ Berlin — Go + k8s');
  });
});

// ─── Service tests with canned verdicts ─────────────────────────────────────

describe('triageCompany — verdict scenarios (mocked LLM + DB)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function runWithVerdict(
    scraped: ScrapedCompany,
    cannedVerdict: Omit<TriageVerdict, 'triaged_at' | 'model_used'>,
  ) {
    setupTxStubs(scraped);
    extractJSONMock.mockResolvedValueOnce(cannedVerdict);
    const { triageCompany } = await import('../../services/company-triage.service.js');
    return triageCompany({
      tenantId: 'tenant-uuid',
      companyId: 'company-uuid',
      masterAgentId: 'agent-uuid',
    });
  }

  it('1. rejects an association', async () => {
    const verdict = await runWithVerdict(
      makeCompany({
        name: 'FINTECH BELGIUM',
        description: 'community for financial professionals',
        size: '2-10',
      }),
      {
        verdict: 'reject',
        rejection_reason: 'wrong_entity_type_association',
        rejection_explanation: 'Self-described community for financial professionals.',
        key_person: null,
        key_person_problem: null,
        signals: emptySignals(),
        fit_score: 5,
        fit_score_explanation: 'Industry association — not an operating buyer.',
      },
    );
    expect(verdict?.verdict).toBe('reject');
    expect(verdict?.rejection_reason).toBe('wrong_entity_type_association');
    expect(verdict?.key_person).toBeNull();
  });

  it('2. rejects a media outlet', async () => {
    const verdict = await runWithVerdict(
      makeCompany({
        name: 'FinTech Magazine',
        description: "Connecting the World's FinTech Leaders... media production",
      }),
      {
        verdict: 'reject',
        rejection_reason: 'wrong_entity_type_media',
        rejection_explanation: 'Self-described media production outlet.',
        key_person: null,
        key_person_problem: null,
        signals: emptySignals(),
        fit_score: 0,
        fit_score_explanation: 'Magazine, not a SaaS buyer.',
      },
    );
    expect(verdict?.verdict).toBe('reject');
    expect(verdict?.rejection_reason).toBe('wrong_entity_type_media');
  });

  it('3. rejects an academic group', async () => {
    const verdict = await runWithVerdict(
      makeCompany({
        name: 'Machine Learning at Berkeley',
        description: 'student-run organization',
      }),
      {
        verdict: 'reject',
        rejection_reason: 'wrong_entity_type_academic',
        rejection_explanation: 'Student-run organization.',
        key_person: null,
        key_person_problem: null,
        signals: emptySignals(),
        fit_score: 0,
        fit_score_explanation: 'Academic group, not a commercial buyer.',
      },
    );
    expect(verdict?.verdict).toBe('reject');
    expect(verdict?.rejection_reason).toBe('wrong_entity_type_academic');
  });

  it('4. accepts a real buyer with hiring signal + citation', async () => {
    const verdict = await runWithVerdict(
      makeCompany({
        description: 'Series A fintech building payments infra',
        openPositions: [
          { title: 'Senior Backend Engineer', location: 'Berlin', description: 'Go + k8s' },
        ],
      }),
      {
        verdict: 'accept',
        rejection_reason: null,
        rejection_explanation: null,
        key_person: {
          name: 'Bob Second',
          title: 'CEO at Acme Co',
          linkedinUrl: 'https://linkedin.com/in/bob',
          rationale: 'Title states CEO at Acme Co — at-this-company role and decision maker.',
        },
        key_person_problem: null,
        signals: {
          ...emptySignals(),
          hiring_signals: [
            { claim: 'Hiring senior backend engineers', citation: 'Senior Backend Engineer @ Berlin — Go + k8s' },
          ],
        },
        fit_score: 72,
        fit_score_explanation: 'Series A fintech with cited hiring signal and ICP match.',
      },
    );
    expect(verdict?.verdict).toBe('accept');
    expect(verdict?.fit_score).toBeGreaterThanOrEqual(60);
    expect(verdict?.signals.hiring_signals).toHaveLength(1);
    expect(verdict?.signals.hiring_signals[0]?.citation.length).toBeGreaterThan(0);
  });

  it('5. selects CEO over external board member', async () => {
    const scraped = makeCompany({
      name: 'FinTech Belgium',
      people: [
        { name: 'Brent Christiaens', title: 'Managing Partner @ Evergrove Capital | Family Office' },
        { name: 'Raf De Kimpe', title: 'CEO FinTech Belgium' },
      ],
    });
    const verdict = await runWithVerdict(scraped, {
      verdict: 'accept',
      rejection_reason: null,
      rejection_explanation: null,
      key_person: {
        name: 'Raf De Kimpe',
        title: 'CEO FinTech Belgium',
        linkedinUrl: '',
        rationale: 'Title literally reads "CEO FinTech Belgium" — actual employee and decision maker.',
      },
      key_person_problem: null,
      signals: emptySignals(),
      fit_score: 55,
      fit_score_explanation: 'Real buyer; no urgency signal cited.',
    });
    expect(verdict?.key_person?.name).toBe('Raf De Kimpe');
    expect(verdict?.key_person?.name).not.toBe('Brent Christiaens');
    expect(verdict?.key_person?.rationale).toContain('CEO');
  });

  it('6. returns null key_person with explanation when no real employee found', async () => {
    const verdict = await runWithVerdict(
      makeCompany({
        people: [
          { name: 'Some Student', title: 'MBA student at Insead' },
          { name: 'External Affiliate', title: 'Founder at OtherCo' },
        ],
      }),
      {
        verdict: 'accept',
        rejection_reason: null,
        rejection_explanation: null,
        key_person: null,
        key_person_problem: 'no_decision_maker_in_scraped_list',
        signals: emptySignals(),
        fit_score: 50,
        fit_score_explanation: 'Real buyer but no surfaced decision maker.',
      },
    );
    expect(verdict?.key_person).toBeNull();
    expect(verdict?.key_person_problem).toBe('no_decision_maker_in_scraped_list');
  });

  it('7. flags review when data is too thin', async () => {
    const verdict = await runWithVerdict(
      makeCompany({ industry: null, size: null, description: null, people: [], openPositions: [] }),
      {
        verdict: 'review',
        rejection_reason: null,
        rejection_explanation: null,
        key_person: null,
        key_person_problem: 'people_list_was_empty',
        signals: emptySignals(),
        fit_score: 30,
        fit_score_explanation: 'Insufficient data — nothing to ground a decision on.',
      },
    );
    expect(verdict?.verdict).toBe('review');
  });

  it('8. preserves empty signal arrays — no hallucinated entries', async () => {
    const verdict = await runWithVerdict(
      makeCompany({ description: 'Builds B2B software.', openPositions: [] }),
      {
        verdict: 'accept',
        rejection_reason: null,
        rejection_explanation: null,
        key_person: null,
        key_person_problem: 'people_list_was_empty',
        signals: emptySignals(),
        fit_score: 45,
        fit_score_explanation: 'ICP fit, no cited urgency signals.',
      },
    );
    expect(verdict?.signals.hiring_signals).toEqual([]);
    expect(verdict?.signals.funding_signals).toEqual([]);
    expect(verdict?.signals.growth_signals).toEqual([]);
    expect(verdict?.signals.tech_signals).toEqual([]);
    expect(verdict?.signals.pain_hypotheses).toEqual([]);
    expect(verdict?.fit_score).toBeLessThanOrEqual(60);
  });

  it('returns null and skips persistence when LLM emits invalid shape', async () => {
    setupTxStubs(makeCompany());
    extractJSONMock.mockResolvedValueOnce({ verdict: 'maybe', signals: 'wat' } as unknown);
    const { triageCompany } = await import('../../services/company-triage.service.js');
    const verdict = await triageCompany({
      tenantId: 'tenant-uuid',
      companyId: 'company-uuid',
      masterAgentId: 'agent-uuid',
    });
    expect(verdict).toBeNull();
  });

  it('is idempotent — returns cached verdict without calling LLM when force=false', async () => {
    const cachedTriage: TriageVerdict = {
      verdict: 'accept',
      rejection_reason: null,
      rejection_explanation: null,
      key_person: null,
      key_person_problem: null,
      signals: emptySignals(),
      fit_score: 70,
      fit_score_explanation: 'cached',
      triaged_at: '2025-01-01T00:00:00.000Z',
      model_used: 'deepseek.v3.2',
    };
    const scraped = makeCompany();
    const companyWithTriage = {
      ...fakeCompanyRow(scraped),
      rawData: { ...fakeCompanyRow(scraped).rawData, triage: cachedTriage },
    };
    withTenantMock.mockImplementationOnce(async (cb: (tx: unknown) => unknown) => {
      const fakeTx = {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => {
                const callOrder = (fakeTx as unknown as { _seq: number })._seq ?? 0;
                (fakeTx as unknown as { _seq: number })._seq = callOrder + 1;
                if (callOrder === 0) return [companyWithTriage];
                return [fakeAgentRow];
              },
            }),
          }),
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      };
      return cb(fakeTx);
    });

    const { triageCompany } = await import('../../services/company-triage.service.js');
    const verdict = await triageCompany({
      tenantId: 'tenant-uuid',
      companyId: 'company-uuid',
      masterAgentId: 'agent-uuid',
    });
    expect(verdict).toEqual(cachedTriage);
    expect(extractJSONMock).not.toHaveBeenCalled();
  });
});
