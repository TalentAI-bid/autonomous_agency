import { describe, it, expect } from 'vitest';
import { detectMissionStrategyFromText } from '../src/utils/mission-intent.js';

describe('detectMissionStrategyFromText', () => {
  it('classifies industry-only Gulf-style mission as industry_target (regression for a52a3923)', () => {
    const r = detectMissionStrategyFromText(
      'Identify English-speaking mid-market SaaS, FinTech, HealthTech, and e-commerce firms in Gulf countries, qualify key decision-makers, and deliver a scored list for manual outreach.',
    );
    expect(r.hasHiringVerbs).toBe(false);
    expect(r.hasIndustryMentions).toBe(true);
    expect(r.recommended).toBe('industry_target');
  });

  it('classifies pure hiring missions as hiring_signal', () => {
    const r = detectMissionStrategyFromText(
      'Find European companies actively hiring senior DevOps engineers and email their talent acquisition leads.',
    );
    expect(r.hasHiringVerbs).toBe(true);
    expect(r.hasIndustryMentions).toBe(false);
    expect(r.recommended).toBe('hiring_signal');
  });

  it('classifies missions with both signals as hybrid', () => {
    const r = detectMissionStrategyFromText(
      'EU fintechs that are hiring blockchain developers — score them and reach out to CTOs.',
    );
    expect(r.hasHiringVerbs).toBe(true);
    expect(r.hasIndustryMentions).toBe(true);
    expect(r.recommended).toBe('hybrid');
  });

  it('returns null for empty/whitespace mission text', () => {
    expect(detectMissionStrategyFromText('').recommended).toBe(null);
    expect(detectMissionStrategyFromText(null).recommended).toBe(null);
    expect(detectMissionStrategyFromText('   ').recommended).toBe(null);
  });

  it('detects industry markers across casing', () => {
    expect(detectMissionStrategyFromText('list of SaaS firms').hasIndustryMentions).toBe(true);
    expect(detectMissionStrategyFromText('saas startups').hasIndustryMentions).toBe(true);
    expect(detectMissionStrategyFromText('mid-market e-commerce').hasIndustryMentions).toBe(true);
  });

  it('does not match incidental words inside other words', () => {
    // "growing pains" should NOT trigger team-growth pattern.
    const r = detectMissionStrategyFromText('Identify firms experiencing growing pains in enterprise SaaS');
    expect(r.hasHiringVerbs).toBe(false);
  });
});
