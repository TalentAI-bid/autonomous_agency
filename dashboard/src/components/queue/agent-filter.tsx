'use client';

import { Select } from '@/components/ui/select';

interface AgentFilterProps {
  agents: Array<{ id: string; name: string }>;
  /** '' means all agents */
  value: string;
  onChange: (id: string) => void;
}

/** Dropdown that scopes the Approvals page to one agent. */
export function AgentFilter({ agents, value, onChange }: AgentFilterProps) {
  return (
    <Select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Show approvals from"
      className="h-8 max-w-[220px] font-medium"
      menuClassName="w-64"
    >
      <option value="">All agents</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>{a.name}</option>
      ))}
    </Select>
  );
}
