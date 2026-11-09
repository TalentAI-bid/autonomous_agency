'use client';

import { lazyOnOpen } from '@/lib/lazy';

/** Same props as CopilotPanel; the panel's code loads the first time it opens. */
export const CopilotPanel = lazyOnOpen(() => import('./copilot-panel').then((m) => m.CopilotPanel));
