/**
 * Shape passed to the Copilot reply/followup prompts to populate the
 * LAYER 1 (recipient context) block. Snake_case keys so the LLM-extracted
 * signals from the classifier JSON merge in without renaming.
 *
 * Built by inbox-copilot.service.ts:buildExtractedContext from:
 *   - deterministic computation over conversation history (tone, lengths, timings)
 *   - DB enrichment (contacts + companies + outreach count + interviews)
 *   - LLM-extracted signals from the classifier call (reply mode only;
 *     empty arrays in followup mode)
 */
export interface ExtractedContext {
  // Recipient communication style (deterministic)
  recipient_tone: 'formal' | 'casual' | 'mixed';
  recipient_avg_message_length_words: number;
  recipient_response_speed: 'fast' | 'medium' | 'slow' | 'unknown';

  // Relationship state (deterministic)
  is_first_interaction: boolean;
  days_since_first_message: number;
  days_since_last_inbound: number | null;
  total_exchanges: number;

  // LLM-extracted signals (empty arrays in followup mode)
  topics_discussed: string[];
  recipient_unanswered_questions: string[];
  sender_unanswered_questions: string[];
  expressed_interests: string[];
  expressed_concerns: string[];
  expressed_constraints: string[];

  // Database enrichment (deterministic, defensive)
  source: string | null;
  prior_outreach_attempts: number;
  prior_meeting_history: Array<{
    scheduled_at: string;
    status: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
  }>;
  prior_notes: string | null;
  company_intel: {
    industry: string | null;
    size: string | null;
    funding: string | null;
    description: string | null;
    pain_points: string[];
    recent_news: string | null;
  };
}
