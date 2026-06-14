import type { MessagingConfig } from '../../db/schema/tenants.js';
import type { MessageType } from './_message-type-instructions.js';

export type StudioTrack = 'sales' | 'partnership' | 'collaboration';

export interface StudioRecipient {
  name: string;
  company?: string;
  title?: string;
  location?: string;
  linkedinUrl?: string;
}

/**
 * Shared context shape every channel prompt builder receives. The studio
 * service assembles this from the tenant's `messaging_config`, the user's
 * input form, the recipient block, and the chosen message type.
 */
export interface ChannelContext {
  recipient: StudioRecipient;
  track: StudioTrack;
  messageType: MessageType;
  sender: MessagingConfig;
  customContext?: string;
}
