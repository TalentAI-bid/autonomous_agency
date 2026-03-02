export type ActivityType =
  | 'email_sent' | 'email_opened' | 'email_replied' | 'email_received' | 'email_bounced'
  | 'stage_change' | 'note_added' | 'call_logged' | 'meeting_scheduled'
  | 'status_change' | 'score_updated' | 'agent_action';

export interface CrmStage {
  id: string;
  tenantId: string;
  name: string;
  slug: string;
  color: string;
  position: number;
  isDefault: boolean;
  isWon: boolean;
  isLost: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Deal {
  id: string;
  tenantId: string;
  contactId: string;
  masterAgentId?: string;
  campaignId?: string;
  stageId: string;
  title: string;
  value?: string;
  currency?: string;
  notes?: string;
  closedAt?: string;
  expectedCloseAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface DealWithContact extends Deal {
  contact?: {
    firstName?: string;
    lastName?: string;
    email?: string;
    title?: string;
    companyName?: string;
  };
  stage?: CrmStage;
}

export interface CrmActivity {
  id: string;
  tenantId: string;
  contactId?: string;
  dealId?: string;
  userId?: string;
  masterAgentId?: string;
  type: ActivityType;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  occurredAt: string;
  createdAt: string;
}

export interface BoardColumn extends CrmStage {
  deals: DealWithContact[];
}
