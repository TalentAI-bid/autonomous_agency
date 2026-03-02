export type MessageRole = 'user' | 'assistant' | 'system';
export type MessageType = 'text' | 'file_upload' | 'pipeline_proposal' | 'pipeline_approved' | 'error';
export type ConversationStatus = 'active' | 'completed' | 'abandoned';

export interface PipelineProposalData {
  name: string;
  useCase: string;
  mission: string;
  config: Record<string, unknown>;
  pipeline: Array<{
    agentType: string;
    order: number;
    description: string;
    config: Record<string, unknown>;
  }>;
  summary: string;
  estimatedDuration: string;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  type: MessageType;
  content: string;
  metadata?: Record<string, unknown>;
  proposalData?: PipelineProposalData;
  orderIndex: number;
  createdAt: string;
}

export interface Conversation {
  id: string;
  tenantId: string;
  userId: string;
  masterAgentId?: string;
  status: ConversationStatus;
  extractedConfig?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationWithMessages {
  conversation: Conversation;
  messages: ChatMessage[];
}
