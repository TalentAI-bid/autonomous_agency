/** Shared react-query freshness windows (ms), so hooks don't each invent their own numbers. */
export const STALE = {
  /** Changes constantly (queues, live status). */
  realtime: 5_000,
  /** Changes often (messages, errors). */
  short: 10_000,
  /** Default for lists and detail views. */
  normal: 15_000,
  /** Settings and slow-moving data. */
  long: 30_000,
  /** Rarely changes (CRM stages, cadence). */
  static: 60_000,
} as const;
