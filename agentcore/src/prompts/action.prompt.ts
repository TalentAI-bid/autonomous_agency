export function buildSystemPrompt(): string {
  return `You are a talent acquisition specialist creating comprehensive candidate briefing documents. Write professional, structured reports that give hiring managers everything they need to prepare for an interview.

Format the report in clean Markdown. Be factual and balanced — highlight both strengths and areas to explore.`;
}

export function buildUserPrompt(data: {
  contact: {
    firstName: string;
    lastName: string;
    title: string;
    companyName: string;
    location: string;
    skills: string[];
    experience: Array<{ company: string; title: string; startDate: string; endDate: string; description?: string }>;
    education: Array<{ institution: string; degree: string; field: string; year?: string }>;
    score: number;
    scoreDetails?: Record<string, unknown>;
    linkedinUrl?: string;
  };
  opportunity: {
    title: string;
    company: string;
    requiredSkills: string[];
    valueProposition: string;
  };
}): string {
  return `Create a comprehensive candidate briefing document for an upcoming interview.

CANDIDATE DETAILS:
- Name: ${data.contact.firstName} ${data.contact.lastName}
- Current Role: ${data.contact.title} at ${data.contact.companyName}
- Location: ${data.contact.location}
- Match Score: ${data.contact.score}/100
- LinkedIn: ${data.contact.linkedinUrl ?? 'Not available'}
- Skills: ${data.contact.skills.join(', ')}
- Experience: ${data.contact.experience.map((e) => `${e.title} at ${e.company} (${e.startDate} - ${e.endDate})`).join('\n  ')}
- Education: ${data.contact.education.map((e) => `${e.degree} in ${e.field}, ${e.institution}`).join('\n  ')}

OPPORTUNITY:
- Role: ${data.opportunity.title} at ${data.opportunity.company}
- Required Skills: ${data.opportunity.requiredSkills.join(', ')}
- Value Proposition: ${data.opportunity.valueProposition}

SCORE BREAKDOWN: ${data.contact.scoreDetails ? JSON.stringify(data.contact.scoreDetails) : 'Not available'}

Generate a markdown report with these sections:
1. **Executive Summary** - 3-4 sentences
2. **Candidate Profile** - Background and career trajectory
3. **Skill Match Analysis** - Required skills vs candidate skills
4. **Experience Highlights** - Top 3 most relevant roles/achievements
5. **Suggested Interview Questions** - 5 tailored questions
6. **Recommendation** - Hire/Strong Consider/Consider/Pass with rationale`;
}
