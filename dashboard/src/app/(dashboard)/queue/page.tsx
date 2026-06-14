'use client';

import { QueueView } from '@/components/queue/queue-view';

export default function QueuePage() {
  return (
    <div style={{ padding: 24, maxWidth: 920, margin: '0 auto' }}>
      <QueueView showGreeting />
    </div>
  );
}
