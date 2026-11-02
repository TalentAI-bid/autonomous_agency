'use client';

import { AiAvatar } from './chat-bubble';

export function TypingIndicator() {
  return (
    <div className="mb-5 flex items-start gap-3" role="status" aria-label="The assistant is typing">
      <AiAvatar />
      <div className="rounded-2xl rounded-tl-sm bg-bg-soft px-4 py-3.5">
        <div className="flex gap-1.5">
          <span className="size-1.5 animate-bounce rounded-full bg-ink-4 [animation-delay:0ms]" />
          <span className="size-1.5 animate-bounce rounded-full bg-ink-4 [animation-delay:150ms]" />
          <span className="size-1.5 animate-bounce rounded-full bg-ink-4 [animation-delay:300ms]" />
        </div>
      </div>
    </div>
  );
}
