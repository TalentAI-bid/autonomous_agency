'use client';

import { lazyOnOpen } from '@/lib/lazy';

/** Same props as EmailComposeModal; its code loads the first time it opens. */
export const EmailComposeModal = lazyOnOpen(() => import('./email-compose-modal').then((m) => m.EmailComposeModal));
