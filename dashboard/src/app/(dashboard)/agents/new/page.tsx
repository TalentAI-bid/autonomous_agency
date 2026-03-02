'use client';

import { useRouter } from 'next/navigation';
import { ChatInterface } from '@/components/chat/chat-interface';

export default function NewAgentPage() {
  const router = useRouter();

  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-4">
        <h1 className="text-2xl font-bold">Create Agent</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Chat with AI to design and launch your agent pipeline
        </p>
      </div>

      <ChatInterface onAgentCreated={(id) => router.push(`/agents/${id}`)} />
    </div>
  );
}
