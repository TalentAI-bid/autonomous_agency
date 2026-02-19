'use client';

import { CreateAgentWizard } from '@/components/agents/create-agent-wizard';

export default function NewAgentPage() {
  return (
    <div className="max-w-3xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold">Create Agent</h1>
        <p className="text-muted-foreground text-sm mt-1">Set up a new AI recruiting agent in a few steps</p>
      </div>
      <CreateAgentWizard />
    </div>
  );
}
