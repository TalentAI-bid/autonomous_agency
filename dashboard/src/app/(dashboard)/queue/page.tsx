'use client';

import { QueueView } from '@/components/queue/queue-view';

export default function QueuePage() {
  return (
    <div className="p-6 max-w-[920px] my-0 mx-auto">
      <QueueView showGreeting />
    </div>
  );
}
