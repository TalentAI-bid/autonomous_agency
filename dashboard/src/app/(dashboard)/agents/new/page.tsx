'use client';

import { useRouter } from 'next/navigation';
import { ChatInterface } from '@/components/chat/chat-interface';

export default function NewAgentPage() {
  const router = useRouter();

  return (
    <div className="mx-auto max-w-[820px] p-6">
      <ChatInterface onAgentCreated={(id) => router.push(`/agents/${id}`)} />
    </div>
  );
}
