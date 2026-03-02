export type EmailProvider = 'smtp' | 'ses' | 'sendgrid' | 'custom';
export type ListenerProtocol = 'imap' | 'pop3';

export interface EmailAccount {
  id: string;
  tenantId: string;
  name: string;
  provider: EmailProvider;
  smtpHost?: string;
  smtpPort?: number;
  smtpUser?: string;
  hasPassword: boolean;
  fromEmail: string;
  fromName?: string;
  replyTo?: string;
  dailyQuota: number;
  hourlyQuota: number;
  isWarmup: boolean;
  warmupStartDate?: string;
  warmupDaysSent: number;
  priority: number;
  isActive: boolean;
  config?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface EmailListenerConfig {
  id: string;
  tenantId: string;
  emailAccountId?: string;
  protocol: ListenerProtocol;
  host: string;
  port: number;
  username: string;
  hasPassword: boolean;
  useTls: boolean;
  mailbox: string;
  pollingIntervalMs: number;
  lastPolledAt?: string;
  lastSeenUid?: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface QuotaStatus {
  dailyUsed: number;
  dailyLimit: number;
  hourlyUsed: number;
  hourlyLimit: number;
  available: boolean;
}
